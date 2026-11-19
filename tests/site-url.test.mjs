import test from 'node:test';
import assert from 'node:assert/strict';
import { EMAIL_LOGO_PATH, emailLogoUrl, httpsOrigin, publicSiteUrl } from '../src/lib/site-url.ts';

test('httpsOrigin accepts only public https origins', () => {
  assert.equal(
    httpsOrigin('https://ai-report-feedback.vercel.app'),
    'https://ai-report-feedback.vercel.app',
  );
  assert.equal(
    httpsOrigin(' https://Shield.QuironGroup.com/x/?q=1#h '),
    'https://shield.quirongroup.com',
  );
  for (const bad of [
    undefined,
    null,
    '',
    'not a url',
    '/images/quiron-logo.png',
    'http://shield.quirongroup.com',
    'https://localhost',
    'https://app.localhost',
    'https://printer.local',
    'https://10.0.0.5',
    'https://172.20.1.1',
    'https://[::1]',
    'https://nodots',
    'ftp://shield.quirongroup.com',
    'https://u:p@shield.quirongroup.com',
  ])
    assert.equal(httpsOrigin(bad), null, String(bad));
});

test('emailLogoUrl is the public PNG path on the configured origin', () => {
  assert.equal(EMAIL_LOGO_PATH, '/images/quiron-logo.png');
  assert.equal(
    emailLogoUrl('https://ai-report-feedback.vercel.app/'),
    'https://ai-report-feedback.vercel.app/images/quiron-logo.png',
  );
  assert.equal(emailLogoUrl('http://localhost:3000'), null);
  assert.equal(emailLogoUrl(null), null);
});

test('publicSiteUrl prefers a usable APP_URL, then the Vercel production domain, else nothing', () => {
  assert.equal(
    publicSiteUrl({
      APP_URL: 'https://shield.example.com',
      VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app',
    }),
    'https://shield.example.com',
  );
  assert.equal(
    publicSiteUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'ai-report-feedback.vercel.app' }),
    'https://ai-report-feedback.vercel.app',
  );
  // an unusable APP_URL (http, localhost) must not win over the production domain
  assert.equal(
    publicSiteUrl({
      APP_URL: 'http://localhost:3000',
      VERCEL_PROJECT_PRODUCTION_URL: 'ai-report-feedback.vercel.app',
    }),
    'https://ai-report-feedback.vercel.app',
  );
  assert.equal(publicSiteUrl({ APP_URL: 'http://localhost:3000' }), null);
  assert.equal(publicSiteUrl({}), null);
  assert.equal(publicSiteUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'localhost' }), null);
});
