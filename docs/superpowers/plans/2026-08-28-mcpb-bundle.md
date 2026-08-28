# lw3-mcp MCP Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce `dist/lw3-mcp-<version>.mcpb`, a bundle a colleague installs into Claude Desktop with one drag, with no Node.js or npm on their machine.

**Architecture:** Pure packaging. `src/` is not modified. A `manifest.json` describes the server to Claude Desktop, `scripts/bundle.js` drives the official `mcpb` CLI to pack the repo plus a pruned `node_modules`, and `scripts/verify-bundle.js` unpacks the result and proves it actually runs before the build reports success.

**Tech Stack:** Node 22, ES modules, `node:test` (built in, no new dependencies), `@anthropic-ai/mcpb@2.1.2` via `npx`.

**Spec:** [2026-08-28-mcpb-bundle-design.md](../specs/2026-08-28-mcpb-bundle-design.md)

## Global Constraints

- **No new runtime or dev dependencies.** `package.json` `dependencies` stays exactly `@modelcontextprotocol/sdk` and `multicast-dns`. Tests use built-in `node:test`; the packer runs through `npx`.
- **Do not modify `src/`.** Any change to `src/index.js`, `src/lw3-protocol.js`, or `src/lightware-discovery.js` is out of scope for this plan.
- **ES modules only.** `package.json` has `"type": "module"`; use `import`, and include `.js` extensions in relative imports.
- **Pin the packer to `@anthropic-ai/mcpb@2.1.2`.** Never `@latest` in a script; a schema change upstream must not silently alter builds.
- **The literal `${__dirname}` in `manifest.json` must survive verbatim** into the packed file. It is expanded by Claude Desktop at install time, not by any shell or by Node.
- **Windows-first.** Development and builds happen on Windows. When spawning `npm` or `npx` from Node, resolve `npm.cmd` / `npx.cmd` on `win32`, otherwise `execFileSync` fails with ENOENT.
- **Node floor is `>=18.0.0`,** declared in `manifest.json` under `compatibility.runtimes.node`.

## Verified Facts

These were confirmed empirically on 2026-08-28 before this plan was written. Trust them; do not re-derive.

- `npx -y @anthropic-ai/mcpb@2.1.2 --version` prints `2.1.2`. Subcommands include `validate`, `pack`, `unpack`, `info`, `clean`, `sign`.
- The exact `manifest.json` in Task 1 passes `mcpb validate` with zero errors. Only a warning appears, recommending 512x512 icons.
- `assets/icon.png` is already 512x512 and committed.
- The MCP stdio handshake in Task 2 returns exactly 11 tools from `src/index.js`: `connect, disconnect, GET, SET, GETALL, GETROOT, CALL, OPEN, MAN, status, discover`.
- The regex `/^ {10}name: '([^']+)',$/gm` extracts exactly those 11 names from `src/index.js` and nothing else.
- `tar` on the Git Bash PATH is **GNU tar 1.35 and cannot read zip archives.** Do not use `tar` for bundle inspection. `mcpb unpack` is the supported path.
- `src/index.js` starts successfully on Node 22 even with no `package.json` beside it, because Node 22.7+ auto-detects ESM syntax. This is **not** a reason to drop `package.json` from the bundle: the manifest declares a `>=18` node floor, older runtimes have no such detection, and the Node version Claude Desktop ships is not under our control.

---

### Task 1: manifest.json and drift tests

Claude Desktop reads `manifest.json` to learn how to launch the server. The tests exist to catch the one failure mode that stays invisible until install time: the manifest's tool list drifting from what `src/index.js` actually registers.

**Files:**
- Create: `manifest.json`
- Create: `tests/manifest.test.js`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `manifest.json` at repo root, with `server.entry_point` set to `src/index.js` and 11 entries in `tools`. Task 2 names `manifest.json` as a required bundle entry; Task 3 packs it.

- [ ] **Step 1: Write the failing tests**

Create `tests/manifest.test.js`:

```js
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
```

- [ ] **Step 2: Add the test script**

In `package.json`, add to `scripts`:

```json
"test": "node --test tests/*.js"
```

The directory form `node --test tests/` does not discover the tests on Node 22.20 on this machine; the glob form does. Verified during Task 1.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL. Every test errors during module load with `ENOENT: no such file or directory, open '...manifest.json'`, because the manifest does not exist yet.

- [ ] **Step 4: Create manifest.json**

