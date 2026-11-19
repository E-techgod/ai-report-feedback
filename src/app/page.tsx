'use client';
import Image from 'next/image';
import Link from 'next/link';
import ReportView, { type Report } from '@/components/ReportView';
import { useRef, useState } from 'react';
import { questions } from '@/lib/questions';
import { type Answers } from '@/lib/scoring';
import { buildReportModel, fallbackNarrative } from '@/lib/report';

export default function Home() {
  const [step, setStep] = useState(0);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [answers, setAnswers] = useState<Answers>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [aiPending, setAiPending] = useState(false);
  const [generatedAt, setGeneratedAt] = useState('');
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
      const saved = await fetch('/api/questionnaire', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await saved.json();
      if (!saved.ok || !data.ok)
        throw new Error(data.error || 'No se pudo guardar el diagnóstico.');
      // 1) Deterministic report (rules engine) + template text: shown immediately.
      const model = buildReportModel(answers);
      setReport({ model, narrative: fallbackNarrative(model), aiUsed: false });
      setGeneratedAt(new Date().toISOString());
      setAiPending(true);
      setStep(3);
      window.scrollTo({ top: 0 });
      // 2) Optional AI wording for the 4 text slots; the template text stays if anything fails.
      try {
        const ai = await fetch('/api/summary', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (ai.ok) {
          const result = await ai.json();
          const contexts: unknown = result.priorityContexts;
          if (
            typeof result.executiveSummary === 'string' &&
            Array.isArray(contexts) &&
            contexts.length === model.priorities.length &&
            contexts.every((c) => typeof c === 'string')
          ) {
            setReport({
              model,
              narrative: {
                executiveSummary: result.executiveSummary,
                priorityContexts: contexts as string[],
              },
              aiUsed: result.ai === true,
            });
          }
        }
      } catch {
        /* deterministic template text stays visible */
      } finally {
        setAiPending(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ocurrió un error.');
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
      {step === 3 && report && (
        <ReportView
          report={report}
          firstName={firstName}
          generatedAt={generatedAt}
          aiPending={aiPending}
        />
      )}
      <footer>
        QUIRÓN · PROTECCIÓN PATRIMONIAL <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
