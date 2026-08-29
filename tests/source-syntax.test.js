import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every source file must at least parse.
 *
 * This looks redundant until you notice what the rest of the suite actually
 * does: manifest.test.js reads src/index.js as *text* and matches patterns in
 * it, and nothing else imports it, because importing it starts a server on
 * stdio. So a syntax error in the largest file in the project passed a green
 * 115-test run, and was caught only when the packed bundle refused to start.
 *
 * `node --check` is the cheapest possible guard against that, and it costs
 * milliseconds per file.
 */
function jsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

test('every file under src/ parses', () => {
  const files = jsFilesUnder(join(ROOT, 'src'));
  assert.ok(files.length >= 5, `expected several source files, found ${files.length}`);

  for (const file of files) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }),
      `${file.slice(ROOT.length + 1)} does not parse`
    );
  }
});

test('every build and verification script parses', () => {
  // These run only during `npm run bundle`, so a break in one is discovered at
  // release time -- exactly when it is most expensive.
  for (const file of jsFilesUnder(join(ROOT, 'scripts'))) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }),
      `${file.slice(ROOT.length + 1)} does not parse`
    );
  }
});
