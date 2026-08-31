# LW3 MCP

An MCP (Model Context Protocol) server that acts as a gateway to Lightware devices over the LW3 protocol. It discovers devices on the local network and holds one persistent connection for the length of an MCP session.

In a host that supports [MCP Apps](#the-crosspoint-panel-mcp-apps), the crosspoint tools render an interactive routing grid rather than text — click a cell to switch.

Ships two ways: as an installable bundle for people who just want the tools, and as a normal Node project for people working on it.

## Install the bundle (most people)

The server is packaged as an `.mcpb` [MCP Bundle](#building-the-bundle).

**[⬇ Download the latest release](https://github.com/tothandrastata/lw3-mcp/releases/latest/download/lw3-mcp.mcpb)**

Drag the downloaded file into Claude Desktop's **Settings → Extensions** and you're done — no Node.js, no npm, no editing `claude_desktop_config.json`. Claude Desktop runs the server with its own bundled runtime. Older versions are on the [releases page](https://github.com/tothandrastata/lw3-mcp/releases).

**[INSTALL.md](INSTALL.md)** is the guide for that audience; it ships next to the `.mcpb` on the file server.

One requirement worth repeating here: **the machine must be on the same network as the device.** Discovery uses mDNS multicast, and connections go to LAN addresses — TCP port 6107 first, falling back to a secure WebSocket if that's blocked (see [Connecting: TCP first, WSS fallback](#connecting-tcp-first-wss-fallback)). That is also why this cannot be hosted as a remote MCP server — a cloud-hosted instance would sit on the wrong side of your network and find nothing.

## Run from source (development)

```bash
npm install
npm start          # run the server on stdio
npm run dev        # same, with --watch
npm test           # 128 tests, node:test, no test framework needed
npm run build:panel # regenerate the UI panels (also run by bundle)
npm run bundle     # build the distributable .mcpb
```

To point an MCP client at your working tree instead of an installed bundle:

```json
{
  "mcpServers": {
    "lightware": {
      "command": "node",
      "args": ["<path-to-repo>/src/index.js"]
    }
  }
}
```

For interactive poking at the tools against a real device:

```bash
npx @modelcontextprotocol/inspector node src/index.js
```

## Building the bundle

```bash
npm run bundle
```

Produces `dist/lw3-mcp-<version>.mcpb`, roughly 3.3 MB, with the version read from `package.json` so the filename cannot drift from the contents. Two generation steps run first, then six build steps, and it refuses to report success unless all of them pass:

- `build-panel` — inlines the MCP Apps SDK and the grid model into the panel

1. `npm test` — catches manifest drift before anything is packed
2. `npm ci --omit=dev` — reinstalls from the lockfile so the build is reproducible
3. `mcpb validate` — checks `manifest.json` against the real schema
4. `mcpb pack` — zips the repo plus its dependencies
5. **Verify** — unpacks the result, confirms the dependencies and panels are inside, and starts the packed server to confirm it answers `tools/list`
6. Restores dev dependencies, which step 2 pruned — without this the tree cannot rebuild its own panels

Step 5 exists because the interesting failures here are silent. A bundle missing `node_modules` installs without complaint and dies on first launch; a stale `manifest.json` version makes Claude Desktop display a version that disagrees with the filename. The verifier reads the *packed* manifest — not your working tree — so it validates the artifact that actually ships.

You can re-run that check against any bundle on its own:

```bash
node scripts/verify-bundle.js dist/lw3-mcp-1.0.0.mcpb
```

### Publishing a release

Distribution is GitHub Releases. To cut a new one:

1. Bump the version in `package.json` **and** `manifest.json`, then `npm run bundle`
2. Copy the output to a version-less name as well: `cp dist/lw3-mcp-<version>.mcpb dist/lw3-mcp.mcpb`
3. Draft a release at [releases/new](https://github.com/tothandrastata/lw3-mcp/releases/new), tag it `v<version>` **on the commit that carries that version**, and attach both files

Check the tag actually points where you think: a release created against a branch name tags
whatever that branch currently is, which is not necessarily the build you just made.

Attaching the version-less copy is what keeps this URL working forever:

```
https://github.com/tothandrastata/lw3-mcp/releases/latest/download/lw3-mcp.mcpb
```

It is the link in this README and in [INSTALL.md](INSTALL.md), so it must not break. Bundles do not self-update — a new release means people drag in the newer file themselves.

### Changing the version

Bump it in **both** `package.json` and `manifest.json`. `npm test` fails if they disagree, and so does the build's verification step, so this is hard to get wrong quietly.

### Adding a tool

Register it in `src/index.js` (the `ListToolsRequestSchema` entry, the `switch` case, and the handler), then add it to the `tools` array in `manifest.json`. The test suite asserts parity in both directions and will fail until the manifest catches up.

## How the host learns to use this

The server returns an `instructions` block at `initialize`, which the host puts in its
system prompt. That matters because tool descriptions are not always read: some hosts
list MCP tools by name and fetch their schemas only on demand, so a tool can be
effectively invisible until the user names the server. One user found exactly that — the
gateway was installed and working, and the assistant suggested running `nmap` instead of
calling `discover`, because at that point it had no idea `discover` existed.

The instructions name `discover` as the entry point and say it is read-only and
argument-free, which is what makes calling it speculatively reasonable. They *prefer*
`discover` over manual scans rather than forbidding them, because someone debugging their
own network may legitimately want a shell command.

Tool descriptions carry the words people actually type — "what devices are on the
network", inventory, audit, "find device X" — alongside the product names. Both are
pinned by tests, since a well-meaning tidy-up of either would quietly undo the fix.

## Available tools

Eleven tools. All the LW3 commands take **separated** `nodepath` and `property`/`method` parameters rather than one combined path string, so a value returned by `GETALL` can be passed straight into `GET` or `CALL`.

### Discovery and connection

- **discover** — Find Lightware devices on the local network via mDNS (see [How discovery works](#how-discovery-works))
  - `timeout` (optional, default 3000 ms)
  - Returns model name, serial number, IP address, and hostname for each device `connect` could actually reach (i.e. it has an `ipAddress` or a `hostname`). `modelName` and `serialNumber` are `null` when the device's mDNS instance name isn't `PRODUCT SERIAL` — the device is still reported, not dropped. A device seen on the network but resolved to neither an address nor a hostname within the timeout is mentioned separately, by count, rather than listed as if it were usable
- **connect** — Open the LW3 connection
  - `host` (required): IP address or hostname
  - `port` (optional, default 6107)
  - `password` (optional): the device's `admin` password. Only needed if the device requires authentication over the WSS fallback — `connect` says so when it does, and it's safe to omit otherwise
  - `transport` (optional, `"wss"`): skip the TCP attempt for a device already known to answer only over secure WebSocket. Leave it unset normally. It exists because such a device reports port 443, and a plain TCP connect to 443 succeeds against *any* HTTPS listener — which would be mistaken for an LW3 session, leaving every command to time out
- **disconnect** — Close the connection
- **status** — Report whether a connection is open, and to what

### LW3 commands

- **GET** — Read a property value
  - `nodepath` (required), e.g. `/V1/EDID`
  - `property` (required), e.g. `EdidStatus`
  - Sends `GET /V1/EDID.EdidStatus`
- **SET** — Write a property value
  - `nodepath`, `property`, `value` (all required)
  - Sends `SET /V1/MANAGEMENT/NETWORK.HostName=jimmy-hc40`
- **GETALL** — List a node's children, properties, and methods
  - `path` (required), e.g. `/V1/MANAGEMENT/NETWORK`
  - Returns structured JSON: `properties` (each with `nodepath`, `property`, `value`, `writable`), `nodes`, and `methods` (each with `nodepath`, `method`)
  - A trailing `/*` asks the device to descend one level and report each child's properties. Not every device accepts that syntax — the Taurus emulator rejects it while answering the plain form, which lists children but none of their values. Where the wildcard is refused, the gateway enumerates the children and reads each, so callers get the same answer either way
- **GETROOT** — Device root structure; equivalent to `GETALL /V1/*`
- **CALL** — Execute a method
  - `nodepath`, `method` (required), `params` (optional)
  - Sends `CALL /V1/EDID:switchAll(F49)`. Parentheses are always emitted, so a method with no parameters becomes `method()`
- **MAN** — Fetch the device's own documentation for a property or method
  - `nodepath` (required), `item` (required)
  - Note this uses the `.` separator even when `item` is a method name

### Video crosspoint

- **xpoint** — Takes no parameters. Renders [an interactive panel](#the-crosspoint-panel-mcp-apps) where the host supports it, falling back to text where it does not
  - Reads `/V1/MEDIA/VIDEO/XP` plus a per-destination `SWITCHABLE` read, and detects the device family from what the crosspoint publishes
  - Covers the `I1`/`O1` family and stream-named ones such as TPN-MMU, whose ports are named after their stream (`41759AEC60DF_S0`, `2D66D972A0C8_D0`), routing lives in `SourceStream` rather than `ConnectedSource`, and names come from `StreamAlias`
  - Detection keys on the **routing property**, not the port-name shape: the property is what the panel has to write, so a device with unfamiliar port names but recognised routing is still usable. An unrecognised device says so rather than returning an empty grid, which would read as a device with nothing routed

Switchability is read per destination and is not assumed uniform across them — a source `Busy` on one output can be `OK` on another, so nothing is cached, inferred, or predicted. A destination whose read fails is reported as unread rather than as refused, and one that publishes no `SWITCHABLE` data at all is treated as publishing *no restriction* rather than as refusing every source: some devices simply do not implement it, and blocking every cell would invent a rule the device never stated.

## The crosspoint panel (MCP Apps)

`xpoint` returns an interactive routing grid as well as text. Destinations
are rows, sources are columns, and clicking a cell switches it. Clicking the cell that is
already routed disconnects that destination — there is no separate Disconnect column, so
the action sits on the thing being undone. Port headers are tinted green or grey by
`SignalPresent`; a port the device never reported keeps the default colour, because
"unreported" and "no signal" are different claims.

Hosts that have not negotiated the extension get the text rendering instead, and only
those: beside a live panel, a text summary is a snapshot frozen at call time that goes
stale on the first click — while reading as more authoritative than the panel, being more
detailed.

Four host behaviours shape the implementation. None is in the specification, and all four
were established the hard way:

- **The extension must be negotiated at `initialize`** — `capabilities.extensions
  ["io.modelcontextprotocol/ui"]`. The `ui://` resource and the tool's `_meta.ui` are not
  sufficient; without it the host quietly renders the text.
- **A `ui://` URI is cached by the host from its first use.** One published before the
  capability was declared never rendered again, across eight releases and a rewrite, while
  every freshly named URI worked first time. Renaming is the only recovery — which is why
  the panel is `ui://lw3-mcp/xpoint-panel-v2`.
- **The panel's tool calls reach a different server instance than the chat's.** It cannot
  see the chat's device connection, so the grid travels with the tool result in
  `structuredContent`, and the panel opens its own connection before it can switch.
- **The panel confirms which device it holds before writing.** The instance is shared
  across panels and may already be connected to whatever an earlier one opened — in which
  case a `SET` succeeds, against the wrong matrix. Confirming first, rather than
  reconnecting only after a failure, is the difference between a refused click and a
  mis-routed one.

Where the device needs a password, the panel asks for it once and holds it in memory for
that panel alone. It is never placed in `structuredContent`, which is visible in the
conversation's raw tool-output view.

General notes on building these — independent of this project — are in the
`building-mcp-apps` skill.

## How discovery works

`discover` opens one mDNS socket per external IPv4 interface on the machine, rather than one shared socket. The `multicast-dns` library receives on every interface but transmits on only one, chosen by the OS — on a machine with a Hyper-V switch or a VPN adapter, that choice can miss the LAN entirely. Each socket binds to `0.0.0.0`, not the interface's own address: Linux and macOS/BSD only deliver a multicast packet to a socket bound to a wildcard (or otherwise matching) address, so binding to the interface address — while still using it to select which interface transmits — would silently receive nothing on those platforms.

Each socket queries a known list of Lightware service types — most have both the plain and the `-https`/`-wss` variants, since a device with its HTTP service disabled advertises only the secure one, so querying just the plain names would make it invisible; `_lara-https` and `_update-rest-https` are exceptions with no plain counterpart — plus whatever Lightware-looking types the network's own `_services._dns-sd._udp.local` enumeration reports. (`_lmdmp._udp.local` is deliberately left out — a UDP management protocol, not an LW3 endpoint.) All name and service-type comparisons are case-insensitive, per RFC 6762 — nothing guarantees a responder or mDNS proxy echoes back the same case that was queried. Queries are re-issued three times inside the timeout window, because the PTR → SRV → A chase rarely completes in one round.

Every Lightware instance found is reported, deduplicated by its mDNS instance label. A PTR or SRV is only accepted when it answers a service type this scan actually queried — mDNS is broadcast, so without that check, an unrelated device's own announcements on the same segment (a Chromecast, a smart plug, anything) would be registered as a Lightware device too. `modelName`, `serialNumber`, `ipAddress`, and `hostname` are each `null` when unresolved: `modelName`/`serialNumber` when the instance name doesn't parse as `PRODUCT SERIAL`, `hostname` when no SRV record arrives, `ipAddress` when no A record arrives before the timeout. As with any mDNS scan, a device that doesn't answer within `timeout` still won't appear in the results — and if no network interface can open a socket at all, `discover` throws rather than returning an empty list, so that failure isn't mistaken for "no devices found."

## Connecting: TCP first, WSS fallback

`connect` tries a raw TCP socket on port 6107 first — the device's native transport, bounded to 3 seconds so a silently dropped connection (VPN, firewall) fails fast instead of waiting on the OS. If that fails, it falls back to a secure WebSocket at `wss://<host>/lw3`, the same endpoint the device's own web UI uses, with the same bounded handshake. The device's certificate is self-signed, so the fallback does not verify it — the connection is encrypted but the device's identity is not.

Some devices require authentication over the WSS path. When one does, `connect` fails with a message asking for the device's `admin` password; pass it as the optional `password` argument and call `connect` again. `status` reports which transport is actually in use (`tcp` or `wss`), so you can tell which path a session ended up on.

## LW3 protocol notes

Line-based text protocol, UTF-8, `\n` terminated — over a raw TCP socket (port 6107) or, when that's unavailable, the secure WebSocket fallback described above. Both transports feed the same line-based parser.

Response prefixes:

| Prefix | Meaning |
|---|---|
| `{XXXX` | opens the reply block for the command with signature `XXXX` |
| `}` | closes the current reply block |
| `pr` | read-only property: `pr /path.Prop=value` |
| `pw` | read-write property: `pw /path.Prop=value` |
| `n-` | child node |
| `m-` | method |
| `mO` | method executed successfully |
| `pE` / `mE` | property / method error |
| `er` | general error |

Errors are detected by the `%E<digits>:` marker itself, not by which of these prefixes carries it — `pE`, `mE`, and `-E` (a general command error) all reject the same way.

Two behaviours worth knowing before changing anything:

- **Every command carries a signature, and replies are correlated by it.** Each command is sent as `XXXX#<command>`, where `XXXX` is a 4-hex-digit signature; the device brackets its reply as `{XXXX` … `}`. A reply is matched to the pending command with that signature rather than to whichever command happens to be waiting, so a late or out-of-order reply can no longer land on the wrong command. A line arriving outside any block is unsolicited — a subscription `CHG` update, a banner — and is emitted as an `unsolicited` event, never treated as a reply. Commands are still sent one at a time in this codebase, but that's now a choice, not a constraint of the correlation itself.
- **`GETALL` resolves when its block closes, not on a fixed wait.** It uses the same signature/block mechanism as every other command, so it returns as soon as the device sends the closing `}` — measured at 20–25 ms against real hardware, down from the old fixed 1 second. An empty result now means the node genuinely has nothing in it.

Every command times out after 5 seconds if its reply block never closes. `connect` is bounded too: each transport attempt (TCP, then WSS) times out on its own rather than relying on the OS — see [Connecting: TCP first, WSS fallback](#connecting-tcp-first-wss-fallback).

## Project structure

```
lw3-mcp/
├── src/
│   ├── index.js                 # MCP server: tool registration and handlers
│   ├── lw3-protocol.js          # framing, signature-keyed pending-command map, TCP->WSS fallback
│   ├── transports/
│   │   ├── tcp.js               # raw TCP socket, port 6107
│   │   └── wss.js               # secure WebSocket fallback, wss://<host>/lw3
│   ├── lightware-discovery.js   # mDNS device discovery
│   └── xpoint.js                # crosspoint grid model, dialect-detecting
├── ui/
│   ├── xpoint.src.html          # panel source; edit this one
│   └── xpoint.html              # GENERATED: source + SDK + grid model inlined
├── scripts/
│   ├── build-panel.js           # inlines the MCP Apps SDK and the grid model
│   ├── bundle.js                # npm run bundle
│   └── verify-bundle.js         # unpack-and-run verification
├── tests/                       # node:test suites
├── assets/                      # bundle icon (svg source + 512px png)
├── manifest.json                # what Claude Desktop reads to launch the server
├── .mcpbignore                  # what stays out of the bundle
├── INSTALL.md                   # end-user install guide, ships with the .mcpb
└── CLAUDE.md                    # architecture notes for AI coding agents
```

The file marked GENERATED is build output — edit `ui/xpoint.src.html` and run
`npm run build:panel`. The panel cannot import from the server's filesystem, so the grid
model has to live inside the document; it used to be pasted there by hand, and it went
stale exactly as the comment asking the next editor to keep it in step had feared. A test asserts the built panel still carries the behaviour of its source, so a stale build
fails rather than shipping.

Design and implementation notes for the packaging work live in `docs/superpowers/`.

## License

MIT
