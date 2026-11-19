import type { FinalReport } from './final-report';

/**
 * Every customer-visible string of the report, derived from the finalized report object.
 * The web view (ReportView), the PDF (ReportPdf) and the email all render from this structure,
 * so they cannot diverge. Edit wording HERE, not in the renderers.
 */
export type AreaContent = {
  id: string;
  title: string;
  description: string;
  solid: boolean;
  statusLabel: string;
  countLabel: string;
};

export type ReportContent = {
  brand: string;
  hero: {
    eyebrow: string;
    title: string;
    lead: string;
    meta: string[];
    score: { label: string; value: string; levelLabel: string; levelTone: 'low' | 'mid' | 'high' };
    weak: { label: string; value: string; of: string; sub: string };
  };
  executive: {
    num: string;
    title: string;
    sub: string;
    panelTitle: string;
    signals: Array<{ label: string; value: string; small: string }>;
    summaryText: string;
  };
  personal: { num: string; title: string; sub: string; areas: AreaContent[] };
  business: { num: string; title: string; sub: string; areas: AreaContent[] };
  priorities: {
    num: string;
    title: string;
    sub: string;
    empty: { title: string; text: string } | null;
    items: Array<{
      rank: number;
      themeId: string;
      title: string;
      findingLabel: string;
      finding: string;
      actionLabel: string;
      action: string;
      context: string;
    }>;
  };
  plan: {
    num: string;
    title: string;
    sub: string;
    steps: Array<{ stage: string; title: string; text: string }>;
  };
  cta: {
    title: string;
    text: string;
    buttonLabel: string;
    url: string | null;
    unavailableNote: string;
  };
  legal: string;
};

const TIME_ZONE = 'America/Mexico_City';

export function formatReportDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-MX', { dateStyle: 'long', timeZone: TIME_ZONE }).format(date);
}

function reportYear(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-MX', { year: 'numeric', timeZone: TIME_ZONE }).format(date);
}

export const SECTION_NAV = [
  { id: 'resumen', label: 'Resumen' },
  { id: 'ejecutivo', label: 'Diagnóstico' },
  { id: 'personal', label: 'Personal' },
  { id: 'empresarial', label: 'Empresarial' },
  { id: 'prioridades', label: 'Prioridades' },
  { id: 'plan', label: 'Plan de acción' },
];

function areas(list: FinalReport['model']['personalAreas']): AreaContent[] {
  return list.map((a) => ({
    id: a.id,
    title: a.title,
    description: a.description,
    solid: a.status === 'solid',
    statusLabel: a.status === 'solid' ? 'Sólido' : 'Por revisar',
    countLabel: `${a.yes} de ${a.total} respuestas afirmativas`,
  }));
}

