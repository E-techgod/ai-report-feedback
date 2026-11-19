import {
  MAX_CONTEXT_WORDS,
  MAX_SUMMARY_WORDS,
  buildAiInput,
  fallbackNarrative,
  validateNarrative,
  type ReportModel,
} from './report';
import type { NarrativeOutcome } from './final-report';

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

export function systemPrompt(priorityCount: number, delivery: 'tool' | 'json' = 'tool'): string {
  const how =
    delivery === 'tool'
      ? `llamando a la herramienta ${TOOL_NAME}`
      : 'como un objeto JSON que cumpla el esquema indicado, sin texto adicional';
  return [
    'Eres un redactor de Quirón especializado en diagnóstico patrimonial orientativo; NO das asesoría legal, financiera ni fiscal.',
    'Recibirás resultados YA calculados por reglas. Tu única tarea es redactar texto breve que los explique.',
    'No cambies ni recalcules el score ni el nivel. No agregues cifras, diagnósticos, riesgos, prioridades, coberturas, pólizas, situación familiar ni acciones nuevas. No modifiques las acciones indicadas.',
    `Entrega el resultado ${how}: executiveSummary (un párrafo de máximo ${MAX_SUMMARY_WORDS} palabras que interprete los hallazgos) y priorityContexts (arreglo con EXACTAMENTE ${priorityCount} textos, uno por prioridad y en el mismo orden, cada uno de máximo ${MAX_CONTEXT_WORDS} palabras que expliquen por qué ese hallazgo merece atención).`,
    'Español mexicano profesional, claro y amable. Recomienda contrastar con documentación vigente y con un especialista, sin alarmismo.',
  ].join(' ');
}

export function toolDefinition(priorityCount: number) {
  return {
    name: TOOL_NAME,
    description: 'Entrega la redacción del reporte (resumen ejecutivo y contexto por prioridad).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['executiveSummary', 'priorityContexts'],
      properties: {
        executiveSummary: { type: 'string' },
        priorityContexts: {
          type: 'array',
          minItems: priorityCount,
          maxItems: priorityCount,
          items: { type: 'string' },
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
  body: (modelId: string, model: ReportModel) => unknown;
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
  body: (modelId, model) => ({
    model: modelId,
    max_tokens: 800,
    system: systemPrompt(model.priorities.length),
    tools: [toolDefinition(model.priorities.length)],
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
  body: (modelId, model) => ({
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
      { role: 'system', content: systemPrompt(model.priorities.length, 'json') },
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
  | { ok: true; narrative: NonNullable<ReturnType<typeof validateNarrative>> }
  | { ok: false; reason: string; retryable: boolean; retryAfterMs?: number };

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
    fetchImpl: typeof fetch;
  },
  timeoutMs: number,
): Promise<Attempt> {
  const count = model.priorities.length;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await cfg.fetchImpl(cfg.adapter.url, {
      method: 'POST',
      signal: controller.signal,
      headers: cfg.adapter.headers(cfg.apiKey),
      body: JSON.stringify(cfg.adapter.body(cfg.modelId, model)),
    });
    if (response.status === 429) {
      // Never read or log the body: only the pause the provider asks for.
      const retryAfterMs =
        parseRetryAfterMs(response.headers.get('retry-after')) ?? DEFAULT_RATE_LIMIT_PAUSE_MS;
      return { ok: false, reason: 'rate-limited', retryable: true, retryAfterMs };
    }
    if (!response.ok) {
      return { ok: false, reason: `http-${response.status}`, retryable: response.status >= 500 };
    }
    const narrative = validateNarrative(cfg.adapter.extract(await response.json()), count);
    if (!narrative) return { ok: false, reason: 'invalid-output', retryable: true };
    return { ok: true, narrative };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
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

  const fetchImpl = config.fetchImpl ?? fetch;
  const attemptTimeout = config.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const budget = config.totalBudgetMs ?? TOTAL_BUDGET_MS;
  const maxAttempts = config.maxAttempts ?? MAX_ATTEMPTS;
  const started = Date.now();
  let reason = 'error';

  for (let n = 1; n <= maxAttempts; n += 1) {
    const remaining = budget - (Date.now() - started);
    if (remaining < 1000) break;
    const result = await attempt(
      model,
      { adapter, apiKey, modelId, fetchImpl },
      Math.min(attemptTimeout, remaining),
    );
    if (result.ok) return { narrative: result.narrative, source: 'ai', failureReason: null };
    reason = result.reason;
    console.warn(`[narrative] attempt ${n}/${maxAttempts} failed: ${reason}`);
    if (!result.retryable) break;
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
