# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**lw3-mcp** is an MCP server that acts as a gateway to Lightware AV devices over the LW3 protocol (line-based text protocol, default port 6107). One MCP session holds one persistent device connection. `connect` tries a raw TCP socket first and, if that fails, falls back to a secure WebSocket at `wss://<host>/lw3` — the same endpoint the device's own web UI uses. Some devices require the `admin` password over that path; `connect` takes it as an optional `password` argument.

## Commands

```bash
npm install
npm start                                          # run the server on stdio
npm run dev                                         # same, with --watch
npm test                                            # 56 tests, node:test — no framework, no config
npm run bundle                                      # build dist/lw3-mcp-<version>.mcpb (scripts/bundle.js)
npx @modelcontextprotocol/inspector node src/index.js   # interactive tool testing
```

There is no linter. `npm test` runs `tests/*.js` with `node:test`; `npm run bundle` runs the test suite as its first step, so a broken test blocks the build. The MCP Inspector is still the practical way to exercise tools against a real device.

`cursor_config.json` is a sample MCP client registration pointing at `C:\Taurus\lw3-mcp\src\index.js`.

## Architecture

- [src/index.js](src/index.js) — `LW3MCPServer`. Registers 10 MCP tools, owns the single `LW3Protocol` instance for the process lifetime, and **builds the LW3 path strings**. The protocol layer never assembles paths.
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
- A line arriving outside any open block is unsolicited — a subscription `CHG` update, a banner — and is emitted as an `unsolicited` event, never treated as a reply.
- Device errors are detected by the `%E<digits>:` marker (`DEVICE_ERROR` regex) anywhere in a block's lines, not by a prefix list, so `pE`, `mE`, and `-E` all reject the same way. The old prefix check reported `-E` errors as successful values.
- Commands are still issued one at a time in this codebase (`index.js` awaits each call before making the next), but that's a choice, not a limitation of `sendCommand()` — it already tolerates concurrent, out-of-order replies.

### One completion strategy for every command

`sendCommand()` resolves when the reply block closes (`}` matching its signature) and rejects if any line in the block carries `%E<digits>:`. 5-second timeout if the block never closes. GET, SET, CALL, MAN, and GETALL all share this path — there is no separate handling for GETALL any more.

`getAll()`/`getRoot()` differ only in what happens *after* the lines come back: `parseGetAll()` sorts them into `{properties, nodes, methods}`. There's no fixed wait — a GETALL against `/V1/MANAGEMENT/DATETIME` measured 20–25 ms against real hardware, down from the old fixed 1000 ms, and an empty result now means an empty node rather than "nothing arrived within one second".

### Response grammar (parsed in `getAll()` / `processResponse()`)

```
pr /nodepath.Prop=value     read-only property   -> {nodepath, property, value, writable:false}
pw /nodepath.Prop=value     read-write property  -> {nodepath, property, value, writable:true}
n- /path/child              child node           -> nodes[]
m- /nodepath:method         method               -> {nodepath, method}
mO /nodepath:method         CALL succeeded
pE|mE ... %E###: message    property/method error
er<code>                    general error
```

Property lines are split with `/^p[rw] (.+?)\.([^=]+)=(.*)$/` (non-greedy path, so the **last** dot before `=` separates node from property). Only the four collectible prefixes above survive GETALL parsing; anything else in the window is dropped silently.

`get`/`set`/`call`/`man` return the **raw lines of the reply block**, joined with `\n`, not a parsed value. `GET /V1/EDID.EdidStatus` yields the literal `pw /V1/EDID.EdidStatus=...`, and `handleGet` wraps that unparsed into its text output. Callers wanting a bare value must strip the prefix themselves. Multi-line replies are no longer truncated: `GET /V1/MANAGEMENT/NETWORK.*` returns all nine lines the device sends, not just the first.

### Discovery constraints

`discover` queries PTR for `_lwr3._tcp.local`, `_lara-https._tcp.local`, `_webldc-http._tcp.local`, `_rest-http._tcp.local`, then chases SRV → A. A device is reported **only** when `modelName`, `serialNumber`, and `ipAddress` have all arrived within the timeout (default 3000 ms), and only when the mDNS instance name matches `PRODUCT-NAME SERIAL` (`/^([\w-]+)\s+([A-F0-9]+)$/i`). Devices advertising other name shapes are dropped without warning. Results are keyed `modelName_serialNumber`.

## Constraints when editing

- **stdout belongs to the MCP stdio transport.** All logging goes to stderr via `console.error`; a stray `console.log` corrupts the protocol stream.
- Tool failures are returned as ordinary text content (`Error: <message>`) from the `CallToolRequestSchema` catch block, not as MCP protocol errors — no `isError` flag is set. Keep new tools consistent or change it deliberately everywhere.
- `connect` refuses when already connected (checked in both `handleConnect` and `LW3Protocol.connect`); there is no reconnect logic and no keepalive.
- ES modules (`"type": "module"`); use `.js` extensions in imports.
- Adding a tool means three coordinated edits in `index.js`: the `ListToolsRequestSchema` entry, the `switch` case, and the `handleX` method. Command handlers that touch the device must call `this.ensureConnected()` first.
