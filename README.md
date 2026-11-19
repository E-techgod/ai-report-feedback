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

## Environment sync (local `.env` → Vercel Production)

`npm run env:sync:production` copies an explicit allowlist of variables from your local `.env` to Vercel **Production** using the official Vercel CLI. It never deploys.

**One-time setup:** `npm i -g vercel`, `vercel login`, then `vercel link` in this folder (creates the git-ignored `.vercel/`). Set `VERCEL_BIN` if the CLI is not on your `PATH`.

```bash
npm run env:sync:production -- --dry-run   # names + operations only; modifies nothing
npm run env:sync:production                # shows the plan, then asks you to type "sync production"
npm run env:sync:production -- --only EMAIL_FROM,RESEND_API_KEY   # a subset of the allowlist
```

Other options: `--offline` (skip the read-only `vercel env ls`, operations show as `upsert`) and `--env-file <path>`.

What it does, and what it guarantees:

- **Allowlist only:** `GOOGLE_SHEET_ID`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `REPORT_TOKEN_SECRET`, `CRON_SECRET`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `APP_URL`, `NEXT_PUBLIC_BOOKING_URL` (list in `scripts/lib/env-sync.ts`). Missing or empty local values are skipped, never written as blanks.
- **Never synced, on purpose:** `REPORT_EMAIL_ENABLED` (the email master switch is flipped deliberately in the Vercel dashboard, never as a side effect of copying a file), `DATABASE_URL*` (owned by the Neon integration) and the legacy `GOOGLE_SHEETS_WEBHOOK_*`. Asking for one with `--only` is an error.
- **Create or update:** a variable missing in Production is created; an existing one is overwritten (`vercel env add … --force`). Nothing is ever removed, so every other Production variable is preserved.
- **No secret exposure:** values reach the CLI through its **stdin**, never argv, a shell command, a log or the plan (which shows `<hidden>`). The `.env` is not loaded into the process environment, and any CLI error output is redacted before it is printed.
- **Confirmation:** applying requires typing `sync production` in an interactive terminal; piped or CI runs are refused. Dry run never writes.
- **Protected source:** the run aborts if the env file is tracked by git or not git-ignored. `.gitignore` ignores `.env` and every `.env.*` variant (`.env.local`, `.env.production`, …) except the `.env.example` template, plus `.vercel/`, `.neon` and `*.pem`.
- **No deployment:** Vercel applies new values only to the next deployment, so **redeploy Production afterwards**. Changing `REPORT_TOKEN_SECRET` invalidates existing report links, and `CRON_SECRET` must match the Vercel Cron configuration; the plan flags both.
- **If a write fails** the run stops, names the variables already written, and exits non-zero; re-running is safe because writes are idempotent.

## Booking

Set `NEXT_PUBLIC_BOOKING_URL` to the real, published Google Appointment Schedule booking page. The client CTA opens it in a separate tab (no Calendar API/OAuth required). Test actual availability and confirmation with the calendar owner.

## Security and scope

- Must validate privacy/consent language and suitability of questions before a public blast.
- No scoring adjustments for nonapplicable questions. All twenty must be answered. Confirm this business rule before launch.
- Questionnaire responses live only in the header-mapped Google Sheet. Finalized reports and email status live in Postgres. Reports and PDFs are retrievable only with the per-report access token issued to the submitting browser; there are no public links.
- Rate limiting / CAPTCHA, spam monitoring, credential rotation, retention policies, authorized staff access, and legal review are needed before a high-volume campaign.
- Ensure Vercel plan permits commercial usage. Secrets must never be in `NEXT_PUBLIC_` vars or committed.
- Do not enable `REPORT_EMAIL_ENABLED` until the migration in `docs/report-email.md` is approved and a real test submission has been verified end to end.
