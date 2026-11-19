# Unified report + automatic email

One finalized report per submission. The website, the PDF and the email are all rendered from that
single stored object, so they can never disagree.

## Flow

```
Browser ──POST /api/questionnaire──▶ validate (consent required) + IP rate limit
                                      │
                                      ├─ 1. append row to Google Sheets A:X   (unchanged mapping)
                                      ├─ 2. createReport():  rules engine + Claude (tool-use, zod-validated,
                                      │      1 bounded retry) → FinalReport → frozen → stored in Postgres
                                      │      (AI failed? stored as narrativeSource="template" and labelled so)
                                      ├─ 3. response: finalized report + access token + email status
                                      └─ 4. after(): claim send → render PDF → Resend → record "accepted"

Browser ──GET /api/report/:id──▶ stored report + real email status (no Claude call)   [x-report-token]
Browser ──GET /api/report/:id/pdf──▶ PDF rendered from the stored report              [x-report-token]
Resend  ──POST /api/webhooks/resend──▶ delivered / bounced / complained (Svix-signed)
Vercel Cron ──GET /api/cron/retry-emails (once a day, 12:00 UTC)──▶ retries pending/failed sends   [CRON_SECRET]
```

- `src/lib/final-report.ts` – the immutable report (zod schema, SHA-256 integrity hash, access token).
- `src/lib/report-content.ts` – every customer-visible string. `ReportView`, the PDF and the email all
  render from it. **Edit wording here.**
- `src/lib/narrative.ts` – Claude call. Output is forced through a tool schema and re-validated.
- `src/lib/store.ts` + `db/schema.sql` – Postgres (Neon). Questionnaire responses stay in Sheets only.
- `src/lib/pipeline.ts` – create report, send email (atomic claim), recovery sweep.
- `src/lib/email.ts` – Resend client, branded HTML, webhook signature check.
- `src/lib/pdf/ReportPdf.tsx` – server-side PDF (`@react-pdf/renderer`).

## Guarantees and how they are enforced

| Requirement                    | Mechanism                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Single canonical report        | `FinalReport` is built once, deep-frozen, hashed, stored; web/PDF/email only read it.                                                                                                            |
| AI failure is explicit         | `narrativeSource: "ai" \| "template"` + `aiFailureReason`. Template reports say so in the report ("Cómo se elaboró este reporte").                                                               |
| No duplicate emails            | `UPDATE … WHERE status IN (pending, failed) AND due` is the only way to start a send (one winner), plus Resend `Idempotency-Key: report-email/<id>` for lost responses.                          |
| Provider acceptance ≠ delivery | `accepted` is set on Resend's 2xx; `delivered`/`bounced` only by signed webhook. The UI says "Informe enviado" on `accepted`/`delivered`, "No se pudo entregar" on `bounced`.                    |
| Submission never lost          | Sheets row is written first. If report generation fails the browser retries with the same submission id and gets the same report.                                                                |
| Bounded retries                | max 5 attempts, backoff 1/5/15/60 min, never after 12 h; stuck `sending` rows are reclaimed after a 5 min lease.                                                                                 |
| Recipient integrity            | Email goes to the address stored with the submission; no endpoint accepts a recipient. No client "resend" endpoint exists.                                                                       |
| Abuse limits                   | 10 submissions/IP/min, 120 report reads and 20 PDFs/IP/min, 5 new reports per address per day (all shared across instances via Postgres). Report/PDF need an HMAC access token sent in a header. |
| No secrets/content in logs     | Logs carry report ids, attempt numbers and short error codes only.                                                                                                                               |
| Consent                        | `privacyAccepted` must be `true` in the request schema or nothing is written or sent.                                                                                                            |
| Master switch                  | Reports are created with email status `disabled` unless `REPORT_EMAIL_ENABLED=true` and Resend is configured. Disabled reports are never emailed later.                                          |

## Required configuration (see `.env.example`)

