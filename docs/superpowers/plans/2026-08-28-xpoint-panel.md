# Crosspoint Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A clickable video routing grid rendered in the chat, where clicking a cell switches that source to that destination.

**Architecture:** All parsing and cell logic lives in a pure module that turns `GETALL` output into a grid model and answers "what is this cell's state" — that is where the tests are. A new `xpoint` tool renders that model as text always, and references a `ui://` HTML resource for hosts that support MCP Apps. The view reads and writes through the existing `GETALL` and `SET` tools, so no new device-facing surface is added.

**Tech Stack:** Node 22, ES modules, `node:test`, MCP Apps extension (`io.modelcontextprotocol/ui`).

**Spec:** [2026-08-28-xpoint-panel-design.md](../specs/2026-08-28-xpoint-panel-design.md)

## Global Constraints

- **No new dependencies.** `dependencies` stays exactly `@modelcontextprotocol/sdk`, `multicast-dns`, `ws`.
- **Do not modify `src/lw3-protocol.js`, `src/transports/`, or `src/lightware-discovery.js`.** This feature sits above them.
- **The panel writes nothing but `ConnectedSource`.** `Mute` and `Lock` are read and displayed, never set.
- **ES modules.** `.js` extensions on relative imports.
- **The HTML must be entirely self-contained** — inline CSS and JS, no fonts, images, or CDN references. The host enforces a restrictive CSP.
- **`xpoint` must return usable text even with no UI support.** It is never allowed to be useless.
- **Video crosspoint only**, at `/V1/MEDIA/VIDEO/XP`. A device without that node gets a clear error naming it.
- Test script stays `"test": "node --test tests/*.js"`.

## Verified Facts

Measured against a UCX-4x2-HC30 (`jimmy-hc30`, 192.168.2.104) on 2026-08-28. These are the real fixtures; use them in tests rather than inventing data.

`GETALL /V1/MEDIA/VIDEO/XP/*` (relevant lines):

```
pw /V1/MEDIA/VIDEO/XP/I3.Lock=false
pr /V1/MEDIA/VIDEO/XP/I3.SignalPresent=false
pw /V1/MEDIA/VIDEO/XP/O1.Lock=false
pw /V1/MEDIA/VIDEO/XP/O1.ConnectedSource=I5
pr /V1/MEDIA/VIDEO/XP/O1.SignalPresent=true
pw /V1/MEDIA/VIDEO/XP/O2.Lock=false
pw /V1/MEDIA/VIDEO/XP/O2.ConnectedSource=I5
pr /V1/MEDIA/VIDEO/XP/O2.SignalPresent=true
n- /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE
n- /V1/MEDIA/VIDEO/XP/O2/SWITCHABLE
```

`GETALL /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE` and the same for `O2`:

```
pr /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE.0=OK
pr /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE.I1=Busy
pr /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE.I2=OK
pr /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE.I3=OK
pr /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE.I4=OK
pr /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE.I5=OK
```

`GETALL /V1/MEDIA/VIDEO/*` (relevant lines):

```
pw /V1/MEDIA/VIDEO/I1.Name=USB-C in 1
pr /V1/MEDIA/VIDEO/I1.SignalPresent=false
pw /V1/MEDIA/VIDEO/I2.Name=USB-C in 2
pw /V1/MEDIA/VIDEO/I3.Name=HDMI in 3
pw /V1/MEDIA/VIDEO/I4.Name=HDMI in 4
pw /V1/MEDIA/VIDEO/I5.Name=Welcome Screen
pr /V1/MEDIA/VIDEO/I5.SignalPresent=true
pw /V1/MEDIA/VIDEO/O1.Name=HDMI out 1
pr /V1/MEDIA/VIDEO/O1.SignalPresent=false
pw /V1/MEDIA/VIDEO/O2.Name=HDMI out 2
```

Other measured facts:

- `ConnectedSource` is writable, so routing is a `SET`, not a method call.
- `0` means disconnect. `MAN …:switch` — *"Use `0` character as `<in>` to disconnect destination."*
- `Busy` is **shared-chip-input contention**: `I1` and the Welcome Screen (`I5`) sit on the same internal crosspoint chip input, so while `I5` is routed anywhere, `I1` is `Busy` on **every** destination. Availability therefore changes as a result of the user's own clicks.
- `SWITCHABLE` is a child node per destination, so a full read is 2 + N calls (four on this model, roughly one second) — not the two calls the routing-and-names sweep alone takes.
- Whether Claude Desktop negotiates `io.modelcontextprotocol/ui` is **unknown**. Task 1 settles it.

