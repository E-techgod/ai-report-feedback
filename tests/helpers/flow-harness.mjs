import { randomUUID } from 'node:crypto';
import { answersOf, SAMPLE_YES } from './fixtures.mjs';

export const T0 = new Date('2026-11-19T12:00:00Z').getTime();

/** Deterministic dependencies for generateReport / handleQuestionnaire. No database, no mailer. */
export function reportDeps({ narrative } = {}) {
  const clock = { t: T0 };
  const narrativeCalls = [];
  return {
    clock,
    narrativeCalls,
    deps: {
      now: () => new Date(clock.t),
      bookingUrl: 'https://example.com/cita',
      generateNarrative:
        narrative ??
        (async (model) => {
          narrativeCalls.push(model);
          return {
            narrative: {
              executiveSummary: 'Texto redactado por IA.',
              // Short AI text, as the prompt limits require (<= 15% of the visible words).
              priorityContexts: model.priorities.map(() => 'Contexto breve.'),
            },
            source: 'ai',
            failureReason: null,
          };
        }),
    },
  };
}

export const submission = (over = {}) => ({
  id: randomUUID(),
  firstName: 'Ana',
  lastName: 'Pérez',
  email: 'Ana.Perez@Example.com',
  privacyAccepted: true,
  answers: answersOf(SAMPLE_YES),
  ...over,
});
