# PDF download flow (stateless)

Google Sheets is the only data store. No database, no email provider, no cron.

```
POST /api/questionnaire
  1. validate (consent mandatory)
  2. append the header-mapped row to the Sheet      -> failure: 502, no report, no grant
  3. generate the report (rules + AI narrative)     -> failure: 502 (answers stay saved), no grant
  4. issue a 5-minute download grant
  <- { report, download: { token, expiresInMs } }   (report is NOT stored)

POST /api/report/pdf       header x-download-token, body = the report JSON
  verify grant -> render PDF with the existing ReportPdf template -> application/pdf
```

## The grant (`src/lib/download-grant.ts`)

`token = "<expiresAtMs>.<HMAC-SHA256(REPORT_TOKEN_SECRET, 'download:v1.<reportHash>.<expiresAtMs>')>"`

- `reportHash` is the SHA-256 of the canonical report (it covers `reportId`, `submissionId`, the
  answers-derived model and the AI narrative). A grant only works with the exact report it was
  issued for: another client's report or an edited copy fails with 401.
- The expiry is inside the signature, so it cannot be extended. The server answers 410 with
  "Tu sesión de descarga ha expirado." once `now >= expiresAt`. Repeated downloads before that are
  allowed.
- Verification needs only `REPORT_TOKEN_SECRET`, so it works on any Vercel function instance.
- The token contains no report content. The report travels in a POST body, never in a URL.
- The browser keeps the report and grant in React state only (no localStorage). A reload ends the
  session; there is no way to retrieve or regenerate the report afterwards.
- The page's countdown is display only; the server is the authority.

## Sheet columns

The row is appended exactly as before (`Estado Reporte = Pendiente` and the `submission:<uuid>` marker
in `ID Reporte`, which makes retries idempotent). After the report is generated the app sets that
one row's `Estado Reporte` cell to `Generado`, after the response is sent:

- it re-reads the row and writes only if the email and all 20 answers still match (rows can move);
- it writes a single cell, never other rows, answers or formatting;
- a failure is logged and ignored: the customer's download is unaffected and the cell stays
  `Pendiente`;
- a report with template text (AI unavailable) also counts as `Generado`; failed submissions never do.

Every other tracking column (`Estado Email`, `Estado Descarga PDF`, `Fecha *`, `Intentos Email`, ...)
stays empty: there is nothing to project. The legacy Apps Script files in `scripts/` are untouched.
