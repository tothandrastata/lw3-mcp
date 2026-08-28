import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const manifest = JSON.parse(read('../manifest.json'));
const pkg = JSON.parse(read('../package.json'));
const serverSource = read('../src/index.js');

test('declares the fields Claude Desktop requires', () => {
  for (const field of ['manifest_version', 'name', 'version', 'description', 'author', 'server']) {
    assert.ok(manifest[field], `manifest.json is missing "${field}"`);
  }
});

test('version tracks package.json', () => {
  assert.equal(manifest.version, pkg.version,
    'manifest version must match package.json or the built filename lies about its contents');
});

test('server entry point is relocatable', () => {
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.server.entry_point, 'src/index.js');
  assert.deepEqual(manifest.server.mcp_config.args, ['${__dirname}/src/index.js'],
    'an absolute path here would only work on the build machine');
});

test('every tool in the manifest is registered in src/index.js', () => {
  for (const tool of manifest.tools) {
    assert.match(serverSource, new RegExp(`name: '${tool.name}',`),
      `manifest declares "${tool.name}" but src/index.js does not register it`);
  }
});

test('every tool registered in src/index.js is in the manifest', () => {
  const registered = [...serverSource.matchAll(/^ {10}name: '([^']+)',$/gm)].map((m) => m[1]);
  assert.equal(registered.length, 10, 'expected 10 registered tools');
  const declared = new Set(manifest.tools.map((t) => t.name));
  const missing = registered.filter((n) => !declared.has(n));
  assert.deepEqual(missing, [],
    `src/index.js registers tools absent from manifest.json: ${missing.join(', ')}`);
});

test('MCP Server constructor version tracks package.json', () => {
  const match = serverSource.match(/new Server\(\s*\{\s*name:\s*'[^']+',\s*version:\s*'([^']+)'/);
  assert.ok(match, 'could not find `new Server({ name: ..., version: ... })` in src/index.js');
  assert.equal(match[1], pkg.version,
    `src/index.js hardcodes Server version '${match[1]}'; update that literal to match package.json's "${pkg.version}"`);
});
