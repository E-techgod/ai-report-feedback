# PDF download flow (stateless)

Google Sheets is the only data store. No database, no email provider, no cron.

```
POST /api/questionnaire
  1. validate (consent mandatory)
  2. Sheet: duplicate check, then per-email limit    -> over the limit: 429, nothing else runs
  3. append the header-mapped row to the Sheet       -> failure: 502, no report, no grant
  4. generate the report (rules + AI narrative)      -> failure: 502 (answers stay saved), no grant
     (a duplicate never calls the AI, see "Duplicates")
  5. issue a 5-minute download grant
  <- { report, download: { token, expiresInMs } }    (report is NOT stored)

POST /api/report/pdf       header x-download-token, body = the report JSON
  verify grant -> render PDF with the existing ReportPdf template
  -> count it in the ledger (max 5 per submission)    -> over: 429
  -> application/pdf
```

## The grant (`src/lib/download-grant.ts`)

`token = "<expiresAtMs>.<HMAC-SHA256(REPORT_TOKEN_SECRET, 'download:v1.<reportHash>.<expiresAtMs>')>"`

- `reportHash` is the SHA-256 of the canonical report (it covers `reportId`, `submissionId`, the
  answers-derived model and the AI narrative). A grant only works with the exact report it was
  issued for: another client's report or an edited copy fails with 401.
- The expiry is inside the signature, so it cannot be extended. The server answers 410 with
  "Tu sesión de descarga ha expirado." once `now >= expiresAt`. Within that window a submission may
  download its PDF up to **5 times** (see "Download limit"), then the server answers 429.
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

## Abuse protection

Everything below uses only the existing Google spreadsheet: no Neon, no Redis, no new paid service,
no stored PDF. Where a limit cannot be enforced perfectly with a spreadsheet, the trade-off is stated.

### Submission limit: 5 per email per rolling 24 hours

`src/lib/sheets.ts` (`MAX_SUBMISSIONS_PER_EMAIL`, `SUBMISSION_WINDOW_HOURS`).

- Order inside `POST /api/questionnaire`: same-id check -> duplicate check -> **limit check** ->
  append. The limit is decided before the AI or the report generator is reached; a refusal costs a few
  Sheet reads and nothing else.
- The limit counts the email's rows in the response tab. It is over when the email's 5 newest rows all
  fall inside the last 24 hours; the answer is `429` with `Retry-After` and a message such as
  "Has alcanzado el límite de 5 diagnósticos en 24 horas con este correo. Por favor inténtalo de nuevo
  en aproximadamente 3 horas."
- Emails are compared case-insensitively. Duplicates (below) add no row, so they never count.

**Concurrency, and why a spreadsheet is a weak lock.** Google Sheets has no transactions or
compare-and-set. A plain "count, then append" would let N parallel requests all see 4 rows and all
write. So the check is done twice:

1. _Before_ appending (cheap refusal for the normal case).
2. _After_ appending: the new row's position among that email's rows is read back. Sheets appends are
   atomic and ordered, so concurrent requests get distinct rows, and a row is accepted only if fewer
   than 5 same-email rows inside the window precede it. Rows before it always already exist, so every
   racing request reaches a consistent verdict about itself: exactly 5 win, the rest get 429.

A request that loses that race keeps its row (the lead is not lost) with `Estado Reporte =
Rechazado por límite`, and retrying its submission id is judged by the same rule (it is **not**
treated as a harmless duplicate).

Known limitations (none of them is hidden by the code):

- It depends on row order. Sorting, re-ordering or inserting rows in the response tab changes who
  counts as "before". Deleting a row frees that slot. Rows whose timestamp is not a real date/time
  (for example hand-typed text) are ignored by the window.
- Rows from racing losers stay in the Sheet and keep counting toward the window. That can only make the
  limit slightly stricter, never looser.
- It limits an _address_, not a person. `ana+1@gmail.com`, `a.na@gmail.com` and throw-away addresses are
  different emails, and nothing verifies that the address is real or owned by the sender. Per-email
  limiting protects cost and fairness; resistance to bots comes from the Firewall rule below (and
  BotID or a challenge if abuse appears).
- It costs Google API calls (roughly 10 per submission; the limit adds one read). Google's per-user
  quota is on the order of 60 reads per minute (check your Cloud console): a flood can exhaust it and
  make submissions fail with 502. The Firewall rule is what keeps floods away from Sheets.
