import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG } from '../../src/lib/pipeline.ts';
import { fallbackNarrative } from '../../src/lib/report.ts';
import { answersOf, freshStore, SAMPLE_YES } from './fixtures.mjs';

export const T0 = new Date('2026-11-18T15:00:00Z').getTime();

export function harness({
  narrative,
  mailerBehavior,
  emailEnabled = true,
  withMailer = true,
} = {}) {
  const clock = { t: T0 };
  const sent = [];
  let calls = 0;
  const narrativeCalls = [];
  const mailer = withMailer
    ? {
        async send(message) {
          if (mailerBehavior) await mailerBehavior(message, calls++);
          sent.push(message);
          return { messageId: `em_${sent.length}` };
        },
      }
    : null;
  return {
    clock,
    sent,
    narrativeCalls,
    async build() {
      const store = await freshStore();
      const deps = {
        store,
        mailer,
        now: () => new Date(clock.t),
        generateNarrative:
          narrative ??
          (async (model) => {
            narrativeCalls.push(model);
            return {
              narrative: {
                ...fallbackNarrative(model),
                executiveSummary: 'Texto redactado por Claude.',
              },
              source: 'ai',
              failureReason: null,
            };
          }),
        renderPdf: async () => Buffer.from('%PDF-fake'),
        config: {
          ...DEFAULT_CONFIG,
          bookingUrl: 'https://example.com/cita',
          emailEnabled,
          siteUrl: null,
        },
      };
      return { store, deps };
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
