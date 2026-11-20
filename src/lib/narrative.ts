import {
  buildAiInput,
  fallbackNarrative,
  narrativeSchema,
  wordCount,
  type Narrative,
  type ReportModel,
} from './report';
import type { NarrativeOutcome } from './final-report';
import { DEFAULT_LIMITS, aiWordLimits, promptWordTarget, type AiWordLimits } from './ai-share';

/**
 * Writes the 4 AI text slots (executive summary + one short context per priority) with the
 * configured provider. Score, level, areas, priorities and actions come from the rules engine;
 * the AI only explains them. The output is forced into a schema and validated again with zod.
 * Providers are small adapters (request shape + where the JSON sits in the response); the retry,
 * timeout and fallback logic below is shared.
 *
 * Failure is explicit: the outcome has source 'template' and a failureReason, and the report
 * says so. A template is never presented as AI-written text.
 */
export const TOOL_NAME = 'entregar_redaccion';
const ATTEMPT_TIMEOUT_MS = 20_000;
const TOTAL_BUDGET_MS = 38_000;
const MAX_ATTEMPTS = 2;
/** Longest Retry-After we are willing to wait for; a longer one ends the AI step at once. */
const MAX_RETRY_AFTER_MS = 8_000;
/** Pause after a 429 that carries no usable Retry-After. */
const DEFAULT_RATE_LIMIT_PAUSE_MS = 1_000;
/** A retry is pointless unless this much of the total budget is left after the pause. */
const MIN_RETRY_WINDOW_MS = 3_000;

/** Groq is the default; anthropic must be selected explicitly with AI_PROVIDER=anthropic. */
export const DEFAULT_PROVIDER = 'groq';
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-20b';
export const GROQ_SCHEMA_NAME = 'redaccion_reporte';

export type NarrativeConfig = {
  /** 'groq' (default) or 'anthropic'. Falls back to the AI_PROVIDER environment variable. */
  provider?: string;
  apiKey?: string;
  modelId?: string;
  fetchImpl?: typeof fetch;
  attemptTimeoutMs?: number;
  totalBudgetMs?: number;
  maxAttempts?: number;
  /** Test seam for the Retry-After pause. */
  sleep?: (ms: number) => Promise<void>;
};

/** Preferred lengths leave room under the combined cap while field caps stay independent. */
export function promptWordTargets(priorityCount: number, limits: AiWordLimits) {
  const total = limits.total ?? limits.summary + priorityCount * limits.context;
  const preferredTotal = Math.max(1, Math.floor(total * 0.85));
  if (priorityCount === 0) {
    return { summary: Math.min(promptWordTarget(limits.summary), preferredTotal), context: 0 };
  }
  const context = Math.min(
    promptWordTarget(limits.context),
    Math.max(1, Math.floor((preferredTotal * 0.45) / priorityCount)),
  );
  const summary = Math.min(
    promptWordTarget(limits.summary),
    Math.max(1, preferredTotal - priorityCount * context),
  );
  return { summary, context };
}

export function systemPrompt(
  priorityCount: number,
  delivery: 'tool' | 'json' = 'tool',
  limits: AiWordLimits = DEFAULT_LIMITS,
): string {
  const how =
    delivery === 'tool'
      ? `llamando a la herramienta ${TOOL_NAME}`
      : 'como un objeto JSON que cumpla el esquema indicado, sin texto adicional';
  const targets = promptWordTargets(priorityCount, limits);
  const contexts =
    priorityCount === 0
      ? 'priorityContexts debe ser un arreglo vacío ([]).'
      : `priorityContexts debe contener EXACTAMENTE ${priorityCount} textos, uno por prioridad y en el mismo orden, cada uno de máximo ${limits.context} palabras; procura ${targets.context} para explicar por qué ese hallazgo merece atención.`;
  return [
    'Eres un redactor de Quirón especializado en diagnóstico patrimonial orientativo; NO das asesoría legal, financiera ni fiscal.',
    'Recibirás resultados YA calculados por reglas. Tu única tarea es redactar texto breve que los explique.',
    'No cambies ni recalcules el score ni el nivel. No agregues cifras, diagnósticos, riesgos, prioridades, coberturas, pólizas, situación familiar ni acciones nuevas. No modifiques las acciones indicadas.',
    `Entrega el resultado ${how}: executiveSummary debe ser un párrafo de máximo ${limits.summary} palabras; procura ${targets.summary} para interpretar los hallazgos. ${contexts}`,
    limits.total === undefined
      ? ''
      : `En conjunto, executiveSummary y priorityContexts no deben superar ${limits.total} palabras.`,
    'Español mexicano profesional, claro y amable. Recomienda contrastar con documentación vigente y con un especialista, sin alarmismo.',
  ].join(' ');
}

