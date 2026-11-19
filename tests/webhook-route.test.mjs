import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleResendWebhook } from '../src/lib/resend-webhook-handler.ts';

const key = Buffer.from('isolated-webhook-test-key');
const secret = `whsec_${key.toString('base64')}`;

function signedRequest(messageId = 'em_1') {
  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: messageId } });
  const id = 'webhook-test-1';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
  return new Request('https://example.com/api/webhooks/resend', {
    method: 'POST',
    headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature },
    body,
  });
}

test('webhook acknowledges persisted delivery before slow Sheet synchronization starts', async () => {
  const calls = [];
  const tasks = [];
  let release;
  let syncStarted = false;
  const deps = {
    store: {
      async applyProviderEvent(id, event) {
        calls.push([id, event]);
        return true;
      },
      async getByProviderMessageId() {
        return { id: 'report-1' };
      },
    },
    syncTracking() {
      syncStarted = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const response = await handleResendWebhook(signedRequest(), deps, secret, (task) =>
    tasks.push(task),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [['em_1', 'delivered']]);
  assert.equal(syncStarted, false);
  assert.equal(tasks.length, 1);
  const pending = tasks[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(syncStarted, true);
  release(true);
  await pending;
});

test('unknown message ID returns retryable 404 without scheduling a Sheet write', async () => {
  const tasks = [];
  const deps = {
    store: {
      async applyProviderEvent() {
        return false;
      },
    },
    syncTracking: async () => true,
  };
  const response = await handleResendWebhook(signedRequest('unknown'), deps, secret, (task) =>
    tasks.push(task),
  );
  assert.equal(response.status, 404);
  assert.equal(tasks.length, 0);
});

test('invalid webhook signature cannot persist an event or schedule tracking', async () => {
  let calls = 0;
  const deps = {
    store: {
      async applyProviderEvent() {
        calls += 1;
        return true;
      },
    },
  };
  const response = await handleResendWebhook(signedRequest(), deps, 'wrong-secret', () => {
    throw new Error('must not schedule');
  });
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});
