# Quirón Shield Survey — MVP

Standalone Next.js questionnaire: 20 yes/no questions, deterministic score, one finalized AI-assisted report shown on the web, downloadable as a server-rendered PDF for 5 minutes after submission, plus an appointment-booking CTA. Google Sheets is the only data store. See `docs/pdf-download.md` for the architecture.

## Setup

1. Node 22: `nvm use 22`
2. `npm install`
3. `cp .env.example .env.local` and set configured credentials
4. `npm run dev`
5. `npm run typecheck && npm run lint && npm run build`

## Important: integrating into an existing repository

This ZIP is a standalone Next.js app. Do **not** copy its `package.json`, `tsconfig.json`, or files on top of an existing repository without comparing them. Merge `src/app`, `src/lib`, and the Apps Script with your actual repo, preserving any existing implementation. If you replace a starter repo, remove obsolete starter code. Push a reviewed commit to GitHub to trigger Vercel deployment.

## Google Sheets (POST /api/questionnaire)

The UI submits to `POST /api/questionnaire`, which appends one row to the existing `Respuestas de formulario 1` tab using its current header names. Tracking fields now sit between email and the 20 questions, so answer columns are resolved by question headers. The app writes only its own tracking cells in newly linked rows; historical rows are not changed. Answers remain `Si`/`No` (the UI shows “Sí”).

