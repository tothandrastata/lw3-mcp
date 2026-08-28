# Command Signatures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correlate every LW3 response with the command that caused it, so responses stop being attributed to the wrong request, GETALL stops guessing with a timer, multi-line replies stop truncating, and device errors stop being reported as successes.

**Architecture:** Every command is prefixed with a 4-hex-digit signature; the device brackets its reply with `{XXXX` … `}`. `processResponse` becomes a state machine over those three line shapes, keyed on signature instead of "whichever command is at the head of the queue". `sendCommand` resolves with the block's lines. The transports, the GETALL parser, and the MCP tool handlers are untouched.

**Tech Stack:** Node 22, ES modules, `node:test`.

**Spec:** [2026-08-28-command-signatures-design.md](../specs/2026-08-28-command-signatures-design.md)

## Global Constraints

- **No new dependencies.** `dependencies` stays exactly `@modelcontextprotocol/sdk`, `multicast-dns`, `ws`.
- **Do not modify `src/transports/tcp.js` or `src/transports/wss.js`.** This change is entirely above the transport layer.
- **ES modules.** `.js` extensions on relative imports.
- **Signatures are always on.** No probe, no fallback to unsigned commands. A device whose firmware rejects them fails on every command — accepted deliberately, recorded in the spec's Risks.
- **Signature format:** 4 uppercase hex digits, `%04X`, counter wrapping at `0xFFFF`, sent as `<SIG>#<command>\n`.
- **Error detection is by pattern, not prefix:** a line matching `/%E\d+:/` is an error. This replaces the `pE `/`mE `/`er` prefix list.
- **The GETALL response parser does not change.** Its parsing of `pr`/`pw`/`n-`/`m-` lines into `{properties, nodes, methods}` is lifted into a function verbatim, not rewritten.
- **The 5-second timeout is retained**, repurposed from "how long to collect" to "how long to wait for `}`".
- Test script stays `"test": "node --test tests/*.js"`.

## Verified Facts

Measured against a UCX-4x2-HC30 (`jimmy-hc30`, 192.168.2.104) on 2026-08-28. Trust these.

- The device brackets signed replies:
  ```
  > 0001#GETALL /V1/MANAGEMENT/DATETIME
    {0001
    pr /V1/MANAGEMENT/DATETIME.UpTime=0 days 11:09:54
    pw /V1/MANAGEMENT/DATETIME.TimeZone=UTC
    m- /V1/MANAGEMENT/DATETIME:setTime
    n- /V1/MANAGEMENT/DATETIME/NTP
    }
  ```
  Confirmed for `GET`, `GETALL`, and `CALL`. Round trip ~30 ms.
- `/V1/MANAGEMENT/DATETIME` really contains 4 properties, 1 method, 1 child node.
- The current code returns `{"properties":[],"nodes":[],"methods":[]}` for that node when its reply is late, then returns **doubled** counts on the next call, which collects both replies.
- Three error shapes all carry `%E<digits>:` — `pE … %E002: Not exists`, `-E … %E001: Syntax error`, `mE … %E###: …`. Legitimate lines such as `pr /V1/MANAGEMENT/DATETIME.CurrentTime=2026-08-28T18:51:48` do not match, despite containing digits and a colon.
- `OPEN` takes a **node** path. `OPEN /path.Property` returns `%E001: Syntax error`; `OPEN /path` returns `o- /path` and then streams unsolicited `CHG` lines — 15 in 5 idle seconds for `DATETIME`.

---

### Task 1: Signature framing in the protocol layer

The whole correlation change, in one file. It cannot be split: if `sendCommand` were signed while `getAll` was not, the unsigned command's reply would arrive outside any block and be discarded.

**Files:**
- Modify: `src/lw3-protocol.js` (constructor, `processResponse`, `sendCommand`, `getAll`, `get`, `set`, `call`, `man`)
- Create: `tests/signatures.test.js`

