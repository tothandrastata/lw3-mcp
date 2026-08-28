#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

const MCPB = '@anthropic-ai/mcpb@2.1.2';
const isWin = process.platform === 'win32';
const npx = isWin ? 'npx.cmd' : 'npx';

// Node 20.12+ refuses to spawn .cmd/.bat without shell:true (the
// CVE-2024-27980 hardening), and shell:true routes through cmd.exe, which
// splits arguments on spaces. So on Windows: shell on, path arguments quoted.
const quoteArg = (arg) => (isWin ? `"${arg}"` : arg);

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
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error(`Server did not answer tools/list within 15s. stderr:\n${stderr}`));
    }, 15000);

    const doResolve = (value) => {
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const doReject = (err) => {
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { doReject(err); });
    child.on('exit', (code) => {
      if (settled) return;
      doReject(new Error(`Server exited with code ${code} before answering tools/list. stderr:\n${stderr}`));
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
          doResolve(msg.result?.tools ?? []);
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
    execFileSync(npx, ['-y', MCPB, 'unpack', quoteArg(mcpbPath), quoteArg(workdir)], {
      stdio: 'pipe',
      shell: isWin,
    });
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