1. Enable the **Google Sheets API** in the Cloud project that owns the service account.
2. Share the spreadsheet with `GOOGLE_CLIENT_EMAIL` as **Editor**.
3. Set `GOOGLE_SHEET_ID`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY` (server-only; see `.env.example`).
4. Success is returned only after Google confirms exactly one 24-cell row was written.

Duplicate protection (no schema change): the client keeps one submission id per diagnosis; the server ignores a repeated id, merges concurrent identical requests, and skips the append if the same email already has identical answers within the last 10 minutes.

**Limitations**

- Rows added through the Sheets API do **not** fire Google Form submit triggers. If the existing Apps Script email workflow uses an `onFormSubmit` trigger, it will not run for these rows (see report / add an `onChange` or time-based trigger separately).
- The in-memory id/rate-limit guards are per server instance; the sheet check covers cross-instance duplicates.
- `scripts/google-apps-script.gs` and `/api/submit` are the legacy webhook bridge and are no longer used by the UI.

## Report, AI and PDF

One **finalized report** is built on the server per submission and returned to the browser; it is used for the web page and the PDF and is **not stored** (details: `docs/pdf-download.md`).

- **Rules engine (~65%)** — `src/lib/report.ts`: score, level (same labels as the Dashboard), the 6 areas, ranked top-3 priorities, findings, actions and the action plan. Deterministic and covered by tests.
- **Fixed interface (~20%)** — headings, descriptions, CTA, disclaimer, all in `src/lib/report-content.ts`, the single source of every customer-visible string for the web view and PDF.
- **AI (≤15%)** — exactly 4 text slots written by the configured provider (`src/lib/narrative.ts`): an executive summary and a short context for each priority. `AI_PROVIDER` is `groq` (default, `GROQ_API_KEY`, `GROQ_MODEL`, default `openai/gpt-oss-20b`, strict `json_schema` output) or `anthropic` (explicit, tool schema). Output is re-validated with zod and retried once; a 429 waits for a short `Retry-After`. Per-slot word limits are derived so AI text stays ≤15% of the report's visible words (`src/lib/ai-share.ts`); if a provider still exceeds it, the report uses template text. The AI receives only computed results (no names, emails or raw answers) and never calculates, selects or reorders anything.
- **AI failure** — if the provider is unconfigured, rate-limited, times out or returns invalid output, the report is finalized with template text, marked `narrativeSource: "template"`, and the report itself says the AI was not used. It is never presented as AI-written.
- **PDF** — rendered on demand on the server (`@react-pdf/renderer`), never stored. After a successful submission the server issues a signed grant valid for **5 minutes** (repeatable downloads); after that the server refuses it and the page shows "Tu sesión de descarga ha expirado." There is no retrieval or regeneration afterwards.
- **Editing the design** — run `npm run dev` and open `/report-preview` (development only, 404 in production) to review the web view with sample data, in client or team mode, including the download-window states.
- **Editorial review needed** — the area/priority/context catalog in `src/lib/report.ts` (`THEMES`) reuses the prototype wording for three areas; the other three are drafts in the same tone.

## Environment sync (local `.env` → Vercel Preview or Production)

The local `.env` is the source for the explicit allowlist below. New names in `.env` are detected and proposed for creation when absent from Vercel; they require separate approval before any write. The workflow uses the official Vercel CLI, handles Preview and Production independently, and never deploys or deletes variables.

**One-time setup:** `npm i -g vercel`, `vercel login`, then `vercel link` in this folder (creates the git-ignored `.vercel/`). Set `VERCEL_BIN` if the CLI is not on your `PATH`. Needs a CLI recent enough to support `vercel env ls --format json` and `vercel api` (used read-only to list custom environments; if your CLI cannot run it, applies are refused rather than guessed).

```bash
npm run env:check                                  # read-only plans for Preview and Production
npm run env:sync:preview -- --expect-project prj_xxx     # Preview only; type "sync preview"
npm run env:sync:production -- --expect-project prj_xxx  # Production only; type "sync production"
npm run env:sync:preview -- --dry-run                    # read-only Preview plan
npm run env:sync:preview -- --approve-new NEW_SERVICE_TOKEN --expect-project prj_xxx
npm run env:sync:production -- --only GOOGLE_SHEET_ID --expect-project prj_xxx
```

Run `env:check` first: it prints the resolved `projectId` / `orgId` (from `.vercel/repo.json` in Vercel CLI 66.2.0, or `.vercel/project.json` in older links), names, and `create`, `update`, `skip`, or `blocked` for each target. `update` means an existing target-only record would be overwritten; the CLI does not reveal its value, so the check cannot tell whether the value already matches `.env`. The check never writes and exits 1 whenever an apply would be refused. An apply **requires** `--expect-project <that projectId>` (and optionally `--expect-org`) and an interactive confirmation.

Other options: `--offline` (dry run without calling the CLI) and `--env-file <path>`.

### What it does

- **Default allowlist:** `GOOGLE_SHEET_ID`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `NEXT_PUBLIC_BOOKING_URL` (list in `scripts/lib/env-sync.ts`). Missing or empty local values are skipped, never written as blanks. `AI_PROVIDER`, `GROQ_API_KEY` and `GROQ_MODEL` are deliberately not in the default list: they show up as `propose` and need `--approve-new` (see below), so a routine sync cannot change which provider production uses.
- **New entries:** nonempty names in `.env` are shown as `propose` when absent from every Vercel environment. For Preview, a name with one Production-only record is shown as `propose-preview`. A normal sync leaves proposals untouched. To approve creation, run `npm run env:sync:preview -- --approve-new NAME[,NAME...] --expect-project <id>` and type `sync preview`. This focused run creates only the approved Preview entries, without `--force`; if a Preview value already exists or the scope becomes ambiguous, the whole run is refused. It can create approved Production-only names even while another name remains shared and blocked. `--only` and `--approve-new` cannot be combined. Add new application variables to `.env.example` without values or credentials.
- **Opt-in secret:** `REPORT_TOKEN_SECRET` is **not** part of a default run. It needs `--only REPORT_TOKEN_SECRET --allow-secret-rotation`, prints a warning, and requires `rotate preview secrets` or `rotate production secrets` for the selected target. Replacing it invalidates every PDF download window that is still open (5 minutes at most).
- **Never synced, on purpose:** the retired Neon / Resend / cron variables (`DATABASE_URL*`, `RESEND_*`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `APP_URL`, `CRON_SECRET`, `REPORT_EMAIL_ENABLED`, `REPORT_EMAIL_ALLOWLIST`) and the legacy `GOOGLE_SHEETS_WEBHOOK_*`. A stale local value is never pushed or proposed, and the tool never deletes anything: remove the obsolete variables from Vercel yourself when you are ready. Runtime names such as `VERCEL_*`, `NOW_*`, and `NODE_ENV` are not proposed as new variables either. Asking for a protected name with `--only` or `--approve-new` is an error.
- **Create or update, failing closed:** the tool lists the project's variables (`vercel env ls --format json`; malformed or unexpected output is an error) and reads the project's **custom environments** (`vercel api /v9/projects/<projectId>/custom-environments`). It then writes a variable only in two cases:
  - **create** — the variable is absent from the listing, or a Preview entry is absent while exactly one Production-only record exists. Run as `vercel env add NAME --environment <target> --project <projectId> --type <secret|config> --yes` with **no `--force`**, so a same-target value cannot be overwritten. The value goes over stdin. New variables default to Secret; `NEXT_PUBLIC_*` names use Config because they are exposed to the browser.
  - **update** — exactly one record for the selected target only, no branch scope, and **the project has no custom environments**. Run with `--environment <target> --project <projectId> --force --yes`, the only place `--force` is used. The script requires its own typed confirmation before this call.
  - Anything else is `blocked` (shared with another environment, split across records, branch-scoped, or a custom environment exists) and the whole apply is refused with nothing written. If the listing or the custom-environment read fails, an apply is refused too. Nothing is ever removed, so unrelated variables are untouched.
  - A shared Production + Preview record stays `blocked`; the script never changes its scope. Separate it safely in the Vercel dashboard before attempting to change its Preview value. Preview-only records are never overwritten by `--approve-new`.
- **What actually protects you, and what only might.** The CLI's JSON listing is lossy: it contains `key`, `target`, `gitBranch`, `type`, `visibility`, `createdAt` and `updatedAt`, but **not** `customEnvironmentIds`, `hiddenProductionEnvCount` or pagination data, which the underlying API can return. So:
  - _Works with the real CLI output:_ the `target` / `gitBranch` / duplicate-record classification; the custom-environment count read through `vercel api` (a custom environment anywhere blocks every update, because `target: ["production"]` does not prove "Production only"); the create-without-`--force` rule; the plan re-check after you confirm; stdin-only values and redaction.
  - _Theoretical only:_ the checks that reject a listing declaring `hiddenProductionEnvCount` ≠ 0, a `pagination.next` cursor, or a record carrying `customEnvironmentIds`. They only fire if some future CLI version starts emitting those fields; **they do not protect a run today** and nothing relies on them.
  - _Why a truncated or partial listing cannot cause an overwrite anyway:_ an update needs one visible Production-only record, and two records cannot own the Production target, so a missing record can at worst turn an intended update into a create. A create never sends `upsert`, and per the Vercel API reference (`POST /v10/projects/{id}/env`, `upsert` = "Allow override of environment variable if it already exists") the API then refuses a variable that already exists (documented as 403 "already exists" / 409). The run stops at that variable and names what was already written. To change a blocked variable, split it in the dashboard (Production on its own) and re-run.
  - _Why `--force` is limited:_ it is a server-side upsert, and we could not prove that it leaves the other environments of a shared record alone.
- **Plan and apply must match:** after you type the phrase, the tool reads the variables and custom environments **again** and compares them with the plan you confirmed (operations, scopes, change timestamps, custom-environment count). Any difference, or a failed re-read, aborts with nothing written. After **each create**, it reads Vercel again and requires one new independent target-only record while existing records retain their metadata. An exit code of 0 alone is never treated as proof of creation. If the read fails or the expected record is absent, the run stops before the next variable; the current create's outcome is uncertain and must be inspected in Vercel before retrying. Secret values cannot be read back, so this verifies record existence and scope, not value bytes.
- **No secret exposure:** values reach the CLI through its **stdin**, never argv, a shell command, a log or the plan (which shows `<hidden>`). The `.env` is not loaded into the process environment, and all CLI output is redacted (plain, JSON-escaped, URL-encoded, base64, per-line and embedded-password forms of every local value of 8+ characters) before it is printed. The CLI child is pinned to the displayed project via `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`; a conflicting value for either in your shell is an error.
- **Confirmation:** applying requires typing the exact phrase in an interactive terminal (stdin **and** stdout must be TTYs); piped or CI runs are refused, and the script does not accept `--yes`. The child CLI receives `--yes` only after this confirmation to choose its default all-branches Preview scope without a second prompt. A dry run never writes.
- **Protected source:** the run aborts if the env file is tracked by git or not git-ignored. `.gitignore` ignores `.env` and every `.env.*` variant (`.env.local`, `.env.production`, …) except the `.env.example` template, plus `.vercel/`, `.neon` and `*.pem`.
- **No deployment:** Vercel applies new values only to the next deployment, so redeploy the selected target afterwards. `NEXT_PUBLIC_BOOKING_URL` is inlined at build time.
- **If a write fails** the run stops and names the variables already verified. If a create is unverified, inspect Vercel before retrying; the CLI may have written the record even though the verification read failed.

### Real CLI verification limits

The previous scripted workflow piped only a value into a non-TTY CLI process, leaving the variable-type and Preview Git-branch choices unresolved. It reported `ok` from the CLI exit code alone, but the next listing still lacked the records. A manual `vercel env add GROQ_API_KEY preview` worked after the operator answered the type, value, and branch prompts, so the positional `preview` syntax was not the cause by itself. This version supplies the type and all-branches choice explicitly, keeps values on stdin, and verifies each creation through a fresh listing. The tests drive a **fake** `vercel` binary; they cover exit-zero no-ops, unresolved prompts, and wrong scopes, but the corrected write has not been exercised against a real project under this change. Rehearse on a **disposable Vercel project** before the next real apply:

1. A create (`env add NAME production`, no `--force`) of a variable that already exists is **refused** by the CLI/API rather than overwritten (expected from the spec; not tested).
2. `--force` on a lone Production-only record changes only that record.
3. `vercel api /v9/projects/<id>/custom-environments` runs under the project's own team and returns `{ "environments": [...] }`. It uses the CLI's saved team, not `VERCEL_ORG_ID`, so a different saved team should make it fail (and the apply be refused), not return wrong data. Accounts without custom environments may get a 404 that this tool also treats as "cannot verify".
4. Multi-line values (`GOOGLE_PRIVATE_KEY`) round-trip intact through stdin.
5. A shell that defines both `NOW_*` and `VERCEL_*` project variables may make the CLI abort (so the run is refused).

This script is only ever run by hand: no package lifecycle script, git hook, CI workflow or Vercel build step invokes it, and an apply needs an interactive terminal plus a typed phrase.

## Booking

Set `NEXT_PUBLIC_BOOKING_URL` to the real, published Google Appointment Schedule booking page. The client CTA opens it in a separate tab (no Calendar API/OAuth required). Test actual availability and confirmation with the calendar owner.

## Security and scope

- Must validate privacy/consent language and suitability of questions before a public blast.
- No scoring adjustments for nonapplicable questions. All twenty must be answered. Confirm this business rule before launch.
- Questionnaire responses live only in the header-mapped Google Sheet. Reports and PDFs are not stored anywhere: the browser holds the report in memory and the PDF is rendered only for a request carrying a valid, unexpired, report-specific grant; there are no public links.
- Rate limiting / CAPTCHA (the database-backed limits were removed with Neon: use the Vercel Firewall rule in `docs/pdf-download.md`), spam monitoring, credential rotation, retention policies, authorized staff access, and legal review are needed before a high-volume campaign.
- Ensure Vercel plan permits commercial usage. Secrets must never be in `NEXT_PUBLIC_` vars or committed.
