'use client';
import { useEffect, useMemo, useState } from 'react';
import ReportView, { type PdfDownload } from '@/components/ReportView';
import { getBookingUrl } from '@/lib/booking';
import type { FinalReport } from '@/lib/final-report';
import { questions } from '@/lib/questions';
import { buildReportModel, fallbackNarrative } from '@/lib/report';

/** Sample answer sets: the first `yes` ids (in question order) are "Si", the rest "No". */
const PRESETS = [
  {
    label: '55% · Bajo (11 Sí)',
    yes: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B5'],
  },
  { label: '0% · Muy bajo', yes: [] as string[] },
  { label: '60% · Medio', yes: questions.slice(0, 12).map((q) => q.id) },
  { label: '90% · Alto', yes: questions.slice(0, 18).map((q) => q.id) },
  { label: '100% · Excelente', yes: questions.map((q) => q.id) },
];

/** Download-window states for the PDF button (the preview token is fake: the server would refuse it). */
const DOWNLOAD_STATES: Array<{ label: string; value: PdfDownload | null }> = [
  { label: 'Descarga: vista previa (imprimir)', value: null },
  { label: 'Descarga: ventana de 5 min', value: { token: 'preview', expiresInMs: 300_000 } },
  { label: 'Descarga: expira en 4 s', value: { token: 'preview', expiresInMs: 4_000 } },
];

const SAMPLE_AI_SUMMARY =
  'El resultado preliminar muestra áreas de protección que conviene atender de forma ordenada. La planeación sucesoria destaca entre los puntos a revisar, junto con la protección familiar y la organización documental. Estos indicadores no equivalen a una valoración definitiva: sirven como punto de partida para contrastar tu situación con documentación vigente y definir acciones concretas con un especialista.';

export default function PreviewClient() {
  const [preset, setPreset] = useState(0);
  const [team, setTeam] = useState(true);
  const [simulateAi, setSimulateAi] = useState(false);
  const [downloadIdx, setDownloadIdx] = useState(0);

  // Optional URL parameters, e.g. /report-preview?view=client&ai=1&preset=2
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('view') === 'client') setTeam(false);
    if (q.get('ai') === '1') setSimulateAi(true);
    const d = Number(q.get('download'));
    if (Number.isInteger(d) && d >= 0 && d < DOWNLOAD_STATES.length) setDownloadIdx(d);
    const n = Number(q.get('preset'));
    if (Number.isInteger(n) && n >= 0 && n < PRESETS.length) setPreset(n);
  }, []);

  const report = useMemo(() => {
    const yes = new Set(PRESETS[preset].yes);
    const answers = Object.fromEntries(questions.map((q) => [q.id, yes.has(q.id)]));
    const model = buildReportModel(answers);
    const fallback = fallbackNarrative(model);
    // Built by hand: the server-side builder (final-report.ts) uses node:crypto.
    const finalReport: FinalReport = {
      version: 1,
      reportId: '00000000-0000-4000-8000-000000000001',
      submissionId: '00000000-0000-4000-8000-000000000002',
      firstName: 'Ana',
      generatedAt: '2026-11-18T18:00:00Z',
      model,
      narrative: simulateAi
        ? {
            ...fallback,
            executiveSummary: model.priorities.length
              ? SAMPLE_AI_SUMMARY
              : fallback.executiveSummary,
          }
        : fallback,
      narrativeSource: simulateAi ? 'ai' : 'template',
      aiFailureReason: simulateAi ? null : 'preview',
      bookingUrl: getBookingUrl(process.env.NEXT_PUBLIC_BOOKING_URL),
    };
    return finalReport;
  }, [preset, simulateAi]);

  const btn = (on: boolean) => ({
    border: '1px solid #1b6246',
    background: on ? '#143b2c' : '#fff',
    color: on ? '#fff' : '#143b2c',
    borderRadius: 8,
    padding: '7px 12px',
    font: 'inherit',
    fontSize: 12,
    cursor: 'pointer',
  });

  return (
    <div style={{ background: '#f4f3ee', minHeight: '100vh' }}>
      <div
        className="preview-controls"
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          padding: '12px 16px',
          background: '#102b21',
        }}
      >
        <strong style={{ color: '#d9f5e3', fontSize: 12, alignSelf: 'center', marginRight: 8 }}>
          VISTA PREVIA (solo desarrollo)
        </strong>
        {PRESETS.map((p, i) => (
          <button key={p.label} style={btn(i === preset)} onClick={() => setPreset(i)}>
            {p.label}
          </button>
        ))}
        <button style={btn(team)} onClick={() => setTeam(!team)}>
          {team ? '● Vista del equipo' : '○ Vista del cliente'}
        </button>
        <button style={btn(simulateAi)} onClick={() => setSimulateAi(!simulateAi)}>
          {simulateAi ? 'Texto IA simulado' : 'Texto de plantilla'}
        </button>
        <button
          style={btn(downloadIdx > 0)}
          onClick={() => setDownloadIdx((downloadIdx + 1) % DOWNLOAD_STATES.length)}
        >
          {DOWNLOAD_STATES[downloadIdx].label}
        </button>
      </div>
      <ReportView
        // Remounts per state so each choice restarts its own countdown.
        key={downloadIdx}
        report={report}
        mode={team ? 'team' : 'client'}
        pdf={DOWNLOAD_STATES[downloadIdx].value}
      />
    </div>
  );
}
