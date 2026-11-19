'use client';
import Image from 'next/image';
import { createContext, useContext, useEffect, useState } from 'react';
import type { FinalReport } from '@/lib/final-report';
import type { PublicEmailState } from '@/lib/pipeline';
import { SECTION_NAV, buildReportContent, type AreaContent } from '@/lib/report-content';
import { MAX_CONTEXT_WORDS, MAX_SUMMARY_WORDS } from '@/lib/report';
import s from './ReportView.module.css';

/**
 * The personalized diagnosis ("Tu diagnóstico patrimonial personalizado"), built from
 * report-template/quiron-report-prototype-v2.html.
 *
 * It renders ONE finalized report object (FinalReport). All customer-visible text comes from
 * buildReportContent(), the same source the PDF and the email use, so they cannot diverge.
 * Edit wording in src/lib/report-content.ts and layout/styles here and in ReportView.module.css.
 *
 * `mode="team"` adds the prototype's review annotations (source tags, AI/rules mix panel).
 * Customers always get `mode="client"` (the default).
 */
export type EmailStatusView = { state: PublicEmailState; to: string };

type ReportViewProps = {
  report: FinalReport;
  mode?: 'client' | 'team';
  /** Server PDF endpoint + access token. Without it (dev preview) the browser print dialog is used. */
  pdf?: { url: string; token: string } | null;
  /** Real delivery state of the report email; null/undefined hides the line. */
  email?: EmailStatusView | null;
};

const cx = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(' ');

function slug(text: string) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
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

function AiBox({ title, limit, text }: { title: string; limit: string; text: string }) {
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
          Origen del texto: <b>{aiUsed ? 'IA' : 'plantilla determinística (IA no disponible)'}</b>.
          La IA solo redacta; no calcula ni decide.
        </p>
      )}
    </div>
  );
}

