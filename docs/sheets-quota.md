# Google Sheets requests, quota and campaign throughput

Google Sheets is the only store (no Neon, Redis or other database), so its API quota is the capacity
limit of the app. This page counts exactly what each flow costs, what the quota really is, and what a
campaign can expect. Numbers for "before" come from commit `b23fcff`, "after" from the optimization
described below; both were measured by counting calls through the same gateway interface the app uses,
and the batching claim was checked at HTTP level against a local server (`tests/sheets-requests.test.mjs`).

## 1. What Google counts (verified)

Source: <https://developers.google.com/workspace/sheets/api/limits> (read on 2026-11-19).

| Quota          | Per minute per project | Per minute per user per project |
| -------------- | ---------------------- | ------------------------------- |
| Read requests  | 300                    | **60**                          |
| Write requests | 300                    | **60**                          |

- **Requests are counted, not ranges.** "Each batch request, including any subrequest, is counted as
  one API request toward your usage limit." One `values.batchGet` of 5 ranges, or one
  `values.batchUpdate` of 3 cells, is **one** request. That is what makes consolidation worthwhile.
- Read = a method that retrieves data (`get`, `batchGet`, `spreadsheets.get`); write = a method that
  changes the spreadsheet (`append`, `update`, `batchUpdate`). Reads and writes have **separate** buckets.
  (The page gives `get`/`search` and `update`/`clear`/`copyTo` as examples; classifying `append` and
  `batchGet` is an inference from them, not a quote.)
- "API calls by a service account are considered to be using a single account." The app uses one
  service account, so the **per-user limit (60 reads/min, 60 writes/min) is the one that binds**, not the
  per-project 300.
- Quotas are "refilled every minute"; the page does not say whether the window is fixed or rolling. Over
  quota, Google answers `429`, and recommends exponential backoff of up to 32 or 64 seconds.
- Recommended payload: at most 2 MB per request; a request running over 180 seconds times out.
- **Billing:** the page says exceeding the quota "is planned to incur charges to your Google Cloud
  billing account later in 2026". Check the Cloud console for whether this applies to your project.
- The quota is shared by everything that uses the same service account or project (for example other
  apps or scripts), not only this app.

## 2. Audit of an accepted submission (before)

Steady state, email with earlier submissions. The route created a new Google client for every request, so
the memoized time zone was lost each time and was fetched on every submission.

| #   | Request                                          | Needed?                                                   |
| --- | ------------------------------------------------ | --------------------------------------------------------- |
| 1   | header row                                       | yes (column mapping) but can share a request with 3 and 4 |
| 2   | spreadsheet time zone                            | once per instance, not per request                        |
| 3   | marker column (same-id retries across instances) | yes                                                       |
| 4   | email column                                     | yes                                                       |
| 5   | this email's newest rows (duplicate + limit)     | yes                                                       |
| W1  | append the row                                   | yes                                                       |
| 6   | marker column again, to find the new row         | no: Google reports the appended row (`updatedRange`)      |
| 7   | the new row, to verify it                        | yes, but can share a request with 6 and 8                 |
| 8   | email column again, to rank concurrent writers   | yes, but can share a request with 6 and 7                 |
| 9   | header row (after the response, `Generado`)      | yes, but can share a request with 10                      |
| 10  | the row again (after the response)               | yes (the row may have moved)                              |
| W2  | write `Estado Reporte = Generado`                | yes (existing behaviour)                                  |

**10 reads + 2 writes = 12 requests** (9 reads for an email with no earlier submissions).

## 3. The optimization (what changed)

No new storage, no behaviour change to any limit. Everything that was read in separate requests but
did not depend on a previous answer is now read in one `values.batchGet`.

1. **Header row + marker column + email column: one request** (was 3). The parsed header row is
   remembered per function instance, but it is never trusted: every request re-reads the header row
   _inside the same request_ and uses the remembered schema only if the headers are unchanged. If
   someone inserted or renamed a column the cache is dropped and the columns are read again, so a stale
   schema can never choose a column (tested, including a mutation check that removes the validation).