export function toolDefinition(priorityCount: number, limits: AiWordLimits = DEFAULT_LIMITS) {
  return {
    name: TOOL_NAME,
    description:
      'Entrega la redacción del reporte (resumen ejecutivo y contexto por prioridad).' +
      (limits.total === undefined
        ? ''
        : ` Máximo ${limits.total} palabras entre todos los campos.`),
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['executiveSummary', 'priorityContexts'],
      properties: {
        executiveSummary: {
          type: 'string',
          description: `Resumen ejecutivo de máximo ${limits.summary} palabras.`,
        },
        priorityContexts: {
          type: 'array',
          description: `Exactamente ${priorityCount} contextos, en el orden de las prioridades.`,
          minItems: priorityCount,
          maxItems: priorityCount,
          items: {
            type: 'string',
            description:
              priorityCount === 0
                ? 'No hay contextos cuando no hay prioridades.'
                : `Contexto de máximo ${limits.context} palabras.`,
          },
        },
      },
    },
  };
}

type ProviderAdapter = {
  id: string;
  url: string;
  /** Used when neither config nor the provider's own model variable is set. */
  defaultModel?: string;
  /** Names of the server-side environment variables holding this provider's credentials. */
  env: { apiKey: string; model: string };
  headers: (apiKey: string) => Record<string, string>;
  body: (
    modelId: string,
    model: ReportModel,
    limits: AiWordLimits,
    previousWordCount?: number,
  ) => unknown;
  /** Locates the (still unvalidated) JSON candidate inside the provider response. */
  extract: (data: unknown) => unknown;
};

const anthropic: ProviderAdapter = {
  id: 'anthropic',
  url: 'https://api.anthropic.com/v1/messages',
  env: { apiKey: 'ANTHROPIC_API_KEY', model: 'ANTHROPIC_MODEL' },
  headers: (apiKey) => ({
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }),
  body: (modelId, model, limits, previousWordCount) => ({
    model: modelId,
    max_tokens: 800,
    system:
      systemPrompt(model.priorities.length, 'tool', limits) +
      (model.priorities.length > 0
        ? ' Escribe cada contexto en una sola oración corta sobre por qué importa el hallazgo; omite introducciones y consejos repetidos.'
        : '') +
      (limits.total === undefined
        ? ''
        : ` Antes de llamar la herramienta, cuenta juntas las palabras de executiveSummary y de todos los priorityContexts. El límite total exacto es ${limits.total} palabras; apunta a ${Math.max(1, limits.total - 5)} palabras o menos para dejar margen.` +
          (previousWordCount === undefined
            ? ''
            : ` El intento anterior sumó ${previousWordCount} palabras. Redacta una nueva versión con al menos ${previousWordCount - limits.total} palabras menos. Acorta primero los contextos y conserva la razón principal de cada prioridad.`)),
    tools: [toolDefinition(model.priorities.length, limits)],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content: JSON.stringify(buildAiInput(model)) }],
  }),
  extract: (data) => {
    const content = (data as { content?: Array<Record<string, unknown>> } | null)?.content;
    return content?.find((b) => b.type === 'tool_use' && b.name === TOOL_NAME)?.input;
  },
};

/**
 * Groq (OpenAI-compatible). The JSON is requested with strict structured outputs. Strict mode
 * needs every property in `required` and additionalProperties:false; the docs do not cover
 * minItems/maxItems/minLength there, so the counts and word limits are enforced by zod after
 * parsing. gpt-oss reasons before answering: low effort, reasoning left out of the response, and
 * enough completion tokens that reasoning cannot truncate the JSON.
 */
export function groqResponseSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['executiveSummary', 'priorityContexts'],
    properties: {
      executiveSummary: { type: 'string' },
      priorityContexts: { type: 'array', items: { type: 'string' } },
    },
  };
}

const groq: ProviderAdapter = {
  id: 'groq',
  url: 'https://api.groq.com/openai/v1/chat/completions',
  defaultModel: DEFAULT_GROQ_MODEL,
  env: { apiKey: 'GROQ_API_KEY', model: 'GROQ_MODEL' },
  headers: (apiKey) => ({
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  }),
  body: (modelId, model, limits) => ({
    model: modelId,
    temperature: 0.2,
    max_completion_tokens: 2048,
    reasoning_effort: 'low',
    include_reasoning: false,
    response_format: {
      type: 'json_schema',
      json_schema: { name: GROQ_SCHEMA_NAME, strict: true, schema: groqResponseSchema() },
    },
    messages: [
      { role: 'system', content: systemPrompt(model.priorities.length, 'json', limits) },
      { role: 'user', content: JSON.stringify(buildAiInput(model)) },
    ],
  }),
  extract: (data) => {
    const text = (data as { choices?: Array<{ message?: { content?: unknown } }> } | null)
      ?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  },
};