Create `manifest.json` at the repository root, exactly:

```json
{
  "manifest_version": "0.2",
  "name": "lw3-mcp",
  "display_name": "Lightware LW3 Gateway",
  "version": "1.0.0",
  "description": "Discover and control Lightware devices over the LW3 protocol",
  "author": { "name": "Andras Toth", "email": "andras.toth@lightware.com" },
  "icon": "assets/icon.png",
  "license": "MIT",
  "keywords": ["lightware", "lw3", "av", "matrix", "mdns"],
  "server": {
    "type": "node",
    "entry_point": "src/index.js",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/src/index.js"]
    }
  },
  "tools": [
    { "name": "discover", "description": "Discover Lightware devices on the local network using mDNS" },
    { "name": "connect", "description": "Connect to a Lightware device using LW3 protocol" },
    { "name": "disconnect", "description": "Disconnect from the current Lightware device" },
    { "name": "status", "description": "Get the current connection status" },
    { "name": "GET", "description": "Read a property value from the connected Lightware device" },
    { "name": "SET", "description": "Set a property value on the connected Lightware device" },
    { "name": "GETALL", "description": "Get all child nodes, properties and methods of a node" },
    { "name": "GETROOT", "description": "Get root structure of the device (equivalent to GETALL /V1/*)" },
    { "name": "CALL", "description": "Execute a method on the connected Lightware device" },
    { "name": "OPEN", "description": "Open a subscription to a property on the connected Lightware device" },
    { "name": "MAN", "description": "Get manual/documentation for a property or method" }
  ],
  "compatibility": {
    "platforms": ["win32", "darwin", "linux"],
    "runtimes": { "node": ">=18.0.0" }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`

Expected: PASS, `# pass 5`, `# fail 0`.

- [ ] **Step 6: Confirm the real schema accepts it**

Run: `npx -y @anthropic-ai/mcpb@2.1.2 validate manifest.json`

Expected: `Manifest schema validation passes!` and exit code 0. An "Icon validation passed" warning is fine.

If validation fails, the CLI is authoritative over this plan. Fix `manifest.json` to satisfy it, then correct the spec's manifest section to match.

- [ ] **Step 7: Commit**

```bash
git add manifest.json tests/manifest.test.js package.json
git commit -m "Add MCP bundle manifest with tool-drift tests"
```

---

### Task 2: Bundle verifier

Two failure modes here are silent: a bundle that installs cleanly but dies on launch because `node_modules` was excluded, and a bundle whose imports do not resolve from the unpacked tree. This task builds the check; Task 3 wires it into the build.

The pure entry-list assertion is unit-tested here. The unpack-and-run path is integration and first runs against a real bundle in Task 3.

**Files:**
- Create: `scripts/verify-bundle.js`
- Create: `tests/verify-bundle.test.js`

**Interfaces:**
- Consumes: `manifest.json` from Task 1, named as a required entry.
- Produces, all exported from `scripts/verify-bundle.js`:
  - `REQUIRED_ENTRIES: string[]` — forward-slash relative paths that must exist inside the bundle.
  - `assertRequiredEntries(entries: string[]): void` — throws `Error` listing every missing entry; returns `undefined` on success.
  - `listFilesRecursive(dir: string, prefix?: string): string[]` — forward-slash paths relative to `dir`.
  - `verifyBundle(mcpbPath: string): Promise<{ toolCount: number, root: string }>` — unpacks, asserts entries, runs the handshake; throws on any failure.

  Task 3 imports `verifyBundle` only.

- [ ] **Step 1: Write the failing test**

Create `tests/verify-bundle.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRequiredEntries, REQUIRED_ENTRIES } from '../scripts/verify-bundle.js';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`

Expected: FAIL with `Cannot find module` for `../scripts/verify-bundle.js`. The five Task 1 tests still pass.

- [ ] **Step 3: Write the verifier**

Create `scripts/verify-bundle.js`:

```js
#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

const MCPB = '@anthropic-ai/mcpb@2.1.2';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

export const REQUIRED_ENTRIES = [
  'manifest.json',
  // package.json carries "type": "module". Node 22.7+ detects ESM syntax without
  // it, but the manifest declares a >=18 floor and older runtimes do not, so an
  // omitted package.json fails at launch on whatever Node Claude Desktop ships.
  'package.json',
  'src/index.js',
  'src/lw3-protocol.js',
  'src/lightware-discovery.js',
  'assets/icon.png',
  'node_modules/@modelcontextprotocol/sdk/package.json',
  'node_modules/multicast-dns/package.json',
];

export function assertRequiredEntries(entries) {
  const present = new Set(entries.map((e) => e.replace(/\\/g, '/')));
  const missing = REQUIRED_ENTRIES.filter((e) => !present.has(e));
  if (missing.length === 0) return;
  throw new Error(
    `Bundle is missing required entries:\n  ${missing.join('\n  ')}\n\n` +
      'If the node_modules entries are the missing ones, the packer honored .gitignore ' +
      '(which lists node_modules/). Such a bundle installs without complaint and then fails ' +
      'on first launch with an unresolvable import. Fix .mcpbignore before shipping.'
  );
}

export function listFilesRecursive(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRecursive(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

function findBundleRoot(dir) {
  if (existsSync(join(dir, 'manifest.json'))) return dir;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(dir, entry.name, 'manifest.json'))) {
      return join(dir, entry.name);
    }
  }
  throw new Error(`No manifest.json found in the unpacked bundle at ${dir}`);
}

function listTools(entryPoint) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entryPoint], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Server did not answer tools/list within 15s. stderr:\n${stderr}`));
    }, 15000);

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Server exited with code ${code}. stderr:\n${stderr}`));
      }
    });

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(msg.result?.tools ?? []);
        }
      }
    });

    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'verify-bundle', version: '1.0.0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

export async function verifyBundle(mcpbPath) {
  const workdir = mkdtempSync(join(tmpdir(), 'lw3-mcpb-'));
  try {
    execFileSync(npx, ['-y', MCPB, 'unpack', mcpbPath, workdir], { stdio: 'pipe' });
    const root = findBundleRoot(workdir);

    assertRequiredEntries(listFilesRecursive(root));

    const tools = await listTools(join(root, 'src', 'index.js'));
    if (tools.length !== 11) {
      throw new Error(
        `Expected 11 tools from the unpacked server, got ${tools.length}: ` +
          tools.map((t) => t.name).join(', ')
      );
    }
    return { toolCount: tools.length, root };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith('verify-bundle.js')) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node scripts/verify-bundle.js <path-to.mcpb>');
    process.exit(2);
  }
  verifyBundle(target).then(
    ({ toolCount }) => console.log(`OK: bundle unpacks, dependencies present, server lists ${toolCount} tools`),
    (err) => { console.error(`FAILED: ${err.message}`); process.exit(1); }
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`

Expected: PASS, `# pass 9`, `# fail 0` (five from Task 1, four here).

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-bundle.js tests/verify-bundle.test.js
git commit -m "Add bundle verifier that unpacks and runs the packed server"
```

---

### Task 3: Build script and ignore rules

**Files:**
- Create: `.mcpbignore`
- Create: `scripts/bundle.js`
- Modify: `package.json` (add `bundle` script)

**Interfaces:**
- Consumes: `verifyBundle` from `scripts/verify-bundle.js` (Task 2), and `manifest.json` (Task 1).
- Produces: `dist/lw3-mcp-<version>.mcpb`, verified before the script exits 0.

- [ ] **Step 1: Write the ignore rules**

Create `.mcpbignore`:

```
.git/
.claude/
docs/
dist/
tests/
scripts/
assets/icon.svg
logo.svg
cursor_config.json
CLAUDE.md
.mcpbignore
```

`node_modules/` is deliberately absent from this list: the dependencies must ship. `tests/` and `scripts/` are build-time only.

- [ ] **Step 2: Write the build script**

Create `scripts/bundle.js`:

```js
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

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

console.log(`Building lw3-mcp ${pkg.version}`);

console.log('\n[1/4] Installing production dependencies');
run(npm, ['ci', '--omit=dev']);

console.log('\n[2/4] Validating manifest');
run(npx, ['-y', MCPB, 'validate', 'manifest.json']);

console.log('\n[3/4] Packing');
mkdirSync(join(root, 'dist'), { recursive: true });
run(npx, ['-y', MCPB, 'pack', '.', outFile]);

if (!existsSync(outFile)) {
  throw new Error(`Packer reported success but ${outFile} does not exist`);
}

console.log('\n[4/4] Verifying');
const { toolCount } = await verifyBundle(outFile);

