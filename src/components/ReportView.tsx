'use client';
import Image from 'next/image';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getBookingUrl } from '@/lib/booking';
import {
  MAX_CONTEXT_WORDS,
  MAX_SUMMARY_WORDS,
  type Area,
  type Narrative,
  type ReportModel,
} from '@/lib/report';
import s from './ReportView.module.css';

/**
 * The personalized diagnosis ("Tu diagnóstico patrimonial personalizado"), built from
 * report-template/quiron-report-prototype-v2.html.
 *
 * Who writes what (the 65% / 20% / 15% split):
 *  - Rules engine (src/lib/report.ts): score, level, areas, statuses, ranked priorities, findings,
 *    actions, plan.                                                              ~65%
 *  - Fixed interface: headings, labels, descriptions, CTA, disclaimer.            ~20%
 *  - AI (4 text slots only): executive summary + one short context per priority.  ~15%
 *
 * Edit layout/wording here and styles in ReportView.module.css. The PDF is the browser's print
 * of this same page (A4 rules in the CSS module's @media print).
 *
 * `mode="team"` adds the prototype's review annotations (source tags, AI/rules mix panel).
 * Customers always get `mode="client"` (the default).
 */
export type Report = { model: ReportModel; narrative: Narrative; aiUsed: boolean };

type ReportViewProps = {
  report: Report;
  firstName: string;
  /** ISO date-time the report was generated. */
  generatedAt: string;
  mode?: 'client' | 'team';
  /** True while the AI text is still loading (the PDF button waits so the PDF matches the page). */
  aiPending?: boolean;
};

const SECTIONS = [
  { id: 'resumen', label: 'Resumen' },
  { id: 'ejecutivo', label: 'Diagnóstico' },
  { id: 'personal', label: 'Personal' },
  { id: 'empresarial', label: 'Empresarial' },
  { id: 'prioridades', label: 'Prioridades' },
  { id: 'plan', label: 'Plan de acción' },
];

const cx = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(' ');

function slug(text: string) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function formatDate(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'long',
    timeZone: 'America/Mexico_City',
  }).format(date);
}

function MixBar() {
  return (
    <div className={s.mixBar} role="img" aria-label="65% reglas, 20% interfaz fija, 15% IA">
      <span className={s.barDet} />
      <span className={s.barStatic} />
      <span className={s.barAi} />
    </div>
  );
}

const ViewContext = createContext({ team: false, aiUsed: false });

function SourceLine({
  kind,
  tag,
  note,
}: {
  kind: 'det' | 'ai' | 'static';
  tag: string;
  note?: string;
}) {
  const { team } = useContext(ViewContext);
  if (!team) return null;
  return (
    <div className={s.sourceLine}>
      <span
        className={cx(
          s.sourceTag,
          kind === 'det' && s.tagDet,
          kind === 'ai' && s.tagAi,
          kind === 'static' && s.tagStatic,
        )}
      >
        {tag}
      </span>
      {note && <span className={s.sourceNote}>{note}</span>}
    </div>
  );
}

function AiBox({
  title,
  limit,
  text,
  children,
}: {
  title: string;
  limit: string;
  text: string;
  children?: ReactNode;
}) {
  const { team, aiUsed } = useContext(ViewContext);
  return (
    <div className={cx(s.aiBox, team && s.aiBoxTeam)}>
      {team && (
        <div className={s.aiHead}>
          <strong>✧ {title}</strong>
          <span className={s.aiLimit}>IA · {limit}</span>
        </div>
      )}
      <p className={s.aiContent}>{text}</p>
      {team && (
        <p className={s.aiMeta}>
          Origen del texto:{' '}
          <b>{aiUsed ? 'Claude' : 'plantilla determinística (IA no disponible)'}</b>. La IA solo
          redacta; no calcula ni decide.
        </p>
      )}
      {children}
    </div>
  );
}