| Variable                                             | Purpose                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                       | Neon Postgres. Run `npm run db:migrate` once (creates `reports`, `report_email_events`, `rate_limits`). |
| `REPORT_TOKEN_SECRET`                                | ≥ 32 random chars; signs per-report access tokens.                                                      |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`     | Resend; the sender domain must be verified (SPF + DKIM DNS records).                                    |
| `RESEND_WEBHOOK_SECRET`                              | Resend webhook (`/api/webhooks/resend`; events: delivered, bounced, complained, delivery_delayed).      |
| `REPORT_EMAIL_ENABLED`                               | `true` only after migration approval.                                                                   |
| `APP_URL`                                            | Public base URL (email logo).                                                                           |
| `CRON_SECRET`                                        | Vercel Cron bearer secret. The recovery sweep runs once a day (see "Recovery schedule").                |
| `GOOGLE_*`, `ANTHROPIC_*`, `NEXT_PUBLIC_BOOKING_URL` | Existing. Redeploy after changing the booking URL.                                                      |

## Recovery schedule (Vercel Hobby: once a day)

Vercel Hobby only accepts cron jobs that run at most once per day, so `vercel.json` schedules
`/api/cron/retry-emails` at `0 12 * * *` (12:00 UTC, 06:00 in Mexico City). The endpoint path and its
`CRON_SECRET` bearer check are unchanged, and so is the retry/idempotency logic.

- **Normal case is unaffected.** The first send happens immediately, right after the report is stored
  (`after()` in `POST /api/questionnaire`). It does not wait for the cron.
- **That first send is the only prompt attempt.** If it fails (provider error, instance died) the next
  attempt is the next daily sweep. The 1/5/15/60 min backoff values are _minimum_ delays, so the real
  delay before a retry can be up to ~24 h.
- **Retry window gap.** The sweep only retries reports younger than 12 h (`maxAgeMs`, kept below the
  provider's 24 h idempotency window). A report is therefore only recoverable if the 12:00 UTC sweep
  falls within 12 h of its creation, i.e. reports created between 00:00 and 12:00 UTC (18:00–06:00
  Mexico City). A first-send failure for a report created between 12:00 and 24:00 UTC
  (06:00–18:00 Mexico City) is **not** retried automatically and the email is not sent.
- **Status shown to the user.** A failed attempt that will not be retried is still stored as `failed`,
  which the page shows as "Enviando…" (retry pending), not as an error. It becomes an error only for
  permanent failures or after the attempt budget is spent.
- `processDueEmails` is safe to run by hand or concurrently (atomic claims), so an operator can call
  the endpoint with the `CRON_SECRET` bearer to recover stuck sends.

Options if this gap matters (none applied here; the retry logic was deliberately left unchanged):
raise `maxAgeMs` to just under 24 h so the daily sweep covers every report; move to a Vercel plan that
allows frequent crons and restore a short schedule; or trigger the endpoint from an external scheduler.

## Legacy Apps Script (not touched)

`enviarCorreosPendientes()` has **not** been reviewed: its source has not been provided, and
`scripts/apps-script-test-one-row.gs` is only a reconstruction. Nothing in this change installs,
edits or removes any trigger.

Facts that matter for the migration:

- Rows appended through the Sheets API do **not** fire `onFormSubmit`. A legacy `onFormSubmit` trigger
  therefore only emails real Google Forms submissions.
- If a **time-driven** trigger polls the Dashboard for rows without "Enviado", it will also email rows
  written by this app. That would already be happening with the current production flow, so check
  _Apps Script → Triggers_ before anything else.

Proposed migration (each step needs approval):

1. Provide the real `enviarCorreosPendientes()` and the list of installed triggers.
2. Add a guard so the legacy sender skips rows created by this app (e.g. a marker the app writes, or
   the legacy script ignoring rows whose id exists in `reports`). Test on one `PRUEBA` row.
3. Create the Neon database, run `npm run db:migrate`, set the Resend/Vercel variables with
   `REPORT_EMAIL_ENABLED=false`, deploy, and verify `/api/questionnaire` end to end (report only).
4. Send one real test submission to an address you control with `REPORT_EMAIL_ENABLED=true`
   (preview/staging deployment first). Check the inbox, the PDF, `accepted` → `delivered`.
5. Enable in production. Keep the legacy Forms workflow untouched for Forms submissions.

## Verification matrix

| Scenario                                                | Covered by                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| Submission → report → email with PDF, correct recipient | `tests/pipeline.test.mjs` (success, recipient)                         |
| Web ↔ PDF identical content                             | `tests/pdf.test.mjs` (text extracted from the real PDF)                |
| Booking URL consistent                                  | `tests/pdf.test.mjs` (content, email, PDF link annotation)             |
| Duplicates, retries, races                              | `tests/pipeline.test.mjs`, `tests/store.test.mjs` (real SQL on PGlite) |
| AI timeout/failure                                      | `tests/pipeline.test.mjs`, `tests/narrative.test.mjs`                  |
| Email provider failure / lost response                  | `tests/pipeline.test.mjs`, `tests/email.test.mjs`                      |
| Webhook signature                                       | `tests/email.test.mjs`                                                 |
| No duplicate legacy messages                            | **Not verifiable** until the legacy script and triggers are reviewed.  |
| Against real Neon + Resend + production Sheets          | **Not run**: needs credentials and approval.                           |
