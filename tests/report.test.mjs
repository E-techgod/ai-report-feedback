import test from 'node:test';
import assert from 'node:assert/strict';
import { questionIds } from '../src/lib/questions.ts';
import {
  THEMES,
  MAX_CONTEXT_WORDS,
  MAX_SUMMARY_WORDS,
  buildAiInput,
  buildReportModel,
  fallbackNarrative,
  validateNarrative,
  wordCount,
} from '../src/lib/report.ts';

const answers = (fn) => Object.fromEntries(questionIds.map((id, i) => [id, fn(id, i)]));
const all = (v) => answers(() => v);
const only = (ids) => answers((id) => ids.includes(id));

test('every question belongs to exactly one area', () => {
  const used = THEMES.flatMap((t) => t.questionIds);
  assert.equal(used.length, 20);
  assert.deepEqual([...used].sort(), [...questionIds].sort());
});

test('all "No": every area needs review, top 3 priorities in catalog order', () => {
  const m = buildReportModel(all(false));
  assert.equal(m.weakCount, 20);
  assert.equal(m.level, 'Muy bajo');
  assert.ok([...m.personalAreas, ...m.businessAreas].every((a) => a.status === 'review'));
  assert.deepEqual(
    m.priorities.map((p) => p.themeId),
    ['sucesoria', 'familiar', 'documentacion'],
  );
  assert.deepEqual(
    m.priorities.map((p) => p.rank),
    [1, 2, 3],
  );
});

test('all "Sí": every area solid, no priorities, excelente', () => {
  const m = buildReportModel(all(true));
  assert.equal(m.weakCount, 0);
  assert.equal(m.level, 'Excelente');
  assert.equal(m.levelTone, 'high');
  assert.ok([...m.personalAreas, ...m.businessAreas].every((a) => a.status === 'solid'));
  assert.equal(m.priorities.length, 0);
  assert.deepEqual(fallbackNarrative(m).priorityContexts, []);
});

test('priorities rank by gap share, then catalog order (never more than 3)', () => {
  // seguros fully missing (3/3 No), gobierno 5/6 No, everything else answered Sí.
  const yes = questionIds.filter(
    (id) => !['A6', 'A7', 'A8', 'B1', 'B2', 'B3', 'B8', 'B9'].includes(id),
  );
  const m = buildReportModel(only(yes));
  assert.deepEqual(
    m.priorities.map((p) => p.themeId),
    ['seguros', 'gobierno'],
  );
  assert.equal(m.focus, 'Seguros y coberturas');
});

test('the 55% example (11 Sí) is level Bajo with 9 areas to strengthen', () => {
  const m = buildReportModel(
    only(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B5']),
  );
  assert.equal(m.score.protection, 55);
  assert.equal(m.level, 'Bajo');
  assert.equal(m.weakCount, 9);
  assert.equal(m.priorities.length, 3);
});

test('model is deterministic: same answers, same report', () => {
  const a = only(['A1', 'B7']);
  assert.deepEqual(buildReportModel(a), buildReportModel(a));
});

test('fallback narrative respects the AI word limits and has one context per priority', () => {
  for (const a of [all(false), only(['A1', 'A2', 'B1']), all(true)]) {
    const m = buildReportModel(a);
    const n = fallbackNarrative(m);
    assert.ok(wordCount(n.executiveSummary) <= MAX_SUMMARY_WORDS);
    assert.equal(n.priorityContexts.length, m.priorities.length);
    assert.ok(n.priorityContexts.every((c) => wordCount(c) <= MAX_CONTEXT_WORDS));
  }
});

test('validateNarrative accepts a conforming AI answer', () => {
  const ok = {
    executiveSummary: 'Texto breve de resumen.',
    priorityContexts: ['Uno.', 'Dos.', 'Tres.'],
  };
  assert.deepEqual(validateNarrative(ok, 3), ok);
});

test('validateNarrative rejects out-of-contract AI answers', () => {
  const long = (n) => Array.from({ length: n }, () => 'palabra').join(' ');
  const base = { executiveSummary: 'Resumen.', priorityContexts: ['a', 'b', 'c'] };
  assert.equal(validateNarrative(null, 3), null);
  assert.equal(validateNarrative({ ...base, executiveSummary: 42 }, 3), null);
  assert.equal(validateNarrative({ ...base, executiveSummary: '   ' }, 3), null);
  assert.equal(
    validateNarrative({ ...base, executiveSummary: long(MAX_SUMMARY_WORDS + 1) }, 3),
    null,
  );
  assert.equal(validateNarrative({ ...base, priorityContexts: ['a', 'b'] }, 3), null);
  assert.equal(
    validateNarrative({ ...base, priorityContexts: ['a', 'b', long(MAX_CONTEXT_WORDS + 1)] }, 3),
    null,
  );
  assert.equal(validateNarrative({ ...base, priorityContexts: ['a', 'b', 7] }, 3), null);
  assert.equal(validateNarrative(base, 2), null);
});

test('AI input contains only computed results: no personal data, no raw answers', () => {
  const input = buildAiInput(buildReportModel(only(['A1', 'A2'])));
  assert.deepEqual(Object.keys(input).sort(), [
    'areasPorFortalecer',
    'focoPrincipal',
    'nivel',
    'prioridades',
    'score',
  ]);
  const text = JSON.stringify(input);
  assert.ok(!/@|nombre|email|correo/i.test(text));
  assert.ok(!/"A\d+"|"B\d+"/.test(text));
  assert.ok(input.prioridades.length <= 3);
});
