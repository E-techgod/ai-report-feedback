import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import configModule from '../next.config.ts';

// tsx compiles the .ts config as CommonJS, so the default export can arrive wrapped.
const nextConfig = configModule.default ?? configModule;

/**
 * Regression: on Vercel the PDF route returned an empty HTTP 500 because pdfkit loads its built-in
 * fonts through `createRequire('#standard-fonts/*')`, which Next's file tracer cannot follow, so
 * pdfkit/js/standard-fonts was missing from the deployed function (MODULE_NOT_FOUND). Everything
 * worked locally because the whole node_modules tree is present there.
 *
 * These tests derive the required files from the real sources (the fonts ReportPdf.tsx uses,
 * pdfkit's own font table and each font module's requires), so a new font or a pdfkit layout
 * change fails here instead of in production.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const pdfkitDir = path.join(root, 'node_modules', 'pdfkit');
const PDF_ROUTES = ['/api/report/[id]/pdf', '/api/questionnaire', '/api/cron/retry-emails'];
const FONT_GLOB = './node_modules/pdfkit/js/standard-fonts/**/*.cjs';

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Files a Next outputFileTracingIncludes entry would add (supports the `**` / `*` forms used here). */
function expand(pattern) {
  const [dir, rest] = pattern.split('/**/');
  const base = path.join(root, dir);
  const ext = rest ? rest.replace('*', '') : '';
  return rest ? walk(base).filter((f) => f.endsWith(ext)) : [path.join(root, pattern)];
}

function pdfFonts() {
  const source = readFileSync(path.join(root, 'src/lib/pdf/ReportPdf.tsx'), 'utf8');
  return [...new Set([...source.matchAll(/fontFamily: '([^']+)'/g)].map((m) => m[1]))];
}

test('every function that renders the PDF packages the logo and the pdfkit fonts', () => {
  const includes = nextConfig.outputFileTracingIncludes ?? {};
  for (const route of PDF_ROUTES) {
    assert.ok(includes[route], `${route} must be listed in outputFileTracingIncludes`);
    assert.ok(includes[route].includes('./public/images/quiron-logo.png'), `${route}: logo`);
    assert.ok(includes[route].includes(FONT_GLOB), `${route}: pdfkit standard fonts`);
  }
});

test('the font glob matches how pdfkit resolves #standard-fonts at runtime', () => {
  const pkg = JSON.parse(readFileSync(path.join(pdfkitDir, 'package.json'), 'utf8'));
  // If this alias moves, FONT_GLOB (and next.config.ts) must follow.
  assert.equal(pkg.imports['#standard-fonts/*'].require, './js/standard-fonts/*.cjs');
});

test('the packaged files cover every font the PDF uses and what each font requires', () => {
  const packaged = new Set(expand(FONT_GLOB));
  const pdfkitSource = readFileSync(path.join(pdfkitDir, 'js/pdfkit.node.mjs'), 'utf8');
  const fonts = pdfFonts();
  assert.ok(fonts.includes('Helvetica'), 'sanity: the PDF uses Helvetica');

  for (const family of fonts) {
    const table = new RegExp(
      `'?${family}'?: \\(\\) => require\\$1\\('#standard-fonts/([A-Za-z]+)'\\)`,
    );
    const moduleName = pdfkitSource.match(table)?.[1];
    assert.ok(
      moduleName,
      `pdfkit has no built-in font module for "${family}" (embed the font instead)`,
    );
    const pending = [path.join(pdfkitDir, 'js/standard-fonts', `${moduleName}.cjs`)];
    while (pending.length) {
      const file = pending.pop();
      assert.ok(packaged.has(file), `${family}: ${path.relative(root, file)} is not packaged`);
      for (const [, request] of readFileSync(file, 'utf8').matchAll(/require\('(\.[^']+)'\)/g))
        pending.push(path.resolve(path.dirname(file), request));
    }
  }
});
