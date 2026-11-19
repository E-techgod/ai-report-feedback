import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (name) => readFileSync(new URL(`../scripts/${name}`, import.meta.url), 'utf8');

test('legacy kill switch is valid source and its function guard defaults off', () => {
  const source = read('legacy-email-kill-switch.gs');
  new vm.Script(source);
  const wrapped = `${source}\nfunction enviarCorreosPendientes() { if (!legacyEmailEnabled_()) return; return 'sent'; } enviarCorreosPendientes()`;
  const script = new vm.Script(wrapped);
  const props = (value) => ({
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => value }) },
    console: { log() {} },
  });
  assert.equal(script.runInNewContext(props(null)), undefined);
  assert.equal(script.runInNewContext(props('true')), 'sent');
});

test('legacy one-row helper locates shifted questionnaire columns by header', () => {
  const source = read('apps-script-test-one-row.gs');
  const context = vm.createContext({});
  new vm.Script(source).runInContext(context);
  const headers = [
    'Marca temporal',
    'Nombre',
    'Apellido*',
    'Correo*',
    ...Array.from({ length: 11 }, (_, i) => `Tracking ${i}`),
    ...Array.from({ length: 10 }, (_, i) => `A) ${i + 1}.- Pregunta`),
    ...Array.from({ length: 10 }, (_, i) => `B) ${i + 1}.- Pregunta`),
  ];
  const row = headers.map((_, i) => (i === 3 ? 'a@b.com' : ''));
  headers.slice(15).forEach((_, i) => {
    row[15 + i] = i % 2 ? 'No' : 'Si';
  });
  const sheet = {
    getLastColumn: () => headers.length,
    getRange: (n) => ({ getValues: () => [n === 1 ? headers : row] }),
  };
  const answers = context.leerRespuestasPorCabecera_(sheet, 2, 'a@b.com');
  assert.equal(answers.length, 20);
  assert.equal(answers[0], 'Si');
  assert.equal(answers[19], 'No');
  assert.throws(() => context.leerRespuestasPorCabecera_(sheet, 2, 'wrong@b.com'), /no coincide/);
});

test('one-row sender stops at the kill switch before acquiring a lock or sending', () => {
  const source = `${read('legacy-email-kill-switch.gs')}\n${read('apps-script-test-one-row.gs')}`;
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    LockService: {
      getScriptLock: () => {
        throw new Error('lock must not be used');
      },
    },
    GmailApp: {
      sendEmail: () => {
        throw new Error('mail must not be sent');
      },
    },
  });
  new vm.Script(source).runInContext(context);
  assert.throws(() => context.enviarCorreoPrueba(), /disabled/);
});

test('paste-ready legacy patch reads A/B answers by header after tracking columns', () => {
  const context = vm.createContext({});
  new vm.Script(read('legacy-questionnaire-header-patch.gs')).runInContext(context);
  const headers = [
    'Marca temporal',
    'Nombre',
    'Apellido*',
    'Correo*',
    ...Array.from({ length: 11 }, (_, i) => `Tracking ${i}`),
    ...Array.from({ length: 10 }, (_, i) => `A) ${i + 1}.- Pregunta`),
    ...Array.from({ length: 10 }, (_, i) => `B) ${i + 1}.- Pregunta`),
  ];
  const row = headers.map((_, i) => (i === 3 ? 'a@b.com' : ''));
  headers.slice(15).forEach((_, i) => {
    row[15 + i] = i % 2 ? 'No' : 'Si';
  });
  const sheet = {
    getLastColumn: () => headers.length,
    getRange: (n) => ({ getValues: () => [n === 1 ? headers : row] }),
  };
  assert.equal(context.leerRespuestasLegacyPorCabecera_(sheet, 2, 'a@b.com').length, 20);
  assert.throws(
    () => context.leerRespuestasLegacyPorCabecera_(sheet, 2, 'wrong@b.com'),
    /no coincide/,
  );
});
