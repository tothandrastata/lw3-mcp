#!/usr/bin/env node
/**
 * Generates ui/xpoint.html from ui/xpoint.src.html by inlining the official
 * MCP Apps SDK.
 *
 * The panel has to be a single self-contained document -- the host serves it
 * from a sandboxed origin under a restrictive CSP, so it cannot fetch a script
 * from anywhere. The SDK ships an "app-with-deps" build that has no external
 * imports, which is what makes inlining possible at all.
 *
 * The bundle is minified, so `App` is a mangled local name exposed only through
 * its trailing `export {... as App}` clause. We read that clause to recover the
 * real binding rather than hard-coding a name that changes on every SDK release.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = join(
  ROOT,
  'node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js'
);
const PANELS = [
  { src: join(ROOT, 'ui/xpoint.src.html'), out: join(ROOT, 'ui/xpoint.html') },
  { src: join(ROOT, 'ui/probe.src.html'), out: join(ROOT, 'ui/probe.html') },
];
const PLACEHOLDER = '/* __MCP_APPS_SDK__ */';

/** Names the panel needs out of the SDK bundle. */
const WANTED = ['App'];

function bindingsFor(bundle, names) {
  const clause = [...bundle.matchAll(/export\s*\{([^}]*)\}/g)]
    .map((m) => m[1])
    .join(',');
  if (!clause) throw new Error('no export clause in the SDK bundle');

  return names.map((name) => {
    // `X as App`, or a bare `App` if the bundle ever stops mangling it.
    const aliased = clause.match(
      new RegExp(`([A-Za-z_$][\\w$]*)\\s+as\\s+${name}\\b`)
    );
    if (aliased) return [name, aliased[1]];
    if (new RegExp(`(^|,)\\s*${name}\\s*(,|$)`).test(clause)) return [name, name];
    throw new Error(`SDK bundle does not export "${name}"`);
  });
}

const bundle = readFileSync(SDK, 'utf8');
const bindings = bindingsFor(bundle, WANTED);
const aliases = bindings
  .map(([name, local]) => `const ${name} = ${local};`)
  .join('\n');

const inlined = [
  '// --- @modelcontextprotocol/ext-apps (app-with-deps), inlined by',
  '// --- scripts/build-panel.js. Do not edit ui/xpoint.html by hand.',
  bundle.trimEnd(),
  '',
  aliases,
].join('\n');

// The replacement MUST go through a function. The minified bundle is full of
// `$` sequences -- `$&`, `` $` ``, `$'` -- which String.replace treats as
// substitution patterns when the replacement is a plain string, splicing parts
// of this very document into the middle of the script. A replacer function is
// handed the text verbatim.
for (const { src: srcPath, out } of PANELS) {
  const src = readFileSync(srcPath, 'utf8');
  if (!src.includes(PLACEHOLDER)) {
    throw new Error(`${srcPath} is missing the ${PLACEHOLDER} marker`);
  }
  writeFileSync(out, src.replace(PLACEHOLDER, () => inlined), 'utf8');
}

const version = JSON.parse(
  readFileSync(join(ROOT, 'node_modules/@modelcontextprotocol/ext-apps/package.json'), 'utf8')
).version;
console.log(
  `[build-panel] ${PANELS.length} panel(s) built from ext-apps@${version} ` +
    `(${bindings.map(([n, l]) => `${n}=${l}`).join(', ')})`
);