2. **After the append: marker column + email column + the appended row: one request** (was 3). The row
   number comes from Google's `updatedRange`; if it is ever missing the code falls back to finding the
   row by its marker, as before. The same checks run: the marker appears exactly once, the stored email and all 20
   answers are ours, and the rank among this email's rows decides the limit.
3. **Marker retries reuse the email column already read** (was a second read) and a refused 6th
   submission costs the same two requests as any pre-check.
4. **`Generado` update: header row + row in one request** (was 2).
5. **One Google client per function instance** in the questionnaire route (as the PDF route already
   did), so the time zone is requested once per instance instead of once per submission.
6. **No automatic retry on `429`.** Verified against a local server: the Google client retries a read
   three times on `429` after 100-400 ms, so one quota failure cost 4 requests while the quota was
   already exhausted, and the quota is per minute, so those retries cannot succeed. `429` now fails
   fast (the app answers `503` with `Retry-After`). Timeouts and `5xx` keep the retries. Writes
   (`append`, `batchUpdate`) were never retried.

## 4. Requests per flow, before and after

| Flow                                                 | Before           | After                                            |
| ---------------------------------------------------- | ---------------- | ------------------------------------------------ |
| Accepted submission, email with history              | 10R + 2W         | **4R + 2W**                                      |
| Accepted submission, first submission of that email  | 9R + 2W          | **3R + 2W**                                      |
| Refused 6th submission                               | 5R               | **2R**                                           |
| Retry of a known submission id (marker in the Sheet) | 4-5R             | **2R**                                           |
| Delivered PDF download (ledger)                      | 1R + 1W          | 1R + 1W (unchanged)                              |
| Download refused after the 5th (same instance)       | 0                | 0                                                |
| Extra, once per cold instance                        | tz every request | 1R time zone, 1R header row, 1R ledger tab check |

R = read request, W = write request. The ledger append and its read-back were already minimal (the
ordinal needs the rows before it); they are unchanged.

Measured in the scenario suite (`tests/live-scenarios.test.mjs`, five accepted submissions then a
refused sixth): before `9r/2w, 10r/2w ×4, refused 6th 5r/0w`; after `5r/2w (cold instance), 4r/2w ×4,
refused 6th 2r/0w`. Eight concurrent submissions for one email: before `59r/11w`, after `26r/11w`.

## 5. Realistic campaign throughput

Reads bind (60 per minute for the service account). Per person, reads = submission + downloads.
Most campaign respondents use a new email and download once or twice:

| Downloads per person | Reads/person before | Persons/min before | Reads/person after | Persons/min after |
| -------------------- | ------------------- | ------------------ | ------------------ | ----------------- |
| 1                    | 10                  | ~6                 | **4**              | **~15**           |
| 2                    | 11                  | ~5                 | **5**              | **~12**           |
| 5 (worst case)       | 14                  | ~4                 | **8**              | **~7**            |

So about **700-900 completed respondents per hour** if arrivals are spread evenly, against roughly
300-360 before. Writes (60/min) do not bind: 2 + downloads per person.

What the numbers do not say:

- **Bursts matter more than the hourly rate.** The quota is per minute. Twenty people submitting in
  the same few seconds already use all 60 reads of that minute (20 x 3) before anyone downloads, so some
  requests fail even though the hourly average is fine. A campaign email sent to a large list at once
  will produce such a burst.
- **Concurrency does not change the cost** per request; it only compresses it in time. Several
  instances share the one service account and so the one quota.
