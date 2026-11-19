# Quirón Shield Survey — MVP

Standalone Next.js questionnaire: 20 yes/no questions, deterministic score, one finalized AI-assisted report shown on the web, downloadable as a server-rendered PDF and emailed automatically, plus an appointment-booking CTA. See `docs/report-email.md` for the architecture, configuration and migration plan.

## Setup

1. Node 22: `nvm use 22`
2. `npm install`
3. `cp .env.example .env.local` and set configured credentials
4. `npm run dev`
5. `npm run typecheck && npm run lint && npm run build`

## Important: integrating into an existing repository

This ZIP is a standalone Next.js app. Do **not** copy its `package.json`, `tsconfig.json`, or files on top of an existing repository without comparing them. Merge `src/app`, `src/lib`, and the Apps Script with your actual repo, preserving any existing implementation. If you replace a starter repo, remove obsolete starter code. Push a reviewed commit to GitHub to trigger Vercel deployment.

## Google Sheets (POST /api/questionnaire)

The UI submits to `POST /api/questionnaire`, which appends one row to the existing `Respuestas de formulario 1` tab using its current header names. Tracking fields now sit between email and the 20 questions, so answer columns are resolved by question headers. The app writes only its own tracking cells in newly linked rows; historical rows are not changed. Answers remain `Si`/`No` (the UI shows “Sí”). See [tracking and cutover](docs/tracking-and-cutover.md).

1. Enable the **Google Sheets API** in the Cloud project that owns the service account.
2. Share the spreadsheet with `GOOGLE_CLIENT_EMAIL` as **Editor**.
3. Set `GOOGLE_SHEET_ID`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY` (server-only; see `.env.example`).
4. Success is returned only after Google confirms exactly one 24-cell row was written.

Duplicate protection (no schema change): the client keeps one submission id per diagnosis; the server ignores a repeated id, merges concurrent identical requests, and skips the append if the same email already has identical answers within the last 10 minutes.

**Limitations**

- Rows added through the Sheets API do **not** fire Google Form submit triggers. If the existing Apps Script email workflow uses an `onFormSubmit` trigger, it will not run for these rows (see report / add an `onChange` or time-based trigger separately).
- The in-memory id/rate-limit guards are per server instance; the sheet check covers cross-instance duplicates.
- `scripts/google-apps-script.gs` and `/api/submit` are the legacy webhook bridge and are no longer used by the UI.

## Report, AI, PDF and email

One **finalized report** is built on the server per submission, stored in Postgres, and used for the web page, the PDF and the email (details: `docs/report-email.md`).

- **Rules engine (~65%)** — `src/lib/report.ts`: score, level (same labels as the Dashboard), the 6 areas, ranked top-3 priorities, findings, actions and the action plan. Deterministic and covered by tests.
- **Fixed interface (~20%)** — headings, descriptions, CTA, disclaimer, all in `src/lib/report-content.ts`, the single source of every customer-visible string for the web view, PDF and email.
- **AI (~15%)** — exactly 4 text slots written by Claude (`src/lib/narrative.ts`): an executive summary (≤90 words) and a short context for each priority (≤25 words). The call is forced through a tool schema, re-validated with zod, and retried once. The AI receives only computed results (no names, emails or raw answers) and never calculates, selects or reorders anything.
- **AI failure** — if Claude is unconfigured, times out or returns invalid output, the report is finalized with template text, stored as `narrativeSource: "template"`, and the report itself says the AI was not used. It is never presented as AI-written.
- **PDF** — rendered on the server (`@react-pdf/renderer`) from the stored report, not from the browser. "Descargar PDF" downloads it and the same file is attached to the email.
- **Email** — sent by Resend right after the report is stored, to the address supplied in the questionnaire. Status shown to the user comes from the database ("Informe enviado" / "No se pudo enviar el correo"). Nothing is sent unless `REPORT_EMAIL_ENABLED=true`.
- **Editing the design** — run `npm run dev` and open `/report-preview` (development only, 404 in production) to review the web view with sample data, in client or team mode, with each email status.
- **Editorial review needed** — the area/priority/context catalog in `src/lib/report.ts` (`THEMES`) reuses the prototype wording for three areas; the other three are drafts in the same tone.

Setup: create a Neon database, set the variables in `.env.example`, then run `npm run db:migrate` once.

## Booking

Set `NEXT_PUBLIC_BOOKING_URL` to the real, published Google Appointment Schedule booking page. The client CTA opens it in a separate tab (no Calendar API/OAuth required). Test actual availability and confirmation with the calendar owner.

## Security and scope

- Must validate privacy/consent language and suitability of questions before a public blast.
- No scoring adjustments for nonapplicable questions. All twenty must be answered. Confirm this business rule before launch.
- Questionnaire responses live only in Google Sheets (A:X). Finalized reports and email status live in Postgres. Reports and PDFs are retrievable only with the per-report access token issued to the submitting browser; there are no public links.
- Rate limiting / CAPTCHA, spam monitoring, credential rotation, retention policies, authorized staff access, and legal review are needed before a high-volume campaign.
- Ensure Vercel plan permits commercial usage. Secrets must never be in `NEXT_PUBLIC_` vars or committed.
- Do not enable `REPORT_EMAIL_ENABLED` until the migration in `docs/report-email.md` is approved and a real test submission has been verified end to end.
