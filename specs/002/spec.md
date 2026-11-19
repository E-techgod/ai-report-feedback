# Spec 002 — Groq AI Provider

**Status:** Draft

## Requirements
- FR-1: THE SYSTEM SHALL default `AI_PROVIDER` to groq (`openai/gpt-oss-20b`); anthropic stays selectable.
- FR-2: Groq output SHALL use strict `json_schema` and pass Zod validation.
- FR-3: IF 429, timeout or invalid output, THEN the report SHALL use template text.
- FR-4: AI text SHALL be ≤15% of visible report words, else template.
- FR-5: Scoring, recommendations, FinalReport, dedupe and email SHALL NOT change.
- FR-6: Keys SHALL stay server-side.

## Out of Scope
Production deployment.
