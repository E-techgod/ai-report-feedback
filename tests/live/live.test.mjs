import test, { before } from 'node:test';
import { createLiveBackend } from './backend.mjs';
import { defineScenarios } from './scenarios.mjs';

/**
 * OPT-IN. Runs the abuse-protection scenarios against a REAL Google spreadsheet that is created for
 * the run (or given as LIVE_TEST_SHEET_ID) and must be titled "[TEST] ...". Never the production
 * spreadsheet. Run: `npm run test:live`. Read docs/live-testing.md first (quota is shared!).
 */
let backend;
before(async () => {
  if (process.env.LIVE_TEST !== '1')
    throw new Error('Set LIVE_TEST=1 to run the live tests (see docs/live-testing.md)');
  backend = await createLiveBackend();
});
defineScenarios(test, () => backend);
