import test from 'node:test';
import { readFileSync } from 'node:fs';
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
import { buildReportContent } from '../src/lib/report-content.ts';
import { questionIds } from '../src/lib/questions.ts';
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

test('email carries name, score, level, booking link and the PDF attachment', async () => {
  const report = sampleReport({ source: 'ai' });
  const { subject, html, text } = buildEmail(report, { siteUrl: 'https://app.example.com/' });
  for (const part of [
    report.firstName,
    `${report.model.score.protection}%`,
    report.model.level,
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

function plain(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ');
}

test('email is a concise summary: finding, priority area and next step come from the top stored priority', () => {
  const report = sampleReport({ source: 'ai' });
  const top = buildReportContent(report).priorities.items[0];
  assert.ok(top, 'fixture must have a priority');
  const { html, text } = buildEmail(report, { attachmentName: 'Informe.pdf' });
  const flat = plain(html);
  for (const [label, value] of [
    ['Tu principal hallazgo:', top.finding],
    ['Área prioritaria:', top.title],
    ['Siguiente paso:', top.action],
  ]) {
    assert.ok(flat.includes(`${label} ${value}`), `html missing "${label} ${value}"`);
    assert.ok(text.includes(`${label} ${value}`), `text missing "${label} ${value}"`);
  }
  // Greeting, attachment notice and appointment invitation, in both versions.
  for (const part of [`Hola, ${report.firstName}.`, 'Informe completo adjunto']) {
    assert.ok(flat.includes(part), `html missing ${part}`);
    assert.ok(text.includes(part), `text missing ${part}`);
  }
  assert.ok(flat.includes('Informe.pdf') && text.includes('Informe.pdf'));
  assert.ok(html.includes(`href="${report.bookingUrl}"`));
  assert.ok(text.includes(`Agenda una asesoría con Quirón: ${report.bookingUrl}`));
  // Concise: only the top priority, not the full priority list or the 5-step plan.
  const second = buildReportContent(report).priorities.items[1];
  if (second) assert.ok(!text.includes(second.finding));
  assert.ok(text.length < 1800, `plain text should stay short, was ${text.length}`);
});

test('email never claims AI authorship, for AI-written and for template reports', () => {
  for (const source of ['ai', 'template']) {
    const { html, text } = buildEmail(sampleReport({ source }));
    for (const body of [plain(html), text]) {
      assert.doesNotMatch(body, /inteligencia artificial|\bIA\b|Claude|redactad[oa] con/i, source);
    }
  }
});

test('with no weak areas the email uses the report\'s own "nothing to strengthen" message', () => {
  const report = sampleReport({ yes: questionIds });
  const c = buildReportContent(report);
  assert.equal(c.priorities.items.length, 0);
  const { html, text } = buildEmail(report);
  assert.ok(text.includes(`Tu principal hallazgo: ${c.priorities.empty.title}`));
  assert.ok(text.includes(`Siguiente paso: ${c.priorities.empty.text}`));
  assert.ok(!text.includes('Área prioritaria:') && !html.includes('Área prioritaria:'));
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

test('redesigned email follows the report structure and takes every value from the stored report', () => {
  const report = sampleReport({ source: 'ai' });
  const c = buildReportContent(report);
  const { html } = buildEmail(report, {
    siteUrl: 'https://app.example.com',
    attachmentName: 'Informe.pdf',
  });
  const flat = plain(html);
  const order = [
    'Tu diagnóstico patrimonial está listo',
    `Hola, ${report.firstName}.`,
    c.hero.score.label,
    c.hero.score.value,
    `${c.hero.weak.value} ${c.hero.weak.of}`,
    c.hero.weak.label,
    c.hero.score.levelLabel,
    'Tu principal hallazgo:',
    'Área prioritaria:',
    'Siguiente paso:',
    'Informe completo adjunto',
    'Informe.pdf',
    'Agendar asesoría personalizada',
    c.legal,
  ];
  let at = -1;
  for (const part of order) {
    const found = flat.indexOf(part, at + 1);
    assert.ok(found >= 0, `missing or out of order: ${part}`);
    at = found;
  }
  assert.ok(html.includes('https://app.example.com/images/quiron-logo.png'));
  // White editorial layout with a black field for the white-lettered logo.
  for (const color of ['#000000', '#ffffff', '#171717', '#777777', '#e6e6e6', '#d95d1e']) {
    assert.ok(html.includes(color), `palette colour ${color} missing`);
  }
  assert.doesNotMatch(html, /#16171a|#1d1e22|#34363c/);
  assert.ok(html.includes(`width="${report.model.score.protection}%"`));
  assert.ok(html.includes(`href="${report.bookingUrl}"`));
});

test('email html is email-safe: table layout, inline styles, no scripts, flex/grid or remote CSS', () => {
  const { html } = buildEmail(sampleReport({ source: 'ai' }), { siteUrl: 'https://a.example' });
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /@media only screen and \(max-width:620px\)/);
  assert.ok(html.length < 100_000, 'Gmail clips messages over ~102KB');
  assert.doesNotMatch(
    html,
    /<script|<link|@import|display:\s*(flex|grid)|position:\s*(absolute|fixed)|var\(--/i,
  );
  assert.doesNotMatch(html, /url\(/i);
  assert.equal([...html.matchAll(/<img /g)].length, 1);
  assert.match(html, /<img [^>]*alt="Quirón"/);
  assert.match(html, /<table role="presentation"/);
});

test('every user-controlled value is escaped, including the attachment name and booking URL', () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const report = {
    ...sampleReport({ bookingUrl: `https://e.example/?a=1&b="${evil}` }),
    firstName: evil,
  };
  const { html } = buildEmail(report, {
    siteUrl: `https://a.example/${evil}`,
    attachmentName: `${evil}.pdf`,
  });
  assert.doesNotMatch(html, /<img src=x|onerror=alert\(1\)>/);
  assert.ok(html.includes('&#60;img src=x onerror=alert(1)&#62;'));
});

test('missing or extreme fields never break the layout', () => {
  const base = sampleReport({ source: 'ai' });
  // no logo origin: text wordmark instead of a broken image
  const noLogo = buildEmail(base).html;
  assert.ok(!noLogo.includes('<img') && noLogo.includes('QUIRÓN'));
  // empty first name falls back like the subject does
  const noName = buildEmail({ ...base, firstName: '' });
  assert.ok(noName.html.includes('Hola, cliente.'));
  // no booking URL: no link at all, only the report's own note
  const noUrl = buildEmail({ ...base, bookingUrl: null }).html;
  assert.ok(!noUrl.includes('href=') && !noUrl.includes('Agendar asesoría personalizada'));
  // the progress bar never leaves 0-100 or renders a NaN width: [stored value, fill %, track %]
  for (const [protection, fill, track] of [
    [0, null, 100],
    [64, 64, 36],
    [100, 100, null],
    [140, 100, null],
    [-5, null, 100],
    [Number.NaN, null, 100],
  ]) {
    const score = { ...base.model.score, protection };
    const { html: bar } = buildEmail({ ...base, model: { ...base.model, score } });
    assert.doesNotMatch(bar, /width="(NaN|-)/);
    const fillCell = bar.match(/<td width="(\d+)%" bgcolor="#d95d1e"/);
    const trackCell = bar.match(/<td width="(\d+)%" bgcolor="#ededed"/);
    assert.equal(fillCell && Number(fillCell[1]), fill, `fill for ${protection}`);
    assert.equal(trackCell && Number(trackCell[1]), track, `track for ${protection}`);
  }
  // long unbroken text wraps instead of widening the table
  const long = { ...base, firstName: 'A'.repeat(100) };
  const { html } = buildEmail(long, { attachmentName: `${'B'.repeat(120)}.pdf` });
  assert.ok(html.includes('A'.repeat(100)) && html.includes('B'.repeat(120)));
  assert.ok(html.split('overflow-wrap:anywhere').length > 5);
  assert.doesNotMatch(html, /white-space:\s*nowrap/);
});

test('pdf filename is ASCII-safe', () => {
  assert.equal(pdfFilename('José Ángel'), 'Diagnostico-Patrimonial-Quiron-Jose-Angel.pdf');
  assert.equal(pdfFilename(''), 'Diagnostico-Patrimonial-Quiron.pdf');
});

test("a permanent provider error keeps Resend's error name; retryable ones and unsafe names stay bare", async () => {
  const send = async (status, body) => {
    const { mailer: m } = mailer(() => new Response(body, { status }));
    return m.send(message).catch((e) => e);
  };
  const named = await send(
    403,
    JSON.stringify({
      name: 'validation_error',
      message: 'You can only send testing emails to your own email address (someone@example.com).',
    }),
  );
  assert.equal(named.message, 'resend-http-403:validation_error');
  assert.equal(named.retryable, false);
  assert.doesNotMatch(named.message, /someone|example\.com|testing/);
  assert.equal(
    (await send(403, JSON.stringify({ name: 'invalid_api_key' }))).message,
    'resend-http-403:invalid_api_key',
  );
  // retryable statuses are never decorated: 'resend-http-409' must stay an exact AMBIGUOUS_ERRORS match
  for (const status of [409, 429, 500, 503])
    assert.equal(
      (await send(status, JSON.stringify({ name: 'concurrent_idempotent_requests' }))).message,
      `resend-http-${status}`,
    );
  // anything that is not a short snake_case name is ignored
  for (const body of [
    'not json',
    '{}',
    '{"name":42}',
    '{"name":"Has Spaces"}',
    '{"name":"a@b.com"}',
    `{"name":"${'x'.repeat(60)}"}`,
    '',
  ])
    assert.equal((await send(403, body)).message, 'resend-http-403', body);
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

const LOGO_PNG = new URL('../public/images/quiron-logo.png', import.meta.url);
const logoTag = (html) => html.match(/<img [^>]*>/)?.[0] ?? '';

test('the logo is the existing PNG as an absolute HTTPS <img> with its aspect ratio preserved', () => {
  const png = readFileSync(LOGO_PNG);
  assert.equal(png.subarray(1, 4).toString(), 'PNG', 'public/images/quiron-logo.png is a PNG');
  const [pxWidth, pxHeight] = [png.readUInt32BE(16), png.readUInt32BE(20)];

  const { html } = buildEmail(sampleReport({ source: 'ai' }), {
    siteUrl: 'https://app.example.com/',
  });
  const tag = logoTag(html);
  assert.match(tag, /^<img src="https:\/\/app\.example\.com\/images\/quiron-logo\.png" /);
  assert.match(tag, / alt="Quirón" /);
  const width = Number(tag.match(/ width="(\d+)"/)?.[1]);
  const height = Number(tag.match(/ height="(\d+)"/)?.[1]);
  assert.ok(width >= 100 && width <= 200, `display width ${width}px suits a 640px email`);
  assert.ok(
    Math.abs(height - (width * pxHeight) / pxWidth) <= 1,
    `${width}x${height} keeps the ${pxWidth}x${pxHeight} ratio`,
  );
  // Email-compatible inline styles: block image, no border, fluid height, never wider than its cell.
  for (const rule of [
    'display:block',
    'border:0',
    `width:${width}px`,
    'max-width:100%',
    'height:auto',
  ])
    assert.ok(tag.includes(rule), `inline style ${rule}`);
  // Plain <img>: no Next.js Image output, no relative, localhost or filesystem source.
  assert.doesNotMatch(tag, /srcset|_next\/image|loading=|decoding=|data-nimg/i);
  assert.equal(
    [...html.matchAll(/src="([^"]+)"/g)].every(([, src]) => src.startsWith('https://')),
    true,
  );
  assert.doesNotMatch(html, /localhost|127\.0\.0\.1|file:|src="\//);
  // The old text wordmark is only a fallback, never rendered next to the image.
  assert.ok(!html.includes('QUIRÓN<span'));
});

test('only a public HTTPS site URL produces an image; anything else uses the text fallback', () => {
  const report = sampleReport({ source: 'ai' });
  for (const siteUrl of [
    null,
    '',
    'http://app.example.com',
    'https://localhost:3000',
    'http://localhost:3000',
    'https://127.0.0.1',
    'https://192.168.1.20',
    'https://intranet',
    '/images/quiron-logo.png',
    'images/quiron-logo.png',
    'file:///Users/me/quiron-logo.png',
    'javascript:alert(1)',
    'https://user:pass@app.example.com',
  ]) {
    const { html } = buildEmail(report, { siteUrl });
    assert.ok(!html.includes('<img'), `no image for ${JSON.stringify(siteUrl)}`);
    assert.ok(html.includes('QUIRÓN'), 'text fallback keeps a brand mark');
  }
  // A path or trailing slash on the configured URL never leaks into the image URL.
  const { html } = buildEmail(report, { siteUrl: 'https://app.example.com/some/path/' });
  assert.match(logoTag(html), /src="https:\/\/app\.example\.com\/images\/quiron-logo\.png"/);
});