---

### Task 1: Find out whether the host supports MCP Apps

A spike. Its deliverable is a fact, not code — and that fact decides whether Task 4 happens at all. Do it first so nobody writes a panel for a host that will not render it.

**Files:**
- Modify: `src/index.js` (temporary logging, reverted in Step 5)

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded answer to "does this client advertise `io.modelcontextprotocol/ui`?" Task 4 is conditional on it.

- [ ] **Step 1: Log what the client advertises**

In `src/index.js`, in `run()`, immediately after `await this.server.connect(transport)`, add:

```js
    // TEMPORARY probe — removed in step 5. Logs the raw initialize params to
    // establish whether this host advertises the MCP Apps UI extension.
    //
    // The raw message is captured rather than server.getClientCapabilities(),
    // which returns only params.capabilities: the extension is advertised "in
    // the initialize request", and if it sits outside that field a capabilities
    // -only probe would report a false negative.
    const inner = transport.onmessage;
    transport.onmessage = (message) => {
      if (message?.method === 'initialize') {
        console.error('[PROBE] initialize params:', JSON.stringify(message.params));
      }
      inner?.(message);
    };
```

`console.error` is correct here: stdout carries the MCP protocol, and Claude Desktop captures stderr into its per-server log — confirmed by this project's own "MCP LW3 Gateway server running on stdio" line appearing there.

Wrapping after `connect()` matters: `connect()` installs its own `onmessage`, so wrapping before it would be overwritten.

- [ ] **Step 2: Restart Claude Desktop and exercise the server**

Quit Claude Desktop completely and reopen it. Claude Desktop is configured to run this server from source at `c:\Taurus\lw3-mcp\src\index.js`, so it will connect on launch. Ask it to run any lw3 tool — `status` is enough — to be certain the server started.

- [ ] **Step 3: Read the answer**

Run: `Get-Content "$env:APPDATA\Claude\logs\mcp-server-lw3-mcp.log" -Tail 40 | Select-String "PROBE"`

Expected: two `[PROBE]` lines. Record them verbatim in the report.

Then decide, and state the decision explicitly:

- If the capabilities or the client's declared extensions mention `io.modelcontextprotocol/ui` — **Task 4 proceeds.**
- If they do not — **Task 4 is not implemented.** Tasks 2 and 3 still ship: the `xpoint` tool and its text rendering are useful on their own, and the HTML can be added later when host support arrives.

If the log file does not exist, list `%APPDATA%\Claude\logs` and report what is there. Do not guess the answer.

- [ ] **Step 4: Confirm the suite is untouched**

Run: `npm test`
Expected: PASS, 89 tests, 0 failures.

- [ ] **Step 5: Revert the probe**

Remove the `this.server.oninitialized = ...` block added in Step 1. `src/index.js` returns to exactly its previous content.

Run: `git diff --stat src/index.js`
Expected: no output. The file is unchanged from HEAD.

- [ ] **Step 6: Record the finding**

No commit — nothing changed. Write the two `[PROBE]` lines and the resulting decision into the task report, because Task 4 depends on it.

---

### Task 2: The grid model

All the parsing and all the cell logic, as pure functions. This is where the feature's correctness lives and where every test goes; the HTML that follows is deliberately thin.

**Files:**
- Create: `src/xpoint.js`
- Create: `tests/xpoint.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces, exported from `src/xpoint.js`:
  - `XP_NODE = '/V1/MEDIA/VIDEO/XP'` and `VIDEO_NODE = '/V1/MEDIA/VIDEO'`
  - `buildGrid({ xpLines, videoLines, switchableLines }): Grid`
  - `cellState(grid, destPort, srcPort): { selected: boolean, enabled: boolean, reason: string | null }`
  - `renderGridText(grid): string`

  where `Grid` is:

  ```js
  {
    sources:      [{ port: '0',  name: 'Disconnect',  signalPresent: null  },
                   { port: 'I1', name: 'USB-C in 1',  signalPresent: false }, ...],
    destinations: [{ port: 'O1', name: 'HDMI out 1', signalPresent: false,
                     connectedSource: 'I5', locked: false }, ...],
    switchable:   { O1: { '0': 'OK', I1: 'Busy', ... }, ... },
  }
  ```

  Task 3 calls `buildGrid` and `renderGridText`. Task 4's HTML calls `cellState`.

- [ ] **Step 1: Write the failing tests**

Create `tests/xpoint.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, cellState, renderGridText, XP_NODE, VIDEO_NODE } from '../src/xpoint.js';

