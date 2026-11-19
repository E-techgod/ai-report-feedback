import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  MailError,
  buildEmail,
  createResendMailer,
  parseWebhookEvent,
  pdfFilename,
  verifyWebhookSignature,
} from '../src/lib/email.ts';
import { sampleReport } from './helpers/fixtures.mjs';

const message = {
  to: 'cliente@example.com',
  subject: 's',
  html: '<p>x</p>',
  text: 'x',
  attachments: [{ filename: 'a.pdf', content: Buffer.from('%PDF') }],
  idempotencyKey: 'report-email/abc',
};

function mailer(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(calls.length);
  };
  return {
    calls,
    mailer: createResendMailer({ apiKey: 'k', from: 'Quirón <a@quirongroup.com>', fetchImpl }),
  };
}

test('email carries name, score, level, summary, booking link and the PDF attachment', async () => {
  const report = sampleReport({ source: 'ai' });
  const { subject, html, text } = buildEmail(report, { siteUrl: 'https://app.example.com/' });
  for (const part of [
    report.firstName,
    `${report.model.score.protection}%`,
    report.model.level,
    report.narrative.executiveSummary,
    report.bookingUrl,
  ]) {
    assert.ok(html.includes(part), `html missing ${part}`);
    assert.ok(text.includes(part) || subject.includes(part), `text missing ${part}`);
  }
  assert.ok(html.includes('https://app.example.com/images/quiron-logo.png'));
  const { calls, mailer: m } = mailer(
    () => new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }),
  );
  assert.deepEqual(await m.send(message), { messageId: 'em_1' });
  assert.equal(calls[0].body.to.length, 1);
  assert.equal(calls[0].body.attachments[0].content, Buffer.from('%PDF').toString('base64'));
  assert.equal(calls[0].init.headers['idempotency-key'], 'report-email/abc');
  assert.equal(calls[0].init.headers.authorization, 'Bearer k');
});

test('email escapes HTML in user-controlled names and omits the button without a booking URL', () => {
  const evil = sampleReport({ bookingUrl: null });
  const report = { ...evil, firstName: '<script>alert(1)</script>' };
  const { html } = buildEmail(report);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&#60;script&#62;'));
  assert.ok(!html.includes('href="https://example.com'));
  assert.match(html, /no está disponible/);
});

test('pdf filename is ASCII-safe', () => {
  assert.equal(pdfFilename('José Ángel'), 'Diagnostico-Patrimonial-Quiron-Jose-Angel.pdf');
  assert.equal(pdfFilename(''), 'Diagnostico-Patrimonial-Quiron.pdf');
});

test('provider errors are classified as retryable or permanent', async () => {
  const outcomes = {
    429: true,
    500: true,
    503: true,
    409: true,
    400: false,
    401: false,
    403: false,
    422: false,
  };
  for (const [status, retryable] of Object.entries(outcomes)) {
    const { mailer: m } = mailer(() => new Response('{}', { status: Number(status) }));
    await assert.rejects(
      () => m.send(message),
      (e) =>
        e instanceof MailError &&
        e.retryable === retryable &&
        e.message === `resend-http-${status}`,
    );
  }
  const network = createResendMailer({
    apiKey: 'k',
    from: 'a@b.com',
    fetchImpl: async () => {
      throw new Error('ECONNRESET secret-token');
    },
  });
  await assert.rejects(
    () => network.send(message),
    (e) => e.retryable === true && !/secret/.test(e.message),
  );
});

const secret = 'whsec_' + Buffer.from('super-secret-key').toString('base64');
const sign = (id, ts, body) =>
  'v1,' +
  createHmac('sha256', Buffer.from('super-secret-key'))
    .update(`${id}.${ts}.${body}`)
    .digest('base64');

test('webhook signatures: valid, tampered, stale and multi-signature', () => {
  const now = new Date('2026-11-18T15:00:00Z');
  const ts = String(Math.floor(now.getTime() / 1000));
  const body = '{"type":"email.delivered"}';
  const base = { body, id: 'msg_1', timestamp: ts, secret, now };
  assert.equal(verifyWebhookSignature({ ...base, signature: sign('msg_1', ts, body) }), true);
  assert.equal(
    verifyWebhookSignature({ ...base, signature: `v1,AAAA ${sign('msg_1', ts, body)}` }),
    true,
  );
  assert.equal(
    verifyWebhookSignature({ ...base, body: body + ' ', signature: sign('msg_1', ts, body) }),
    false,
  );
  assert.equal(verifyWebhookSignature({ ...base, signature: null }), false);
  const old = String(Number(ts) - 3600);
  assert.equal(
    verifyWebhookSignature({ ...base, timestamp: old, signature: sign('msg_1', old, body) }),
    false,
  );
  assert.equal(
    verifyWebhookSignature({
      ...base,
      secret: 'whsec_' + Buffer.from('other').toString('base64'),
      signature: sign('msg_1', ts, body),
    }),
    false,
  );
});

test('webhook payload mapping', () => {
  assert.deepEqual(parseWebhookEvent('{"type":"email.bounced","data":{"email_id":"em_9"}}'), {
    messageId: 'em_9',
    event: 'bounced',
  });
  assert.deepEqual(parseWebhookEvent('{"type":"email.delivered","data":{"email_id":"em_9"}}'), {
    messageId: 'em_9',
    event: 'delivered',
  });
  assert.equal(parseWebhookEvent('{"type":"email.opened","data":{"email_id":"em_9"}}'), null);
  assert.equal(parseWebhookEvent('not json'), null);
});
