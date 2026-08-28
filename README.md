# LW3 MCP

An MCP (Model Context Protocol) server that acts as a gateway to Lightware devices over the LW3 protocol. It discovers devices on the local network and holds one persistent connection for the length of an MCP session.

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
npm test           # 85 tests, node:test, no test framework needed
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

Produces `dist/lw3-mcp-<version>.mcpb`, roughly 2.5 MB, with the version read from `package.json` so the filename cannot drift from the contents. The build runs five steps and refuses to report success unless all of them pass:

1. `npm test` — catches manifest drift before anything is packed
2. `npm ci --omit=dev` — reinstalls from the lockfile so the build is reproducible
3. `mcpb validate` — checks `manifest.json` against the real schema
4. `mcpb pack` — zips the repo plus its dependencies
5. **Verify** — unpacks the result, confirms the dependencies are inside, and starts the packed server to confirm it answers `tools/list`

Step 5 exists because the interesting failures here are silent. A bundle missing `node_modules` installs without complaint and dies on first launch; a stale `manifest.json` version makes Claude Desktop display a version that disagrees with the filename. The verifier reads the *packed* manifest — not your working tree — so it validates the artifact that actually ships.

You can re-run that check against any bundle on its own:

```bash
node scripts/verify-bundle.js dist/lw3-mcp-1.0.0.mcpb
```

### Publishing a release

Distribution is GitHub Releases. To cut a new one:

1. Bump the version in `package.json` **and** `manifest.json`, then `npm run bundle`
2. Copy the output to a version-less name as well: `cp dist/lw3-mcp-<version>.mcpb dist/lw3-mcp.mcpb`
3. Draft a release at [releases/new](https://github.com/tothandrastata/lw3-mcp/releases/new), tag it `v<version>`, and attach both files

Attaching the version-less copy is what keeps this URL working forever:

```
https://github.com/tothandrastata/lw3-mcp/releases/latest/download/lw3-mcp.mcpb
```

It is the link in this README and in [INSTALL.md](INSTALL.md), so it must not break. Bundles do not self-update — a new release means people drag in the newer file themselves.

### Changing the version

Bump it in **both** `package.json` and `manifest.json`. `npm test` fails if they disagree, and so does the build's verification step, so this is hard to get wrong quietly.

### Adding a tool

Register it in `src/index.js` (the `ListToolsRequestSchema` entry, the `switch` case, and the handler), then add it to the `tools` array in `manifest.json`. The test suite asserts parity in both directions and will fail until the manifest catches up.

## Available tools

Ten tools. All of them take **separated** `nodepath` and `property`/`method` parameters rather than one combined path string, so a value returned by `GETALL` can be passed straight into `GET` or `CALL`.

### Discovery and connection

- **discover** — Find Lightware devices on the local network via mDNS (see [How discovery works](#how-discovery-works))
  - `timeout` (optional, default 3000 ms)
  - Returns model name, serial number, IP address, and hostname for each device found. `modelName` and `serialNumber` are `null` when the device's mDNS instance name isn't `PRODUCT SERIAL` — the device is still reported, not dropped
- **connect** — Open the LW3 connection
  - `host` (required): IP address or hostname
  - `port` (optional, default 6107)
  - `password` (optional): the device's `admin` password. Only needed if the device requires authentication over the WSS fallback — `connect` says so when it does, and it's safe to omit otherwise
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
- **GETROOT** — Device root structure; equivalent to `GETALL /V1/*`
- **CALL** — Execute a method
  - `nodepath`, `method` (required), `params` (optional)
  - Sends `CALL /V1/EDID:switchAll(F49)`. Parentheses are always emitted, so a method with no parameters becomes `method()`
- **MAN** — Fetch the device's own documentation for a property or method
  - `nodepath` (required), `item` (required)
  - Note this uses the `.` separator even when `item` is a method name

## How discovery works

`discover` opens one mDNS socket per external IPv4 interface on the machine, rather than one shared socket. The `multicast-dns` library receives on every interface but transmits on only one, chosen by the OS — on a machine with a Hyper-V switch or a VPN adapter, that choice can miss the LAN entirely.

Each socket queries a known list of Lightware service types — both the plain and the `-https`/`-wss` variants — plus whatever Lightware-looking types the network's own `_services._dns-sd._udp.local` enumeration reports. The secure variants matter on their own: a device with its HTTP service disabled advertises only those, so querying just the plain names would make it invisible. (`_lmdmp._udp.local` is deliberately left out — a UDP management protocol, not an LW3 endpoint.) Queries are re-issued three times inside the timeout window, because the PTR → SRV → A chase rarely completes in one round.

Every Lightware instance found is reported, deduplicated by its mDNS instance label — nothing is dropped silently. `modelName`/`serialNumber` are `null` when the instance name doesn't parse as `PRODUCT SERIAL`, and `ipAddress` is `null` if no A record arrives before the timeout. As with any mDNS scan, a device that doesn't answer within `timeout` still won't appear in the results.

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
│   └── lightware-discovery.js   # mDNS device discovery
├── scripts/
│   ├── bundle.js                # npm run bundle
│   └── verify-bundle.js         # unpack-and-run verification
├── tests/                       # node:test suites
├── assets/                      # bundle icon (svg source + 512px png)
├── manifest.json                # what Claude Desktop reads to launch the server
├── .mcpbignore                  # what stays out of the bundle
├── INSTALL.md                   # end-user install guide, ships with the .mcpb
└── CLAUDE.md                    # architecture notes for AI coding agents
```

Design and implementation notes for the packaging work live in `docs/superpowers/`.

## License

MIT
