# LW3 MCP

An MCP (Model Context Protocol) server that acts as a gateway to Lightware devices over the LW3 protocol. It discovers devices on the local network and holds one persistent connection for the length of an MCP session.

Ships two ways: as an installable bundle for people who just want the tools, and as a normal Node project for people working on it.

## Install the bundle (most people)

The server is packaged as an `.mcpb` [MCP Bundle](#building-the-bundle).

**[⬇ Download the latest release](https://github.com/tothandrastata/lw3-mcp/releases/latest/download/lw3-mcp.mcpb)**

Drag the downloaded file into Claude Desktop's **Settings → Extensions** and you're done — no Node.js, no npm, no editing `claude_desktop_config.json`. Claude Desktop runs the server with its own bundled runtime. Older versions are on the [releases page](https://github.com/tothandrastata/lw3-mcp/releases).

**[INSTALL.md](INSTALL.md)** is the guide for that audience; it ships next to the `.mcpb` on the file server.

One requirement worth repeating here: **the machine must be on the same network as the device.** Discovery uses mDNS multicast and connections go to LAN addresses on TCP port 6107. That is also why this cannot be hosted as a remote MCP server — a cloud-hosted instance would sit on the wrong side of your network and find nothing.

## Run from source (development)

```bash
npm install
npm start          # run the server on stdio
npm run dev        # same, with --watch
npm test           # 10 tests, node:test, no test framework needed
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

Eleven tools. All of them take **separated** `nodepath` and `property`/`method` parameters rather than one combined path string, so a value returned by `GETALL` can be passed straight into `GET` or `CALL`.

### Discovery and connection

- **discover** — Find Lightware devices on the local network via mDNS
  - `timeout` (optional, default 3000 ms)
  - Returns model name, serial number, IP address, and hostname for each device found
- **connect** — Open the LW3 connection
  - `host` (required): IP address or hostname
  - `port` (optional, default 6107)
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
- **OPEN** — Subscribe to a property
  - `nodepath`, `property` (required)
- **MAN** — Fetch the device's own documentation for a property or method
  - `nodepath` (required), `item` (required)
  - Note this uses the `.` separator even when `item` is a method name

## LW3 protocol notes

Line-based text protocol over TCP, default port 6107, UTF-8, `\n` terminated.

Response prefixes:

| Prefix | Meaning |
|---|---|
| `pr` | read-only property: `pr /path.Prop=value` |
| `pw` | read-write property: `pw /path.Prop=value` |
| `n-` | child node |
| `m-` | method |
| `mO` | method executed successfully |
| `pE` / `mE` | property / method error |
| `er` | general error |

Two behaviours worth knowing before changing anything:

- **Commands are strictly one at a time.** The protocol layer resolves whichever command is at the head of its queue rather than correlating responses to requests, so concurrent commands would cross-resolve.
- **`GETALL` is time-boxed, not terminated.** No end-of-response marker is recognised; it collects lines for one second and then parses. Every `GETALL` costs about a second regardless of how fast the device replies.

Single-line commands time out after 5 seconds. `connect` itself has no timeout of its own, so a silently dropped connection relies on the OS.

## Project structure

```
lw3-mcp/
├── src/
│   ├── index.js                 # MCP server: tool registration and handlers
│   ├── lw3-protocol.js          # TCP socket, framing, command queue
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
