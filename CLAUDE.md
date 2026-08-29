# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**lw3-mcp** is an MCP server that acts as a gateway to Lightware AV devices over the LW3 protocol (line-based text protocol, default port 6107). One MCP session holds one persistent device connection. `connect` tries a raw TCP socket first and, if that fails, falls back to a secure WebSocket at `wss://<host>/lw3` — the same endpoint the device's own web UI uses. Some devices require the `admin` password over that path; `connect` takes it as an optional `password` argument.

## Commands

```bash
npm install
npm start                                          # run the server on stdio
npm run dev                                         # same, with --watch
npm test                                            # 113 tests, node:test — no framework, no config
npm run bundle                                      # build dist/lw3-mcp-<version>.mcpb (scripts/bundle.js)
npx @modelcontextprotocol/inspector node src/index.js   # interactive tool testing
```

There is no linter. `npm test` runs `tests/*.js` with `node:test`; `npm run bundle` runs the test suite as its first step, so a broken test blocks the build. The MCP Inspector is still the practical way to exercise tools against a real device.

`cursor_config.json` is a sample MCP client registration pointing at `C:\Taurus\lw3-mcp\src\index.js`.

## Architecture

- [src/index.js](src/index.js) — `LW3MCPServer`. Registers 11 MCP tools, owns the single `LW3Protocol` instance for the process lifetime, and **builds the LW3 path strings**. The protocol layer never assembles paths.
- [src/xpoint.js](src/xpoint.js) — Pure video-crosspoint model: turns `GETALL` lines into a `{sources, destinations, switchable}` grid, decides each cell's state (`cellState`), and renders the grid as text (`renderGridText`). No protocol, no sockets; `handleXpoint` in `index.js` is the only caller.
- [src/lw3-protocol.js](src/lw3-protocol.js) — `LW3Protocol extends EventEmitter`. Owns no socket itself: line buffering, command queue, GETALL response parsing, and the TCP→WSS fallback in `connect()`. Transport construction is injected via `createTcp`/`createWss` factories passed to the constructor, so tests substitute fakes instead of opening real sockets (see `tests/fallback.test.js`).
- [src/transports/tcp.js](src/transports/tcp.js) — `TcpTransport extends EventEmitter`. Raw TCP socket, port 6107 by default. `connect()` is bounded by `CONNECT_TIMEOUT_MS` (3s) so a silently dropped connection fails fast instead of waiting on the OS. Emits `data` (strings), `close`, `error`.
- [src/transports/wss.js](src/transports/wss.js) — `WssTransport extends EventEmitter`. Secure WebSocket to `wss://<host>/lw3`; `rejectUnauthorized: false` because devices self-sign. `connect()` uses the same `CONNECT_TIMEOUT_MS` as a `handshakeTimeout`. Sends HTTP Basic auth as the `admin` user when a password is supplied; a 401 response throws `AuthRequiredError` (distinguishing "no password yet" from "password rejected") so `index.js` can ask the user for it instead of reporting a generic failure. Same `data`/`close`/`error` event shape as `TcpTransport`, so `LW3Protocol` treats both uniformly.
- [src/lightware-discovery.js](src/lightware-discovery.js) — `LightwareDiscovery extends EventEmitter`. mDNS sweep, independent of the connection; a fresh instance is created and destroyed per `discover` call.

### Transport fallback (`LW3Protocol.connect`)

`connect(host, port, { password })` tries `TcpTransport` first. If it fails, it tries `WssTransport` with `password` (which may be `undefined`). If WSS also fails with an `AuthRequiredError`, that error is rethrown as-is — it is directly actionable ("ask the user for the password") and burying it in a combined message would hide that. Any other double failure raises one error naming both underlying failures. `getConnectionInfo()` reports which transport actually connected as `transport: 'tcp' | 'wss'`; both the `connect` and `status` tool responses surface it.

### Path construction lives in index.js