- **Failure behaviour when the quota is exhausted:**
  - before the row is written: nothing saved, the person gets `503` ("Estamos recibiendo muchas
    solicitudes...", `Retry-After: 60`) and can simply retry. Clean.
  - after the row is written but before the app could confirm it (the read-back request): the row
    exists and counts toward the person's 5, but they get the same `503`. When they retry, the app
    recognises the answers as already received and returns the `409` "ya recibimos este diagnóstico"
    (reports are not stored, so it cannot be re-shown) until the 10-minute duplicate window passes.
    This exposure used to be three requests long; it is now one.
  - downloads: `503` "No pudimos verificar tu descarga"; the same grant works again after the quota
    refills, if still inside the 5 minutes. A `429` whose append Google had already applied can use up
    one of the 5 downloads.
  - **Retries:** the person retrying (or a script) is the only retry. The server does not retry `429`
    (section 3.6) because that would multiply the load on an exhausted quota.

## 6. Options considered, not done

| Option                                                   | Why not (now)                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read the whole table once instead of columns + rows      | Fewer requests but the payload grows with the number of responses (2 MB recommended); slower at scale.                                             |
| Trust the cached header row without re-reading it        | Saves nothing more (it rides in the same request) and would risk writing into the wrong column.                                                    |
| Drop the `Generado` update                               | Removes 1R + 1W per submission but changes data that dashboards may use.                                                                           |
| A second service account (per-user quota is per account) | Roughly doubles capacity inside the 300/min project quota. Needs a new account shared on the sheet and a choice rule; worth it if campaigns burst. |
| Ask Google for a higher quota                            | Free to try, no code. The right first step before a large send.                                                                                    |
| Smooth the burst (stagger the campaign email)            | Free and effective: send in batches (for example 10 per minute).                                                                                   |
| Recover the ambiguous write                              | See section 7.                                                                                                                                     |

## 7. The ambiguous write: saved, but the person saw an error (implemented)

Case: Google applied the append, then the app failed before it could confirm the row or finish the
report. The row exists and counts toward the person's 5; no report was shown. Because reports are not
stored, a retry cannot be answered with the report, only with a `409`.

What can be known without storing anything: the failure happened **before** a report was shown, but a
later retry cannot know that, because a row left `Pendiente` can also be a report that was shown whose
`Generado` update (after the response) failed. Regenerating from `Pendiente` alone could show a second,
different report for the same submission. That is the line not to cross, so the app never regenerates.

What the app does now (smallest safe recovery, no new state, no extra Sheets requests):

| Where it failed                                                   | Answer                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| After Google confirmed the append (read-back, verification, rank) | `503` `saved_unconfirmed`, `Retry-After` = rest of the 10-minute duplicate window, the exact Spanish message "Recibimos tus respuestas, pero no pudimos completar tu reporte. Por favor, vuelve a intentarlo en aproximadamente 10 minutos." |
| Report generation failed after the save                           | The same response                                                                                                                                                                                                                            |
| The append call itself failed or timed out (write uncertain)      | `503 service_busy` (quota) or `502`; **no claim** that the answers were or were not saved                                                                                                                                                    |
| Before the append                                                 | Same as above: nothing was written                                                                                                                                                                                                           |
| A retry before the window ends                                    | `409` "Ya recibimos este diagnóstico, pero no podemos mostrar su informe desde aquí. Podrás generar un informe nuevo en N minutos." It never assumes a report was received                                                                   |
| After the window                                                  | A new submission with its own report (it uses one of the 5 daily slots, as the unconfirmed row did)                                                                                                                                          |

The cost is one burnt slot of the person's 5 per day and a wait of up to 10 minutes.

**The page must use a new submission id for that second attempt.** A known id is always a duplicate, however
long ago, so reusing it would answer `409` forever. The page now starts a new id after any definitive
server answer (it keeps the id only when no answer arrived: network errors and timeouts), found in the
final review: the first version of this recovery was a dead end for anyone who retried without reloading.

Not done: a claim state (`Estado Reporte = Generando`) or writing `Generado` before the response. Neither
can prove "never shown" without adding latency and a hard dependency on a second Sheets write. Revisit
only if live data shows this case is frequent. Storing the report or the PDF is out of scope.

## 8. Not verified

Everything above except the HTTP-level request counts was measured with an in-memory spreadsheet. Real
Google latency, real quota refill behaviour, and real append ordering under concurrency need the opt-in
live suite on an isolated `[TEST]` spreadsheet (`docs/live-testing.md`); it has **not** been run because
no such spreadsheet is available to the app's service account.
