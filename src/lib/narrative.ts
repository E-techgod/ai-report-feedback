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
 * Writes the 4 AI text slots (executive summary + one short context per priority) with Claude.
 * Score, level, areas, priorities and actions come from the rules engine; the AI only explains
 * them. The output is forced through a tool schema and validated again with zod.
 *
 * Failure is explicit: the outcome has source 'template' and a failureReason, and the report
 * says so. A template is never presented as AI-written text.
 */
export const TOOL_NAME = 'entregar_redaccion';
const API_URL = 'https://api.anthropic.com/v1/messages';
const ATTEMPT_TIMEOUT_MS = 20_000;
const TOTAL_BUDGET_MS = 38_000;
const MAX_ATTEMPTS = 2;

export type NarrativeConfig = {
  apiKey?: string;
  modelId?: string;
  fetchImpl?: typeof fetch;
  attemptTimeoutMs?: number;
  totalBudgetMs?: number;
  maxAttempts?: number;
};

export function systemPrompt(priorityCount: number): string {
  return [
    'Eres un redactor de Quirón especializado en diagnóstico patrimonial orientativo; NO das asesoría legal, financiera ni fiscal.',
    'Recibirás resultados YA calculados por reglas. Tu única tarea es redactar texto breve que los explique.',
    'No cambies ni recalcules el score ni el nivel. No agregues cifras, diagnósticos, riesgos, prioridades, coberturas, pólizas, situación familiar ni acciones nuevas. No modifiques las acciones indicadas.',
    `Entrega el resultado llamando a la herramienta ${TOOL_NAME}: executiveSummary (un párrafo de máximo ${MAX_SUMMARY_WORDS} palabras que interprete los hallazgos) y priorityContexts (arreglo con EXACTAMENTE ${priorityCount} textos, uno por prioridad y en el mismo orden, cada uno de máximo ${MAX_CONTEXT_WORDS} palabras que expliquen por qué ese hallazgo merece atención).`,
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

type Attempt =
  | { ok: true; narrative: NonNullable<ReturnType<typeof validateNarrative>> }
  | { ok: false; reason: string; retryable: boolean };

async function attempt(
  model: ReportModel,
  cfg: Required<Pick<NarrativeConfig, 'apiKey' | 'modelId'>> & { fetchImpl: typeof fetch },
  timeoutMs: number,
): Promise<Attempt> {
  const count = model.priorities.length;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await cfg.fetchImpl(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.modelId,
        max_tokens: 800,
        system: systemPrompt(count),
        tools: [toolDefinition(count)],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [{ role: 'user', content: JSON.stringify(buildAiInput(model)) }],
      }),
    });
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      return { ok: false, reason: `http-${response.status}`, retryable };
    }
    const data = (await response.json()) as { content?: Array<Record<string, unknown>> };
    const block = data.content?.find((b) => b.type === 'tool_use' && b.name === TOOL_NAME);
    const narrative = validateNarrative(block?.input, count);
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

  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const modelId = config.modelId ?? process.env.ANTHROPIC_MODEL;
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
      { apiKey, modelId, fetchImpl },
      Math.min(attemptTimeout, remaining),
    );
    if (result.ok) return { narrative: result.narrative, source: 'ai', failureReason: null };
    reason = result.reason;
    console.warn(`[narrative] attempt ${n}/${maxAttempts} failed: ${reason}`);
    if (!result.retryable) break;
  }
  return template(reason);
}
