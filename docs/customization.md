# Customizing the survey and the report

Where to edit the questionnaire and the report: wording, colors, fonts and layout.

**Rule of thumb:** report wording lives in `src/lib/report-content.ts` and `src/lib/report.ts`; the web view and the PDF both read from them. Colors live in two token files (web and PDF) that must be changed together.

## Previewing changes

```bash
npm run dev
```

Open `http://localhost:3000/report-preview`. It renders the report with sample data, in client or team mode, including the 5-minute download-window states. It exists in development only; production returns 404.

Before committing, run the checks: `npm run typecheck && npm run lint && npm run format:check && npm test`.

## Survey (questionnaire page)

| What to change                                                                                         | File                   |
| ------------------------------------------------------------------------------------------------------ | ---------------------- |
| Question text and the help text under each question                                                    | `src/lib/questions.ts` |
| Page copy: headline, intro form, field labels and placeholders, "Tiempo estimado", the loading message | `src/app/page.tsx`     |
| Browser tab title and description                                                                      | `src/app/layout.tsx`   |
| Survey layout, spacing, buttons, form styling                                                          | `src/app/globals.css`  |

### Editing vs. adding or removing questions

- **Changing the wording** of an existing question (`title`, `help`) is safe: edit `src/lib/questions.ts` only.
- **Adding, removing or renumbering a question** has knock-on effects, because everything below is keyed by the question ids (`A1`, `A2`, … `B…`):
  - `src/lib/report.ts`: every area in `THEMES` lists its `questionIds`, and each question is used once. A new question must be assigned to an area.
  - `src/lib/scoring.ts`: the score is computed from `questions`, split by `section` (`personal` / `empresarial`).
  - `src/lib/validation.ts` and `src/lib/sheets.ts`: submissions are validated and written for exactly the ids in `questions.ts`.
  - **Google Sheet:** each question needs a column whose header looks like `A) 1. …` or `B) 12. …` (matched by `src/lib/sheet-schema.ts`). Add or rename the column in the Sheet to match. A missing or duplicated header is an error.
  - Tests in `tests/` that assume the current question set will need updating.

## Report text

| What to change                                                                                  | File                                                |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Hero, section titles and subtitles, labels, "Tu plan de acción", the closing call to action     | `src/lib/report-content.ts`                         |
| The six areas: area title and description, priority title, finding, action and fallback context | `src/lib/report.ts` (`THEMES`)                      |
| Action-plan steps                                                                               | `src/lib/report.ts` (`PLAN_STEPS`)                  |
| Level names and thresholds (Muy bajo, Bajo, Medio, Alto, Excelente)                             | `src/lib/scoring.ts`                                |
| Booking link on the call to action                                                              | `NEXT_PUBLIC_BOOKING_URL` in `.env` (and in Vercel) |

`src/lib/report-content.ts` is the single source of customer-visible strings: edit wording there, not in the renderers (`ReportView.tsx`, `ReportPdf.tsx`).

The order of `THEMES` is also the tie-break order when priorities are ranked.

### AI-written text

Only four slots are written by the AI: the executive summary and a short context for each priority. Everything else is deterministic.

| What to change                                                   | File                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| Role, tone and instructions given to the model (`systemPrompt`)  | `src/lib/narrative.ts`                                               |
| Word limits and the share of AI text allowed in the report (15%) | `src/lib/ai-share.ts`                                                |
| Word caps for the summary and each context                       | `src/lib/report.ts` (`MAX_SUMMARY_WORDS`, `MAX_CONTEXT_WORDS`)       |
| Text used when the AI is unavailable or over the limit           | `context` in `THEMES` and `fallbackNarrative` in `src/lib/report.ts` |

## Colors

The palette is defined twice and the two copies must stay in sync:

| Where it applies        | File                                                  |
| ----------------------- | ----------------------------------------------------- |
| PDF                     | `src/lib/design-tokens.ts` (`palette`)                |
| Web (survey and report) | the `:root` block at the top of `src/app/globals.css` |

Current values (both files): background `#FFFFFF`, text `#111111`, accent `#E66B22`, accent text `#A7430C`, surface `#F7F7F7`, muted `#666666`, border `#E5E5E5`.

`src/components/ReportView.module.css` maps these into report-specific variables (`--ink`, `--ai`, `--amber`, …) in its `.root` block. Prefer changing the palette files rather than adding hard-coded colors there.

## Fonts

| Where | Font                                  | How to change                                                                                                                                |
| ----- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Web   | Inter (Google Fonts)                  | The `@import` on line 1 of `src/app/globals.css`, and the `font-family` declarations in the same file                                        |
| PDF   | Helvetica / Helvetica-Bold (built in) | `fontFamily` entries in `src/lib/pdf/ReportPdf.tsx`. The PDF does **not** use Inter. A custom font requires registering the font file there. |

Changing the web font does not change the PDF, and the reverse.

## Layout

| What                                   | File                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------- |
| Report web layout and styling          | `src/components/ReportView.module.css` and `src/components/ReportView.tsx` |
| PDF layout, sizes, spacing, page setup | `src/lib/pdf/ReportPdf.tsx`                                                |
| Survey layout                          | `src/app/globals.css`, `src/app/page.tsx`                                  |

## Logo

`public/images/quiron-logo.png` is used by the survey (`src/app/page.tsx`), the report web view (`src/components/ReportView.tsx`) and the PDF (`src/lib/pdf/ReportPdf.tsx`, read from disk). To replace it, overwrite that file keeping the same name. To use a different filename, update all three references and `tests/pdf-bundle.test.mjs`, which checks that the file is included in the PDF route's serverless bundle.
