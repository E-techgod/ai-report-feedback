import { NextResponse } from 'next/server';
import { submissionSchema } from '@/lib/validation';
import {
  MAX_CONTEXT_WORDS,
  MAX_SUMMARY_WORDS,
  buildAiInput,
  buildReportModel,
  fallbackNarrative,
  validateNarrative,
} from '@/lib/report';

export const runtime = 'nodejs';

/**
 * Fills the 4 AI text slots of the report (executive summary + one short context per priority).
 * The report itself (score, areas, priorities, actions) is computed by the deterministic engine in
 * src/lib/report.ts; the AI only explains results that are already calculated.
 * Response: { executiveSummary, priorityContexts, ai } where ai=false means "template fallback".
 */
function systemPrompt(priorityCount: number): string {
  return [
    'Eres un redactor de Quirón especializado en diagnóstico patrimonial orientativo; NO das asesoría legal, financiera ni fiscal.',
    'Recibirás resultados YA calculados por reglas. Tu única tarea es redactar texto breve que los explique.',
    'No cambies ni recalcules el score ni el nivel. No agregues cifras, diagnósticos, riesgos, prioridades, coberturas, pólizas, situación familiar ni acciones nuevas. No modifiques las acciones indicadas.',
    `Devuelve SOLO JSON válido con las claves: executiveSummary (un párrafo de máximo ${MAX_SUMMARY_WORDS} palabras que interprete los hallazgos) y priorityContexts (arreglo con EXACTAMENTE ${priorityCount} textos, uno por prioridad y en el mismo orden, cada uno de máximo ${MAX_CONTEXT_WORDS} palabras que expliquen por qué ese hallazgo merece atención).`,
    'Español mexicano profesional, claro y amable. Recomienda contrastar con documentación vigente y con un especialista, sin alarmismo.',
  ].join(' ');
}

export async function POST(req: Request) {
  try {
    const parsed = submissionSchema.safeParse(await req.json());
    if (!parsed.success)
      return NextResponse.json({ error: 'Respuestas inválidas.' }, { status: 400 });

    const model = buildReportModel(parsed.data.answers);
    const fallback = { ...fallbackNarrative(model), ai: false };
    const fail = (reason: string) => {
      console.warn(`[summary] AI fallback used: ${reason}`);
      return NextResponse.json(fallback);
    };

    if (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_MODEL)
      return fail('not-configured');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8500);
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL,
          max_tokens: 600,
          system: systemPrompt(model.priorities.length),
          messages: [{ role: 'user', content: JSON.stringify(buildAiInput(model)) }],
        }),
      });
      if (!response.ok) return fail(`http-${response.status}`);
      const data = await response.json();
      const raw: string =
        data?.content
          ?.filter((x: { type: string }) => x.type === 'text')
          .map((x: { text: string }) => x.text)
          .join('') ?? '';
      const clean = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      const narrative = validateNarrative(JSON.parse(clean), model.priorities.length);
      if (!narrative) return fail('invalid-output');
      return NextResponse.json({ ...narrative, ai: true });
    } catch (error) {
      return fail(error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'error');
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 });
  }
}