const ADAPTERS: Record<string, ProviderAdapter> = { groq, anthropic };

type Attempt =
  | { ok: true; narrative: Narrative }
  | {
      ok: false;
      reason: string;
      retryable: boolean;
      retryAfterMs?: number;
      overBudgetWordCount?: number;
    };

/** Keep provider-controlled strings out of logs, including unexpected JSON field names. */
function diagnosticLabel(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}

function diagnosticPath(path: PropertyKey[]): string {
  return path
    .map((part) =>
      typeof part === 'number'
        ? String(part)
        : (diagnosticLabel(part, ['executiveSummary', 'priorityContexts']) ?? '[other]'),
    )
    .join('.');
}

function outputFields(candidate: unknown) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const fields = candidate as Record<string, unknown>;
  return {
    names: Object.keys(fields)
      .slice(0, 10)
      .map((name) => diagnosticLabel(name, ['executiveSummary', 'priorityContexts']) ?? '[other]'),
    executiveSummary: {
      type: typeof fields.executiveSummary,
      words:
        typeof fields.executiveSummary === 'string' ? wordCount(fields.executiveSummary) : null,
    },
    priorityContexts: {
      type: Array.isArray(fields.priorityContexts) ? 'array' : typeof fields.priorityContexts,
      length: Array.isArray(fields.priorityContexts) ? fields.priorityContexts.length : null,
      words: Array.isArray(fields.priorityContexts)
        ? fields.priorityContexts
            .slice(0, 10)
            .map((value) => (typeof value === 'string' ? wordCount(value) : null))
        : null,
    },
  };
}

function logAttemptDiagnostic(args: {
  adapter: ProviderAdapter;
  modelId: string;
  retry: number;
  status: number | null;
  data?: unknown;
  candidate?: unknown;
  issues?: { path: PropertyKey[]; code: string }[];
  result: string;
}) {
  const data = args.data && typeof args.data === 'object' ? args.data : null;
  const record = data as Record<string, unknown> | null;
  const content = Array.isArray(record?.content) ? record.content : [];
  const usage = record?.usage && typeof record.usage === 'object' ? record.usage : null;
  const tokens = usage as Record<string, unknown> | null;
  const tokenCount = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  console.info(
    '[narrative] diagnostic',
    JSON.stringify({
      provider: args.adapter.id,
      model: /^(claude-|openai\/|meta-llama\/|llama-)[a-zA-Z0-9._/-]{1,90}$/.test(args.modelId)
        ? args.modelId
        : '[redacted]',
      retry: args.retry,
      httpStatus: args.status,
      stopReason: diagnosticLabel(record?.stop_reason, [
        'tool_use',
        'end_turn',
        'max_tokens',
        'stop_sequence',
        'refusal',
        'model_context_window_exceeded',
      ]),
      contentBlockTypes: content
        .slice(0, 10)
        .map(
          (block) =>
            diagnosticLabel((block as Record<string, unknown> | null)?.type, [
              'tool_use',
              'text',
              'thinking',
              'redacted_thinking',
            ]) ?? '[other]',
        ),
      namedToolUseFound:
        args.adapter.id === 'anthropic'
          ? content.some(
              (block) =>
                block &&
                typeof block === 'object' &&
                block.type === 'tool_use' &&
                block.name === TOOL_NAME,
            )
          : null,
      inputTokens: tokenCount(tokens?.input_tokens ?? tokens?.prompt_tokens),
      outputTokens: tokenCount(tokens?.output_tokens ?? tokens?.completion_tokens),
      outputFields: outputFields(args.candidate),
      zodIssueCount: args.issues?.length ?? 0,
      zodIssues:
        args.issues?.slice(0, 20).map((issue) => ({
          path: diagnosticPath(issue.path),
          code:
            diagnosticLabel(issue.code, [
              'invalid_type',
              'too_big',
              'too_small',
              'unrecognized_keys',
              'custom',
              'invalid_value',
              'invalid_format',
              'invalid_union',
            ]) ?? '[other]',
        })) ?? [],
      result: args.result,
    }),
  );
}

/** Retry-After in seconds (Groq documents seconds). Returns null when absent or unusable. */
export function parseRetryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
}

