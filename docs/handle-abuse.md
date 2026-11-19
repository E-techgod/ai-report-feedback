# Handling abuse and rate limits

How the app protects its three costly resources, how to tell when someone is abusing it, and what to
do about it.

- **Groq (AI)**: every new submission costs one AI call.
- **Google Sheets**: every submission and every download uses Sheets API calls (and Google's quota is
  shared by everyone).
- **PDF generation**: every download renders a PDF on the server.

Hard constraints this design respects: Google Sheets stays the system of record; **no database, no
Redis, no extra paid service, and no stored PDFs**. Where a spreadsheet cannot enforce something
perfectly, this document says so ([Limitations](#limitations-read-this)).

> **Status of the per-IP protection:** the Vercel Firewall rule is **not created yet** (checked on
> 2026-11-19). Until it is, nothing limits requests per IP. See [Do this before launch](#do-this-before-launch).

## At a glance

| What                      | Limit                                          | Enforced by                        | Over the limit                    |
| ------------------------- | ---------------------------------------------- | ---------------------------------- | --------------------------------- |
| Submissions per email     | **5 per rolling 24 hours**                     | the app, against the Sheet         | `429` + `Retry-After`, no AI call |
| Downloads per submission  | **5 successful**, only within the 5-min window | the app, against the ledger tab    | `429`                             |
| Download window           | **5 minutes** from when the report is ready    | signed token (HMAC)                | `410` expired                     |
| Repeating the same survey | same email + answers within **10 minutes**     | the app, against the Sheet         | no AI call, no new window         |
| Requests per IP           | **10 per minute** on `/api/questionnaire`      | **Vercel Firewall (to be set up)** | `429` from Vercel                 |

## 1. Submissions: 5 per email per rolling 24 hours

Code: `src/lib/sheets.ts` (`MAX_SUBMISSIONS_PER_EMAIL`, `SUBMISSION_WINDOW_HOURS`).

Order of checks inside `POST /api/questionnaire`:

```
validate -> same id already saved? -> same email + same answers in last 10 min?
         -> over the 5-per-24h limit?  -> append row -> (re-check, see below) -> AI report -> grant
```

The limit is decided **before** the AI or the report generator is reached, so a refused request costs
a few Sheet reads and nothing else. "Rolling" means the limit is over when the email's 5 newest rows
all fall inside the last 24 hours; the oldest one leaving the window frees exactly one slot.

What the person sees: `429` and a message like _"Has alcanzado el límite de 5 diagnósticos en 24
horas con este correo. Por favor inténtalo de nuevo en aproximadamente 3 horas."_ The response also
carries a `Retry-After` header (seconds). Emails are compared case-insensitively.

### Why it needs a second check (concurrency)

Google Sheets has no transactions or "compare and set". If the app only counted rows and then wrote,
ten simultaneous requests could all count 4 and all write. So the check runs twice:

1. **Before appending** (cheap refusal in the normal case).
2. **After appending**: the new row's position among that email's rows is read back. Sheets appends
   are atomic and ordered, so concurrent requests get different rows. A row is accepted only if fewer
   than 5 same-email rows inside the window come before it. Rows before it always exist already, so
   every racing request reaches a consistent verdict: **exactly 5 win**, the rest get `429`.

A request that loses the race keeps its row (the lead is not lost), marked `Estado Reporte =
Rechazado por límite`. If it retries with the same submission id it is judged by the same rule again;
it is **not** treated as a harmless duplicate.

## 2. Duplicates: no AI call, no second window

A **duplicate** is the same submission id (a retry or double click) or the same email with identical
answers within 10 minutes (for example a page refresh and redo). Duplicates add no Sheet row, so they
never count toward the 5-per-day limit.

Before this change a duplicate called the AI again and received a brand-new 5-minute window (a way to
regenerate a report after it expired). Now:

- **No AI call.** The Sheet already answers "is this a duplicate?" before any report is generated.
- **No new window.** A duplicate's window ends where the original's ended, and it shares the
  original's 5 downloads. Repeating the survey can never extend a deadline or multiply downloads.
- **Inside the window** the same server instance hands back the report it just generated (a short
  in-memory cache that dies with the window; nothing is written anywhere). On another instance, or
  after a cold start, there is no cached report, so the duplicate gets a report built from the
  **approved template text** (no AI call), clearly labelled as template text. This is a deliberate
  trade-off: a legitimate user always gets a PDF inside the window, and nobody can spend AI calls by
  repeating a form.
- **After the window** the duplicate is refused with `409`: _"Ya recibimos este diagnóstico y su
  ventana de descarga de 5 minutos terminó..."_, plus how long until a new report can be requested.
  There is no way to retrieve or regenerate a report after it expired. After the 10-minute duplicate
  window, the same answers count as a new submission (and use one of the 5 daily slots).

## 3. Downloads: 5 successful per submission

Code: `src/lib/download-ledger.ts`, `src/lib/report-pdf-handler.ts`, `src/lib/download-grant.ts`.

The download grant is unchanged: a signed token that expires 5 minutes after the report is ready and
only works with its exact report. On top of that, each **submission** can download its PDF at most
**5 times**. All grants issued for the same submission (including by a repeated survey) share one
budget. A render that fails does not use a download.

### The ledger tab

The count lives in an **append-only tab** of the same spreadsheet named `Control de descargas`. It is
created automatically on the first download (no setup needed). One row per delivered PDF, two columns:

| Fecha (UTC)              | Concesión de descarga                  |
| ------------------------ | -------------------------------------- |
| `2026-11-19T18:02:11.4Z` | `dl_3f9a...` (32 hex, keyed HMAC hash) |

It contains **no email, name, answers, report or token**: the key is an HMAC of the submission id with
`REPORT_TOKEN_SECRET`, so it cannot be traced back to a person without that secret.

### How it stays correct under concurrency

```
render PDF -> append one ledger row -> read the key column up to that row
           -> ordinal = how many rows carry this key (itself included)
           -> ordinal 1..5: deliver the PDF      ordinal 6+: withhold it (429)
```

Appends are atomic, so concurrent requests, **even on different serverless instances**, get different
ordinals and exactly 5 are delivered. Inside one instance a per-submission queue runs same-grant
requests one at a time, and once an instance has seen a submission exhausted it refuses further
attempts from memory without calling Google. That memory only saves work; the ledger is the
enforcement, so cold starts and other instances apply the same limit.

**It fails closed.** If the ledger cannot be reached, or a write cannot be confirmed, the download is
refused with `503` ("No pudimos verificar tu descarga...") rather than served without a limit. That
attempt does not use a download, and the same grant works again once Google responds. If Google
credentials are missing the route returns `503` too.

## 4. Per-IP limit: Vercel Firewall (to be set up)

A per-IP counter needs shared state that survives across serverless instances (a database or Redis,
which this project does not use), and an in-memory counter is per instance and would not hold. So the
per-IP limit is a **Vercel Firewall rule**, which runs before the app. It also keeps floods away from
the Sheets quota, which is what the in-app limits cannot do on their own.

## 5. Monitoring: structured, privacy-safe logs

Code: `src/lib/security-log.ts`. One JSON line per event in the Vercel runtime logs, tagged
`"app":"bp-questionnaire"`. Search the logs for the event name.

```json
{"app":"bp-questionnaire","event":"submission_rate_limited","subject":"2158bd1037","reason":"email_24h","limit":5,"retryAfterSeconds":3600}
{"app":"bp-questionnaire","event":"download_served","grant":"3f9a1c2b","ordinal":2,"limit":5}
```

| Event                        | Level | Meaning                                                                              |
| ---------------------------- | ----- | ------------------------------------------------------------------------------------ |
| `submission_rate_limited`    | warn  | 6th or later submission for an email in 24 h (`retryAfterSeconds`)                   |
| `submission_duplicate`       | info  | `outcome`: `served_cached_report`, `served_template_report` or `refused_window_over` |
| `download_served`            | info  | a PDF was delivered (`ordinal` 1 to 5)                                               |
| `download_limit_reached`     | warn  | the 6th or later download of a submission was refused                                |
| `download_limit_unavailable` | warn  | the ledger could not be reached (download refused, `503`)                            |
| `download_expired`           | warn  | a genuine grant used after its 5 minutes (`410`)                                     |
| `download_unauthorized`      | warn  | missing, invalid or mismatched grant (`reason`)                                      |

**What is never logged:** questionnaire answers, email addresses, names, IP addresses, download tokens,
the report or its ids. Only allow-listed fields are written, and any value that is not a short machine
token (letters, digits and `_ - . :`) is replaced by `[redacted]`, so an email or a token cannot slip
in by mistake.

Two opaque tags let you correlate events without personal data:

- `subject`: 10 hex characters of a keyed hash of the email. The same email always gives the same tag,
  but it cannot be reversed or recomputed without `REPORT_TOKEN_SECRET`.
- `grant`: 8 hex characters of the ledger key of a submission.

IP addresses are not in these logs; they are in Vercel's own request logs and the Firewall dashboard.
The app does no alerting by itself: set up Vercel Log Drains or Alerts if you want to be notified.

## What to do when...

### A real user says "I can't submit" (they got the 5-per-day message)

1. Search the logs for `submission_rate_limited`; `retryAfterSeconds` is how long until a slot frees.
2. The simplest answer is to wait (the message tells them how long). Five diagnostics in a day is far
   above normal for one person, so first check whether several people share one email.
3. If you must let them through, a slot frees when one of that email's rows leaves the window **or is
   deleted from the response tab**. The Sheet is your system of record: copy the row somewhere safe
   before deleting it.

### A real user says "it says I reached the download limit" or "the session expired"

- Both are by design: 5 downloads and 5 minutes per report, and nothing can be retrieved or
  regenerated afterwards.
- They can take the survey again. Repeating the **same** answers within the first 5 minutes just gives
  the same report back (same deadline); between minute 5 and minute 10 they get a `409`; after 10
  minutes it is a new submission (and uses one of the 5 daily slots).

### Downloads fail with "No pudimos verificar tu descarga" (`503`)

1. Search for `download_limit_unavailable`.
2. It means Google could not be reached or the ledger write was not confirmed: check Google Workspace
   status, the service account's access to the spreadsheet, and the Sheets API quota (Google Cloud
   console). It also happens if `GOOGLE_*` variables are missing.
3. Nothing is lost: the attempt did not use a download, and the grant works again once Google responds
   (within its 5 minutes).

### You suspect a bot or a flood

Signs: many `submission_rate_limited` events; bursts of `download_unauthorized` (someone guessing
tokens) or `download_limit_reached` (a grant being hammered); many new rows from different emails with
similar answers; `502` errors from Sheets (quota).

1. Check the **Firewall** dashboard in Vercel for the source IPs and the traffic spike.
2. Make sure the [per-IP rule](#do-this-before-launch) is live; tighten it if needed.
3. Add a **challenge** action or **Vercel BotID** for `/api/questionnaire`.
4. Do not try to fix this with an in-memory or database limiter in the app (see section 4).

### The `Control de descargas` tab is getting long

Reads grow with the tab. Rows older than 5 minutes are never needed, so you can clear all rows except
the header at any time. Do it **off-hours**: clearing while someone is inside their 5-minute window
resets the count for that person. If you prefer to create the tab yourself, name it exactly
`Control de descargas`.

## Tuning the limits

| Setting                    | Where                                                        | Default |
| -------------------------- | ------------------------------------------------------------ | ------- |
| Submissions per email      | `MAX_SUBMISSIONS_PER_EMAIL`, `src/lib/sheets.ts`             | 5       |
| Submission window (hours)  | `SUBMISSION_WINDOW_HOURS`, `src/lib/sheets.ts`               | 24      |
| Duplicate window (minutes) | `DUPLICATE_WINDOW_MINUTES`, `src/lib/sheets.ts`              | 10      |
| Downloads per submission   | `MAX_DOWNLOADS_PER_SUBMISSION`, `src/lib/download-ledger.ts` | 5       |
| Download window (ms)       | `DOWNLOAD_WINDOW_MS`, `src/lib/download-grant.ts`            | 5 min   |

Some user-facing text repeats these numbers literally and **must be edited by hand** when you change
them: `DOWNLOAD_COPY` in `src/components/ReportView.tsx` ("hasta 5 veces durante 5 minutos", "límite de
5 descargas") and the `409` message in `src/lib/questionnaire-handler.ts` ("ventana de descarga de 5
minutos"). The `429` messages for submissions and for the PDF use the constants. Then run the tests;
several of them assert the limits.

## Do this before launch

These are not done by the code and need a person:

1. **Create the Vercel Firewall rule** (a Production change that has to be made deliberately):

   | Setting           | Value                                                                         |
   | ----------------- | ----------------------------------------------------------------------------- |
   | Name              | `questionnaire-rate-limit`                                                    |
   | If                | Request Path **equals** `/api/questionnaire` **and** Method **equals** `POST` |
   | Then              | **Rate Limit**                                                                |
   | Strategy          | Fixed Window                                                                  |
   | Window / Requests | 60 s / 10 requests                                                            |
   | Key               | IP address                                                                    |
   | Action when over  | default `429 Too Many Requests`                                               |

   In the dashboard: Project, then **Firewall**, add a custom rule (menu labels can differ slightly
   between versions), then review and **Publish**. Equivalent CLI (stages a draft; nothing is live until
   `publish`; confirm the generated condition names with `vercel firewall diff` first):

   ```bash
   vercel firewall rules add "questionnaire-rate-limit" \
     --condition '{"type":"path","op":"eq","value":"/api/questionnaire"}' \
     --condition '{"type":"method","op":"eq","value":"POST"}' \
     --action rate_limit --rate-limit-algo fixed_window \
     --rate-limit-requests 10 --rate-limit-window 60 --rate-limit-keys ip --yes
   vercel firewall diff      # review the draft
   vercel firewall publish   # makes it live
   ```

   Check that it exists with `vercel firewall rules list`. To verify it works, send 11
   `POST /api/questionnaire` requests with body `{}` from one IP (they are rejected with `400` before
   touching Sheets or the AI, so the test is free): the 11th must return `429`. One rule fits the
   Hobby plan's allowance (1 rate-limit rule). `/api/report/pdf` is already bounded by the grant and the
   ledger, but if your plan allows a second rule, add the same one for it.

2. **Test against a copy of the spreadsheet, not Production.** The automated tests use in-memory fakes
   with the same ordering guarantees as Sheets, but nothing in them talks to real Google. On a test
   spreadsheet confirm that: the `Control de descargas` tab is created; one report downloads 5 times and
   the 6th returns `429`; and 6 submissions from one email return `429` on the 6th.

3. Optionally set up alerts on the security logs (Vercel Log Drains or Alerts).

## Limitations (read this)

None of these is hidden by the code.

- **Per email address, not per person.** `ana+1@gmail.com`, `a.na@gmail.com` and throw-away addresses
  are different emails, and nothing verifies that the address is real or belongs to the sender. The
  per-email limit protects cost and fairness; resistance to bots has to come from the Firewall rule
  (plus BotID or a challenge if abuse appears).
- **The email limit depends on row order** in the response tab. Do not sort, re-order or insert rows
  there. Deleting a row frees a slot. Rows whose timestamp is not a real date and time (for example
  typed by hand) are ignored by the window.
- **Race losers keep a labelled row** and it keeps counting toward the window. That can only make the
  limit slightly stricter, never looser.
- **Sheets API cost and quota.** A submission makes roughly 10 Sheets calls (the limit adds one read).
  Google's per-user quota is on the order of 60 reads per minute (check your Cloud console), so a flood
  can exhaust it and make submissions fail with `502`. Only the Firewall rule keeps floods away from it.
- **Render before count.** A burst of N parallel download requests can render up to N PDFs before the
  extra ones are withheld (they are never delivered). The per-submission queue and the in-memory
  "exhausted" memo keep this small.
- **A PDF that is delivered but never saved by the browser still counts** as one of the 5.
- **A duplicate served by a different instance has template text**, not AI text, by design (section 2).
- **The cached report** (answers-derived content and first name) stays in one instance's memory for at
  most the 5-minute window. It is never persisted.
- **Time zone.** Timestamps use the spreadsheet's time zone, so around a daylight-saving change the
  24-hour window can be off by an hour.

## Where the tests are

| File                                    | Covers                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `tests/rate-limit-submissions.test.mjs` | the 5-per-24h limit, rolling window, duplicates, concurrency, retry of a refused request, log content |
| `tests/download-limit.test.mjs`         | 5 downloads, expiry, unauthorized requests, concurrency across instances, fail-closed, ledger privacy |
| `tests/duplicate-handling.test.mjs`     | no AI call, no extended window, shared budget, `409` after the window                                 |
| `tests/security-log.test.mjs`           | allow-listing and redaction of log fields                                                             |

See also `docs/pdf-download.md` for the download flow and the grant format.
