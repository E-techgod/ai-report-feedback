'use client';
import Image from 'next/image';
import Link from 'next/link';
import ReportView, { type PdfDownload } from '@/components/ReportView';
import { useRef, useState } from 'react';
import type { FinalReport } from '@/lib/final-report';
import { questions } from '@/lib/questions';
import { type Answers } from '@/lib/scoring';

export default function Home() {
  const [step, setStep] = useState(0);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [answers, setAnswers] = useState<Answers>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<FinalReport | null>(null);
  // Held in memory only (never localStorage): lost on reload, which ends the download session.
  const [download, setDownload] = useState<PdfDownload | null>(null);
  // One id per diagnosis so network retries/double clicks can't create duplicate rows.
  const submissionId = useRef<string | null>(null);
  const answered = Object.keys(answers).length;
  const current = questions.filter((q) => q.section === (step === 1 ? 'personal' : 'empresarial'));
  const canAdvance =
    step === 1
      ? questions.slice(0, 10).every((q) => q.id in answers)
      : questions.slice(10).every((q) => q.id in answers);
  function advance() {
    setError('');
    if (
      step === 0 &&
      (!firstName.trim() || !lastName.trim() || !/^\S+@\S+\.\S+$/.test(email) || !consent)
    ) {
      setError('Completa tus datos y acepta el aviso de privacidad para continuar.');
      return;
    }
    if ((step === 1 || step === 2) && !canAdvance) {
      setError('Responde todas las preguntas de esta sección.');
      return;
    }
    if (step < 2) setStep(step + 1);
  }
  async function submit() {
    setError('');
    if (!canAdvance || busy) return;
    setBusy(true);
    submissionId.current ??= crypto.randomUUID();
    const payload = {
      id: submissionId.current,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      answers,
      privacyAccepted: consent,
    };
    try {
      // The server saves the answers to the Sheet, generates the finalized report and issues a
      // 5-minute download grant. Safe to repeat: the same submission id never adds a second row.
      let response: Response | undefined;
      let data: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 12; attempt += 1) {
        response = await fetch('/api/questionnaire', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(75_000),
        });
        data = await response.json().catch(() => ({}));
        if (response.status === 409 && data.retry) {
          await new Promise((resolve) => setTimeout(resolve, 3000)); // same report is being prepared
          continue;
        }
        break;
      }
      if (!response?.ok || data.ok !== true) {
        // The server answered definitively. The id it knows may now belong to a saved row, and a known
        // id is always a duplicate, however long ago. So the next attempt (for example the "try again
        // in about 10 minutes" of saved_unconfirmed) must be a NEW submission. Network errors and
        // timeouts (no answer) keep the id, so a retry of those still never adds a second row.
        submissionId.current = null;
        throw new Error(
          typeof data.error === 'string' ? data.error : 'No se pudo generar el diagnóstico.',
        );
      }
      setReport(data.report as FinalReport);
      setDownload(data.download as PdfDownload);
      setStep(3);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(
        e instanceof Error && e.name !== 'TimeoutError' && e.name !== 'AbortError'
          ? e.message
          : 'El informe tardó más de lo esperado. Vuelve a intentarlo: tus respuestas no se perderán.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="header">
        <Link href="/" className="brand" aria-label="Quirón Arquitectos Financieros">
          <span className="brand-mark" style={{ width: 151, height: 66 }}>
            <Image
              src="/images/quiron-logo.png"
              alt="Quirón Arquitectos Financieros"
              width={151}
              height={66}
              priority
            />
          </span>
        </Link>
        <span className="header-note">Diagnóstico de Blindaje</span>
      </header>
      {step < 3 && (
        <main className="container">
          {step < 3 && (
            <>
              <div className="eyebrow">PATRIMONIO · PREVISIÓN · CONTINUIDAD</div>
              <h1>
                Protege lo que has <em>construido.</em>
              </h1>
              <p className="lead">
                Conoce qué tan preparado está tu patrimonio personal y empresarial a través de un
                diagnóstico de 20 preguntas.
              </p>
              <div className="progress-meta">
                <span>
                  {step === 0
                    ? 'Tus datos'
                    : step === 1
                      ? '01 / Patrimonio personal'
                      : '02 / Patrimonio empresarial'}
                </span>
                <span>{answered}/20 preguntas respondidas</span>
              </div>
              <div className="progress">
                <div style={{ width: `${answered * 5}%` }} />
              </div>
            </>
          )}
          {step === 0 && (
            <section className="panel">
              <div className="section-label">ANTES DE COMENZAR</div>
              <h2>Primero, nos presentamos</h2>
              <p className="muted">
                Usaremos tus datos para identificar tu diagnóstico y permitir el seguimiento de
                Quirón.
              </p>
              <div className="fields">
                <label>
                  Nombre
                  <input
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    maxLength={100}
                    autoComplete="given-name"
                    placeholder="Tu nombre"
                  />
                </label>
                <label>
                  Apellido
                  <input
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    maxLength={100}
                    autoComplete="family-name"
                    placeholder="Tu apellido"
                  />
                </label>
                <label className="wide">
                  Correo electrónico
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    maxLength={254}
                    autoComplete="email"
                    placeholder="nombre@ejemplo.com"
                  />
                </label>
              </div>
              <label className="consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  He leído el{' '}
                  <a
                    href="https://www.quirongroup.com/aviso-de-privacidad"
                    target="_blank"
                    rel="noreferrer"
                  >
                    aviso de privacidad
                  </a>{' '}
                  y acepto el tratamiento de mis datos para generar mi diagnóstico.
                </span>
              </label>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary" onClick={advance}>
                Comenzar diagnóstico <span>→</span>
              </button>
              <p className="fine">Tiempo estimado: 4–6 minutos · Sin costo</p>
            </section>
          )}
          {(step === 1 || step === 2) && (
            <section className="panel questions-panel">
              <div className="section-label">
                {step === 1
                  ? 'SECCIÓN A · PATRIMONIO PERSONAL'
                  : 'SECCIÓN B · PATRIMONIO EMPRESARIAL'}
              </div>
              <h2>{step === 1 ? 'Tu protección personal' : 'La continuidad de tu empresa'}</h2>
              <p className="muted">
                Selecciona Sí o No en cada pregunta. Todas tienen el mismo valor.
              </p>
              <div className="question-list">
                {current.map((q, i) => (
                  <article className="question" key={q.id}>
                    <div className="qnumber">{String(i + 1).padStart(2, '0')}</div>
                    <div className="qcontent">
                      <h3>{q.title}</h3>
                      {q.help && <p>{q.help}</p>}
                    </div>
                    <div className="answer">
                      <button
                        type="button"
                        className={answers[q.id] === true ? 'chosen' : ''}
                        aria-pressed={answers[q.id] === true}
                        onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: true }))}
                      >
                        Sí
                      </button>
                      <button
                        type="button"
                        className={answers[q.id] === false ? 'chosen' : ''}
                        aria-pressed={answers[q.id] === false}
                        onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: false }))}
                      >
                        No
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <div className="actions">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setError('');
                    setStep(step - 1);
                  }}
                >
                  ← Volver
                </button>
                <button
                  className="primary"
                  disabled={!canAdvance || busy}
                  onClick={step === 1 ? advance : submit}
                >
                  {step === 1
                    ? 'Continuar'
                    : busy
                      ? 'Procesando diagnóstico…'
                      : 'Ver mi diagnóstico'}{' '}
                  <span>→</span>
                </button>
              </div>
            </section>
          )}
        </main>
      )}
      {step === 3 && report && <ReportView report={report} pdf={download} />}
      {busy && (
        <div className="generating" role="status" aria-live="polite">
          <div className="generating-card">
            <span className="spinner" aria-hidden="true" />
            <h2>Estamos generando tu informe personalizado</h2>
            <p>Esto puede tardar hasta un minuto. Por favor no cierres esta página.</p>
          </div>
        </div>
      )}
      <footer>
        QUIRÓN · PROTECCIÓN PATRIMONIAL <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