- Timestamps are in the spreadsheet's time zone; around a daylight-saving change the window can be off
  by an hour.

### Download limit: 5 successful downloads per submission

`src/lib/download-ledger.ts`, `src/lib/report-pdf-handler.ts`.

The grant still expires after 5 minutes and is still bound to its report. On top of that, each
**submission** may download its PDF at most 5 times (all grants issued for the same submission, even by
a repeated survey, share one budget). A render that fails does not use a download.

The count is kept in an **append-only ledger tab** in the same spreadsheet, `Control de descargas`
(created automatically the first time a download is made; no setup needed). One row per delivered PDF,
two columns: a UTC timestamp and an opaque key (`dl_` + 32 hex of an HMAC of the submission id with
`REPORT_TOKEN_SECRET`). It holds no email, name, answers, report or token.

How it stays correct under concurrency: render the PDF, append one ledger row, read the key column up
to that row, and count how many rows carry this key. That count is the row's _ordinal_; ordinals 1-5
are delivered, 6 and up are withheld with 429. Appends are atomic, so concurrent requests, even on
different serverless instances, get different ordinals and exactly five are delivered. Inside one
instance a per-submission queue runs same-grant requests one at a time, and once an instance has seen
a submission exhausted it refuses further attempts from memory without calling Google. That memory is
an optimization only; the ledger is the enforcement, so cold starts and other instances apply the same
limit.

Trade-offs:

- Render happens before the count, so a burst of N parallel requests renders up to N PDFs before the
  extra ones are withheld (they are never delivered). The queue and the memo keep this small.
- **It fails closed.** If the ledger cannot be reached or a write cannot be confirmed, the download is
  refused with 503 ("No pudimos verificar tu descarga...") rather than served unlimited. The failed
  attempt does not use a download, and the same grant works again once Google responds. If Google
  credentials are missing the route returns 503.
- A download that is delivered but never saved by the browser still counts.
- Reading the key column grows with the ledger. Rows older than the 5-minute window are never needed:
  you may clear the ledger rows (keep the header) now and then, ideally off-hours, since clearing during
  an active window resets the count of grants issued in the last 5 minutes.
- The ledger tab is created with the service account's Editor access. If you prefer to create it
  yourself, add a tab named exactly `Control de descargas`.

### Duplicates

A duplicate is the same submission id (a retry or double click) or the same email with identical answers
within 10 minutes (for example a page refresh and redo). Before this change a duplicate was treated
like a new request: it called the AI again and opened a fresh 5-minute window. Now:

- **No AI call.** The Sheet already answers "is this a duplicate?" before report generation, and a
  duplicate skips the AI.
- **No new window.** A duplicate's download window ends where the original's ended, and it shares the
  original's 5-download budget. Repeating the survey can never extend a deadline or multiply downloads.
- **Inside the window** the same function instance returns the report it just generated (a short-lived,
  in-memory cache that dies with the window, never written anywhere). On another instance or after a
  cold start there is no cached report, so the duplicate gets a report built from the approved template
  text (no AI call), clearly labelled as template text. That is a deliberate trade-off: a legitimate
  user always receives a PDF inside the authorized window, and an attacker cannot spend AI calls by
  repeating a form.
