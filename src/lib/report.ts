import { z } from 'zod';
import { scoreAnswers, type Answers, type Score } from './scoring';

/**
 * Deterministic report engine ("motor de reglas") for the personalized diagnosis.
 * Everything here is computed from the 20 answers with fixed rules and approved text.
 * The AI only fills 4 text slots (see Narrative) and never selects, ranks or calculates anything.
 *
 * EDITORIAL NOTE: area descriptions and the findings/actions/contexts below are a catalog meant to
 * be reviewed by Quirón's team. The first three themes reuse the prototype wording; the others
 * follow the same tone and still need editorial approval.
 */

export type Theme = {
  id: string;
  section: 'personal' | 'empresarial';
  /** Area card title. */
  title: string;
  /** Area card description (static, approved text). */
  description: string;
  /** Questions (ids from questions.ts) that belong to this area. Each question is used once. */
  questionIds: string[];
  /** Priority card title. */
  priorityTitle: string;
  finding: string;
  action: string;
  /** Deterministic text for the AI "context" slot; shown when the AI is unavailable. */
  context: string;
};

/** Catalog order is also the tie-break order when ranking priorities. */
export const THEMES: Theme[] = [
  {
    id: 'sucesoria',
    section: 'personal',
    title: 'Planeación sucesoria',
    description:
      'Verificar que existan decisiones y documentos sucesorios pertinentes y actualizados.',
    questionIds: ['A1', 'A10'],
    priorityTitle: 'Revisar la planeación sucesoria',
    finding: 'Documentación y decisiones sucesorias por validar.',
    action: 'Reunir documentos existentes y revisarlos con un especialista.',
    context:
      'Clarificar la planeación sucesoria puede facilitar la toma de decisiones familiares y reducir incertidumbres cuando se requiere actuar.',
  },
  {
    id: 'familiar',
    section: 'personal',
    title: 'Protección familiar',
    description:
      'Identificación de dependientes, contingencias y mecanismos de respaldo existentes.',
    questionIds: ['A3', 'A4'],
    priorityTitle: 'Evaluar la protección familiar',
    finding: 'Preparación de tu familia ante una contingencia por validar.',
    action: 'Compartir con tu familia un plan de acción y la ubicación de los documentos clave.',
    context:
      'Contrastar lo que tu familia sabe y puede consultar con las responsabilidades que tiene ayuda a identificar los temas que conviene revisar.',
  },
  {
    id: 'documentacion',
    section: 'personal',
    title: 'Documentación patrimonial',
    description: 'Organización, vigencia y accesibilidad de documentos esenciales.',
    questionIds: ['A2', 'A5', 'A9'],
    priorityTitle: 'Organizar la documentación esencial',
    finding: 'Organización de información patrimonial por evaluar.',
    action: 'Preparar un inventario de documentos y responsables.',
    context:
      'La documentación accesible permite consultar información relevante y dar seguimiento a las decisiones patrimoniales con mayor orden.',
  },
  {
    id: 'seguros',
    section: 'personal',
    title: 'Seguros y coberturas',
    description: 'Revisión inicial de las coberturas declaradas y su pertinencia.',
    questionIds: ['A6', 'A7', 'A8'],
    priorityTitle: 'Revisar seguros y coberturas',
    finding: 'Coberturas de seguro e información asociada por validar.',
    action: 'Revisar la vigencia y suficiencia de tus coberturas con tu agente o un especialista.',
    context:
      'Revisar las coberturas y la información que tu familia conoce sobre ellas ayuda a saber si responden a las necesidades actuales.',
  },
  {
    id: 'sucesion-empresarial',
    section: 'empresarial',
    title: 'Sucesión empresarial',
    description: 'Existencia de criterios para transferir liderazgo o propiedad.',
    questionIds: ['B4', 'B5', 'B6', 'B7'],
    priorityTitle: 'Definir la sucesión empresarial',
    finding: 'Criterios y protocolos de sucesión por formalizar.',
    action: 'Documentar los protocolos ante un fallecimiento y revisarlos con un especialista.',
    context:
      'Contar con criterios claros de sucesión facilita la continuidad de la empresa y las decisiones de socios y familia cuando se requiere actuar.',
  },
  {
    id: 'gobierno',
    section: 'empresarial',
    title: 'Gobierno y continuidad',
    description: 'Protocolos, responsabilidades y preparación ante interrupciones.',
    questionIds: ['B1', 'B2', 'B3', 'B8', 'B9', 'B10'],
    priorityTitle: 'Fortalecer el gobierno y la continuidad',
    finding: 'Estructura de gobierno y documentación societaria por validar.',
    action: 'Actualizar actas y formalizar el gobierno corporativo con apoyo de especialistas.',
    context:
      'Un gobierno formal y documentación societaria vigente dan orden a las decisiones y respaldan la continuidad de la empresa.',
  },
];

export type Area = {
  id: string;
  title: string;
  description: string;
  status: 'solid' | 'review';
  yes: number;
  total: number;
};

export type Priority = {
  rank: number;
  themeId: string;
  title: string;
  finding: string;
  action: string;
  context: string;
};

export type PlanStep = { stage: string; title: string; text: string };

export type ReportModel = {
  score: Score;
  /** Dashboard label: Muy bajo | Bajo | Medio | Alto | Excelente */
  level: string;
  levelTone: 'low' | 'mid' | 'high';
  /** Number of "No" answers (shown as "N / 20"). */
  weakCount: number;
  personalAreas: Area[];
  businessAreas: Area[];
  /** Up to 3 ranked priorities; empty when every answer is "Sí". */
  priorities: Priority[];
  focus: string;
  plan: PlanStep[];
};