export function buildReportContent(report: FinalReport): ReportContent {
  const { model, narrative } = report;
  const date = formatReportDate(report.generatedAt);
  const year = reportYear(report.generatedAt);
  const count = model.priorities.length;

  return {
    brand: 'Diagnóstico de Blindaje Patrimonial',
    hero: {
      eyebrow: 'Tu evaluación · Diagnóstico inicial',
      title: 'Tu diagnóstico patrimonial personalizado.',
      lead: 'Una mirada integral a la protección de tu patrimonio, tu familia y la continuidad de lo que has construido.',
      meta: [
        report.firstName ? `Preparado para ${report.firstName}` : '',
        date,
        year ? `QUIRÓN · ${year}` : 'QUIRÓN',
      ].filter(Boolean),
      score: {
        label: 'Blindaje patrimonial general',
        value: `${model.score.protection}%`,
        levelLabel: `Nivel de blindaje: ${model.level}`,
        levelTone: model.levelTone,
      },
      weak: {
        label: 'Áreas por fortalecer',
        value: String(model.weakCount),
        of: '/ 20',
        sub: 'Indicadores detectados según las respuestas',
      },
    },
    executive: {
      num: '01',
      title: 'Diagnóstico ejecutivo',
      sub: 'Una lectura clara de tus principales indicadores patrimoniales.',
      panelTitle: 'Lo que detectamos en tu evaluación',
      signals: [
        { label: 'Nivel general', value: model.level, small: 'Clasificación del motor' },
        {
          label: 'Indicadores',
          value: `${model.weakCount} ${model.weakCount === 1 ? 'área' : 'áreas'} por fortalecer`,
          small: 'Conteo del motor',
        },
        { label: 'Foco principal', value: model.focus, small: 'Prioridad según tus respuestas' },
      ],
      summaryText: narrative.executiveSummary,
    },
    personal: {
      num: '02',
      title: 'Patrimonio personal',
      sub: 'Planeación sucesoria, documentación, protección familiar y seguros.',
      areas: areas(model.personalAreas),
    },
    business: {
      num: '03',
      title: 'Patrimonio empresarial',
      sub: 'Protección de la empresa, sucesión y continuidad de operaciones.',
      areas: areas(model.businessAreas),
    },
    priorities: {
      num: '04',
      title: count === 1 ? 'Tu prioridad estratégica' : 'Prioridades estratégicas',
      sub: 'Puntos de atención seleccionados y ordenados con reglas predefinidas.',
      empty:
        count === 0
          ? {
              title: 'No detectamos áreas por fortalecer en tus respuestas.',
              text: 'Conviene revisar periódicamente tus documentos y coberturas para confirmar que siguen vigentes.',
            }
          : null,
      items: model.priorities.map((p, i) => ({
        rank: p.rank,
        themeId: p.themeId,
        title: p.title,
        findingLabel: 'Hallazgo:',
        finding: p.finding,
        actionLabel: 'Acción recomendada:',
        action: p.action,
        context: narrative.priorityContexts[i] ?? p.context,
      })),
    },
    plan: {
      num: '05',
      title: 'Tu plan de acción',
      sub: 'Pasos iniciales elegidos de un catálogo de acciones aprobadas.',
      steps: model.plan.map((s) => ({ stage: s.stage, title: s.title, text: s.text })),
    },
    cta: {
      title: 'Da el siguiente paso para proteger tu patrimonio.',
      text: 'Un asesor de Quirón puede ayudarte a validar los hallazgos y convertir este diagnóstico inicial en un plan personalizado.',
      buttonLabel: 'Agendar diagnóstico',
      url: report.bookingUrl,
      unavailableNote:
        'El calendario de citas no está disponible por el momento. Escríbenos y con gusto te ayudamos a agendar.',
    },
    legal:
      'Este reporte es una herramienta informativa preliminar basada en respuestas autodeclaradas; no constituye ni sustituye asesoría legal, fiscal, financiera ni de seguros personalizada, ni certificación de cobertura. Algunas preguntas pueden no aplicar a todas las personas. Para un diagnóstico integral, consulta con especialistas.',
  };
}

/** Every customer-visible string in document order (used to prove web/PDF/email consistency). */
export function flattenContent(c: ReportContent): string[] {
  const area = (a: AreaContent) => [a.title, a.statusLabel, a.description, a.countLabel];
  return [
    c.brand,
    c.hero.eyebrow,
    c.hero.title,
    c.hero.lead,
    ...c.hero.meta,
    c.hero.score.label,
    c.hero.score.value,
    c.hero.score.levelLabel,
    c.hero.weak.label,
    c.hero.weak.value,
    c.hero.weak.sub,
    c.executive.title,
    c.executive.sub,
    c.executive.panelTitle,
    ...c.executive.signals.flatMap((s) => [s.label, s.value, s.small]),
    c.executive.summaryText,
    c.personal.title,
    c.personal.sub,
    ...c.personal.areas.flatMap(area),
    c.business.title,
    c.business.sub,
    ...c.business.areas.flatMap(area),
    c.priorities.title,
    c.priorities.sub,
    ...(c.priorities.empty ? [c.priorities.empty.title, c.priorities.empty.text] : []),
    ...c.priorities.items.flatMap((p) => [
      p.title,
      `${p.findingLabel} ${p.finding}`,
      `${p.actionLabel} ${p.action}`,
      p.context,
    ]),
    c.plan.title,
    c.plan.sub,
    ...c.plan.steps.flatMap((s) => [s.stage, s.title, s.text]),
    c.cta.title,
    c.cta.text,
    c.cta.buttonLabel,
    ...(c.cta.url ? [] : [c.cta.unavailableNote]),
    c.legal,
  ];
}
