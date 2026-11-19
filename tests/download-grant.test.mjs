import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOWNLOAD_WINDOW_MS,
  issueDownloadGrant,
  verifyDownloadGrant,
} from '../src/lib/download-grant.ts';
import { sampleReport } from './helpers/fixtures.mjs';

const SECRET = 's'.repeat(32);
const T0 = new Date('2026-11-19T12:00:00Z');
const at = (ms) => new Date(T0.getTime() + ms);

test('the window is exactly five minutes', () => {
  const grant = issueDownloadGrant(sampleReport(), SECRET, T0);
  assert.equal(DOWNLOAD_WINDOW_MS, 300_000);
  assert.equal(grant.expiresInMs, 300_000);
  assert.equal(grant.expiresAt, T0.getTime() + 300_000);
});

test('a grant verifies repeatedly until the deadline, then expires', () => {
  const report = sampleReport();
  const { token } = issueDownloadGrant(report, SECRET, T0);
  for (const offset of [0, 1_000, 60_000, 299_999])
    assert.equal(verifyDownloadGrant(report, token, SECRET, at(offset)), 'ok');
  assert.equal(verifyDownloadGrant(report, token, SECRET, at(300_000)), 'expired');
  assert.equal(verifyDownloadGrant(report, token, SECRET, at(3_600_000)), 'expired');
});

test('the token carries no report content', () => {
  const report = sampleReport();
  const { token } = issueDownloadGrant(report, SECRET, T0);
  assert.match(token, /^\d+\.[0-9a-f]{64}$/);
  assert.ok(!token.includes(report.reportId));
  assert.ok(!token.includes(report.firstName));
});

test('tampered tokens are rejected, including a forged later expiry', () => {
  const report = sampleReport();
  const { token } = issueDownloadGrant(report, SECRET, T0);
  const [exp, sig] = token.split('.');
  const flipped = `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`;
  const forgedExpiry = `${Number(exp) + 24 * 3_600_000}.${sig}`;
  for (const bad of [
    `${exp}.${flipped}`,
    forgedExpiry,
    `${exp}.`,
    `.${sig}`,
    exp,
    sig,
    '',
    'not-a-token',
    `${exp}.${sig}.extra`,
    `-1.${sig}`,
  ])
    assert.equal(verifyDownloadGrant(report, bad, SECRET, at(1_000)), 'invalid', bad);
});

test('a forged extension of an already expired grant stays invalid, not ok', () => {
  const report = sampleReport();
  const { token } = issueDownloadGrant(report, SECRET, T0);
  const [exp, sig] = token.split('.');
  const extended = `${Number(exp) + 600_000}.${sig}`;
  assert.equal(verifyDownloadGrant(report, extended, SECRET, at(400_000)), 'invalid');
});

test('a grant only works for the report it was issued for', () => {
  const mine = sampleReport();
  const theirs = sampleReport();
  const { token } = issueDownloadGrant(mine, SECRET, T0);
  assert.equal(verifyDownloadGrant(theirs, token, SECRET, at(1_000)), 'invalid');
  // Same submission, edited content (e.g. a changed narrative) also fails.
  const edited = {
    ...mine,
    narrative: { ...mine.narrative, executiveSummary: 'Texto distinto.' },
  };
  assert.equal(verifyDownloadGrant(edited, token, SECRET, at(1_000)), 'invalid');
});

test('a grant signed with another secret is rejected', () => {
  const report = sampleReport();
  const { token } = issueDownloadGrant(report, 'x'.repeat(32), T0);
  assert.equal(verifyDownloadGrant(report, token, SECRET, at(1_000)), 'invalid');
});

test('a second instance verifies with the secret alone (no shared state)', () => {
  const report = sampleReport();
  const { token } = issueDownloadGrant(report, SECRET, T0);
  // Round-trip through JSON, as the report travels browser -> any function instance.
  const received = JSON.parse(JSON.stringify(report));
  assert.equal(verifyDownloadGrant(received, token, SECRET, at(120_000)), 'ok');
});
