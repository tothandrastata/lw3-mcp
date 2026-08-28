import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRequiredEntries, REQUIRED_ENTRIES, assertNoNativeBinaries } from '../scripts/verify-bundle.js';

test('accepts a complete entry list', () => {
  assert.doesNotThrow(() => assertRequiredEntries([...REQUIRED_ENTRIES, 'README.md']));
});

test('normalises backslashes before comparing', () => {
  const windowsStyle = REQUIRED_ENTRIES.map((e) => e.replace(/\//g, '\\'));
  assert.doesNotThrow(() => assertRequiredEntries(windowsStyle));
});

test('rejects a bundle with no dependencies and explains why', () => {
  const withoutDeps = REQUIRED_ENTRIES.filter((e) => !e.startsWith('node_modules/'));
  assert.throws(() => assertRequiredEntries(withoutDeps), (err) => {
    assert.match(err.message, /node_modules/);
    assert.match(err.message, /gitignore/i,
      'the error must name the likely cause, since such a bundle installs fine and only fails at launch');
    return true;
  });
});

test('names every missing entry, not just the first', () => {
  assert.throws(() => assertRequiredEntries([]), (err) => {
    for (const entry of REQUIRED_ENTRIES) {
      assert.match(err.message, new RegExp(entry.replace(/[/.]/g, '\\$&')));
    }
    return true;
  });
});

test('accepts a bundle with no compiled addons', () => {
  assert.doesNotThrow(() =>
    assertNoNativeBinaries(['src/index.js', 'node_modules/ws/index.js', 'manifest.json'])
  );
});

test('rejects compiled addons and names every one', () => {
  assert.throws(
    () =>
      assertNoNativeBinaries([
        'src/index.js',
        'node_modules/bufferutil/build/Release/bufferutil.node',
        'node_modules/utf-8-validate/build/Release/validation.node',
      ]),
    (err) => {
      assert.match(err.message, /bufferutil\.node/);
      assert.match(err.message, /validation\.node/, 'both offenders must be listed, not just the first');
      assert.match(err.message, /platform/i, 'the message must say why this matters');
      return true;
    }
  );
});

test('is case-insensitive, since Windows paths may not be', () => {
  assert.throws(() => assertNoNativeBinaries(['node_modules/x/Binding.NODE']));
});
