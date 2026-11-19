import test from 'node:test';
import assert from 'node:assert/strict';
import { logSecurityEvent, sanitizeFields, subjectFingerprint } from '../src/lib/security-log.ts';

const sink = () => {
  const out = { info: [], warn: [] };
  return {
    out,
    sink: { info: (l) => out.info.push(l), warn: (l) => out.warn.push(l) },
  };
};

test('events are one JSON line each, tagged with the app and the event name', () => {
  const { out, sink: s } = sink();
  logSecurityEvent('download_served', { grant: 'ab12cd34', ordinal: 2, limit: 5 }, s);
  logSecurityEvent('download_limit_reached', { grant: 'ab12cd34', limit: 5 }, s);
  assert.deepEqual(JSON.parse(out.info[0]), {
    app: 'bp-questionnaire',
    event: 'download_served',
    grant: 'ab12cd34',
    ordinal: 2,
    limit: 5,
  });
  assert.equal(out.warn.length, 1, 'refusals log at warn so they can be filtered');
});

test('only allow-listed fields are written', () => {
  assert.deepEqual(
    sanitizeFields({ email: 'a@b.com', answers: { A1: true }, token: 'x', reason: 'ok' }),
    {
      reason: 'ok',
    },
  );
});

test('anything that does not look like a short machine token is redacted, even in an allowed field', () => {
  for (const value of [
    'ana.perez@example.com',
    'Ana Pérez',
    '1731999999999.' + 'a'.repeat(64),
    'x'.repeat(65),
    '',
    'with space',
  ])
    assert.equal(sanitizeFields({ reason: value }).reason, '[redacted]', value);
  assert.equal(sanitizeFields({ reason: 'email_24h' }).reason, 'email_24h');
});

test('the subject fingerprint is a stable, keyed, non-reversible 10-hex tag', () => {
  const a = subjectFingerprint('Ana@Example.com ', 's'.repeat(32));
  assert.match(a, /^[0-9a-f]{10}$/);
  assert.equal(
    a,
    subjectFingerprint('ana@example.com', 's'.repeat(32)),
    'case and spacing do not matter',
  );
  assert.notEqual(
    a,
    subjectFingerprint('ana@example.com', 't'.repeat(32)),
    'depends on the secret',
  );
  assert.notEqual(a, subjectFingerprint('beto@example.com', 's'.repeat(32)));
  assert.ok(!a.includes('ana'));
});
