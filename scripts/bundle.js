#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundle } from './verify-bundle.js';

const MCPB = '@anthropic-ai/mcpb@2.1.2';
const isWin = process.platform === 'win32';
const npx = isWin ? 'npx.cmd' : 'npx';
const npm = isWin ? 'npm.cmd' : 'npm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outFile = join(root, 'dist', `lw3-mcp-${pkg.version}.mcpb`);

// shell:true is required on Windows to spawn .cmd at all; quoting is required
// because shell:true splits arguments on spaces. See Global Constraints.
const quoteArg = (arg) => (isWin ? `"${arg}"` : arg);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: isWin });

console.log(`Building lw3-mcp ${pkg.version}`);

console.log('\n[1/6] Running tests');
run(npm, ['test']);

console.log('\n[2/6] Installing production dependencies');
run(npm, ['ci', '--omit=dev']);

console.log('\n[3/6] Validating manifest');
run(npx, ['-y', MCPB, 'validate', 'manifest.json']);

console.log('\n[4/6] Packing');
mkdirSync(join(root, 'dist'), { recursive: true });
run(npx, ['-y', MCPB, 'pack', '.', quoteArg(outFile)]);

if (!existsSync(outFile)) {
  throw new Error(`Packer reported success but ${outFile} does not exist`);
}

console.log('\n[5/6] Verifying');
const { toolCount } = await verifyBundle(outFile);

// Step 2 pruned devDependencies, which leaves the tree unable to run
// build:panel (it inlines the ext-apps SDK from node_modules). Put them back
// so the repo still works after a bundle.
console.log('
[6/6] Restoring dev dependencies');
run(npm, ['install', '--no-audit', '--no-fund']);

const mb = (statSync(outFile).size / 1024 / 1024).toFixed(1);
console.log(`\nOK  ${outFile}  (${mb} MB, ${toolCount} tools)`);