function AreaCard({ area }: { area: AreaContent }) {
  return (
    <article className={s.area}>
      <div className={s.areaTop}>
        <h3>{area.title}</h3>
        <span className={cx(s.chip, area.solid && s.chipGreen)}>{area.statusLabel}</span>
      </div>
      <p>{area.description}</p>
      <span className={s.areaCount}>{area.countLabel}</span>
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

/** What the customer is told about the email, from the REAL delivery state. */
function emailMessage(email: EmailStatusView): { text: string; tone: 'ok' | 'wait' | 'error' } {
  switch (email.state) {
    case 'sending':
      return { text: `Enviando tu informe a ${email.to}…`, tone: 'wait' };
    case 'retrying':
      return {
        text: 'No pudimos enviar el correo todavía. Lo reintentaremos automáticamente; mientras tanto puedes descargar tu informe en PDF aquí.',
        tone: 'wait',
      };
    case 'sent':
    case 'delivered':
      return { text: `Informe enviado a ${email.to}`, tone: 'ok' };
    case 'bounced':
      return {
        text: `No se pudo entregar el correo a ${email.to}. Descarga tu informe en PDF aquí.`,
        tone: 'error',
      };
    default:
      return {
        text: 'No se pudo enviar el correo. Descarga tu informe en PDF aquí.',
        tone: 'error',
      };
  }
}

export default function ReportView({
  report,
  mode = 'client',
  pdf = null,
  email = null,
}: ReportViewProps) {
  const team = mode === 'team';
  const c = buildReportContent(report);
  const aiUsed = report.narrativeSource === 'ai';
  const { model } = report;
  const [activeId, setActiveId] = useState('resumen');
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState(false);

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

  async function downloadPdf() {
    if (!pdf) {
      // Development preview only: no stored report exists, so print the page instead.
      window.print();
      return;
    }
    setPdfBusy(true);
    setPdfError(false);
    try {
      // The PDF is rendered on the server from the stored finalized report.
      const response = await fetch(pdf.url, { headers: { 'x-report-token': pdf.token } });
      if (!response.ok) throw new Error('pdf');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `Diagnostico-Patrimonial-Quiron${report.firstName ? `-${slug(report.firstName)}` : ''}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setPdfError(true);
    } finally {
      setPdfBusy(false);
    }
  }

  const emailInfo = email && email.state !== 'off' ? emailMessage(email) : null;

  return (
    <ViewContext.Provider value={{ team, aiUsed }}>
      <div className={s.root}>
        <div className={s.actionbar}>
          {emailInfo && (
            <span
              className={cx(
                s.emailStatus,
                emailInfo.tone === 'ok' && s.emailOk,
                emailInfo.tone === 'error' && s.emailError,
              )}
              role="status"
            >
              {emailInfo.text}
            </span>
          )}
          {pdfError && (
            <span className={cx(s.emailStatus, s.emailError)} role="alert">
              No se pudo descargar el PDF. Intenta nuevamente.
            </span>
          )}
          <button type="button" className={s.pdfButton} onClick={downloadPdf} disabled={pdfBusy}>
            {pdfBusy ? 'Preparando PDF…' : 'Descargar PDF ↓'}
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
              {SECTION_NAV.map((section, i) => (
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
                  <i className={cx(s.dot, s.dotAi)} /> Morado · Espacio para IA
                </div>
                <div className={s.legendRow}>
                  <i className={cx(s.dot, s.dotStatic)} /> Gris · Interfaz fija
                </div>
              </div>
            )}
          </aside>

          <main className={s.paper} id="report">
            {/* Brand header: only visible in the print fallback (the site header is hidden there) */}
            <div className={s.printBrand}>
              <span className={s.printLogo}>
                <Image
                  src="/images/quiron-logo.png"
                  alt="Quirón Arquitectos Financieros"
                  width={151}
                  height={66}
                />
              </span>
              <span className={s.printBrandText}>{c.brand}</span>
            </div>

            {/* 00 · Resumen */}
            <section className={s.hero} id="resumen" data-report-section>
              <div className={s.eyebrow}>{c.hero.eyebrow}</div>
              <h1>{c.hero.title}</h1>
              <p className={s.lead}>{c.hero.lead}</p>
              <SourceLine
                kind="static"
                tag="INTERFAZ FIJA"
                note="Encabezado, contenido de marca y estructura del reporte."
              />
              <div className={s.meta}>
                {c.hero.meta.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
              <div className={s.scores}>
                <article className={s.scoreCard}>
                  <div className={s.scoreLabel}>{c.hero.score.label}</div>
                  <div className={s.scoreNumber}>{c.hero.score.value}</div>
                  <span className={cx(s.level, c.hero.score.levelTone === 'high' && s.levelGreen)}>
                    {c.hero.score.levelLabel}
                  </span>
                  <div
                    className={s.progress}
                    role="img"
                    aria-label={`${model.score.protection} por ciento`}
                  >
                    <div
                      className={s.progressFill}
                      style={{ width: `${model.score.protection}%` }}
                    />
                  </div>
                  <SourceLine
                    kind="det"
                    tag="REGLAS · SCORE"
                    note="Resultado y nivel calculados (mismos que el Dashboard)."
                  />
                </article>
                <article className={s.scoreCard}>
                  <div className={s.scoreLabel}>{c.hero.weak.label}</div>
                  <div className={s.scoreNumber}>
                    {c.hero.weak.value} <span className={s.scoreOf}>{c.hero.weak.of}</span>
                  </div>
                  <div className={s.scoreSub}>{c.hero.weak.sub}</div>
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
                num={c.executive.num}
                title={c.executive.title}
                sub={c.executive.sub}
              />
              <div className={s.contentPanel}>
                <h3>{c.executive.panelTitle}</h3>
                <div className={s.signalList}>
                  {c.executive.signals.map((signal) => (
                    <div className={s.signal} key={signal.label}>
                      <div className={s.signalLabel}>{signal.label}</div>
                      <strong>{signal.value}</strong>
                      <small>{signal.small}</small>
                    </div>
                  ))}
                </div>
                <SourceLine
                  kind="det"
                  tag="REGLAS · RESULTADOS"
                  note="Los datos y hallazgos proceden del motor, nunca de la IA."
                />
              </div>
              <AiBox
                title="Interpretación ejecutiva"
                limit={`Hasta ${MAX_SUMMARY_WORDS} palabras`}
                text={c.executive.summaryText}
              />
            </section>

            {/* 02 · Patrimonio personal */}
            <section className={s.section} id="personal" data-report-section>
              <SectionHeader num={c.personal.num} title={c.personal.title} sub={c.personal.sub} />
              <div className={s.areas}>
                {c.personal.areas.map((area) => (
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
              <SectionHeader num={c.business.num} title={c.business.title} sub={c.business.sub} />
              <div className={s.areas}>
                {c.business.areas.map((area) => (
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
                num={c.priorities.num}
                title={c.priorities.title}
                sub={c.priorities.sub}
              />
              <SourceLine
                kind="det"
                tag="REGLAS · RANKING"
                note="La IA no selecciona ni reordena ninguna prioridad."
              />
              {c.priorities.empty ? (
                <div className={s.allGood}>
                  <h3>{c.priorities.empty.title}</h3>
                  <p style={{ marginBottom: 0 }}>{c.priorities.empty.text}</p>
                </div>
              ) : (
                c.priorities.items.map((priority) => (
                  <article className={s.priority} key={priority.themeId}>
                    <div className={s.rank}>{priority.rank}</div>
                    <div>
                      <h3>{priority.title}</h3>
                      <p className={s.priorityLine}>
                        <b>{priority.findingLabel}</b> {priority.finding}
                      </p>
                      <p className={s.priorityLine}>
                        <b>{priority.actionLabel}</b> {priority.action}
                      </p>
                      <SourceLine kind="det" tag="REGLAS · HALLAZGO + ACCIÓN" />
                      <AiBox
                        title="Contexto breve para esta prioridad"
                        limit={`${MAX_CONTEXT_WORDS} palabras máx.`}
                        text={priority.context}
                      />
                    </div>
                  </article>
                ))
              )}
            </section>

            {/* 05 · Plan de acción + CTA */}
            <section className={s.section} id="plan" data-report-section>
              <SectionHeader num={c.plan.num} title={c.plan.title} sub={c.plan.sub} />
              <div className={s.timeline}>
                {c.plan.steps.map((step) => (
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
                <h3>{c.cta.title}</h3>
                <p>{c.cta.text}</p>
                {c.cta.url ? (
                  <a
                    className={s.ctaButton}
                    href={c.cta.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {c.cta.buttonLabel} ↗
                  </a>
                ) : (
                  <>
                    <button
                      type="button"
                      className={s.ctaButton}
                      disabled
                      aria-describedby="booking-unavailable"
                    >
                      {c.cta.buttonLabel} ↗
                    </button>
                    <small id="booking-unavailable" role="status" className={s.ctaNote}>
                      {c.cta.unavailableNote}
                    </small>
                  </>
                )}
                <SourceLine kind="static" tag="CTA FIJO" />
              </div>

              {/* How this report was produced (reflects what actually happened for this report) */}
              <div className={s.transparency}>
                <h3>{c.transparency.title}</h3>
                {c.transparency.aiUsed && (
                  <>
                    <MixBar />
                    <div className={s.legendInline}>
                      <span>
                        <i className={cx(s.dot, s.dotDet)} /> {c.transparency.mixLegend[0]}
                      </span>
                      <span>
                        <i className={cx(s.dot, s.dotStatic)} /> {c.transparency.mixLegend[1]}
                      </span>
                      <span>
                        <i className={cx(s.dot, s.dotAi)} /> {c.transparency.mixLegend[2]}
                      </span>
                    </div>
                  </>
                )}
                {c.transparency.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>

              <p className={s.legal}>{c.legal}</p>
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
                <h3>La IA solo llena {1 + model.priorities.length} espacios</h3>
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
                  Esta vista: texto {aiUsed ? 'generado por IA' : 'de plantilla (fallback)'}
                  {report.aiFailureReason ? ` · motivo: ${report.aiFailureReason}` : ''}.
                </p>
              </div>
            </aside>
          )}
        </div>
      </div>
    </ViewContext.Provider>
  );
}
