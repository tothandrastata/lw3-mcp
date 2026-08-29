#!/usr/bin/env node
/**
 * Generates ui/univ-xpoint.src.html from ui/xpoint.src.html.
 *
 * The two panels are the same panel over two grid models. Keeping them as
 * separate hand-edited files means every fix has to be made twice, and today
 * already showed what that costs: a cellState fix landed in one copy of the
 * grid model and not the other, and the panel silently used the stale one while
 * every test passed.
 *
 * So the crosspoint panel is the source, and the universal one is derived. A
 * change to rendering, clicking or error handling is made once.
 *
 * Every substitution below must match, or the build fails: a rule that has
 * silently stopped applying is how the two would drift apart again.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'ui/xpoint.src.html');
const OUT = join(ROOT, 'ui/univ-xpoint.src.html');

/** [label, find, replace] — all applied in order, all required to match. */
const RULES = [
  [
    'model injected',
    '// src/xpoint.js, injected verbatim by scripts/build-panel.js.',
    '// src/univ-xpoint.js, injected verbatim by scripts/build-panel.js.',
  ],
  [
    'app identity',
    "const app = new App({ name: 'lw3-xpoint', version: '1.0.0' });",
    "const app = new App({ name: 'lw3-univ-xpoint', version: '1.0.0' });",
  ],
  ['title', '<title>Video crosspoint</title>', '<title>Crosspoint</title>'],
  ['heading', '<h1>Video crosspoint</h1>', '<h1>Crosspoint</h1>'],
  ['table label', 'aria-label="Video crosspoint routing"', 'aria-label="Crosspoint routing"'],
  [
    // The universal model reads names from the XP node, so the second sweep of
    // /V1/MEDIA/VIDEO is not needed.
    'no VIDEO sweep',
    "  const videoLines = linesFromGetAll(await callTool('GETALL', { path: `${VIDEO_NODE}/*` }));\n",
    '',
  ],
  [
    'universal model',
    '  return buildGrid({ xpLines, videoLines, switchableLines });',
    '  return buildUniversalGrid({ xpLines, switchableLines });',
  ],
  [
    // Which ports are destinations is dialect-dependent, so the model decides
    // rather than a port-name pattern that fits one family only.
    'destinations from the model',
    `  // Same pattern src/index.js uses to enumerate destinations before
  // reading each one's SWITCHABLE child: derived from what XP actually
  // reported, not assumed from VIDEO or hardcoded.
  const destinations = [...new Set(
    xpLines.map((l) => {
      const m = l.match(/\\/XP\\/(O\\d+)[./]/);
      return m ? m[1] : null;
    }).filter(Boolean)
  )];`,
    `  // Which ports are destinations depends on the device family, so the model
  // decides it. A port-name pattern here would fit one family only, which is
  // the whole reason this panel exists.
  const first = buildUniversalGrid({ xpLines, switchableLines: [] });
  const destinations = first.destinations.map((d) => d.port);`,
  ],
  [
    'routing property from the grid',
    "      property: 'ConnectedSource',",
    `      // ConnectedSource on one family, SourceStream on another. The grid says
      // which, so nothing here has to know the device.
      property: (lastGrid && lastGrid.routeProp) || 'ConnectedSource',`,
  ],
  [
    'chat fallback names the same property',
    '`Set ${XP_NODE}/${destPort}.ConnectedSource to ${srcPort} ` +',
    "`Set ${XP_NODE}/${destPort}.${(lastGrid && lastGrid.routeProp) || 'ConnectedSource'} to ${srcPort} ` +",
  ],
  [
    'unrecognised device is reported',
    `  if (!grid || grid.destinations.length === 0) {
    gridEl.innerHTML = '';
    setBanner('No video crosspoint destinations were reported.', { stale: false });
    return;
  }`,
    `  if (grid && grid.dialect === null) {
    // Better to say the device was not recognised than to draw an empty grid,
    // which reads as a device with nothing routed.
    gridEl.innerHTML = '';
    setBanner(\`This device's crosspoint was not recognised: \${grid.reason}\`, { stale: false });
    return;
  }
  if (!grid || grid.destinations.length === 0) {
    gridEl.innerHTML = '';
    setBanner('No crosspoint destinations were reported.', { stale: false });
    return;
  }`,
  ],
];

// Normalised to LF first. This repo has core.autocrlf=true, so a checkout can
// rewrite the source with CRLF, and every multi-line rule below would stop
// matching -- failing the build over line endings rather than a real
// divergence. The output is written LF; git applies its own policy on checkout.
let html = readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');

const unmatched = RULES.filter(([, find]) => !html.includes(find)).map(([label]) => label);
if (unmatched.length) {
  throw new Error(
    `derive-univ-panel: no longer matches ui/xpoint.src.html: ${unmatched.join(', ')}.\n` +
      'The panels have diverged. Update the rule rather than editing ui/univ-xpoint.src.html by hand.'
  );
}

for (const [, find, replace] of RULES) html = html.replace(find, () => replace);
writeFileSync(OUT, html, 'utf8');

console.log(`[derive-univ-panel] ui/univ-xpoint.src.html <- ui/xpoint.src.html (${RULES.length} rules)`);