const mb = (statSync(outFile).size / 1024 / 1024).toFixed(1);
console.log(`\nOK  ${outFile}  (${mb} MB, ${toolCount} tools)`);
```

- [ ] **Step 3: Add the bundle script**

In `package.json`, add to `scripts`:

```json
"bundle": "node scripts/bundle.js"
```

- [ ] **Step 4: Build**

Run: `npm run bundle`

Expected: the four steps print in order and the final line reads roughly

```
OK  C:\Taurus\lw3-mcp\dist\lw3-mcp-1.0.0.mcpb  (18.x MB, 11 tools)
```

If step 4 fails naming missing `node_modules/` entries, the packer honored `.gitignore`. Fix it by moving the exclusion list entirely into `.mcpbignore`, or by adding an explicit negation for `node_modules/`, then re-run until verification passes. Do not disable or weaken the check to get a green build.

- [ ] **Step 5: Confirm the artifact independently**

Run: `npx -y @anthropic-ai/mcpb@2.1.2 info dist/lw3-mcp-1.0.0.mcpb`

Expected: reports name `lw3-mcp`, version `1.0.0`, and a file count in the thousands, reflecting the dependency tree.

- [ ] **Step 6: Commit**

```bash
git add .mcpbignore scripts/bundle.js package.json
git commit -m "Add mcpb build script with post-pack verification"
```

---

### Task 4: Install documentation

`INSTALL.md` is uploaded next to the `.mcpb` on the file server. Assume its reader has never installed a Claude Desktop extension and does not know about the LAN requirement.

**Files:**
- Create: `INSTALL.md`

**Interfaces:**
- Consumes: the filename convention `lw3-mcp-<version>.mcpb` from Task 3.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Verify the claims against the code first**

Run: `grep -n "6107" src/lw3-protocol.js src/index.js` and `grep -n "_tcp.local" src/lightware-discovery.js`

Expected: 6107 appears as the default port in both files, and four `_tcp.local` service types appear in the discovery module. Write the document to match what you find, not what this plan assumes.

- [ ] **Step 2: Write INSTALL.md**

Create `INSTALL.md`:

```markdown
# Lightware LW3 Gateway — Install

Adds eleven tools to Claude Desktop for discovering and controlling Lightware
devices over LW3.

## Requirements

- Claude Desktop, updated to a version with Settings > Extensions
- **Your computer must be on the same network as the device.** The gateway sends
  mDNS multicast to find devices and connects to them on TCP port 6107. A VPN
  that routes all traffic, or a guest network that blocks multicast, will make
  discovery return nothing.
- No Node.js or npm needed. Claude Desktop runs the server with its own runtime.

## Install

1. Download `lw3-mcp-<version>.mcpb`.
2. Open Claude Desktop and go to **Settings > Extensions**.
3. Drag the `.mcpb` file onto that window.
4. Confirm the install prompt.

## First use

Ask Claude:

- *"Discover Lightware devices on the network"* — lists model name, serial
  number, IP address, and hostname for everything it finds.
- *"Connect to 192.168.2.109"* — opens the LW3 connection. The hostname from
  discovery works too.
- *"Show me the root structure"* — dumps the device tree.
- *"Read /V1/MANAGEMENT/NETWORK.HostName"*

The connection stays open for the whole Claude Desktop session. Only one device
at a time; ask Claude to disconnect before connecting to another.

## Troubleshooting

**Discovery finds nothing.** Check that you are on the same subnet as the device
and not on a VPN. Failing that, connect directly by IP address; discovery is a
convenience, not a prerequisite.

**"Not connected to a device".** Ask Claude to connect first. The connection does
not survive a Claude Desktop restart.

**Commands time out.** The device is reachable but not answering on port 6107.
Confirm LW3 is enabled on the device.

## Updating

Bundles do not update themselves. Download the newer `.mcpb` and drag it in
again; it replaces the installed version.

## Which version am I running?

Settings > Extensions lists the installed version. Compare it against the
filename on the file server.
```

- [ ] **Step 3: Commit**

```bash
git add INSTALL.md
git commit -m "Add end-user install guide for the bundle"
```

---

## Done when

- `npm test` passes with 9 tests.
- `npm run bundle` exits 0 and prints a path, a size, and `11 tools`.
- `dist/lw3-mcp-1.0.0.mcpb` and `INSTALL.md` are ready to upload to the file server.

Two things cannot be checked from the build machine and remain the operator's job: a real drag-and-drop install into Claude Desktop, and a discovery run against live hardware on the LAN.
