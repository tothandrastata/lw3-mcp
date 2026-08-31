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
  assert.equal(registered.length, 11, 'expected 11 registered tools');
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

test('the server sends instructions naming discover as the entry point', () => {
  // Instructions reach the host's system prompt. Tool descriptions do not always:
  // some hosts list MCP tools by name and fetch schemas only on demand, so a tool
  // can be invisible until the user names the server — which is exactly what a
  // user reported. This is the one place that is always read.
  const match = serverSource.match(/instructions:\s*\[([\s\S]*?)\]\.join/);
  assert.ok(match, 'the Server options must carry an instructions array');

  const text = match[1];
  assert.match(text, /discover/, 'instructions must name the discovery tool');
  assert.match(text, /read-only/i, 'saying it is read-only is what lowers the bar to calling it');
  assert.match(text, /nmap/i, 'the failure mode worth naming is suggesting a manual scan instead');

  // "prefer", not "never": someone debugging their own network may legitimately
  // want a shell command, and an absolute prohibition misfires there.
  assert.match(text, /Prefer it over/, 'the steer should be a preference, not a prohibition');
  assert.doesNotMatch(text, /never suggest/i);
});

test('the discovery tool description carries the words users actually type', () => {
  const at = serverSource.indexOf("name: 'discover'");
  assert.ok(at > 0, 'discover must be registered');
  // Adjacent string literals are joined first: the description is wrapped across
  // source lines, so phrases that read contiguously in the shipped text are split
  // by `' + '` in the file.
  const description = serverSource.slice(at, at + 900).replace(/'\s*\+\s*'/g, '');

  for (const phrase of ['on the network', 'inventory', 'Read-only', 'no arguments']) {
    assert.ok(description.includes(phrase), `discover's description should mention "${phrase}"`);
  }
});