The tools take **separated** `nodepath` + `property`/`method`/`item` parameters and join them in the handlers. Anything changing separator or call syntax is edited in `index.js`, not the protocol layer:

| Handler | Builds | Note |
|---|---|---|
| `handleGet`/`handleSet` | `nodepath.property` | dot separator |
| `handleCall` | `nodepath:method(params)` | **always emits parentheses** — `method()` when `params` is omitted (commit `21b6d4e`) |
| `handleMan` | `nodepath.item` | dot even when `item` is a method name |
| `getRoot()` | `GETALL /V1/*` | the only path built in the protocol layer |

`LW3Protocol.call(method, params = [])` accepts a params array it joins with spaces, but `index.js` always passes `[]` because params are already baked into the path string. That second argument is effectively dead.

### Commands are correlated by signature, not by queue position

Every command `sendCommand()` sends is prefixed with a 4-hex-digit signature (`nextSignature()`, e.g. `3F2A#GET /V1/EDID.EdidStatus`), and the device brackets its reply as `{3F2A` … `}`. `processResponse()` looks up the pending command by that signature, not by queue position:

```js
const pending = this.pendingCommands.get(signature);
```

Consequences:
- A reply that arrives out of order still resolves the command that asked for it; a late reply can no longer land on the wrong command.
- A line arriving outside any open block is unsolicited — a subscription `CHG` update, a banner — and is emitted as an `unsolicited` event, never treated as a reply. So is a line arriving *inside* an open block whose signature has no pending command (e.g. one that already timed out): its lines are emitted as `unsolicited` too, not silently dropped.
- Device errors are detected by the `%E<digits>:` marker (`DEVICE_ERROR` regex) anywhere in a block's lines, not by a prefix list, so `pE`, `mE`, and `-E` all reject the same way. The old prefix check reported `-E` errors as successful values. A bare `er<code>` general error carries no `%E` marker of its own, so it's caught separately by `GENERAL_ERROR` (`/^er[\s\d]/`, anchored so `error`/`ergonomic`/`ErrorCount` don't false-positive); `isErrorLine()` checks both.
- Commands are still issued one at a time in this codebase (`index.js` awaits each call before making the next), but that's a choice, not a limitation of `sendCommand()` — it already tolerates whole reply blocks arriving out of order. It does **not** tolerate interleaved blocks: there is a single `currentBlock`, so a second `{XXXX` opening while one is already open orphans the pending command for the first, which then settles only by timing out 5 seconds later. Pipelining commands against this implementation is unsafe for that reason.

### One completion strategy for every command

`sendCommand()` resolves when the reply block closes (`}` matching its signature) and rejects if any line in the block carries `%E<digits>:`. 5-second timeout if the block never closes. GET, SET, CALL, MAN, and GETALL all share this path — there is no separate handling for GETALL any more.

`getAll()`/`getRoot()` differ only in what happens *after* the lines come back: `parseGetAll()` sorts them into `{properties, nodes, methods}`. There's no fixed wait — a GETALL against `/V1/MANAGEMENT/DATETIME` measured 20–25 ms against real hardware, down from the old fixed 1000 ms, and an empty result now means an empty node rather than "nothing arrived within one second".

### Response grammar (parsed in `parseGetAll()`)

```
pr /nodepath.Prop=value     read-only property   -> {nodepath, property, value, writable:false}
pw /nodepath.Prop=value     read-write property  -> {nodepath, property, value, writable:true}
n- /path/child              child node           -> nodes[]
m- /nodepath:method         method               -> {nodepath, method}
mO /nodepath:method         CALL succeeded
pE|mE ... %E###: message    property/method error
er<code>                    general error
```

Property lines are split with `/^p[rw] (.+?)\.([^=]+)=(.*)$/` (non-greedy path, so the **last** dot before `=` separates node from property). Only the four collectible prefixes above survive GETALL parsing; anything else in the block is dropped silently.

`get`/`set`/`call`/`man` return the **raw lines of the reply block**, joined with `\n`, not a parsed value. `GET /V1/EDID.EdidStatus` yields the literal `pw /V1/EDID.EdidStatus=...`, and `handleGet` wraps that unparsed into its text output. Callers wanting a bare value must strip the prefix themselves. Multi-line replies are no longer truncated: `GET /V1/MANAGEMENT/NETWORK.*` returns all nine lines the device sends, not just the first.

### Discovery constraints

`discover` opens one mDNS socket per external IPv4 interface — `multicast-dns` transmits on only one OS-chosen interface, which a Hyper-V or VPN adapter can win over the real LAN — each bound to `0.0.0.0` (not the interface address) so multicast replies actually reach it on Linux/macOS, which deliver a multicast packet only to a socket bound to a wildcard or matching address. Each socket queries the known Lightware service-type list (most, but not `_lara-https` or `_update-rest-https`, have both a plain and a `-https`/`-wss` variant, since HTTP-disabled devices advertise only the secure one) plus whatever Lightware-looking types the network's own `_services._dns-sd._udp.local` enumeration reports (`_lmdmp._udp.local` is deliberately excluded: a UDP management protocol, not LW3). All name/service-type comparisons are case-insensitive per RFC 6762. A PTR/SRV is registered only when it answers a service type this scan actually queried — mDNS is broadcast, so without that check an unrelated device's own announcements would be registered as a Lightware device too. Queries are re-issued three times inside the timeout (default 3000 ms) to cover the PTR → SRV → A chase. Every instance found is reported, keyed by its mDNS instance label: `modelName`/`serialNumber`/`hostname`/`ipAddress` are each `null` when unresolved (name doesn't match `PRODUCT SERIAL` — `/^([\w-]+)\s+([A-F0-9]+)$/i` —, no SRV arrived, or no A record arrived in time). `discover` throws, rather than returning `[]`, if no interface can open a socket at all.

## The crosspoint panel (MCP Apps)

`xpoint` returns a `ui://` HTML panel as well as text. Four host behaviours shape the
design, none of them documented upstream; all were established the hard way in this repo.

- **The extension must be negotiated at `initialize`** — `capabilities.extensions
  ["io.modelcontextprotocol/ui"]`. The `ui://` resource and the tool's `_meta.ui` are not
  sufficient: without the capability the host renders the text and says nothing.
- **A `ui://` URI is cached by the host, permanently.** `ui://lw3-mcp/xpoint` was first
  published by 1.6.0, before that capability existed, and never rendered again across
  eight releases and an SDK rewrite, while every freshly named probe URI worked first
  time. The panel is now `ui://lw3-mcp/xpoint-panel-v2`. **Never publish a `ui://` URI
  before the panel works**, and if one is burned, rename it — nothing else recovers it.
- **App-initiated tool calls reach a different server instance.** The panel's `GETALL`
  reported "Not connected" while the chat held an open WSS session. So the panel renders
  from `structuredContent` delivered with the tool result (`app.ontoolresult`), and opens
  its own connection — from the address in that result — before it can switch. No
  password is ever sent into the panel: it runs in a sandboxed third-party frame.
- **The panel confirms which device its instance holds before it writes.** The instance
  is shared across panels, so it may already be connected to whatever an earlier panel
  opened — and then a `SET` *succeeds*, against the wrong matrix, with the panel
  redrawing to show what it just switched. `connectSelf()` therefore runs before the
  write, never as a fallback after one fails, and a connection that cannot be confirmed
  routes the switch through the chat instead of guessing.
- **A `wss` device reports port 443, and TCP to 443 succeeds against any HTTPS listener.**
  `connect()` takes a `transport` hint for this: without it the panel attached a TLS
  socket as an LW3 session and every command timed out. The panel passes the transport
  the chat used.
- **The panel must report its size** (`app.sendSizeChanged`) or the frame can be zero
  height, which hides static markup too. `body` carries an intrinsic `min-height` as a
  floor so a panel that fails can still display why.

`ui/xpoint.html` is **generated** — `npm run build:panel` injects `src/xpoint.js` and the
ext-apps SDK into `ui/xpoint.src.html`. Edit the source template, never the output. The
grid model used to be pasted into the panel by hand under a comment asking the next
editor to keep it in step; it fell behind exactly as that comment feared, and the panel
marked every cell `Unavailable` while every test passed, because the tests only ever
exercised the module. `tests/xpoint.test.js` now compares the built panel's `buildGrid`,
`cellState` and `renderGridText` against the module byte for byte.

## One crosspoint tool, several device families

`xpoint` ([src/xpoint.js](src/xpoint.js)) detects the device family from what the
crosspoint publishes. There used to be two tools -- an I1/O1 one and a dialect-aware
`univ_xpoint` -- kept apart to avoid a breaking change; they were merged in 2.0.0 and
`univ_xpoint` is gone.

| | I1/O1 family | stream-named family |
|---|---|---|
| Ports | `I1` / `O1` | `…_S0` / `…_D0` |
| Routing property | `ConnectedSource` | `SourceStream` |
| Names | `Name` | `StreamAlias` |
| Disconnect | `0` | `0` |

Detection keys on the **routing property**, not port-name shape: the property is what
the panel has to write, so a device with unfamiliar port names but recognised routing is
still usable. An unrecognised device reports that fact; it must never render as an empty
grid, which reads as "a device with nothing routed". Adding a family means an entry in
`DIALECTS` and nothing else.

Ports are read from the XP node alone. The older model also swept `/V1/MEDIA/VIDEO` for
names; the stream-named family publishes them on both, so one sweep does.

**Neither axis shows a Disconnect column.** Clicking the cell that is already routed
disconnects that destination. The token stays in `sources` for the text rendering and in
`grid.disconnect` for the panel, which filters that column out and sends the value when a
routed cell is clicked.

## Device dialects: the `/*` wildcard

`GETALL <node>/*` asks the device to descend one level and report each child's
properties. Real Lightware hardware answers it. **The Taurus emulator rejects it**
(`%E002:Not exists`) while answering plain `GETALL <node>`, which lists children but none
of their properties — not the same thing, and not enough for callers that need values.

`LW3Protocol.getAllDeep(nodePath)` tries the wildcard and, where unsupported, enumerates
the children and reads each (1+N commands instead of 1). `getRoot()` and `handleXpoint`
both use it. Prefer it over hand-writing `GETALL …/*` anywhere new.

The emulator also has **no `SWITCHABLE` node**. `cellState` distinguishes a destination
that published no switchability at all (cells enabled — the device stated no restriction,
so inventing one would make every cell dead) from one that published switchability
without mentioning a source (that cell blocked — the device has spoken). The text
rendering still reports which destinations went unread.
## Constraints when editing

- **`npm test` does not import `src/index.js`** (doing so starts a server on stdio);
  `manifest.test.js` reads it as text. `tests/source-syntax.test.js` runs `node --check`
  over `src/` and `scripts/` because a syntax error in `index.js` once passed a green
  115-test run and surfaced only when the packed bundle refused to start.
- **stdout belongs to the MCP stdio transport.** All logging goes to stderr via `console.error`; a stray `console.log` corrupts the protocol stream.
- Tool failures are returned as ordinary text content (`Error: <message>`) from the `CallToolRequestSchema` catch block, not as MCP protocol errors — no `isError` flag is set. Keep new tools consistent or change it deliberately everywhere.
- `connect` refuses when already connected (checked in both `handleConnect` and `LW3Protocol.connect`); there is no reconnect logic and no keepalive.
- ES modules (`"type": "module"`); use `.js` extensions in imports.
- Adding a tool means three coordinated edits in `index.js`: the `ListToolsRequestSchema` entry, the `switch` case, and the `handleX` method. Command handlers that touch the device must call `this.ensureConnected()` first.
