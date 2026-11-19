import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardReady, eligibleForCutover } from '../scripts/requeue-disabled-reports.ts';

const since = new Date('2026-11-18T14:00:00Z');
const until = new Date('2026-11-18T16:00:00Z');
const now = new Date('2026-11-18T17:00:00Z');
const base = {
  emailStatus: 'disabled',
  emailAttempts: 0,
  emailAcceptedAt: null,
  emailProviderMessageId: null,
  createdAt: new Date('2026-11-18T15:00:00Z'),
};

test('only never-attempted disabled reports inside the cutover window qualify for Sheet audit', () => {
  assert.equal(eligibleForCutover(base, since, until, now), 'eligible');
  assert.equal(
    eligibleForCutover({ ...base, emailStatus: 'pending' }, since, until, now),
    'already-queued',
  );
  assert.equal(eligibleForCutover({ ...base, emailAttempts: 1 }, since, until, now), 'reject');
  assert.equal(eligibleForCutover({ ...base, emailAcceptedAt: now }, since, until, now), 'reject');
  assert.equal(
    eligibleForCutover({ ...base, createdAt: new Date('2026-11-17T15:00:00Z') }, since, until, now),
    'reject',
  );
});

test('Dashboard H must be blank and Dashboard B must match before re-queue', () => {
  assert.equal(dashboardReady({ email: 'A@B.COM', status: '' }, 'a@b.com'), true);
  assert.equal(dashboardReady({ email: 'a@b.com', status: 'Enviado' }, 'a@b.com'), false);
  assert.equal(dashboardReady({ email: 'other@b.com', status: '' }, 'a@b.com'), false);
});
