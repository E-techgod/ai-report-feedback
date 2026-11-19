# Plan 002 — Groq AI Provider

**Spec:** ./spec.md

## Approach
Extract a provider interface in `narrative.ts`; keep Anthropic unchanged behind it. Add Groq: strict `json_schema`, low reasoning effort, `Retry-After` within budget.

## Guard
`ai-share.ts` measures AI words against `flattenContent`; prompt limits derive from it; `createReport` falls back to template when exceeded.

## Verification
`npm run typecheck && npm run lint && npm test`; mocked `fetch` only.