**Interfaces:**
- Consumes: the transport contract — `send(text)` plus a `'data'` event carrying a string.
- Produces:
  - `export const COMMAND_TIMEOUT_MS = 5000`
  - `export function parseGetAll(lines: string[]): { properties: Array, nodes: Array, methods: Array }` — the existing parser, lifted verbatim so it can be tested directly
  - `sendCommand(command: string): Promise<string[]>` — **resolves with the block's lines**, not a single string
  - `get`/`set`/`call`/`man` still resolve with a string: the block's lines joined by `\n`
  - `getAll(path)` unchanged in shape; resolves when `}` arrives rather than after a timer
  - A new `'unsolicited'` event carrying each line that arrives outside any block

  Task 2 deletes `open()`. Task 3 documents this behaviour.

- [ ] **Step 1: Write the failing tests**

Create `tests/signatures.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LW3Protocol, parseGetAll, COMMAND_TIMEOUT_MS } from '../src/lw3-protocol.js';

/** Transport stand-in that records what was sent and lets a test feed lines back. */
class FakeTransport extends EventEmitter {
  constructor() { super(); this.sent = []; }
  async connect() {}
  send(text) { this.sent.push(text); }
  async close() {}
  /** Deliver device output, exactly as a transport would. */
  reply(...lines) { this.emit('data', lines.join('\r\n') + '\r\n'); }
}

const connected = async () => {
  const transport = new FakeTransport();
  const lw3 = new LW3Protocol({ createTcp: () => transport });
  await lw3.connect('device.local');
  return { lw3, transport };
};

/** The 4-hex signature the protocol put on the Nth command it sent. */
const sigOf = (transport, n = 0) => transport.sent[n].match(/^([0-9A-F]{4})#/)[1];

test('commands are prefixed with a 4-hex-digit signature', async () => {
  const { lw3, transport } = await connected();
  lw3.sendCommand('GET /V1/X.Y').catch(() => {});
  assert.match(transport.sent[0], /^[0-9A-F]{4}#GET \/V1\/X\.Y\n$/);
});

test('each command gets a distinct signature', async () => {
  const { lw3, transport } = await connected();
  lw3.sendCommand('GET /V1/A.B').catch(() => {});
  lw3.sendCommand('GET /V1/C.D').catch(() => {});
  assert.notEqual(sigOf(transport, 0), sigOf(transport, 1));
});

test('resolves with the lines of its own block', async () => {
  const { lw3, transport } = await connected();
  const p = lw3.sendCommand('GET /V1/X.Y');
  const s = sigOf(transport);
  transport.reply(`{${s}`, 'pw /V1/X.Y=hello', '}');
  assert.deepEqual(await p, ['pw /V1/X.Y=hello']);
});

test('a multi-line block returns every line, not just the first', async () => {
  const { lw3, transport } = await connected();
  const p = lw3.sendCommand('GET /V1/MANAGEMENT/NETWORK.*');
  const s = sigOf(transport);
  transport.reply(`{${s}`,
    'pw /V1/MANAGEMENT/NETWORK.DhcpEnabled=true',
    'pr /V1/MANAGEMENT/NETWORK.IpAddress=192.168.2.104',
    'pw /V1/MANAGEMENT/NETWORK.HostName=jimmy-hc30',
    '}');
  assert.equal((await p).length, 3, 'GET nodepath.* used to return 1 of these');
});

test('replies arriving out of order each go to the right command', async () => {
  const { lw3, transport } = await connected();
  const first = lw3.sendCommand('GET /V1/FIRST.P');
  const second = lw3.sendCommand('GET /V1/SECOND.P');
  const s1 = sigOf(transport, 0), s2 = sigOf(transport, 1);

  // The device answers the second command first.
  transport.reply(`{${s2}`, 'pw /V1/SECOND.P=two', '}');
  transport.reply(`{${s1}`, 'pw /V1/FIRST.P=one', '}');

  assert.deepEqual(await first, ['pw /V1/FIRST.P=one'],
    'this is the bug: without signatures the first command took the second reply');
  assert.deepEqual(await second, ['pw /V1/SECOND.P=two']);
});

test('lines outside any block are unsolicited and touch no pending command', async () => {
  const { lw3, transport } = await connected();
  const unsolicited = [];
  lw3.on('unsolicited', (l) => unsolicited.push(l));

  const p = lw3.sendCommand('GET /V1/X.Y');
  const s = sigOf(transport);
  // A subscription update lands mid-flight — the exact traffic OPEN produced.
  transport.reply('CHG /V1/MANAGEMENT/DATETIME.CurrentTime=2026-08-28T18:54:05');
  transport.reply(`{${s}`, 'pw /V1/X.Y=hello', '}');

  assert.deepEqual(await p, ['pw /V1/X.Y=hello'], 'the CHG line must not pollute the reply');
  assert.deepEqual(unsolicited, ['CHG /V1/MANAGEMENT/DATETIME.CurrentTime=2026-08-28T18:54:05']);
});

test('a block for an unknown signature is discarded, not misapplied', async () => {
  const { lw3, transport } = await connected();
  const unsolicited = [];
  lw3.on('unsolicited', (l) => unsolicited.push(l));

  const p = lw3.sendCommand('GET /V1/X.Y');
  const s = sigOf(transport);
  transport.reply('{FFFF', 'pw /V1/STALE.P=old', '}');   // a timed-out command's late reply
  transport.reply(`{${s}`, 'pw /V1/X.Y=hello', '}');

  assert.deepEqual(await p, ['pw /V1/X.Y=hello']);
  assert.deepEqual(unsolicited, ['pw /V1/STALE.P=old']);
});

test('rejects on every device error shape, matched by pattern not prefix', async () => {
  for (const bad of [
    'pE /V1/MANAGEMENT/NETWORK.NoSuchProperty %E002: Not exists',
    '-E OPEN /V1/MANAGEMENT/DATETIME.CurrentTime %E001: Syntax error',
    'mE /V1/X:method %E004: Invalid',
  ]) {
    const { lw3, transport } = await connected();
    const p = lw3.sendCommand('GET /V1/X.Y');
    const s = sigOf(transport);
    transport.reply(`{${s}`, bad, '}');
    await assert.rejects(() => p, (err) => {
      assert.match(err.message, /%E\d+:/, `should have rejected on: ${bad}`);
      return true;
    });
  }
});

test('a value containing digits and a colon is not mistaken for an error', async () => {
  const { lw3, transport } = await connected();
  const p = lw3.sendCommand('GET /V1/MANAGEMENT/DATETIME.CurrentTime');
  const s = sigOf(transport);
  const line = 'pr /V1/MANAGEMENT/DATETIME.CurrentTime=2026-08-28T18:51:48';
  transport.reply(`{${s}`, line, '}');
  assert.deepEqual(await p, [line]);
});

test('rejects with a timeout if the block never closes', async () => {
  const { lw3, transport } = await connected();
  const p = lw3.sendCommand('GET /V1/X.Y');
  const s = sigOf(transport);
  transport.reply(`{${s}`, 'pw /V1/X.Y=hello');   // no closing brace
  await assert.rejects(() => p, (err) => {
    assert.match(err.message, /timeout/i);
    assert.match(err.message, /GET \/V1\/X\.Y/, 'the message should name the command that timed out');
    return true;
  });
});

test('the command timeout is 5 seconds', () => {
  assert.equal(COMMAND_TIMEOUT_MS, 5000);
});

test('getAll resolves as soon as the block closes, not after a fixed wait', async () => {
  const { lw3, transport } = await connected();
  const started = Date.now();
  const p = lw3.getAll('/V1/MANAGEMENT/DATETIME');
  const s = sigOf(transport);
  transport.reply(`{${s}`,
    'pr /V1/MANAGEMENT/DATETIME.UpTime=0 days 11:09:54',
    'pw /V1/MANAGEMENT/DATETIME.TimeZone=UTC',
    'm- /V1/MANAGEMENT/DATETIME:setTime',
    'n- /V1/MANAGEMENT/DATETIME/NTP',
    '}');
  const result = await p;
  assert.ok(Date.now() - started < 200, 'GETALL used to always wait a full second');
  assert.equal(result.properties.length, 2);
  assert.equal(result.methods.length, 1);
  assert.equal(result.nodes.length, 1);
});

test('the reported bug: two GETALLs on one node, neither empty nor doubled', async () => {
  const { lw3, transport } = await connected();
  const block = (s) => [`{${s}`,
    'pr /V1/MANAGEMENT/DATETIME.UpTime=0 days 11:09:54',
    'pr /V1/MANAGEMENT/DATETIME.CurrentTime=2026-08-28T18:51:48',
    'pr /V1/MANAGEMENT/DATETIME.UtcTime=2026-08-28T18:51:48Z',
    'pw /V1/MANAGEMENT/DATETIME.TimeZone=UTC',
    'm- /V1/MANAGEMENT/DATETIME:setTime',
    'n- /V1/MANAGEMENT/DATETIME/NTP',
    '}'];

  const p1 = lw3.getAll('/V1/MANAGEMENT/DATETIME');
  transport.reply(...block(sigOf(transport, 0)));
  const first = await p1;

  const p2 = lw3.getAll('/V1/MANAGEMENT/DATETIME');
  transport.reply(...block(sigOf(transport, 1)));
  const second = await p2;

  for (const [label, r] of [['first', first], ['second', second]]) {
    assert.equal(r.properties.length, 4, `${label} call: the node has 4 properties`);
    assert.equal(r.methods.length, 1, `${label} call: 1 method`);
    assert.equal(r.nodes.length, 1, `${label} call: 1 child node`);
  }
});

test('parseGetAll keeps the existing structure', () => {
  const r = parseGetAll([
    'pw /V1/MANAGEMENT/NETWORK.HostName=jimmy-hc30',
    'pr /V1/MANAGEMENT/NETWORK.IpAddress=192.168.2.104',
    'n- /V1/MANAGEMENT/NETWORK/AUTH',
    'm- /V1/MANAGEMENT/NETWORK:applySettings',
  ]);
  assert.deepEqual(r.properties[0],
    { nodepath: '/V1/MANAGEMENT/NETWORK', property: 'HostName', value: 'jimmy-hc30', writable: true });
  assert.equal(r.properties[1].writable, false);
  assert.deepEqual(r.nodes, ['/V1/MANAGEMENT/NETWORK/AUTH']);
  assert.deepEqual(r.methods, [{ nodepath: '/V1/MANAGEMENT/NETWORK', method: 'applySettings' }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL. `parseGetAll` and `COMMAND_TIMEOUT_MS` are not exported, so the file fails to load with `SyntaxError: … does not provide an export named 'parseGetAll'`. The existing 42 tests still pass.

- [ ] **Step 3: Lift the GETALL parser out and export the constant**

At the top of `src/lw3-protocol.js`, below the imports, add:

```js
/** How long to wait for a reply block to close before giving up. */
export const COMMAND_TIMEOUT_MS = 5000;

/** Any device error carries this marker, whatever its prefix: pE, mE, -E. */
const DEVICE_ERROR = /%E\d+:/;

/**
 * Turn the lines of a GETALL reply into structured form.
 * Lifted verbatim out of getAll's timer callback; the parsing itself is unchanged.
 */
export function parseGetAll(lines) {
  const result = { properties: [], nodes: [], methods: [] };

  lines.forEach((line) => {
    if (line.startsWith('pr ') || line.startsWith('pw ')) {
      const writable = line.startsWith('pw ');
      const match = line.match(/^p[rw] (.+?)\.([^=]+)=(.*)$/);
      if (match) {
        result.properties.push({
          nodepath: match[1],
          property: match[2],
          value: match[3],
          writable: writable,
        });
      }
    } else if (line.startsWith('n- ')) {
      result.nodes.push(line.substring(3));
    } else if (line.startsWith('m- ')) {
      const methodPath = line.substring(3);
      const colonIndex = methodPath.lastIndexOf(':');
      if (colonIndex !== -1) {
        result.methods.push({
          nodepath: methodPath.substring(0, colonIndex),
          method: methodPath.substring(colonIndex + 1),
        });
      } else {
        result.methods.push({ nodepath: methodPath, method: '' });
      }
    }
  });

  return result;
}
```

- [ ] **Step 4: Track the current block in the constructor**

In the constructor, replace the `pendingCommands` and `commandId` lines with:

```js
    // Keyed by signature. Each entry: { signature, resolve, reject, lines, timer }
    this.pendingCommands = new Map();
    this.commandId = 0;
    // Signature of the reply block currently being received, or null between blocks.
    this.currentBlock = null;
```

- [ ] **Step 5: Replace processResponse with the state machine**

Replace the whole `processResponse` method with:

```js
  /** Next 4-hex-digit command signature, wrapping at 0xFFFF. */
  nextSignature() {
    const signature = this.commandId.toString(16).padStart(4, '0').toUpperCase();
    this.commandId = (this.commandId + 1) & 0xffff;
    return signature;
  }

  /**
   * Route one line from the device.
   *
   * The device brackets each reply as `{XXXX` … `}`, where XXXX is the signature
   * of the command that caused it. A line outside any block is therefore not a
   * reply to anything — it is subscription traffic or a banner — and must never
   * be attributed to a pending command.
   */
  processResponse(line) {
    this.emit('response', line);

    if (/^\{[0-9A-Fa-f]{4}$/.test(line)) {
      this.currentBlock = line.slice(1).toUpperCase();
      const pending = this.pendingCommands.get(this.currentBlock);
      if (pending) pending.lines = [];
      return;
    }

    if (line === '}') {
      const signature = this.currentBlock;
      this.currentBlock = null;
      if (!signature) return;

      const pending = this.pendingCommands.get(signature);
      if (!pending) return; // already timed out; its lines were emitted as unsolicited

      this.pendingCommands.delete(signature);
      clearTimeout(pending.timer);

      const failure = pending.lines.find((l) => DEVICE_ERROR.test(l));
      if (failure) pending.reject(new Error(`Device error: ${failure}`));
      else pending.resolve(pending.lines);
      return;
    }

    if (this.currentBlock === null) {
      this.emit('unsolicited', line);
      return;
    }

    const pending = this.pendingCommands.get(this.currentBlock);
    if (pending) pending.lines.push(line);
    else this.emit('unsolicited', line);
  }
```

- [ ] **Step 6: Sign outgoing commands**

Replace the whole `sendCommand` method with:

```js
  /**
   * Send one command and resolve with the lines of its reply block.
   * @param {string} command
   * @returns {Promise<string[]>}
   */
  sendCommand(command) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.transport) {
        reject(new Error('Not connected to a device'));
        return;
      }

      const signature = this.nextSignature();

      const timer = setTimeout(() => {
        if (this.pendingCommands.has(signature)) {
          this.pendingCommands.delete(signature);
          reject(new Error(`Command timeout: ${command}`));
        }
      }, COMMAND_TIMEOUT_MS);

      this.pendingCommands.set(signature, { signature, resolve, reject, lines: [], timer });

      try {
        this.transport.send(`${signature}#${command}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pendingCommands.delete(signature);
        reject(error);
      }
    });
  }
```

- [ ] **Step 7: Collapse getAll onto sendCommand**

Replace the whole `getAll` method — its own guard, its own pending entry, its `setTimeout`, and the parsing inside it — with:

```js
  /**
   * GETALL - a node's children, its own properties, and its methods.
   * @param {string} [path]
   * @returns {Promise<{properties: Array, nodes: Array, methods: Array}>}
   */
  async getAll(path = '') {
    const command = path ? `GETALL ${path}` : 'GETALL';
    return parseGetAll(await this.sendCommand(command));
  }
```

- [ ] **Step 8: Join lines in the single-value helpers**

`sendCommand` now resolves with an array, so the four helpers that returned a string must join. Replace them with:

```js
  async get(property) {
    return (await this.sendCommand(`GET ${property}`)).join('\n');
  }

  async set(property, value) {
    return (await this.sendCommand(`SET ${property}=${value}`)).join('\n');
  }

  async call(method, params = []) {
    const paramsStr = params.length > 0 ? ` ${params.join(' ')}` : '';
    return (await this.sendCommand(`CALL ${method}${paramsStr}`)).join('\n');
  }

  async man(path) {
    return (await this.sendCommand(`MAN ${path}`)).join('\n');
  }
```

Leave `getRoot` alone — it calls `getAll('/V1/*')` and needs no change. Leave `open` alone; Task 2 removes it.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm test`

Expected: PASS, 56 tests (42 existing + 14 new), 0 failures, pristine output.

- [ ] **Step 10: Confirm nothing still uses the old collection mechanism**

Run: `grep -n "collectMultiple\|responses\.push\|startsWith('pE\|startsWith('mE" src/lw3-protocol.js`

Expected: no output. Any hit is dead code from the old design, or a prefix check the `%E` pattern replaced.

- [ ] **Step 11: Commit**

```bash
git add src/lw3-protocol.js tests/signatures.test.js
git commit -m "Correlate responses to commands with LW3 signatures"
```

---

### Task 2: Remove the OPEN tool

`OPEN` has never worked: `src/index.js` builds `nodepath.property`, the device wants a node path, and it answers `%E001: Syntax error` — which the old error detection reported as success. MCP has no channel for push updates, so the subscription it would create has no consumer.

**Files:**
- Modify: `src/index.js` (tool list entry, `switch` case, `handleOpen`)
- Modify: `manifest.json` (remove the `OPEN` entry from `tools`)
- Modify: `src/lw3-protocol.js` (remove `open()`)
- Modify: `tests/manifest.test.js:37` (expected tool count 11 → 10)

**Interfaces:**
- Consumes: nothing from Task 1 beyond the file being in its post-Task-1 state.
- Produces: a server exposing 10 tools. Task 3 documents that count.

- [ ] **Step 1: Update the expected tool count**

In `tests/manifest.test.js`, the line currently reading:

```js
  assert.equal(registered.length, 11, 'expected 11 registered tools');
```

becomes:

```js
  assert.equal(registered.length, 10, 'expected 10 registered tools');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL with `expected 10 registered tools` — `11 !== 10`. That failure is the point: the count cannot change silently.

- [ ] **Step 3: Remove the tool from the MCP server**

In `src/index.js`, delete three things:

1. The whole `OPEN` entry in the `ListToolsRequestSchema` tools array — the object beginning `name: 'OPEN',` including its `description` and `inputSchema`.
2. These two lines from the `switch`:

```js
          case 'OPEN':
            return await this.handleOpen(args);
```

3. The whole `handleOpen(args)` method.

- [ ] **Step 4: Remove it from the manifest**

In `manifest.json`, delete this entry from the `tools` array:

```json
    { "name": "OPEN", "description": "Open a subscription to a property on the connected Lightware device" },
```

Take the trailing comma with it if it was the last entry, so the JSON stays valid.

- [ ] **Step 5: Remove the protocol method**

In `src/lw3-protocol.js`, delete the whole `open(property)` method and its JSDoc block.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`

Expected: PASS, 56 tests, 0 failures. The manifest drift tests confirm `manifest.json` and `src/index.js` agree on all 10.

- [ ] **Step 7: Confirm OPEN is gone everywhere**

Run: `grep -rn "OPEN" src/ manifest.json tests/ --include=*.js --include=*.json`

Expected: no output. A hit in `src/` or `manifest.json` is a leftover; a hit in `tests/` means a test still references the removed tool.

- [ ] **Step 8: Check the server really lists 10**

Run:

```bash
node -e '
const {spawn}=require("child_process");
const c=spawn(process.execPath,["src/index.js"],{stdio:["pipe","pipe","pipe"]});
let b="";c.stdout.on("data",d=>{b+=d;let i;while((i=b.indexOf("\n"))!==-1){const l=b.slice(0,i);b=b.slice(i+1);
try{const m=JSON.parse(l);if(m.id===2){console.log(m.result.tools.length+" tools: "+m.result.tools.map(t=>t.name).join(", "));c.kill();process.exit(0);}}catch{}}});
const s=o=>c.stdin.write(JSON.stringify(o)+"\n");
s({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"v",version:"1"}}});
s({jsonrpc:"2.0",method:"notifications/initialized"});
s({jsonrpc:"2.0",id:2,method:"tools/list",params:{}});'
```

Expected: `10 tools: connect, disconnect, GET, SET, GETALL, GETROOT, CALL, MAN, status, discover`

- [ ] **Step 9: Commit**

```bash
git add src/index.js src/lw3-protocol.js manifest.json tests/manifest.test.js
git commit -m "Remove the OPEN tool, which never worked"
```

---

### Task 3: Bring the documentation in line

Three documents describe protocol behaviour this change replaces. `CLAUDE.md` in particular is injected into AI coding agents as authoritative project instructions, so a stale claim there actively misleads.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the behaviour built in Tasks 1 and 2.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Find every stale claim**

Run: `grep -n "one at a time\|head of its queue\|time-boxed\|one second\|1 second\|OPEN\|11 tools\|Eleven tools" CLAUDE.md README.md`

Read each hit before editing. The claims that are now false:

- **`CLAUDE.md`** — "Commands are strictly one at a time … resolves whichever command is at the head of its queue rather than correlating responses to requests". Correlation now exists. Also its `OPEN` row in the tools table, and the `GETALL` timing note.
- **`README.md`** — "**Commands are strictly one at a time.**" and "**`GETALL` is time-boxed, not terminated.** No end-of-response marker is recognised; it collects lines for one second". Both describe the old design. Also "Eleven tools", the `OPEN` bullet in the tool list, and the `LW3 protocol notes` response-prefix table, which should gain the block markers.

- [ ] **Step 2: Rewrite the protocol notes in both files**

The behaviour to describe, in each document's existing voice:

- Every command carries a 4-hex-digit signature; the device brackets the reply as `{XXXX` … `}`.
- Responses are correlated by that signature, so a late reply can no longer land on the next command.
- `GETALL` resolves when the block closes — about 30 ms against the fixed 1 second it used to spend. An empty result now genuinely means an empty node.
- A line arriving outside any block is unsolicited (subscription `CHG` updates, banners); it is emitted as an `unsolicited` event and never treated as a reply.
- Device errors are detected by the `%E<digits>:` marker rather than a list of prefixes, which covers `pE`, `mE`, and `-E` alike.
- Commands are still issued serially, but that is now a choice rather than a constraint.
- The tool count is 10, and `OPEN` is gone.

Keep `CLAUDE.md` concise — it is an orientation document, not a duplicate of the README.

- [ ] **Step 3: Verify no stale claim survives**

Run: `grep -n "one at a time\|head of its queue\|time-boxed\|Eleven tools\|11 tools" CLAUDE.md README.md`

Expected: no output, other than any sentence you deliberately rewrote to say commands are issued serially by choice.

Run: `grep -c "OPEN" CLAUDE.md README.md`

Expected: `0` for both.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "Document signature-based correlation and the removal of OPEN"
```

---

## Manual verification against real hardware

Automated tests use a fake transport, so this is the only proof the signatures work against a device. Claude Desktop's own `lw3-mcp` extension holds the device's single LW3 TCP session, so force the WSS path with a dead TCP port and the admin password.

- [ ] Two `getAll('/V1/MANAGEMENT/DATETIME')` calls in a row: the first returns 4 properties, 1 method, 1 child node; the second returns the same. Neither is empty, neither is doubled. This is the reported bug.
- [ ] `getAll` returns in well under a second, not the old fixed 1000 ms.
- [ ] `get('/V1/MANAGEMENT/NETWORK.*')` returns all nine lines rather than one.
- [ ] `get('/V1/MANAGEMENT/NETWORK.NoSuchProperty')` rejects with the `%E002: Not exists` line.

## Done when

- `npm test` passes with 56 tests.
- The MCP server lists 10 tools.
- A device answers two consecutive GETALLs on the same node correctly.
- `npm run bundle` exits 0 — the bundle's own verifier asserts the packed server's tool count matches its manifest, so it will catch it if 11 and 10 disagree anywhere.