/** Static catalog of approved plan steps (the prototype: "elegidos de un catálogo"). */
export const PLAN_STEPS: PlanStep[] = [
  {
    stage: 'Etapa 1 · Inicio',
    title: 'Reunir documentación esencial',
    text: 'Consolidar la información necesaria para validar los hallazgos prioritarios.',
  },
  {
    stage: 'Etapa 2 · Seguimiento',
    title: 'Revisar prioridades con un asesor',
    text: 'Contrastar la evaluación con el contexto patrimonial y los documentos disponibles.',
  },
  {
    stage: 'Etapa 3 · Revisión periódica',
    title: 'Actualizar la estrategia',
    text: 'Volver a evaluar la protección ante cambios personales o empresariales relevantes.',
  },
];

function toArea(theme: Theme, answers: Answers): Area {
  const yes = theme.questionIds.filter((id) => answers[id] === true).length;
  const total = theme.questionIds.length;
  return {
    id: theme.id,
    title: theme.title,
    description: theme.description,
    status: yes === total ? 'solid' : 'review',
    yes,
    total,
  };
}

/**
 * Ranking rule (deterministic): areas with at least one "No" are ordered by the share of
 * unanswered-yes questions (descending); ties follow the catalog order. The top 3 are shown.
 */
export function buildReportModel(answers: Answers): ReportModel {
  const score = scoreAnswers(answers);
  const areas = THEMES.map((t) => ({ theme: t, area: toArea(t, answers) }));
  const ranked = areas
    .filter(({ area }) => area.status === 'review')
    .map((entry, index) => ({ ...entry, index, gap: 1 - entry.area.yes / entry.area.total }))
    .sort((a, b) => b.gap - a.gap || a.index - b.index)
    .slice(0, 3);
  const priorities: Priority[] = ranked.map(({ theme }, i) => ({
    rank: i + 1,
    themeId: theme.id,
    title: theme.priorityTitle,
    finding: theme.finding,
    action: theme.action,
    context: theme.context,
  }));
  return {
    score,
    level: score.category,
    levelTone:
      score.category === 'Alto' || score.category === 'Excelente'
        ? 'high'
        : score.category === 'Medio'
          ? 'mid'
          : 'low',
    weakCount: score.no,
    personalAreas: areas.filter((x) => x.theme.section === 'personal').map((x) => x.area),
    businessAreas: areas.filter((x) => x.theme.section === 'empresarial').map((x) => x.area),
    priorities,
    focus: ranked[0]?.theme.title ?? 'Revisión periódica',
    plan: PLAN_STEPS,
  };
}

/* ------------------------------------------------------------------ */
/* The 4 AI slots: executive summary (≤90 words) + 3 priority contexts (≤25 words each)        */
/* ------------------------------------------------------------------ */

export type Narrative = { executiveSummary: string; priorityContexts: string[] };

export const MAX_SUMMARY_WORDS = 90;
export const MAX_CONTEXT_WORDS = 25;

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Deterministic text used whenever the AI is unavailable or returns something invalid. */
export function fallbackNarrative(model: ReportModel): Narrative {
  if (model.priorities.length === 0) {
    return {
      executiveSummary:
        'Tus respuestas indican que cuentas con las medidas consultadas. Conviene revisarlas periódicamente con especialistas para confirmar que siguen vigentes y adecuadas a tu situación.',
      priorityContexts: [],
    };
  }
  const [a, b] = model.priorities.map((p) => THEMES.find((t) => t.id === p.themeId)!.title);
  const focus = b ? `${a} y ${b.toLowerCase()} destacan` : `${a} destaca`;
  return {
    executiveSummary: `El resultado preliminar muestra áreas de protección que conviene atender de forma ordenada. ${focus} entre los puntos a revisar. Estos indicadores no equivalen a una valoración definitiva: sirven como punto de partida para contrastar tu situación con documentación vigente y definir acciones concretas con un especialista.`,
    priorityContexts: model.priorities.map((p) => p.context),
  };
}

/** Structured contract for the AI output: exact priority count and word limits. */
export function narrativeSchema(
  priorityCount: number,
  limits: { summary: number; context: number } = {
    summary: MAX_SUMMARY_WORDS,
    context: MAX_CONTEXT_WORDS,
  },
) {
  const text = (maxWords: number) =>
    z
      .string()
      .transform((v) => v.trim())
      .refine((v) => wordCount(v) > 0 && wordCount(v) <= maxWords);
  return z
    .object({
      executiveSummary: text(limits.summary),
      priorityContexts: z.array(text(limits.context)).length(priorityCount),
    })
    .strict();
}

/** Accepts the AI output only if it matches the contract exactly; otherwise null. */
export function validateNarrative(
  candidate: unknown,
  priorityCount: number,
  limits?: { summary: number; context: number },
): Narrative | null {
  const parsed = narrativeSchema(priorityCount, limits).safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * The ONLY data the AI receives: already-computed results. No names, emails or raw answers.
 */
export function buildAiInput(model: ReportModel) {
  return {
    score: model.score.protection,
    nivel: model.level,
    areasPorFortalecer: model.weakCount,
    focoPrincipal: model.focus,
    prioridades: model.priorities.map((p) => ({
      orden: p.rank,
      titulo: p.title,
      hallazgo: p.finding,
      accion: p.action,
    })),
  };
}
