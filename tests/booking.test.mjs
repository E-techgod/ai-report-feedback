import test from 'node:test';
import assert from 'node:assert/strict';
import { getBookingUrl } from '../src/lib/booking.ts';

test('accepts the Quirón booking URL (and trims whitespace)', () => {
  assert.equal(
    getBookingUrl('https://www.quirongroup.com/calendario-jag'),
    'https://www.quirongroup.com/calendario-jag',
  );
  assert.equal(
    getBookingUrl('  https://www.quirongroup.com/calendario-jag \n'),
    'https://www.quirongroup.com/calendario-jag',
  );
});

test('missing or empty values are invalid', () => {
  assert.equal(getBookingUrl(undefined), null);
  assert.equal(getBookingUrl(null), null);
  assert.equal(getBookingUrl(''), null);
  assert.equal(getBookingUrl('   '), null);
});

test('non-https, malformed and unsafe values are invalid', () => {
  for (const bad of [
    'http://www.quirongroup.com/calendario-jag',
    'www.quirongroup.com/calendario-jag',
    'calendario-jag',
    'javascript:alert(1)',
    'data:text/html,hi',
    'https://',
    'https://user:pass@www.quirongroup.com/x',
  ]) {
    assert.equal(getBookingUrl(bad), null, bad);
  }
});
