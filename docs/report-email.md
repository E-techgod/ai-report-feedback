# Unified report + automatic email

One finalized report per submission. The website, the PDF and the email are all rendered from that
single stored object, so they can never disagree.

## Flow

```
Browser ──POST /api/questionnaire──▶ validate (consent required) + IP rate limit
                                      │
                                      ├─ 1. append header-mapped row to Google Sheets
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

| Requirement                    | Mechanism                                                                                                                                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single canonical report        | `FinalReport` is built once, deep-frozen, hashed, stored; web/PDF/email only read it.                                                                                                                                                                                        |
| AI failure is explicit         | `narrativeSource: "ai" \| "template"` + `aiFailureReason`. Template reports say so in the report ("Cómo se elaboró este reporte").                                                                                                                                           |
| No duplicate emails            | `UPDATE … WHERE status IN (pending, failed) AND due` is the only way to start a send (one winner), plus Resend `Idempotency-Key: report-email/<id>` for lost responses.                                                                                                      |
| Provider acceptance ≠ delivery | `accepted` is set on Resend's 2xx; `delivered`/`bounced` only by signed webhook. The UI says "Informe enviado" on `accepted`/`delivered`, "No se pudo entregar" on `bounced`.                                                                                                |
| Submission never lost          | Sheets row is written first. If report generation fails the browser retries with the same submission id and gets the same report.                                                                                                                                            |
| Bounded retries                | max 5 attempts; backoff 1/5/15/60 min are _minimum_ delays; reports are retried for up to **47 h**, then finalized as failed; stuck `sending` rows are reclaimed after a 5 min lease. With the once-daily cron, retries happen at the daily sweep (see "Recovery schedule"). |
| Recipient integrity            | Email goes to the address stored with the submission; no endpoint accepts a recipient. No client "resend" endpoint exists.                                                                                                                                                   |
| Abuse limits                   | 10 submissions/IP/min, 120 report reads and 20 PDFs/IP/min, 5 new reports per address per day (all shared across instances via Postgres). Report/PDF need an HMAC access token sent in a header.                                                                             |
| No secrets/content in logs     | Logs carry report ids, attempt numbers and short error codes only.                                                                                                                                                                                                           |
| Consent                        | `privacyAccepted` must be `true` in the request schema or nothing is written or sent.                                                                                                                                                                                        |
| Master switch                  | Reports are created with email status `disabled` unless `REPORT_EMAIL_ENABLED=true` and Resend is configured. Disabled reports are never emailed later.                                                                                                                      |

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
`/api/cron/retry-emails` at `0 12 * * *` (12:00 UTC, 06:00 in Mexico City; Hobby may start the run
anywhere inside that hour). The endpoint path and its `CRON_SECRET` bearer check are unchanged.

### How a report is recovered

- **Normal case is unaffected.** The first send happens immediately, right after the report is stored
  (`after()` in `POST /api/questionnaire`). It does not wait for the cron.
- **That first send is the only prompt attempt.** If it fails (provider error, instance died) the next
  attempt is the next daily sweep. The 1/5/15/60 min backoff values are _minimum_ delays, so the real
  delay before a retry is up to ~24 h.
- **Retry window: 47 h** (`maxAgeMs`). With one sweep per day, any report is reached by at least one
  sweep: the next 12:00 UTC run is always less than 24 h after it was created. Two sweeps fit inside
  47 h for reports created just before a run (e.g. 11:59 UTC) and one for reports created just after
  (e.g. 12:01 UTC).
- **Skipped or very late runs.** If a run is skipped, a report created just after the previous run is
  reached only by the run two days later (≈48 h), which is past the window. It is then finalized as
  failed and **not sent**. A run that is merely late (still inside 47 h) recovers it normally.
- **Backlog.** The cron first finalizes expired reports, then processes due emails in batches of 25
  for up to 25 s. A send already in flight can exceed that soft deadline (Resend's request timeout
  alone is 20 s). Sheet projection has a separate 12 s window, capped by an absolute 52 s work
  deadline in the 60 s route, leaving eight seconds for cleanup and response. Real PDF/Resend
  throughput is unmeasured; a large outage backlog may outlast the 47 h retry window.

### What the customer sees

| Stored state                                                          | Shown as                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `pending` / `sending` (active attempt)                                | "Enviando…"                                                                            |
| `failed` with a later attempt still possible                          | "No pudimos enviar el correo todavía. Lo reintentaremos automáticamente…" (`retrying`) |
| `accepted` / `delivered`                                              | "Informe enviado"                                                                      |
| `bounced`                                                             | "No se pudo entregar el correo…"                                                       |
| `failed_final`: attempts used up, older than 47 h, or unsafe to retry | "No se pudo enviar el correo. Descarga tu informe en PDF aquí."                        |

The terminal state is also **derived when the report is read**, so a report that is out of attempts or
older than 47 h shows the failure immediately, even before the next sweep writes `failed_final`.
Stored reasons (`email_last_error`): `expired`, `attempts-exhausted`,
`unknown-outcome-after-idempotency-window`, or the last provider error code.

### Duplicate protection beyond 24 h

Resend remembers an idempotency key for 24 h, but retries now span up to 47 h. If an earlier attempt
may have reached the provider without us learning the result — a timeout, a network error, an
in-flight conflict (HTTP 409), or a send whose acceptance was never recorded (crash) — a retry made
more than **23 h** after the first attempt would no longer be de-duplicated and could produce a second
email. In that case the retry is **refused** and the report is finalized as failed
(`unknown-outcome-after-idempotency-window`), even though the customer may in fact have received the
email. A definitive HTTP rejection (e.g. 503, 429, 4xx) means the provider did not accept the message,
so those are retried for the full 47 h. The check uses the existing `report_email_events` audit table:
no schema change.

### Architectural notes

- **No new services were introduced.** PR #7 adds idempotent report/Sheet tracking columns and a
  shared append lease in `db/schema.sql`; migrate the database before deploying that branch.
- **Daily cadence is a ceiling on resilience.** With Hobby, a first-send failure costs up to a day, a
  missed run can cost the email, and throughput depends on measured PDF and provider latency. If volume or reliability
  matters, the clean fixes are a plan that allows frequent crons (restore a short schedule; the logic
  already supports it) or an external scheduler calling the endpoint with the bearer secret.
- **Why 47 h and not 48 h:** a retry window equal to the cron period would let the second sweep land
  at ≈48 h, right on the boundary; 47 h makes the cutoff unambiguous.
- The sweep endpoint is safe to call by hand or concurrently (atomic claims), so an operator can
  recover stuck sends with the `CRON_SECRET` bearer.

## Email audit: which implementation produces which email

The current Sheet headers, prepared guard, header-based answer reader, and read-only requeue checks
are documented in [tracking-and-cutover.md](tracking-and-cutover.md). This section preserves PR #6's
audit and email comparison. No production trigger or Script Property was changed by PR #7.

|                       | Legacy Apps Script                                                                                                | Resend (this app)                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Where                 | `enviarCorreosPendientes()` in the Sheet's Apps Script project (source supplied by the owner)                     | `src/lib/email.ts` → `buildEmail()`, sent by `src/lib/pipeline.ts`                                                            |
| Data source           | `Dashboard` tab formulas + raw `Respuestas de formulario 1` row (same row number assumed)                         | The finalized `FinalReport` stored in Neon. Never regenerated for email                                                       |
| Content               | Subject from a Dashboard cell; plain text + pie chart; 5 hardcoded recommendations (max 3); `calendario-jag` link | Concise branded summary: greeting, score + level, main finding, priority area, next step, attached-PDF notice, booking button |
| Attachment            | None                                                                                                              | The PDF rendered from the same stored report as the website download (same file name)                                         |
| Sent flag             | Writes "Enviado" + timestamp in Dashboard columns H–I                                                             | `reports.email_status` + `report_email_events`, Resend webhook                                                                |
| Idempotency / retries | None: no lock, marks after each send                                                                              | Atomic claim, `report-email/<id>` key, bounded retries, 47 h window                                                           |

The **legacy script is the one that produces the separate, different email.** The Resend email is built from
the same `buildReportContent()` as the web view and the PDF. Its three highlight lines are the top stored
priority's `finding`, `title` and `action` (or the report's own "nothing to strengthen" message), and it never
says anything about AI authorship (the PDF carries the "how this report was made" note, which already
distinguishes AI-assisted from template reports).

## Legacy Apps Script: documented, not activated

Nothing in this repo installs, edits or removes any production trigger or part of the installed
legacy script. The prepared patches remain inert until manually applied after approval.

What the supplied `enviarCorreosPendientes()` does:

- Iterates over **every** `Dashboard` row (`getMaxRows()`); skips rows with no email, an invalid email, or
  column H = "Enviado".
- For every other row it sends a Gmail message (`GmailApp.sendEmail`) and then writes "Enviado" + a timestamp.
- It creates no trigger itself. Whether it runs by itself depends on triggers installed in the Apps Script UI.

Impact on the new flow (**blocker for production activation**):

- This app appends to `Respuestas de formulario 1`, and the Dashboard formulas read that tab. Every app
  submission therefore appears in the Dashboard with an email and no "Enviado", so **any** run of the legacy
  function (time-driven trigger, manual run, or a future trigger) emails it, in addition to the Resend email.
- Rows appended through the Sheets API do not fire `onFormSubmit`: a form-submit trigger alone would not pick
  them up. A time-driven trigger would.
- The legacy function has no lock, and marks "Enviado" only after sending, so overlapping runs or a crash
  between send and mark can duplicate emails on their own.
- Unused code: `mensaje` (column F) and `textoRecomendaciones` are computed but never used.

**Still unknown:** the installed triggers (Apps Script → Triggers). Until they are listed, "no duplicate legacy
messages" cannot be verified. See the migration plan below.

The full migration plan is in the next section. Nothing in it has been applied.

## Migration plan: legacy Apps Script → Resend report email

**Status: proposal. Nothing below has been done.** No Sheet, Apps Script, trigger or production variable has been
changed, `REPORT_EMAIL_ENABLED` is `false`, and no real email has been sent.

### Phase A: audit findings

Read-only look at the production Sheet (tab names, Dashboard header and formulas, column H/I flags, column A
timestamps; no names or emails were read).

1. **References to `enviarCorreosPendientes()`.** The live copy exists only in the Sheet's Apps Script project,
   which could not be read from here. In this repo only comments and helpers mention it:
   - `scripts/apps-script-safe-email-trigger.gs`: a draft that, if installed, adds a 5-minute time-driven trigger.
     It is the riskiest file for duplicates: delete it or label it "do not install".
   - `scripts/apps-script-test-one-row.gs`: a reconstruction that can really send and mark "Enviado".
   - `scripts/google-apps-script.gs`: an unrelated legacy web-app endpoint (`WEB_SHIELD_2026`).
   - `README.md` and `scripts/test-submission.ts` carry warnings about it.
2. **Installed triggers: cannot be inspected from here.** Evidence it runs automatically: the Dashboard shows
   "Enviado" on the same day as the response for the August rows (13/8, 25/8) and for the 18/11 row. A manual run
   on the same day would look identical. Manual check (Apps Script project):
   - **Triggers** (clock icon): list every trigger, its function and its event source.
   - **Executions**: filter on `enviarCorreosPendientes` and read the **Type** column ("Time-driven" or "From
     spreadsheet" = trigger, "Editor" = manual run).
   - **Project Settings → Script Properties**, and **Deploy → Manage deployments**.
3. **The two flows.**
   - Google Form → `Respuestas de formulario 1` → Dashboard → legacy Gmail. It never touches Neon, so Form
     respondents can never receive the Resend email.
   - Web app → `/api/questionnaire` → append row to Sheets → report in Neon → Resend. The Dashboard also picks
     these rows up, so legacy can email them too.
4. **How "sent" is stored, and how pending rows are told apart.**
   - Legacy: Dashboard A–G are open-ended `ARRAYFORMULA`s over the responses tab; H and I are literal values
     the script writes **by row position**. Nothing links a Dashboard row to anything else.
   - Resend: `reports.email_status` (9 states) plus the `report_email_events` audit table.
   - At the time of PR #6's audit, app rows and Form rows had no report ID marker. PR #7 prepares
     `ID Reporte` tracking for new app rows, allowing a legacy exclusion after the installed script
     is reviewed. Historical rows must not be linked by positional guesswork.
   - The app's levels match the Dashboard formula (100 Excelente, 80 Alto, 60 Medio, 40 Bajo, else Muy bajo).
5. **What the Sheet shows.**
   - Historical pending: exactly **1** row (response row 3, 9/4/2026, column H empty).
   - Dashboard rows 14–18 are already marked "Enviado 18/11/2026" although the responses tab only has data through
     row 13. The next 5 submissions would be silently skipped by legacy. Either deleted test rows were emailed and
     removed, or someone pre-marked them as a guard. Not determinable from here. It also shows how fragile the
     positional column H is.
   - `Respuestas` has empty columns Y:AC.
6. **PDF and email use the same persisted report.** `generateNarrative` is called only in `createReport()`
   (`pipeline.ts`). Sending, retrying and the cron read the stored report, and a test proves a failed send never
   regenerates it.
   - **Gap:** a report created while email is disabled gets status `disabled`. PR #7 prepares a
     reviewed-ID, dry-run-first requeue tool for the cutover gap; it is not activated. Anyone who
     submits through the web app while both systems are off gets no immediate email.

### Phase B: proposal

**Approach:** a kill switch inside the legacy function, not trigger deletion. The function body, the formulas,
columns H/I and all triggers stay in place. A manual Run does nothing while the switch is off.

1. **Prepare (no production change).** Verify the Resend domain (SPF and DKIM). Set `RESEND_API_KEY`,
   `EMAIL_FROM` and `RESEND_WEBHOOK_SECRET`, and the Vercel production variables, still with
   `REPORT_EMAIL_ENABLED=false`. Register the webhook.
2. **Kill-switch patch (prepared in the repo, applied by hand).** Add
   `scripts/legacy-email-kill-switch.gs` to the installed project and put
   `if (!legacyEmailEnabled_()) return;` at the start of `enviarCorreosPendientes()`. It defaults
   off. If legacy delivery must continue before cutover, set `LEGACY_EMAIL_ENABLED=true` before
   installing the guard. Review the header-based answer patch at the same time. None is applied.
3. **Remove the dangerous draft** `scripts/apps-script-safe-email-trigger.gs` from the repo, or label it clearly.
4. **Cutover order: gap plus reviewed requeue, not overlap.** This global kill sequence is only
   appropriate after Form-only delivery has a replacement or the Form is retired. If Forms stays
   active, keep legacy mail for Form rows and first prove a tested exclusion for app rows.
   1. In a quiet hour, set `LEGACY_EMAIL_ENABLED` to off.
   2. Right away, set `REPORT_EMAIL_ENABLED=true` in production.
   3. Dry-run `scripts/requeue-disabled-reports.ts` for explicitly reviewed, never-attempted IDs
      inside the 47-hour window. It verifies the report marker and Dashboard B/H before an approved
      apply. The idempotency key (`report-email/<id>`) protects later sends.
5. **Historical records.** Leave row 3 alone (the kill switch stops it being sent). Leave rows 14–18 alone and
   keep the positional-fragility note. Old respondents cannot be back-sent: there are no Neon reports for them.
6. **Dashboard.** No production formula changes. New app rows have report/email tracking columns
   on the response tab; Dashboard H remains the legacy sent flag and is checked before requeue.
7. **Test a real Resend email without touching production.**
   - Use a Neon branch (`neon checkout test --create`) and a Vercel preview.
   - Use an approved isolated Sheet dataset (or a seeded `PRUEBA` report without the Sheet).
     Automatic approval review rejected copying the live response Sheet because it would replicate
     respondent data. No copy was made. Verify `updatedCells` behavior against an authorized copy.
   - Send to an address you control. Check rendering in Gmail, Outlook and Apple Mail.
   - Check the attached PDF opens and matches the website download.
   - Check `accepted` → `delivered` through the webhook.
   - Re-trigger the same send and confirm no second email arrives.
   - Use `bounced@resend.dev` to confirm a bounce is recorded.
8. **Rollback.**
   - New system off: `REPORT_EMAIL_ENABLED=false` and redeploy. This stops all new sends immediately.
   - Legacy back on: set `LEGACY_EMAIL_ENABLED=true`. **First** mark the rows Resend already emailed as "Enviado"
     (list them from Neon: `accepted` or `delivered`), or legacy will email them a second time.
   - If a trigger was ever removed, re-create it from the trigger list recorded in the manual check above.

### Approvals and answers needed before implementation

1. **Is the Google Form still live for new respondents?** If yes, disabling legacy leaves them with no email at
   all, and the plan changes (they stay on legacy or move to the web app).
2. The **Triggers and Executions** results from the manual check in Phase A, item 2.
3. Approval of the kill-switch patch, and agreement that it is applied by hand in Apps Script.
4. Approval of the gap-plus-backfill cutover, the quiet window and the re-queue script.
5. Resend ownership: the verified sender domain, who creates the API key and webhook, and the test recipient.
6. Approval to create a Sheet copy and a Neon branch for testing.
7. Rows 14–18: pre-marked on purpose, or leftovers from deleted tests?
8. Approval to set the Vercel production variables (still with `REPORT_EMAIL_ENABLED=false`).

## Verification matrix

| Scenario                                                | Covered by                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------- |
| Submission → report → email with PDF, correct recipient | `tests/pipeline.test.mjs` (success, recipient)                          |
| Web ↔ PDF identical content                             | `tests/pdf.test.mjs` (text extracted from the real PDF)                 |
| Booking URL consistent                                  | `tests/pdf.test.mjs` (content, email, PDF link annotation)              |
| Duplicates, retries, races                              | `tests/pipeline.test.mjs`, `tests/store.test.mjs` (real SQL on PGlite)  |
| AI timeout/failure                                      | `tests/pipeline.test.mjs`, `tests/narrative.test.mjs`                   |
| Email provider failure / lost response                  | `tests/pipeline.test.mjs`, `tests/email.test.mjs`                       |
| Webhook signature                                       | `tests/email.test.mjs`                                                  |
| Email = concise summary from the stored report          | `tests/email.test.mjs` (html + plain text, empty and AI/template cases) |
| Email, PDF and web share one stored report              | `tests/pipeline.test.mjs` (real PDF text vs email, no regeneration)     |
| No duplicate legacy messages                            | **Not verifiable** until the Apps Script triggers are listed.           |
| Against real Neon + Resend + production Sheets          | **Not run**: needs credentials and approval.                            |
