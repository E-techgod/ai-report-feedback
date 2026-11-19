import test from 'node:test';
import assert from 'node:assert/strict';
import { questions, questionIds } from '../src/lib/questions.ts';
import { scoreAnswers } from '../src/lib/scoring.ts';
import { submissionSchema } from '../src/lib/validation.ts';

const all = (value) => Object.fromEntries(questionIds.map((id) => [id, value]));
const UUID = '3b241101-e2bb-4255-8caf-4136c566a962';
const valid = (answers) => ({
  id: UUID,
  firstName: 'Ana',
  lastName: 'López',
  email: 'ana@example.com',
  privacyAccepted: true,
  answers,
});

test('there are 20 questions, 10 per section, with unique ids', () => {
  assert.equal(questions.length, 20);
  assert.equal(new Set(questionIds).size, 20);
  assert.equal(questions.filter((q) => q.section === 'personal').length, 10);
  assert.equal(questions.filter((q) => q.section === 'empresarial').length, 10);
});

test('all "Sí" scores 100% and Excelente', () => {
  const s = scoreAnswers(all(true));
  assert.equal(s.protection, 100);
  assert.equal(s.no, 0);
  assert.equal(s.category, 'Excelente');
  assert.deepEqual(s.missing, []);
});

test('all "No" scores 0% and Muy bajo', () => {
  const s = scoreAnswers(all(false));
  assert.equal(s.protection, 0);
  assert.equal(s.gap, 100);
  assert.equal(s.category, 'Muy bajo');
  assert.equal(s.missing.length, 20);
});

test('level matches the Dashboard formula for every possible score (0..20 Sí)', () => {
  // Dashboard!G: =IF(C=100,"Excelente",IF(C>=80,"Alto",IF(C>=60,"Medio",IF(C>=40,"Bajo","Muy bajo"))))
  const dashboard = (c) =>
    c === 100 ? 'Excelente' : c >= 80 ? 'Alto' : c >= 60 ? 'Medio' : c >= 40 ? 'Bajo' : 'Muy bajo';
  for (let n = 0; n <= 20; n++) {
    const answers = Object.fromEntries(questionIds.map((id, i) => [id, i < n]));
    assert.equal(scoreAnswers(answers).category, dashboard(n * 5), `${n} Sí`);
  }
  // 55% (the controlled test case) is "Bajo", as in the Dashboard.
  const eleven = Object.fromEntries(questionIds.map((id, i) => [id, i < 11]));
  assert.equal(scoreAnswers(eleven).category, 'Bajo');
});

test('section percentages are computed independently', () => {
  const answers = all(false);
  for (const id of questionIds.slice(0, 10)) answers[id] = true;
  const s = scoreAnswers(answers);
  assert.equal(s.personalPercent, 100);
  assert.equal(s.businessPercent, 0);
  assert.equal(s.protection, 50);
});

test('submissionSchema accepts a complete valid submission', () => {
  assert.equal(submissionSchema.safeParse(valid(all(true))).success, true);
});

test('submissionSchema rejects missing answers, bad email and no consent', () => {
  const partial = all(true);
  delete partial.A1;
  assert.equal(submissionSchema.safeParse(valid(partial)).success, false);
  assert.equal(
    submissionSchema.safeParse({ ...valid(all(true)), email: 'not-an-email' }).success,
    false,
  );
  assert.equal(
    submissionSchema.safeParse({ ...valid(all(true)), privacyAccepted: false }).success,
    false,
  );
  assert.equal(submissionSchema.safeParse({ ...valid(all(true)), id: 'nope' }).success, false);
});
