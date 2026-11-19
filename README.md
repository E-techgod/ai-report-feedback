# Quirón Shield Survey — MVP

Standalone Next.js questionnaire: 20 yes/no questions, deterministic score, AI-assisted short summary, report/PDF via browser print, and appointment-booking CTA.

## Setup

1. Node 22: `nvm use 22`
2. `npm install`
3. `cp .env.example .env.local` and set configured credentials
4. `npm run dev`
5. `npm run typecheck && npm run lint && npm run build`

## Important: integrating into an existing repository

This ZIP is a standalone Next.js app. Do **not** copy its `package.json`, `tsconfig.json`, or files on top of an existing repository without comparing them. Merge `src/app`, `src/lib`, and the Apps Script with your actual repo, preserving any existing implementation. If you replace a starter repo, remove obsolete starter code. Push a reviewed commit to GitHub to trigger Vercel deployment.

## Google Sheets (POST /api/questionnaire)

The UI submits to `POST /api/questionnaire`, which appends one row to the **existing** spreadsheet tab `Respuestas de formulario 1`, columns A:X, in the Google Form's order: timestamp, name, surname, email, A1–A10, B1–B10 (answers persisted as `Si`/`No`, matching the historical Form data; the UI still shows "Sí"). No new sheet, columns or tabs are created and existing rows are never modified.

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

The results page is `src/components/ReportView.tsx` (styles: `ReportView.module.css`), built from `report-template/quiron-report-prototype-v2.html`.

- **Rules engine (~65%)** — `src/lib/report.ts`: score, level (same labels as the Dashboard), the 6 areas, ranked top-3 priorities, findings, actions and the action plan. Deterministic and covered by tests.
- **Fixed interface (~20%)** — headings, descriptions, CTA, disclaimer.
- **AI (~15%)** — exactly 4 text slots filled by `POST /api/summary`: an executive summary (≤90 words) and a short context for each priority (≤25 words). The AI never calculates, selects or reorders anything. It receives only the computed result (`buildAiInput`): score, level, number of areas to strengthen, focus, and the priorities' titles/findings/actions. No names, emails or raw answers.
- **Fallback** — if `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` are missing, the call fails, times out (8.5 s) or returns something outside the contract, the report shows template text (`fallbackNarrative`) and the "Cómo se elaboró este reporte" note says the AI was not used. The reason is logged server-side as `[summary] AI fallback used: <reason>`.
- **PDF** — "Descargar PDF" opens the browser print dialog (choose _Save as PDF_). The button waits until the AI text has loaded so the PDF matches the page. Print layout (A4, logo header, no navigation) is in the `@media print` block of `ReportView.module.css`.
- **Editing the design** — run `npm run dev` and open `/report-preview` (development only, 404 in production). It renders the report from sample answers; use `?view=client&ai=1&preset=0` to start in a given state. The "Vista del equipo" mode shows the prototype's review annotations and the 65/20/15 panel; customers always get the client view.
- **Editorial review needed** — the area/priority/context catalog in `src/lib/report.ts` (`THEMES`) reuses the prototype wording for three areas; the other three are drafts in the same tone.

`ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are server-only; set `ANTHROPIC_MODEL` to an exact, currently available model ID.

## Booking

Set `NEXT_PUBLIC_BOOKING_URL` to the real, published Google Appointment Schedule booking page. The client CTA opens it in a separate tab (no Calendar API/OAuth required). Test actual availability and confirmation with the calendar owner.

## Security and scope

- Must validate privacy/consent language and suitability of questions before a public blast.
- No scoring adjustments for nonapplicable questions. All twenty must be answered. Confirm this business rule before launch.
- Google Sheets is the sole persistence layer. No public report retrieval links or dashboard in V1.
- Rate limiting / CAPTCHA, spam monitoring, credential rotation, retention policies, authorized staff access, and legal review are needed before a high-volume campaign.
- Ensure Vercel plan permits commercial usage. Secrets must never be in `NEXT_PUBLIC_` vars or committed.
- Do not start bulk emailing until the webhook, AI fallback, booking, and responsive UI are verified end to end.