function AreaCard({ area }: { area: Area }) {
  return (
    <article className={s.area}>
      <div className={s.areaTop}>
        <h3>{area.title}</h3>
        <span className={cx(s.chip, area.status === 'solid' && s.chipGreen)}>
          {area.status === 'solid' ? 'Sólido' : 'Por revisar'}
        </span>
      </div>
      <p>{area.description}</p>
      <span className={s.areaCount}>
        {area.yes} de {area.total} respuestas afirmativas
      </span>
      <SourceLine kind="det" tag="REGLAS" note="Indicador, estado y texto aprobado." />
    </article>
  );
}

function SectionHeader({ num, title, sub }: { num: string; title: string; sub: string }) {
  return (
    <div className={s.secHeader}>
      <span className={s.secNumber}>{num}</span>
      <div>
        <h2>{title}</h2>
        <p className={s.secSub}>{sub}</p>
      </div>
    </div>
  );
}

export default function ReportView({
  report,
  firstName,
  generatedAt,
  mode = 'client',
  aiPending = false,
}: ReportViewProps) {
  const team = mode === 'team';
  const { model, narrative, aiUsed } = report;
  const { score } = model;
  // NEXT_PUBLIC_* values are inlined at build time: changing it in Vercel requires a redeploy.
  const bookingUrl = getBookingUrl(process.env.NEXT_PUBLIC_BOOKING_URL);
  const [activeId, setActiveId] = useState('resumen');

  // Highlight the current section in the left navigation.
  useEffect(() => {
    if (!('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setActiveId(entry.target.id);
      },
      { rootMargin: '-16% 0px -70% 0px' },
    );
    document.querySelectorAll('[data-report-section]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  function downloadPdf() {
    // The browser print dialog ("Guardar como PDF") uses the page title as the file name.
    const previous = document.title;
    document.title = `Diagnostico-Patrimonial-Quiron${firstName ? `-${slug(firstName)}` : ''}`;
    const restore = () => {
      document.title = previous;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    window.print();
  }

  return (
    <ViewContext.Provider value={{ team, aiUsed }}>
      <div className={s.root}>
        <div className={s.actionbar}>
          {aiPending && <span className={s.actionNote}>Personalizando la redacción…</span>}
          <button type="button" className={s.pdfButton} onClick={downloadPdf} disabled={aiPending}>
            Descargar PDF ↓
          </button>
        </div>

        {team && (
          <div className={s.reviewbar}>
            <div className={s.reviewbarInner}>
              <div>
                <strong>Mapa de responsabilidad · Vista del equipo</strong>
                <p>
                  La IA solo interviene en el resumen ejecutivo y en breves explicaciones de las
                  tres prioridades.
                </p>
              </div>
              <div className={s.kpis}>
                <span className={cx(s.miniPill, s.miniDet)}>65% · Reglas</span>
                <span className={cx(s.miniPill, s.miniStatic)}>20% · Interfaz</span>
                <span className={cx(s.miniPill, s.miniAi)}>15% · IA</span>
              </div>
            </div>
          </div>
        )}

        <div className={cx(s.workspace, team && s.workspaceTeam)}>
          <aside className={s.aside}>
            <div className={s.sideHeading}>Contenido del reporte</div>
            <nav className={s.nav} aria-label="Secciones del reporte">
              {SECTIONS.map((section, i) => (
                <a
                  key={section.id}
                  href={`#${section.id}`}
                  className={activeId === section.id ? s.navActive : undefined}
                >
                  <span>{String(i).padStart(2, '0')}</span>
                  {section.label}
                </a>
              ))}
            </nav>
            {team && (
              <div className={s.sideCard}>
                <h3>Cómo leer esta vista</h3>
                <div className={s.legendRow}>
                  <i className={cx(s.dot, s.dotDet)} /> Azul · Motor determinístico
                </div>
                <div className={s.legendRow}>
                  <i className={cx(s.dot, s.dotAi)} /> Morado · Espacio para Claude
                </div>
                <div className={s.legendRow}>
                  <i className={cx(s.dot, s.dotStatic)} /> Gris · Interfaz fija
                </div>
              </div>
            )}
          </aside>

          <main className={s.paper} id="report">
            {/* Brand header: only visible in the PDF/print (the site header is hidden there) */}
            <div className={s.printBrand}>
              <span className={s.printLogo}>
                <Image
                  src="/images/quiron-logo.png"
                  alt="Quirón Arquitectos Financieros"
                  width={151}
                  height={66}
                />
              </span>
              <span className={s.printBrandText}>Diagnóstico de Blindaje Patrimonial</span>
            </div>

            {/* 00 · Resumen */}
            <section className={s.hero} id="resumen" data-report-section>
              <div className={s.eyebrow}>Tu evaluación · Diagnóstico inicial</div>
              <h1>Tu diagnóstico patrimonial personalizado.</h1>
              <p className={s.lead}>
                Una mirada integral a la protección de tu patrimonio, tu familia y la continuidad de
                lo que has construido.
              </p>
              <SourceLine
                kind="static"
                tag="INTERFAZ FIJA"
                note="Encabezado, contenido de marca y estructura del reporte."
              />
              <div className={s.meta}>
                {firstName && <span>Preparado para {firstName}</span>}
                {formatDate(generatedAt) && <span>{formatDate(generatedAt)}</span>}
                <span>
                  QUIRÓN · {new Date(generatedAt).getFullYear() || new Date().getFullYear()}
                </span>
              </div>
              <div className={s.scores}>
                <article className={s.scoreCard}>
                  <div className={s.scoreLabel}>Blindaje patrimonial general</div>
                  <div className={s.scoreNumber}>{score.protection}%</div>
                  <span className={cx(s.level, model.levelTone === 'high' && s.levelGreen)}>
                    Nivel de blindaje: {model.level}
                  </span>
                  <div
                    className={s.progress}
                    role="img"
                    aria-label={`${score.protection} por ciento`}
                  >
                    <div className={s.progressFill} style={{ width: `${score.protection}%` }} />
                  </div>
                  <SourceLine
                    kind="det"
                    tag="REGLAS · SCORE"
                    note="Resultado y nivel calculados (mismos que el Dashboard)."
                  />
                </article>
                <article className={s.scoreCard}>
                  <div className={s.scoreLabel}>Áreas por fortalecer</div>
                  <div className={s.scoreNumber}>
                    {model.weakCount} <span className={s.scoreOf}>/ 20</span>
                  </div>
                  <div className={s.scoreSub}>Indicadores detectados según las respuestas</div>
                  <SourceLine
                    kind="det"
                    tag="REGLAS · CONTEO"
                    note="Número de respuestas negativas."
                  />
                </article>
              </div>
            </section>

            {/* 01 · Diagnóstico ejecutivo (AI slot 1) */}
            <section className={s.section} id="ejecutivo" data-report-section>
              <SectionHeader
                num="01"
                title={'Diagnóstico ejecutivo'}
                sub="Una lectura clara de tus principales indicadores patrimoniales."
              />
              <div className={s.contentPanel}>
                <h3>Lo que detectamos en tu evaluación</h3>
                <div className={s.signalList}>
                  <div className={s.signal}>
                    <div className={s.signalLabel}>Nivel general</div>
                    <strong>{model.level}</strong>
                    <small>Clasificación del motor</small>
                  </div>
                  <div className={s.signal}>
                    <div className={s.signalLabel}>Indicadores</div>
                    <strong>
                      {model.weakCount} {model.weakCount === 1 ? 'área' : 'áreas'} por fortalecer
                    </strong>
                    <small>Conteo del motor</small>
                  </div>
                  <div className={s.signal}>
                    <div className={s.signalLabel}>Foco principal</div>
                    <strong>{model.focus}</strong>
                    <small>Prioridad según tus respuestas</small>
                  </div>
                </div>
                <SourceLine
                  kind="det"
                  tag="REGLAS · RESULTADOS"
                  note="Los datos y hallazgos proceden del motor, nunca de Claude."
                />
              </div>
              <AiBox
                title="Interpretación ejecutiva"
                limit={`Hasta ${MAX_SUMMARY_WORDS} palabras`}
                text={narrative.executiveSummary}
              >
                {aiPending && <span className={s.pending}>Personalizando la redacción…</span>}
              </AiBox>
            </section>

            {/* 02 · Patrimonio personal */}
            <section className={s.section} id="personal" data-report-section>
              <SectionHeader
                num="02"
                title={'Patrimonio personal'}
                sub="Planeación sucesoria, documentación, protección familiar y seguros."
              />
              <div className={s.areas}>
                {model.personalAreas.map((area) => (
                  <AreaCard key={area.id} area={area} />
                ))}
              </div>
              <SourceLine
                kind="det"
                tag="SECCIÓN 100% REGLAS"
                note="Hallazgos, estados y explicaciones proceden de reglas y plantillas validadas."
              />
            </section>

            {/* 03 · Patrimonio empresarial */}
            <section className={s.section} id="empresarial" data-report-section>
              <SectionHeader
                num="03"
                title={'Patrimonio empresarial'}
                sub="Protección de la empresa, sucesión y continuidad de operaciones."
              />
              <div className={s.areas}>
                {model.businessAreas.map((area) => (
                  <AreaCard key={area.id} area={area} />
                ))}
              </div>
              <SourceLine
                kind="det"
                tag="SECCIÓN 100% REGLAS"
                note="No existe bloque de generación IA en patrimonio empresarial."
              />
            </section>

            {/* 04 · Prioridades (AI slots 2–4) */}
            <section className={s.section} id="prioridades" data-report-section>
              <SectionHeader
                num="04"
                title={
                  model.priorities.length === 1
                    ? 'Tu prioridad estratégica'
                    : 'Prioridades estratégicas'
                }
                sub="Puntos de atención seleccionados y ordenados con reglas predefinidas."
              />
              <SourceLine
                kind="det"
                tag="REGLAS · RANKING"
                note="Claude no selecciona ni reordena ninguna prioridad."
              />
              {model.priorities.length === 0 ? (
                <div className={s.allGood}>
                  <h3>No detectamos áreas por fortalecer en tus respuestas.</h3>
                  <p style={{ marginBottom: 0 }}>
                    Conviene revisar periódicamente tus documentos y coberturas para confirmar que
                    siguen vigentes.
                  </p>
                </div>
              ) : (
                model.priorities.map((priority, i) => (
                  <article className={s.priority} key={priority.themeId}>
                    <div className={s.rank}>{priority.rank}</div>
                    <div>
                      <h3>{priority.title}</h3>
                      <p className={s.priorityLine}>
                        <b>Hallazgo:</b> {priority.finding}
                      </p>
                      <p className={s.priorityLine}>
                        <b>Acción recomendada:</b> {priority.action}
                      </p>
                      <SourceLine kind="det" tag="REGLAS · HALLAZGO + ACCIÓN" />
                      <AiBox
                        title="Contexto breve para esta prioridad"
                        limit={`${MAX_CONTEXT_WORDS} palabras máx.`}
                        text={narrative.priorityContexts[i] ?? priority.context}
                      />
                    </div>
                  </article>
                ))
              )}
            </section>

            {/* 05 · Plan de acción + CTA */}
            <section className={s.section} id="plan" data-report-section>
              <SectionHeader
                num="05"
                title={'Tu plan de acción'}
                sub="Pasos iniciales elegidos de un catálogo de acciones aprobadas."
              />
              <div className={s.timeline}>
                {model.plan.map((step) => (
                  <div className={s.step} key={step.title}>
                    <small>{step.stage}</small>
                    <h3>{step.title}</h3>
                    <p>{step.text}</p>
                  </div>
                ))}
              </div>
              <SourceLine
                kind="det"
                tag="REGLAS · ACCIONES + ORDEN"
                note="Sin generación de IA; textos de un catálogo autorizado."
              />

              <div className={s.cta}>
                <h3>Da el siguiente paso para proteger tu patrimonio.</h3>
                <p>
                  Un asesor de Quirón puede ayudarte a validar los hallazgos y convertir este
                  diagnóstico inicial en un plan personalizado.
                </p>
                {bookingUrl ? (
                  <a
                    className={s.ctaButton}
                    href={bookingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Agendar diagnóstico ↗
                  </a>
                ) : (
                  <>
                    <button
                      type="button"
                      className={s.ctaButton}
                      disabled
                      aria-describedby="booking-unavailable"
                    >
                      Agendar diagnóstico ↗
                    </button>
                    <small id="booking-unavailable" role="status" className={s.ctaNote}>
                      El calendario de citas no está disponible por el momento. Escríbenos y con
                      gusto te ayudamos a agendar.
                    </small>
                  </>
                )}
                <SourceLine kind="static" tag="CTA FIJO" />
              </div>

              {/* How this report was produced (reflects what actually happened for this report) */}
              {!aiPending && (
                <div className={s.transparency}>
                  <h3>Cómo se elaboró este reporte</h3>
                  {aiUsed ? (
                    <>
                      <MixBar />
                      <div className={s.legendInline}>
                        <span>
                          <i className={cx(s.dot, s.dotDet)} /> 65% reglas y plantillas validadas
                        </span>
                        <span>
                          <i className={cx(s.dot, s.dotStatic)} /> 20% interfaz fija
                        </span>
                        <span>
                          <i className={cx(s.dot, s.dotAi)} /> 15% redacción con IA
                        </span>
                      </div>
                      <p>
                        El 85% de este reporte se genera con reglas y plantillas validadas por
                        Quirón. Solo el 15% —el resumen ejecutivo y una breve explicación de cada
                        prioridad— es redactado con ayuda de inteligencia artificial, que no calcula
                        puntajes ni decide acciones.
                      </p>
                    </>
                  ) : (
                    <p>
                      Este reporte se generó por completo con reglas y plantillas validadas por
                      Quirón. La redacción asistida por inteligencia artificial no estuvo disponible
                      en esta ocasión.
                    </p>
                  )}
                </div>
              )}

              <p className={s.legal}>
                Este reporte es una herramienta informativa preliminar basada en respuestas
                autodeclaradas; no constituye ni sustituye asesoría legal, fiscal, financiera ni de
                seguros personalizada, ni certificación de cobertura. Algunas preguntas pueden no
                aplicar a todas las personas. Para un diagnóstico integral, consulta con
                especialistas.
              </p>
              <SourceLine
                kind="static"
                tag="INTERFAZ FIJA"
                note="Disclaimer, branding, navegación y CTA."
              />
            </section>
          </main>

          {team && (
            <aside className={cx(s.aside, s.rightSide)}>
              <div className={s.sideCard} style={{ marginTop: 0 }}>
                <h3>Distribución de contenido</h3>
                <p>Participación conceptual del contenido del reporte.</p>
                <MixBar />
                <div className={s.mixRow}>
                  <span className={s.detLabel}>Motor de reglas</span>
                  <b className={s.detLabel}>65%</b>
                </div>
                <div className={s.mixRow}>
                  <span className={s.staticLabel}>Interfaz fija</span>
                  <b className={s.staticLabel}>20%</b>
                </div>
                <div className={s.mixRow}>
                  <span className={s.aiLabel}>Texto de IA</span>
                  <b className={s.aiLabel}>15%</b>
                </div>
                <p className={s.footnote}>
                  Meta de diseño aproximada, no una medición exacta de palabras.
                </p>
                <hr className={s.noteDivider} />
                <h3>Claude solo llena {1 + model.priorities.length} espacios</h3>
                <ol className={s.rightNote}>
                  <li>Un resumen ejecutivo (hasta {MAX_SUMMARY_WORDS} palabras).</li>
                  {model.priorities.map((p) => (
                    <li key={p.themeId}>
                      Contexto de prioridad {p.rank} (hasta {MAX_CONTEXT_WORDS} palabras).
                    </li>
                  ))}
                </ol>
                <p className={s.footnote}>
                  Una sola respuesta estructurada. La IA no calcula scores, no selecciona riesgos y
                  no decide acciones.
                </p>
                <p className={s.footnote}>
                  Esta vista: texto {aiUsed ? 'generado por IA' : 'de plantilla (fallback)'}.
                </p>
              </div>
            </aside>
          )}
        </div>
      </div>
    </ViewContext.Provider>
  );
}
