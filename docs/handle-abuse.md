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

| What                      | Limit                                                    | Enforced by                        | Over the limit                                                                  |
| ------------------------- | -------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| Submissions per email     | **5 per rolling 24 hours**                               | the app, against the Sheet         | `429` + `Retry-After`, no AI call                                               |
| Downloads per submission  | **5 successful**, only within the 5-min window           | the app, against the ledger tab    | `429`                                                                           |
| Download window           | **5 minutes** from when the report is ready              | signed token (HMAC)                | `410` expired                                                                   |
| Repeating the same survey | same email + answers within **10 minutes**               | the app, against the Sheet         | the **same report** again (same instance) or a clear `409`; never a new AI call |
| Requests per IP           | **100 POST per 60 s** on `/api/questionnaire` (proposed) | **Vercel Firewall (to be set up)** | `429` from Vercel                                                               |

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
2. **After appending**: the new row's position among that email's rows is read back. The app writes
   with `insertDataOption: INSERT_ROWS`, which gives every request its own new row in the order Google
   receives them. A row is accepted only if fewer than 5 same-email rows inside the window come before
   it. Rows before it already exist when it is judged, so racing requests reach consistent verdicts
   and **5 win, the rest get `429`**.

**What this relies on, and what it does not guarantee.** It relies on Google giving each append its
own row, in arrival order. Google documents this behavior for `INSERT_ROWS` but does not publish a
formal guarantee under heavy concurrency, so this is **not an atomic lock** and is not claimed to be
one. The code does not blindly trust it: it reads the row back and checks the unique submission marker
and answers before accepting a write, and it fails the request if they do not match. The failure modes
that were analysed (ambiguous writes, failed requests, quota) are listed in
[Concurrency and failure review](#concurrency-and-failure-review).

A request that loses the race keeps its row (the lead is not lost), marked `Estado Reporte =
Rechazado por límite`. If it retries with the same submission id, or sends the same answers again, it
is judged by the limit again; it is **not** treated as a harmless duplicate.

## 2. Duplicates: the same report, or a clear error. Never different feedback

A **duplicate** is the same submission id (a retry or double click) or the same email with identical
answers within 10 minutes (for example a page refresh and redo). Duplicates add no Sheet row, so they
never count toward the 5-per-day limit.

**Rule: a report's AI-generated feedback is never replaced, regenerated or approximated.** Reports are
not stored anywhere (no database, no stored PDF), so the only copy of the original that the server can
ever hand back is a short-lived in-memory one on the instance that generated it. Therefore:

| Situation                                                        | Result                                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Duplicate, this instance still holds the original (< 5 min)      | **The identical report and the identical grant** (same token, same deadline, same 5 downloads) |
| Duplicate, a different instance or a cold start (no cached copy) | **`409`** `duplicate_report_unavailable`: no report, no new grant, no AI call                  |
| Duplicate after the 5-minute window                              | **`409`** `duplicate_window_over`: nothing can be retrieved or regenerated afterwards          |
| Same answers after the 10-minute duplicate window                | A **new submission** (counts toward the 5 per day, calls the AI once)                          |

The `409` says, in Spanish: _"Ya recibimos este diagnóstico, pero no podemos mostrar su informe desde
aquí. Podrás generar un informe nuevo en N minutos."_ It deliberately **does not assume the person
already holds a report**: the first attempt may have failed before one was made. If they do still have
the original page open, its grant, its 5-minute deadline and its 5-download budget are untouched.

Consequences to be aware of (a deliberate choice, see [Limitations](#limitations-read-this)):

- A person whose **first** attempt failed after the row was saved and who retries will also get this
  `409`: the server cannot prove, without storing anything, that no report was ever shown, so it will
  not generate a second one. They can resubmit after the 10-minute duplicate window. When the failure
  is one the server knows about, it says so up front (next section) instead of letting them find out
  through the `409`.
- The in-memory copy holds the report (answers-derived content and first name) for at most the
  5-minute window on one instance, and is never written anywhere.

### Saved, but the report could not be completed (`503` `saved_unconfirmed`)

When Google **confirmed the append** (the row exists and counts toward the person's 5 per day) but
reading it back or verifying it failed, or the report could not be generated, the answer is:

- HTTP `503`, body `{"ok":false,"saved":true,"code":"saved_unconfirmed","error":"Recibimos tus
respuestas, pero no pudimos completar tu reporte. Por favor, vuelve a intentarlo en aproximadamente
10 minutos."}`, and `Retry-After` = what is left of the 10-minute duplicate window (600 at most).
- Retrying before then is a duplicate (the `409` above); after it, the same answers are a new
  submission with a new report.
- If the **append call itself** fails or times out, the write is _uncertain_ and nothing is claimed:
  `503 service_busy` for a Google quota error ("Estamos recibiendo muchas solicitudes...") or `502`
  ("No pudimos confirmar el envío de tu diagnóstico..."). The row may or may not exist.
- Logged as `sheets_unavailable` with `outcome: saved_unconfirmed` and the `reason` only.

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

Each request appends its own row (`INSERT_ROWS`) and judges itself by the rows before it, so
concurrent requests, **even on different serverless instances**, get different ordinals and 5 are
delivered. As with submissions this depends on Google giving each append its own row in arrival order
(not a formal atomic guarantee); the code reads back the row it wrote and refuses the download if the
key is not there.

Inside one instance a per-submission queue runs same-grant requests one at a time. When the 5th PDF is
delivered the instance remembers the submission as spent, so the 6th and later attempts are refused
from memory with **no render and no Google call**. That memory only saves work; the ledger is the
enforcement, so cold starts and other instances apply the same limit (their first attempt costs one
render plus one append and one read, then they remember too).

**It fails closed.** If the ledger cannot be reached, or a write cannot be confirmed, the download is
refused with `503` ("No pudimos verificar tu descarga...") rather than served without a limit. If
the append never reached Google, no download is used and the same grant works again once Google
responds. If Google applied the append but the app did not hear back (a timeout), the row exists, so
**that failed attempt may use up one of the 5 downloads**: the limit errs on the strict side, never the
loose one. If Google credentials are missing the route returns `503` too.

## 4. Per-IP limit: Vercel Firewall (to be set up)

A per-IP counter needs shared state that survives across serverless instances (a database or Redis,
which this project does not use), and an in-memory counter is per instance and would not hold. So the
per-IP limit is a **Vercel Firewall rule**, which runs before the app. It also keeps floods away from
the Sheets quota, which is what the in-app limits cannot do on their own.

**Proposed configuration (not applied to Production):** `POST /api/questionnaire`, **100 requests per IP
per 60 seconds**, fixed window, keyed by IP, default `429` when exceeded. It is deliberately generous: it
does not slow a real person or an office or school sharing one IP, and only cuts off scripted floods. The
real per-person limits stay in the app (5 submissions per email per 24 hours, 5 downloads per report).
Because a request that reaches the app can cost up to ~6 Sheets requests, a single IP at the ceiling could
still use a large share of Google's per-minute quota, so this rule is a flood brake, not a quota
guarantee. It is activated only after the integration tests and PR review, with explicit approval.

## 5. Monitoring: structured, privacy-safe logs

Code: `src/lib/security-log.ts`. One JSON line per event in the Vercel runtime logs, tagged
`"app":"bp-questionnaire"`. Search the logs for the event name.

```json
{"app":"bp-questionnaire","event":"submission_rate_limited","subject":"2158bd1037","reason":"email_24h","limit":5,"retryAfterSeconds":3600}
{"app":"bp-questionnaire","event":"download_served","grant":"3f9a1c2b","ordinal":2,"limit":5}
```

| Event                        | Level | Meaning                                                                                  |
| ---------------------------- | ----- | ---------------------------------------------------------------------------------------- |
| `submission_rate_limited`    | warn  | 6th or later submission for an email in 24 h (`retryAfterSeconds`)                       |
| `submission_duplicate`       | info  | `outcome`: `served_cached_report`, `refused_report_unavailable` or `refused_window_over` |
| `download_served`            | info  | a PDF was delivered (`ordinal` 1 to 5)                                                   |
| `download_limit_reached`     | warn  | the 6th or later download of a submission was refused                                    |
| `download_limit_unavailable` | warn  | the ledger could not be reached (download refused, `503`; `reason` as above)             |
| `download_expired`           | warn  | a genuine grant used after its 5 minutes (`410`)                                         |
| `download_unauthorized`      | warn  | missing, invalid or mismatched grant (`reason`)                                          |
| `sheets_unavailable`         | warn  | Google failed while saving a submission (`reason`: `quota`, `timeout`, `other`)          |

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

## Concurrency and failure review

The append-then-rank design was reviewed for race conditions, ambiguous writes, failed requests and
quota behavior. Outcomes of that review, including the problems it found:

| Failure mode                                                       | What happens                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Many requests pass the pre-check at once                           | Ranked by row order after the append; 5 win. Verified with in-memory fakes and randomized fault injection; **to be confirmed on real Google** ([live testing](./live-testing.md))                                                                                                                   |
| **Ambiguous append** (Google applied it, the caller saw a timeout) | The row exists. A retry with the same id finds it by its unique marker, so **no second row**. The retry gets the duplicate `409` (see section 2), not a second report                                                                                                                               |
| Append applied but the read-back fails                             | `503` `saved_unconfirmed` ("Recibimos tus respuestas, pero no pudimos completar tu reporte...") with `Retry-After` = rest of the duplicate window. One row; a retry before then is a `409`                                                                                                          |
| Rank read fails after the append                                   | Same `503` `saved_unconfirmed`; the row stays and still counts toward the limit                                                                                                                                                                                                                     |
| Label write (`Rechazado por límite`) fails                         | Ignored on purpose: the `429` is what matters. Rejection never depends on the label                                                                                                                                                                                                                 |
| A loser's answers are sent again with a new id                     | **Found and fixed in this review:** the loser's row used to match the duplicate check. It is now skipped, so the attempt is judged by the limit (`429`)                                                                                                                                             |
| Google quota (`429`) while saving a submission                     | **Found and fixed:** used to be an opaque `502`. Now a `503` with `Retry-After: 60`, a friendly message and a `sheets_unavailable` log with `reason: quota`                                                                                                                                         |
| Google quota or outage while counting a download                   | `503`, fails closed, reason logged; the grant works again when Google recovers                                                                                                                                                                                                                      |
| Budget spent but the app keeps asking Google                       | **Found and fixed:** after the 5th delivery the 6th attempt cost a render and 2 Google calls; it now costs none (remembered in memory)                                                                                                                                                              |
| Too many Sheets requests per submission (10 reads + 2 writes)      | **Found and fixed:** consolidated into batched requests, 4 reads + 2 writes, with a validated header cache; see [`docs/sheets-quota.md`](./sheets-quota.md)                                                                                                                                         |
| Google client retries a read 3 times on `429`                      | **Found and fixed:** a failed read cost 4 requests while the quota was already exhausted; `429` is no longer retried (timeouts and `5xx` still are)                                                                                                                                                 |
| Quota hit after the row was written but before it was confirmed    | The person gets `503` but the row exists and counts; the retry gets the duplicate `409` until the 10-minute window passes. Exposure is now one request, not three                                                                                                                                   |
| Two writers get the same row (an overwrite)                        | Cannot be ruled out from Google's documentation. The submission path detects it (marker and answers are read back and must match). Two **downloads of the same grant** overwriting one row would be seen as one, so at most one extra PDF could be delivered. Not observed in testing, not provable |
| Rows sorted, inserted or deleted in the response tab               | The email limit judges by row order: do not sort or insert rows. Deleting a row frees a slot                                                                                                                                                                                                        |
| Instance clocks differ by seconds                                  | Harmless: the window is 24 hours and each request judges against its own clock                                                                                                                                                                                                                      |

**Quota.** Google counts API requests, not ranges, and the app's single service account is limited to
60 read and 60 write requests per minute. After the consolidation in [`docs/sheets-quota.md`](./sheets-quota.md),
an accepted submission costs **4 reads + 2 writes** (3 + 2 for a first-time email; it was 10 + 2), a
refused 6th submission 2 reads, a delivered download 1 read + 1 write and a download refused from memory 0. That is roughly 12-15 completed respondents per minute (about 700-900 per hour) if arrivals are
spread out; a burst in a single minute is what exhausts the quota. A Google `429` is not retried by the
client (a retry 100 ms later cannot beat a per-minute quota); it becomes a `503` with `Retry-After`.
That page also lists what remains unverified.

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

### A user says "it says you already received my diagnosis and can't show it again" (`409`)

- This is the duplicate rule (section 2): their first submission was already processed and this server
  holds no copy of the report. Nothing is wrong with the Sheet: their row is there.
- The message does not say whether they received a report. If they still have the original page open
  they can keep downloading (up to 5 times, until the 5-minute window ends); otherwise they can submit
  again after the time the message gives (the 10-minute duplicate window); that is a new submission.
- Check the logs for `submission_duplicate` with `outcome` `refused_report_unavailable`.

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
5 descargas") and the messages in `src/lib/questionnaire-handler.ts` ("aproximadamente 10 minutos" in the
`saved_unconfirmed` text, which mirrors the duplicate window). The `429` messages for submissions and for the PDF use the constants. Then run the tests;
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
   | Window / Requests | 60 s / 100 requests (fixed window)                                            |
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
     --rate-limit-requests 100 --rate-limit-window 60 --rate-limit-keys ip --yes
   vercel firewall diff      # review the draft
   vercel firewall publish   # makes it live
   ```

   Check that it exists with `vercel firewall rules list`. To verify it works, send 101
   `POST /api/questionnaire` requests with body `{}` from one IP within 60 seconds (they are rejected
   with `400` before touching Sheets or the AI, so the test is free): the 101st must return `429`. One rule fits the
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
- **Anyone who knows an email address can use up its 5 daily submissions** (five requests are enough), which
  blocks that person for up to 24 hours. This is inherent to a per-email limit with no verification of the
  address; the 5 limit trades it for cost control. Treat a report of "I can't submit" with that in mind.
- **A repeated submission can return the original report to whoever repeats it**: same email and the
  same 20 answers within the 5 minutes, on the instance that generated it. That needs the victim's email
  and exact answers, so it is not treated as a practical leak, but it is not authentication.
- **The email limit depends on row order** in the response tab. Do not sort, re-order or insert rows
  there. Deleting a row frees a slot. Rows whose timestamp is not a real date and time (for example
  typed by hand) are ignored by the window.
- **Race losers keep a labelled row** and it keeps counting toward the window. That can only make the
  limit slightly stricter, never looser.
- **Sheets API cost and quota.** 4 reads and 2 writes per accepted submission (3 + 2 for a new email,
  see [`docs/sheets-quota.md`](./sheets-quota.md)) against the service account's quota of 60 reads and
  60 writes per minute, so about 12-15 respondents per minute sustained; beyond that, saving fails with
  `503`. Only the Firewall rule keeps floods away
  from it, and Production shares this quota with anything else using the same service account.
- **Not an atomic lock.** Both limits rely on Google giving each `INSERT_ROWS` append its own row in
  arrival order. That is documented behavior but not a formal guarantee under heavy concurrency, so the
  limits are very strong in practice and verified by read-back, not mathematically guaranteed.
- **Render before count.** A burst of N parallel download requests can render up to N PDFs before the
  extra ones are withheld (they are never delivered). The per-submission queue and the in-memory
  "exhausted" memo keep this small.
- **A PDF that is delivered but never saved by the browser still counts** as one of the 5.
- **An uncached duplicate is refused, not re-served.** The server cannot reproduce the original report
  without storing it, so on another instance (or after a cold start) a repeat gets a `409` instead of a
  report. This also affects a user whose first attempt failed after the row was saved: they must wait
  for the 10-minute duplicate window and resubmit. This is the price of never showing different
  feedback; the alternative (storing reports) is explicitly out of scope.
- **A failed or ambiguous download attempt may use a download** (see section 3): the limit errs strict.
- **The cached report** (answers-derived content and first name) stays in one instance's memory for at
  most the 5-minute window. It is never persisted.
- **Time zone.** Timestamps use the spreadsheet's time zone, so around a daylight-saving change the
  24-hour window can be off by an hour.

## Where the tests are

| File                                    | Covers                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `tests/rate-limit-submissions.test.mjs` | the 5-per-24h limit, rolling window, duplicates, concurrency, retry of a refused request, log content                              |
| `tests/download-limit.test.mjs`         | 5 downloads, expiry, unauthorized requests, concurrency across instances, fail-closed, ledger privacy                              |
| `tests/duplicate-handling.test.mjs`     | identical report and grant for a cached duplicate, `409` when uncached or late, never a new AI call                                |
| `tests/security-log.test.mjs`           | allow-listing and redaction of log fields                                                                                          |
| `tests/sheets-failures.test.mjs`        | Google failure modes: quota, ambiguous writes, race losers, randomized fault injection (<=5 served, no duplicate rows)             |
| `tests/live-scenarios.test.mjs`         | the 6th submission, the 6th download, duplicates, concurrency, ledger tab and privacy, against in-memory fakes                     |
| `tests/live/live.test.mjs`              | the same scenarios against a REAL isolated Google spreadsheet (opt-in, `npm run test:live`, see [live testing](./live-testing.md)) |

See also `docs/pdf-download.md` for the download flow and the grant format.
