# Live testing the abuse protection (isolated spreadsheet only)

`npm test` proves the logic against in-memory fakes. Only a real Google spreadsheet can show how Google
actually orders concurrent appends and what the API costs, so there is an **opt-in** live suite.
It **never touches the production spreadsheet**:

- It creates a brand-new spreadsheet titled `[TEST] bp-questionnaire abuse protection <timestamp>` (or
  uses the one in `LIVE_TEST_SHEET_ID`).
- A hard guard refuses to run unless the spreadsheet title starts with `[TEST]`.
- `GOOGLE_SHEET_ID` is deleted from the environment first, so a production id can never leak in.
- Only `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY` are read from the env file; nothing is printed.
- The AI is stubbed, so **no Groq calls** and no cost. The app is not deployed or started.
- All Sheets calls go through a throttle (default 30/min, `LIVE_MAX_CALLS_PER_MIN`) because the Google
  quota is **per project and per user, shared with Production** if you use the same service account.

## Run it

```bash
LIVE_TEST_ENV_FILE=/path/to/.env npm run test:live
# or, with variables already exported:
GOOGLE_CLIENT_EMAIL=... GOOGLE_PRIVATE_KEY=... npm run test:live
```

It takes several minutes (the throttle). Scenarios: the 6th submission, the rolling 24-hour window, 8
concurrent submissions, duplicates (cached, uncached, window over), the 6th download, and 10 parallel
downloads over 3 simulated instances. It prints the real number of Sheets requests and the time per request. Expected after the quota optimization (`docs/sheets-quota.md`): 4 reads + 2 writes per accepted submission, 2 reads for a refused 6th, 1 read + 1 write per delivered download. If the live numbers are higher, the consolidation is not behaving as the fakes suggest.

**The service account of this project cannot create spreadsheets** (Google answered "The caller does not
have permission" when this was tried), so the run needs a spreadsheet you create: make an empty one
titled `[TEST] ...`, share it with the service account email as **Editor**, and pass
`LIVE_TEST_SHEET_ID=<its id>`. The suite adds the response tab and headers itself.

## Manual steps (browser and real deployment)

The suite calls the handlers directly. What it cannot show is the real browser UI and Vercel's multiple
instances. Do this on a **Preview** deployment (not Production) wired to a `[TEST]` spreadsheet shared
with the service account, with `GROQ_API_KEY` set only if you want to see real AI text.

1. **6th submission.** Fill the questionnaire 5 times with the same email, changing at least one answer
   each time and waiting more than 10 minutes between attempts (or change answers and use the same
   email after 10 minutes). The 6th must show the amber message "Has alcanzado el límite de 5
   diagnósticos en 24 horas..." with no report. Check the sheet: 5 accepted rows, no 6th row.
2. **Concurrency.** In DevTools, copy the `POST /api/questionnaire` request as cURL and run 8 copies in
   parallel with one email and different answers (`for i in 1..8; do curl ... & done`). Expect exactly 5
   `200` and 3 `429`, and 8 rows with 3 marked `Rechazado por límite`.
3. **6th download.** On a report, press "Descargar PDF" 5 times (all download), the 6th must show
   "Alcanzaste el límite de 5 descargas de este informe." and the button disables. Open the
   `Control de descargas` tab: 5 or 6 rows with the same opaque `dl_...` key, no names or emails.
4. **Duplicates.** Submit the same answers twice within 5 minutes: you see the identical report. Then
   open a private window, submit the same email and answers: expect either the identical report or the
   `409` message "Ya recibimos este diagnóstico, pero no podemos volver a mostrarte el mismo informe...".
   Never a different text.
5. **Google down.** Revoke the service account's access to the `[TEST]` sheet and submit: the page
   shows "No se pudo guardar tu diagnóstico" (`502`); a download shows "No pudimos verificar tu
   descarga" (`503`). Restore access and confirm the same grant works again.
6. **Quota.** The `503` "Estamos recibiendo muchas solicitudes" is only reachable by really exhausting
   the quota; it is covered by tests with a simulated Google `429` and is **not** expected to be
   reproduced manually.

## Not verifiable here

- Multiple **real** Vercel instances hitting Google at once (the suite simulates instances with separate
  Google clients in one process).
- The Vercel Firewall rule (not applied, see `docs/handle-abuse.md` section 4).
- Behavior at Google's real quota ceiling.