- **After the window** a duplicate is refused with 409 ("Ya recibimos este diagnóstico y su ventana de
  descarga de 5 minutos terminó...") and, if applicable, how long until a new report can be requested.
  There is no way to retrieve or regenerate a report after it expired. The same survey becomes a new
  submission once the 10-minute duplicate window passes (and then counts toward the daily limit).
- The cache keeps a report (answers-derived content and first name) in memory for at most the 5-minute
  window per instance. Nothing is persisted.

### Vercel Firewall (per-IP limit)

A per-IP counter needs shared state that survives across serverless instances (a database or Redis, which
this project does not use), and an in-memory counter is per instance and would not hold. So the per-IP
limit is a Vercel Firewall rule, which runs before the app. **Status checked on 2026-11-19 with `vercel firewall rules list`
(live configuration, project `ai-report-feedback`): the rule does not exist** ("No custom rules
configured"). It is a Production dashboard change that has not been applied; do it deliberately.

Dashboard (Project -> **Firewall** -> add a custom rule; menu labels can differ slightly between
dashboard versions):

| Setting           | Value                                                                         |
| ----------------- | ----------------------------------------------------------------------------- |
| Name              | `questionnaire-rate-limit`                                                    |
| If                | Request Path **equals** `/api/questionnaire` **and** Method **equals** `POST` |
| Then              | **Rate Limit**                                                                |
| Strategy          | Fixed Window                                                                  |
| Window / Requests | 60 s / 10 requests                                                            |
| Key               | IP address                                                                    |
| Action when over  | default `429 Too Many Requests`                                               |

Then **Review Changes -> Publish**. Equivalent CLI (stages a draft; nothing is live until `publish`;
confirm the generated condition names with `vercel firewall diff` before publishing):

```bash
vercel firewall rules add "questionnaire-rate-limit" \
  --condition '{"type":"path","op":"eq","value":"/api/questionnaire"}' \
  --condition '{"type":"method","op":"eq","value":"POST"}' \
  --action rate_limit --rate-limit-algo fixed_window \
  --rate-limit-requests 10 --rate-limit-window 60 --rate-limit-keys ip --yes
vercel firewall diff      # review
vercel firewall publish   # makes it live
```

- Verify after publishing: send 11 `POST /api/questionnaire` requests with body `{}` from one IP (they
  are rejected with 400 before touching Sheets or the AI, so the test is free); the 11th must return 429.
- One rule fits the Hobby allowance (1 rate-limit rule). `/api/report/pdf` is already bounded by the
  grant and the 5-download ledger, but each attempt that passes verification costs a render and a couple
  of Sheet calls; if your plan allows a second rule, add the same one for `/api/report/pdf`.
- Residual risk: many IPs (botnet) or many people behind one NAT. If abuse appears, add Vercel BotID or
  a challenge action; do not add a database or an in-memory limiter.

### Monitoring: structured, privacy-safe logs

`src/lib/security-log.ts` writes one JSON line per event to the Vercel runtime logs
(`"app":"bp-questionnaire"`). Only allow-listed fields are written, and any value that is not a short
machine token is replaced by `[redacted]`. **Never logged:** answers, email addresses, names, IP
addresses, download tokens, the report or its ids. Two opaque tags allow correlation without personal
data: `subject` (10 hex chars, a keyed hash of the email, not reversible without `REPORT_TOKEN_SECRET`)
and `grant` (8 hex chars of the ledger key).

| Event                        | Level | Meaning                                                                            |
| ---------------------------- | ----- | ---------------------------------------------------------------------------------- |
| `submission_rate_limited`    | warn  | 6th+ submission for an email in 24 h (`retryAfterSeconds`)                         |
| `submission_duplicate`       | info  | `outcome`: `served_cached_report`, `served_template_report`, `refused_window_over` |
| `download_served`            | info  | a PDF was delivered (`ordinal` 1-5)                                                |
| `download_limit_reached`     | warn  | the 6th+ download of a submission was refused                                      |
| `download_limit_unavailable` | warn  | the ledger could not be reached (download refused, 503)                            |
| `download_expired`           | warn  | a genuine grant used after its 5 minutes (410)                                     |
| `download_unauthorized`      | warn  | missing/invalid/mismatched grant (`reason`)                                        |

What to look for in Vercel Logs (search the event name): the same `subject` appearing repeatedly in
`submission_rate_limited`; bursts of `download_unauthorized` (someone guessing tokens) or
`download_limit_reached` (a grant being hammered); any `download_limit_unavailable` (Google outage or
quota exhaustion). IP addresses are not in these logs; they are in Vercel's request logs and the
Firewall dashboard. There is no alerting in the app: set one up in Vercel (Log Drains or Alerts) if
you need it.

### Tests

`tests/rate-limit-submissions.test.mjs` (limit, rolling window, duplicates, concurrency, retry of a
refused request), `tests/download-limit.test.mjs` (5 downloads, expiry, unauthorized, concurrency
across instances, fail-closed, ledger privacy), `tests/duplicate-handling.test.mjs` (no AI call, no
extended window, shared budget, 409 after the window), `tests/security-log.test.mjs` (redaction).
They run against in-memory fakes with the same ordering guarantees as Sheets; there is no automated
test against real Google, so run the verification in the PR description before relying on this in
Production.
