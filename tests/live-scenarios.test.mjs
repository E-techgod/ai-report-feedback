import test from 'node:test';
import { createFakeBackend } from './live/backend.mjs';
import { defineScenarios } from './live/scenarios.mjs';

// The same scenarios that run against a real Google spreadsheet (`npm run test:live`), here against
// the in-memory backend, so the scenarios themselves are proven before any live run.
const backend = createFakeBackend();
defineScenarios(test, () => backend);
