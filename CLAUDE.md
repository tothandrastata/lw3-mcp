# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**lw3-mcp** is an MCP server that acts as a gateway to Lightware AV devices over the LW3 protocol (line-based TCP text protocol, default port 6107). One MCP session holds one persistent device connection.

## Commands

```bash
npm install
npm start                                          # run the server on stdio
npm run dev                                         # same, with --watch
npx @modelcontextprotocol/inspector node src/index.js   # interactive tool testing
```

There is no test framework, linter, or build step, and no smoke-test script since `test-connection.js` was removed in `452e975`. The MCP Inspector is the practical way to exercise tools against a real device.

`cursor_config.json` is a sample MCP client registration pointing at `C:\Taurus\lw3-mcp\src\index.js`.

## Architecture

Three files, three layers, no framework in between:

- [src/index.js](src/index.js) — `LW3MCPServer`. Registers 11 MCP tools, owns the single `LW3Protocol` instance for the process lifetime, and **builds the LW3 path strings**. The protocol layer never assembles paths.
- [src/lw3-protocol.js](src/lw3-protocol.js) — `LW3Protocol extends EventEmitter`. TCP socket, line buffering, command queue, GETALL response parsing.
- [src/lightware-discovery.js](src/lightware-discovery.js) — `LightwareDiscovery extends EventEmitter`. mDNS sweep, independent of the connection; a fresh instance is created and destroyed per `discover` call.

### Path construction lives in index.js

The tools take **separated** `nodepath` + `property`/`method`/`item` parameters and join them in the handlers. Anything changing separator or call syntax is edited in `index.js`, not the protocol layer:

| Handler | Builds | Note |
|---|---|---|
| `handleGet`/`handleSet`/`handleOpen` | `nodepath.property` | dot separator |
| `handleCall` | `nodepath:method(params)` | **always emits parentheses** — `method()` when `params` is omitted (commit `21b6d4e`) |
| `handleMan` | `nodepath.item` | dot even when `item` is a method name |
| `getRoot()` | `GETALL /V1/*` | the only path built in the protocol layer |

`LW3Protocol.call(method, params = [])` accepts a params array it joins with spaces, but `index.js` always passes `[]` because params are already baked into the path string. That second argument is effectively dead.

### The command queue only supports one in-flight command

This is the most important invariant. `processResponse()` resolves **the first entry in `pendingCommands`**, not the command that actually produced the line — responses are never correlated with requests:

```js
const firstPending = this.pendingCommands.values().next().value;
```

Consequences to respect when changing anything:
- Commands must be issued strictly one at a time. Two concurrent `sendCommand()` calls will cross-resolve.
- A `collectMultiple` (GETALL) entry sitting at the head of the queue swallows every `pr`/`pw`/`n-`/`m-` line that arrives during its window, including unrelated ones.
- Unsolicited device output (subscription updates from `OPEN`, banners) is emitted as a `response` event **and** consumed by whatever command is at the head of the queue.

If you ever need pipelining, the fix is real request/response correlation (LW3 signature prefixes), not a bigger queue.

### Two different completion strategies

- **Single-line commands** (GET/SET/CALL/OPEN/MAN): resolve on the first line received; reject if it starts with `pE `, `mE `, or `er`. 5-second timeout.
- **GETALL/GETROOT**: no terminator is recognised — the promise resolves on a **fixed 1-second timer** in `getAll()`, after which collected lines are parsed. Every GETALL costs ~1s of wall clock regardless of device speed, and a slow device can have lines truncated. An error line arriving during the window aborts the whole collection.

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

Raw single-line commands return the **whole response line**, not the value. `GET /V1/EDID.EdidStatus` yields the literal `pw /V1/EDID.EdidStatus=...`, and `handleGet` wraps that unparsed into its text output. Callers wanting a bare value must strip the prefix themselves.

### Discovery constraints

`discover` queries PTR for `_lwr3._tcp.local`, `_lara-https._tcp.local`, `_webldc-http._tcp.local`, `_rest-http._tcp.local`, then chases SRV → A. A device is reported **only** when `modelName`, `serialNumber`, and `ipAddress` have all arrived within the timeout (default 3000 ms), and only when the mDNS instance name matches `PRODUCT-NAME SERIAL` (`/^([\w-]+)\s+([A-F0-9]+)$/i`). Devices advertising other name shapes are dropped without warning. Results are keyed `modelName_serialNumber`.

## Constraints when editing

- **stdout belongs to the MCP stdio transport.** All logging goes to stderr via `console.error`; a stray `console.log` corrupts the protocol stream.
- Tool failures are returned as ordinary text content (`Error: <message>`) from the `CallToolRequestSchema` catch block, not as MCP protocol errors — no `isError` flag is set. Keep new tools consistent or change it deliberately everywhere.
- `connect` refuses when already connected (checked in both `handleConnect` and `LW3Protocol.connect`); there is no reconnect logic and no keepalive.
- ES modules (`"type": "module"`); use `.js` extensions in imports.
- Adding a tool means three coordinated edits in `index.js`: the `ListToolsRequestSchema` entry, the `switch` case, and the `handleX` method. Command handlers that touch the device must call `this.ensureConnected()` first.