// Captured verbatim from a UCX-4x2-HC30 on 2026-08-28.
const xpLines = [
  'pw /V1/MEDIA/VIDEO/XP/I3.Lock=false',
  'pr /V1/MEDIA/VIDEO/XP/I3.SignalPresent=false',
  'pw /V1/MEDIA/VIDEO/XP/O1.Lock=false',
  'pw /V1/MEDIA/VIDEO/XP/O1.ConnectedSource=I5',
  'pr /V1/MEDIA/VIDEO/XP/O1.SignalPresent=true',
  'pw /V1/MEDIA/VIDEO/XP/O2.Lock=false',
  'pw /V1/MEDIA/VIDEO/XP/O2.ConnectedSource=I5',
  'pr /V1/MEDIA/VIDEO/XP/O2.SignalPresent=true',
  'n- /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE',
  'n- /V1/MEDIA/VIDEO/XP/O2/SWITCHABLE',
];

const videoLines = [
  'pw /V1/MEDIA/VIDEO/I1.Name=USB-C in 1',
  'pr /V1/MEDIA/VIDEO/I1.SignalPresent=false',
  'pw /V1/MEDIA/VIDEO/I2.Name=USB-C in 2',
  'pw /V1/MEDIA/VIDEO/I3.Name=HDMI in 3',
  'pw /V1/MEDIA/VIDEO/I4.Name=HDMI in 4',
  'pw /V1/MEDIA/VIDEO/I5.Name=Welcome Screen',
  'pr /V1/MEDIA/VIDEO/I5.SignalPresent=true',
  'pw /V1/MEDIA/VIDEO/O1.Name=HDMI out 1',
  'pr /V1/MEDIA/VIDEO/O1.SignalPresent=false',
  'pw /V1/MEDIA/VIDEO/O2.Name=HDMI out 2',
];

const switchableLines = ['O1', 'O2'].flatMap((o) =>
  ['0=OK', 'I1=Busy', 'I2=OK', 'I3=OK', 'I4=OK', 'I5=OK'].map(
    (kv) => `pr /V1/MEDIA/VIDEO/XP/${o}/SWITCHABLE.${kv}`
  )
);

const grid = () => buildGrid({ xpLines, videoLines, switchableLines });

test('the node paths are the video crosspoint', () => {
  assert.equal(XP_NODE, '/V1/MEDIA/VIDEO/XP');
  assert.equal(VIDEO_NODE, '/V1/MEDIA/VIDEO');
});

test('sources lead with Disconnect, then inputs in numeric order', () => {
  assert.deepEqual(grid().sources.map((s) => s.port), ['0', 'I1', 'I2', 'I3', 'I4', 'I5']);
  assert.equal(grid().sources[0].name, 'Disconnect');
});

test('inputs beyond nine sort numerically, not as text', () => {
  const many = ['I2', 'I10', 'I1'].map((p) => `pw /V1/MEDIA/VIDEO/${p}.Name=in ${p}`);
  const g = buildGrid({ xpLines: [], videoLines: many, switchableLines: [] });
  assert.deepEqual(g.sources.map((s) => s.port), ['0', 'I1', 'I2', 'I10'],
    'string ordering would put I10 before I2');
});

test('ports carry their human names on both axes', () => {
  const g = grid();
  assert.equal(g.sources.find((s) => s.port === 'I5').name, 'Welcome Screen');
  assert.equal(g.destinations.find((d) => d.port === 'O1').name, 'HDMI out 1');
});

test('a port with no Name falls back to its port id', () => {
  const g = buildGrid({ xpLines: [], videoLines: ['pr /V1/MEDIA/VIDEO/I7.SignalPresent=true'], switchableLines: [] });
  assert.equal(g.sources.find((s) => s.port === 'I7').name, 'I7');
});

test('destinations carry routing, lock and signal', () => {
  const o1 = grid().destinations.find((d) => d.port === 'O1');
  assert.equal(o1.connectedSource, 'I5');
  assert.equal(o1.locked, false);
  assert.equal(o1.signalPresent, false, 'signal comes from /VIDEO/O1, not /VIDEO/XP/O1');
});