async function attempt(
  model: ReportModel,
  cfg: Required<Pick<NarrativeConfig, 'apiKey' | 'modelId'>> & {
    adapter: ProviderAdapter;
    limits: AiWordLimits;
    fetchImpl: typeof fetch;
    retry: number;
    previousWordCount?: number;
  },
  timeoutMs: number,
): Promise<Attempt> {
  const count = model.priorities.length;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status: number | null = null;
  try {
    const response = await cfg.fetchImpl(cfg.adapter.url, {
      method: 'POST',
      signal: controller.signal,
      headers: cfg.adapter.headers(cfg.apiKey),
      body: JSON.stringify(cfg.adapter.body(cfg.modelId, model, cfg.limits, cfg.previousWordCount)),
    });
    status = response.status;
    if (response.status === 429) {
      // Never read or log the body: only the pause the provider asks for.
      const retryAfterMs =
        parseRetryAfterMs(response.headers.get('retry-after')) ?? DEFAULT_RATE_LIMIT_PAUSE_MS;
      logAttemptDiagnostic({ ...cfg, status, result: 'rate-limited' });
      return { ok: false, reason: 'rate-limited', retryable: true, retryAfterMs };
    }
    if (!response.ok) {
      logAttemptDiagnostic({ ...cfg, status, result: 'http-error' });
      return { ok: false, reason: `http-${response.status}`, retryable: response.status >= 500 };
    }
    const data: unknown = await response.json();
    const candidate = cfg.adapter.extract(data);
    const parsed = narrativeSchema(count, cfg.limits).safeParse(candidate);
    logAttemptDiagnostic({
      ...cfg,
      status,
      data,
      candidate,
      issues: parsed.success ? [] : parsed.error.issues,
      result: parsed.success ? 'valid' : 'invalid-output',
    });
    if (!parsed.success) {
      const failure = { ok: false, reason: 'invalid-output', retryable: true } as const;
      const { summary, context, total } = cfg.limits;
      if (
        cfg.adapter.id === 'anthropic' &&
        total !== undefined &&
        cfg.previousWordCount === undefined
      ) {
        // A candidate that passes every other constraint can be regenerated with count feedback.
        const fields = narrativeSchema(count, { summary, context }).safeParse(candidate);
        if (fields.success) {
          const words =
            wordCount(fields.data.executiveSummary) +
            fields.data.priorityContexts.reduce((sum, value) => sum + wordCount(value), 0);
          if (words > total) return { ...failure, overBudgetWordCount: words };
        }
      }
      return failure;
    }
    return { ok: true, narrative: parsed.data };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    logAttemptDiagnostic({ ...cfg, status, result: timedOut ? 'timeout' : 'error' });
    return { ok: false, reason: timedOut ? 'timeout' : 'error', retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

export async function generateNarrative(
  model: ReportModel,
  config: NarrativeConfig = {},
): Promise<NarrativeOutcome> {
  const template = (failureReason: string): NarrativeOutcome => ({
    narrative: fallbackNarrative(model),
    source: 'template',
    failureReason,
  });

  const providerId = (config.provider ?? process.env.AI_PROVIDER ?? DEFAULT_PROVIDER)
    .trim()
    .toLowerCase();
  // An unknown name (a typo) must not silently pick a provider: the report uses template text.
  const adapter = Object.hasOwn(ADAPTERS, providerId) ? ADAPTERS[providerId] : undefined;
  if (!adapter) return template('unknown-provider');
  const apiKey = config.apiKey ?? process.env[adapter.env.apiKey];
  const modelId = config.modelId ?? (process.env[adapter.env.model] || adapter.defaultModel);
  if (!apiKey || !modelId) return template('not-configured');

  // Keeps AI text within 15% of the visible report (see ai-share.ts).
  const limits = aiWordLimits(model);
  const fetchImpl = config.fetchImpl ?? fetch;
  const attemptTimeout = config.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const budget = config.totalBudgetMs ?? TOTAL_BUDGET_MS;
  const maxAttempts = config.maxAttempts ?? MAX_ATTEMPTS;
  const started = Date.now();
  let reason = 'error';
  let previousWordCount: number | undefined;

  for (let n = 1; n <= maxAttempts; n += 1) {
    const remaining = budget - (Date.now() - started);
    if (remaining < 1000) break;
    const result = await attempt(
      model,
      { adapter, apiKey, modelId, fetchImpl, limits, retry: n, previousWordCount },
      Math.min(attemptTimeout, remaining),
    );
    if (result.ok) return { narrative: result.narrative, source: 'ai', failureReason: null };
    reason = result.reason;
    console.warn(`[narrative] attempt ${n}/${maxAttempts} failed: ${reason}`);
    if (!result.retryable || previousWordCount !== undefined) break;
    previousWordCount = result.overBudgetWordCount;
    if (result.retryAfterMs !== undefined && n < maxAttempts) {
      // Wait for the provider's Retry-After only if it is short and a retry still fits the budget.
      const left = budget - (Date.now() - started);
      if (
        result.retryAfterMs > MAX_RETRY_AFTER_MS ||
        left - result.retryAfterMs < MIN_RETRY_WINDOW_MS
      )
        break;
      await (config.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms))))(
        result.retryAfterMs,
      );
    }
  }
  return template(reason);
}