test('signal presence is a boolean, not the string "false"', () => {
  const i5 = grid().sources.find((s) => s.port === 'I5');
  assert.equal(i5.signalPresent, true);
  assert.equal(grid().sources.find((s) => s.port === 'I1').signalPresent, false);
});

test('switchability is read per destination', () => {
  const g = grid();
  assert.equal(g.switchable.O1.I1, 'Busy');
  assert.equal(g.switchable.O1.I2, 'OK');
  assert.equal(g.switchable.O2.I1, 'Busy');
});

test('the currently routed cell is selected', () => {
  assert.equal(cellState(grid(), 'O1', 'I5').selected, true);
  assert.equal(cellState(grid(), 'O1', 'I2').selected, false);
});

test('a cell the device will not accept is disabled, carrying the device word', () => {
  const c = cellState(grid(), 'O1', 'I1');
  assert.equal(c.enabled, false);
  assert.equal(c.reason, 'Busy', 'the device word is shown, not an invented explanation');
});

test('an OK cell is enabled with no reason', () => {
  assert.deepEqual(cellState(grid(), 'O1', 'I2'), { selected: false, enabled: true, reason: null });
});

test('every cell of a locked destination is disabled', () => {
  const locked = xpLines.map((l) => l.replace('O2.Lock=false', 'O2.Lock=true'));
  const g = buildGrid({ xpLines: locked, videoLines, switchableLines });
  assert.equal(cellState(g, 'O2', 'I2').enabled, false);
  assert.equal(cellState(g, 'O2', 'I2').reason, 'Locked');
  assert.equal(cellState(g, 'O1', 'I2').enabled, true, 'the other destination is unaffected');
});

test('Disconnect is offered when the device says so', () => {
  assert.equal(cellState(grid(), 'O1', '0').enabled, true);
});

test('an unknown cell is disabled rather than assumed switchable', () => {
  const c = cellState(grid(), 'O9', 'I1');
  assert.equal(c.enabled, false, 'absence of information must not read as permission');
});

test('the text rendering names every destination and its current source', () => {
  const text = renderGridText(grid());
  assert.match(text, /HDMI out 1/);
  assert.match(text, /HDMI out 2/);
  assert.match(text, /Welcome Screen/, 'the current source is named, not just its port id');
  assert.match(text, /Busy/, 'unavailable sources are visible in text too');
});

test('an empty device yields an empty grid, not a crash', () => {
  const g = buildGrid({ xpLines: [], videoLines: [], switchableLines: [] });
  assert.deepEqual(g.destinations, []);
  assert.deepEqual(g.sources, [{ port: '0', name: 'Disconnect', signalPresent: null }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL with `Cannot find module '../src/xpoint.js'`. The existing 89 tests still pass.

- [ ] **Step 3: Write the module**

Create `src/xpoint.js`:

```js
/**
 * Turns LW3 GETALL output into a video crosspoint grid, and answers what state
 * each cell is in. Pure — no protocol, no sockets, no rendering beyond text.
 */

export const XP_NODE = '/V1/MEDIA/VIDEO/XP';
export const VIDEO_NODE = '/V1/MEDIA/VIDEO';

/** The device reports booleans as the strings "true" and "false". */
const asBool = (value) => value === 'true';

/** `pw /path.Prop=value` -> { path, prop, value }; anything else -> null. */
function parseProperty(line) {
  const match = line.match(/^p[rw] (.+?)\.([^=]+)=(.*)$/);
  return match ? { path: match[1], prop: match[2], value: match[3] } : null;
}

/** Inputs and outputs sort by their number, so I10 follows I2 rather than I1. */
function byPortNumber(a, b) {
  return Number(a.slice(1)) - Number(b.slice(1));
}

export function buildGrid({ xpLines = [], videoLines = [], switchableLines = [] }) {
  const ports = new Map(); // port -> { name, signalPresent }
  const dest = new Map(); // port -> { connectedSource, locked }
  const switchable = {};

  // /V1/MEDIA/VIDEO/<port>.Name and .SignalPresent
  for (const line of videoLines) {
    const p = parseProperty(line);
    if (!p) continue;
    const port = p.path.startsWith(`${VIDEO_NODE}/`) ? p.path.slice(VIDEO_NODE.length + 1) : null;
    if (!port || !/^[IO]\d+$/.test(port)) continue;
    const entry = ports.get(port) || { name: null, signalPresent: null };
    if (p.prop === 'Name') entry.name = p.value;
    if (p.prop === 'SignalPresent') entry.signalPresent = asBool(p.value);
    ports.set(port, entry);
  }

  // /V1/MEDIA/VIDEO/XP/<out>.ConnectedSource and .Lock
  for (const line of xpLines) {
    const p = parseProperty(line);
    if (!p) continue;
    const port = p.path.startsWith(`${XP_NODE}/`) ? p.path.slice(XP_NODE.length + 1) : null;
    if (!port || !/^O\d+$/.test(port)) continue;
    const entry = dest.get(port) || { connectedSource: null, locked: false };
    if (p.prop === 'ConnectedSource') entry.connectedSource = p.value;
    if (p.prop === 'Lock') entry.locked = asBool(p.value);
    dest.set(port, entry);
  }

  // /V1/MEDIA/VIDEO/XP/<out>/SWITCHABLE.<src>=OK|Busy|...
  for (const line of switchableLines) {
    const p = parseProperty(line);
    if (!p) continue;
    const match = p.path.match(/\/XP\/(O\d+)\/SWITCHABLE$/);
    if (!match) continue;
    switchable[match[1]] = switchable[match[1]] || {};
    switchable[match[1]][p.prop] = p.value;
  }

  const named = (port) => ({
    port,
    name: ports.get(port)?.name || port,
    signalPresent: ports.get(port)?.signalPresent ?? null,
  });

  const inputs = [...ports.keys()].filter((p) => p.startsWith('I')).sort(byPortNumber);
  // Every destination the device mentioned, whether via VIDEO or XP.
  const outputs = [...new Set([...[...ports.keys()].filter((p) => p.startsWith('O')), ...dest.keys()])]
    .sort(byPortNumber);

  return {
    // '0' is the device's own token for "disconnect this destination".
    sources: [{ port: '0', name: 'Disconnect', signalPresent: null }, ...inputs.map(named)],
    destinations: outputs.map((port) => ({
      ...named(port),
      connectedSource: dest.get(port)?.connectedSource ?? null,
      locked: dest.get(port)?.locked ?? false,
    })),
    switchable,
  };
}

/**
 * What the view should draw for one cell.
 *
 * A cell is disabled when the destination is locked, or when the device does not
 * report the source as OK for it. Absence of information counts as disabled:
 * offering a click the device will refuse is worse than withholding one.
 */
export function cellState(grid, destPort, srcPort) {
  const destination = grid.destinations.find((d) => d.port === destPort);
  const selected = destination?.connectedSource === srcPort;

  if (!destination) return { selected: false, enabled: false, reason: 'Unknown destination' };
  if (destination.locked) return { selected, enabled: false, reason: 'Locked' };

  const status = grid.switchable[destPort]?.[srcPort];
  if (status === undefined) return { selected, enabled: false, reason: 'Unavailable' };
  if (status !== 'OK') return { selected, enabled: false, reason: status };

  return { selected, enabled: true, reason: null };
}

/** The same grid as text, for hosts that cannot render the panel. */
export function renderGridText(grid) {
  if (grid.destinations.length === 0) return 'No video crosspoint destinations were reported.';

  const lines = grid.destinations.map((d) => {
    const source = grid.sources.find((s) => s.port === d.connectedSource);
    const from = d.connectedSource ? `${source?.name || d.connectedSource}` : 'nothing';
    const flags = [d.locked ? 'locked' : null, d.signalPresent ? 'signal' : 'no signal']
      .filter(Boolean)
      .join(', ');
    return `  ${d.name} <- ${from}  (${flags})`;
  });

  const blocked = grid.destinations.flatMap((d) =>
    grid.sources
      .filter((s) => {
        const c = cellState(grid, d.port, s.port);
        return !c.enabled && !c.selected;
      })
      .map((s) => `  ${s.name} -> ${d.name}: ${cellState(grid, d.port, s.port).reason}`)
  );

  return [
    'Current routing:',
    ...lines,
    ...(blocked.length ? ['', 'Not currently switchable:', ...blocked] : []),
  ].join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`

Expected: PASS, 105 tests (89 existing + 16 new), 0 failures, pristine output.

- [ ] **Step 5: Commit**

```bash
git add src/xpoint.js tests/xpoint.test.js
git commit -m "Add the crosspoint grid model"
```

---

### Task 3: The `xpoint` tool

Makes the grid reachable. Deliberately independent of MCP Apps: this task ships whatever Task 1 concluded, and is what makes the feature useful in MCP Inspector or any host without UI support.

**Files:**
- Modify: `src/index.js` (tool registration, `switch` case, `handleXpoint`)
- Modify: `manifest.json` (add the tool)
- Modify: `tests/manifest.test.js` (expected tool count 10 → 11)

**Interfaces:**
- Consumes: `buildGrid`, `renderGridText`, `XP_NODE`, `VIDEO_NODE` from `src/xpoint.js`.
- Produces: an `xpoint` MCP tool taking no arguments. Task 4 attaches the UI resource to it.

- [ ] **Step 1: Update the expected tool count**

In `tests/manifest.test.js`, change:

```js
  assert.equal(registered.length, 10, 'expected 10 registered tools');
```

to:

```js
  assert.equal(registered.length, 11, 'expected 11 registered tools');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL with `expected 11 registered tools` — `10 !== 11`. The count cannot change silently.

- [ ] **Step 3: Register the tool**

In `src/index.js`, add to the `ListToolsRequestSchema` tools array, after the `discover` entry:

```js
        {
          name: 'xpoint',
          description:
            'Show the video crosspoint: which source is routed to each destination, and which sources each destination can switch to.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
```

Add to the `switch`:

```js
          case 'xpoint':
            return await this.handleXpoint();
```

Add the import at the top of the file:

```js
import { buildGrid, renderGridText, XP_NODE, VIDEO_NODE } from './xpoint.js';
```

- [ ] **Step 4: Implement the handler**

Add this method to `LW3MCPServer`, beside the other handlers:

```js
  async handleXpoint() {
    this.ensureConnected();

    let xpLines;
    try {
      xpLines = await this.lw3.sendCommand(`GETALL ${XP_NODE}/*`);
    } catch (error) {
      throw new Error(
        `Could not read the video crosspoint at ${XP_NODE} — ${error.message}. ` +
          'This device may not have a video crosspoint, or may use a different node layout.'
      );
    }

    const videoLines = await this.lw3.sendCommand(`GETALL ${VIDEO_NODE}/*`);

    // SWITCHABLE is a child node per destination, so it needs one call each.
    const destinations = [...new Set(
      xpLines.map((l) => l.match(/\/XP\/(O\d+)[./]/)?.[1]).filter(Boolean)
    )];
    const switchableLines = [];
    for (const port of destinations) {
      switchableLines.push(...(await this.lw3.sendCommand(`GETALL ${XP_NODE}/${port}/SWITCHABLE`)));
    }

    const grid = buildGrid({ xpLines, videoLines, switchableLines });

    return {
      content: [{ type: 'text', text: renderGridText(grid) }],
    };
  }
```

- [ ] **Step 5: Add the tool to the manifest**

In `manifest.json`, add to the `tools` array:

```json
    { "name": "xpoint", "description": "Show the video crosspoint: which source is routed to each destination, and which sources each destination can switch to." }
```

Mind the commas so the JSON stays valid.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`

Expected: PASS, 105 tests, 0 failures. The manifest drift tests confirm `manifest.json` and `src/index.js` agree on all 11.

- [ ] **Step 7: Check it against the real device**

Run:

```bash
node -e '
import("./src/lw3-protocol.js").then(async ({LW3Protocol})=>{
  const {buildGrid, renderGridText, XP_NODE, VIDEO_NODE} = await import("./src/xpoint.js");
  const lw3 = new LW3Protocol();
  await lw3.connect("192.168.2.104");
  const xp = await lw3.sendCommand(`GETALL ${XP_NODE}/*`);
  const vid = await lw3.sendCommand(`GETALL ${VIDEO_NODE}/*`);
  const outs = [...new Set(xp.map(l=>l.match(/\/XP\/(O\d+)[./]/)?.[1]).filter(Boolean))];
  const sw = [];
  for (const o of outs) sw.push(...await lw3.sendCommand(`GETALL ${XP_NODE}/${o}/SWITCHABLE`));
  console.log(renderGridText(buildGrid({xpLines:xp, videoLines:vid, switchableLines:sw})));
  await lw3.disconnect();
});'
```

Expected: both destinations named with their current source — at time of writing both on "Welcome Screen" — and `I1` listed as `Busy`. If the device is on a different route by then, the output should still match what the device actually reports; check it against `GETALL /V1/MEDIA/VIDEO/XP/*` rather than against this expectation.

If port 6107 is refused because Claude Desktop holds the device's single LW3 session, connect via the WSS fallback instead: `lw3.connect("192.168.2.104", 6108, { password: "<admin password>" })`.

- [ ] **Step 8: Commit**

```bash
git add src/index.js manifest.json tests/manifest.test.js
git commit -m "Add the xpoint tool with a text crosspoint rendering"
```

---

### Task 4: The panel

**Skipped, not merely undone.** Task 1's probe never fired — Claude Desktop was running the
installed `.mcpb` extension rather than this source tree — so host support for
`io.modelcontextprotocol/ui` is still unconfirmed. See the outcome note at the top of the spec.
Tasks 2 and 3 shipped regardless, since the tool and its text rendering do not depend on the
answer. This task stays unticked deliberately until host support is confirmed from a build
actually running inside Claude Desktop.

**Only if Task 1 concluded that the host advertises `io.modelcontextprotocol/ui`.** If it did not, stop here and report that Task 4 was skipped and why.

**Files:**
- Create: `ui/xpoint.html`
- Modify: `src/index.js` (declare the `resources` capability, serve the resource, attach `_meta.ui` to the tool)
- Modify: `scripts/verify-bundle.js` (`REQUIRED_ENTRIES` gains the HTML)

**Interfaces:**
- Consumes: `cellState`, `buildGrid`, `XP_NODE`, `VIDEO_NODE` from `src/xpoint.js`; the `xpoint` tool from Task 3.
- Produces: the resource `ui://lw3-mcp/xpoint`.

- [ ] **Step 1: Declare the resources capability and serve the resource**

In `src/index.js`, change the `Server` construction's capabilities from:

```js
        capabilities: {
          tools: {},
        },
```

to:

```js
        capabilities: {
          tools: {},
          resources: {},
        },
```

Add these imports at the top:

```js
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
```

Add to `setupHandlers()`:

```js
    const uiPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'xpoint.html');
    const XPOINT_UI = 'ui://lw3-mcp/xpoint';

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: XPOINT_UI,
          name: 'Crosspoint panel',
          mimeType: 'text/html;profile=mcp-app',
        },
      ],
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (request.params.uri !== XPOINT_UI) {
        throw new Error(`Unknown resource: ${request.params.uri}`);
      }
      return {
        contents: [
          {
            uri: XPOINT_UI,
            mimeType: 'text/html;profile=mcp-app',
            text: readFileSync(uiPath, 'utf8'),
          },
        ],
      };
    });
```

- [ ] **Step 2: Point the tool at the resource**

In the `xpoint` tool's registration object, add alongside `inputSchema`:

```js
          _meta: { ui: { resourceUri: 'ui://lw3-mcp/xpoint' } },
```

And in `handleXpoint`'s return, add the same `_meta` so the host knows which view renders this result:

```js
    return {
      content: [{ type: 'text', text: renderGridText(grid) }],
      _meta: { ui: { resourceUri: 'ui://lw3-mcp/xpoint' } },
    };
```

The text content stays. A host without UI support shows it; a host with UI support renders the panel.

- [ ] **Step 3: Write the panel**

Create `ui/xpoint.html`. It is self-contained — inline CSS and JS only, no external requests of any kind, because the host enforces a restrictive CSP.

The script must:

1. Connect to the host over `postMessage` as an MCP client, per the MCP Apps transport.
2. Read the grid by calling the `GETALL` tool three or more times: `${XP_NODE}/*`, `${VIDEO_NODE}/*`, and `${XP_NODE}/<out>/SWITCHABLE` for each destination found.
3. Build the model with the same logic as `src/xpoint.js`. Inline a copy of `buildGrid` and `cellState` into the HTML — the iframe cannot import from the server's filesystem. Keep it a verbatim copy so the tested logic and the rendered logic cannot diverge silently, and add a comment saying so.
4. Render destinations as rows and sources as columns, `Disconnect` first. Mark the selected cell. Disable cells where `cellState().enabled` is false and show `reason` as the cell's title attribute and a short label.
5. On click of an enabled, unselected cell, call the `SET` tool with `nodepath: "${XP_NODE}/<dest>"`, `property: "ConnectedSource"`, `value: "<src>"`, then re-read **everything including SWITCHABLE** — a switch changes which sources are `Busy` elsewhere.
6. Poll every 3000 ms, skipping the poll when `document.hidden`. Show a last-updated time.
7. On any error, keep the last grid visible, mark it stale, and show the error text.

Use the repository's existing voice in comments: explain why, not what.

**The transport, taken from the extension specification** (`ext-apps`, `2026-01-26`). All messages
go through `window.parent.postMessage(msg, '*')` and arrive on `window.addEventListener('message', …)`,
carrying JSON-RPC 2.0.

Handshake, in order:

1. The view sends an `ui/initialize` **request**:
   ```json
   { "jsonrpc": "2.0", "id": 1, "method": "ui/initialize",
     "params": { "capabilities": {}, "clientInfo": { "name": "lw3-xpoint", "version": "1.0.0" },
                 "protocolVersion": "2026-01-26" } }
   ```
2. The host replies with `result` carrying `protocolVersion`, `hostCapabilities`, `hostInfo`, `hostContext`.
3. The view sends `{"jsonrpc":"2.0","method":"ui/notifications/initialized","params":{}}`.
4. The host may send `ui/notifications/tool-input` with the arguments the tool was called with. The
   spec says a view must receive this **after its initialize completes** before calling tools.

Calling a tool from the view is an ordinary MCP request over the same channel:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "GETALL", "arguments": { "path": "/V1/MEDIA/VIDEO/XP/*" } } }
```

and the host answers with `result.content[0].text`.

Note this project's `GETALL` tool returns **JSON** (`{properties, nodes, methods}`), not raw lines,
while `buildGrid` takes raw lines. Reconcile that inside the view: either reconstruct the lines from
the parsed JSON, or call the tool and map its structured output onto the same shape. Whichever you
choose, keep `buildGrid` and `cellState` byte-identical to `src/xpoint.js` so the tested logic and
the rendered logic cannot diverge — and say in a comment that they are a deliberate copy.

Everything the panel does *with* the data — the model, the cell rules, the ordering — is already
written and tested in `src/xpoint.js`. This step is markup plus the transport binding above.

- [ ] **Step 4: Keep the panel in the bundle**

In `scripts/verify-bundle.js`, add to `REQUIRED_ENTRIES`:

```js
  'ui/xpoint.html',
```

The bundle would otherwise install and then fail to render the panel, which is exactly the silent-failure class that array exists to catch.

- [ ] **Step 5: Run the tests**

Run: `npm test`

Expected: PASS, 105 tests, 0 failures. No new unit tests here — the logic is Task 2's and already covered; this task is wiring and markup.

- [ ] **Step 6: Build the bundle**

Run: `npm run bundle`

Expected: ends with an `OK` line naming the path, size, and `11 tools`. If verification fails naming `ui/xpoint.html`, the file is being excluded — check `.mcpbignore`.

- [ ] **Step 7: Verify against the real device, by hand**

This is the only check that covers the HTML. Install or restart so Claude Desktop picks up the change, then ask Claude to show the crosspoint.

- [ ] The panel renders, with both destinations as rows and six columns including Disconnect.
- [ ] Port names are the device's — "HDMI out 1", "Welcome Screen" — not `O1`/`I5`.
- [ ] The currently routed cell is marked, and matches `GETALL /V1/MEDIA/VIDEO/XP/*`.
- [ ] The `I1` column is disabled on both rows and labelled `Busy`.
- [ ] Clicking an enabled cell switches the route, and the device confirms it.
- [ ] After switching **away** from the Welcome Screen on both outputs, the `I1` column becomes enabled — the shared chip input is freed. This is the behaviour that proves the post-switch re-read works.
- [ ] The last-updated time advances while the panel is visible.

Record the outcome of each in the report, including any that fail.

- [ ] **Step 8: Commit**

```bash
git add ui/xpoint.html src/index.js scripts/verify-bundle.js
git commit -m "Add the crosspoint panel as an MCP App"
```

---

## Done when

- `npm test` passes with 105 tests.
- `xpoint` returns a readable text matrix against the real device.
- If Task 1 said yes: the panel renders, clicking routes, and freeing the Welcome Screen re-enables `I1`.
- If Task 1 said no: Tasks 2 and 3 are shipped, and the report records what the host advertised.
