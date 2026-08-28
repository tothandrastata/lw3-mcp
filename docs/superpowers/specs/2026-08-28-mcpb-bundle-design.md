# lw3-mcp as an MCP Bundle (.mcpb)

**Date:** 2026-08-28
**Status:** Approved, pending implementation

## Goal

Ship lw3-mcp as a single `.mcpb` file hosted on an internal cloud file server. A colleague
downloads it, drags it into Claude Desktop's Settings > Extensions, and has the eleven LW3
tools available. No Node.js install, no npm, no hand-editing of `claude_desktop_config.json`.

## Why local install, not a remote connector

Claude Desktop can add remote MCP servers by URL with nothing installed locally. That path is
unavailable here. `discover` sends mDNS multicast on the local subnet and `connect` opens TCP to
`<device>:6107`. A cloud-hosted server sits on the wrong side of the user's LAN and finds zero
devices. The server must run on the same network as the hardware, so the deliverable is a local
bundle and the most we can remove is the install friction.

Claude Desktop supplies its own Node runtime to bundled servers, which is what makes a
zero-prerequisite install possible on machines that have never had Node.

## Decisions

| Decision | Choice | Consequence |
|---|---|---|
| Device selection | No `user_config`; `discover` then `connect` each session | `src/` needs no changes at all |
| Dependency packing | Vendor pruned `node_modules` | ~2.5 MB packed bundle (the ~18 MB dependency tree compresses well), no build tooling, ships what was tested |
| Packer | `npx @anthropic-ai/mcpb pack` | Manifest validated at build time, no new package.json deps |
| Distribution | Versioned filename + `INSTALL.md` | Colleagues can identify their build without opening Claude Desktop |

Vendoring is viable because the dependency tree is pure JavaScript. `find node_modules -name "*.node"`
returns nothing across all 91 production packages, so one bundle is portable to every platform and
no per-architecture builds are needed.

## Repository additions

```
manifest.json          # bundle metadata read by Claude Desktop
.mcpbignore            # keeps repo cruft out of the zip
assets/icon.svg        # Lightware LWR mark, vector source
assets/icon.png        # 256x256 raster for the manifest
scripts/bundle.js      # build driver
INSTALL.md             # ships beside the .mcpb on the file server
dist/                  # build output, gitignored
```

`src/index.js`, `src/lw3-protocol.js`, and `src/lightware-discovery.js` are untouched.
`package.json` gains one `bundle` script.

## manifest.json

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
  "server": {
    "type": "node",
    "entry_point": "src/index.js",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/src/index.js"]
    }
  },
  "tools": [ /* all 11, name + description, mirrored from ListToolsRequestSchema */ ],
  "compatibility": { "platforms": ["win32", "darwin", "linux"] }
}
```

`${__dirname}` is expanded by Claude Desktop to the directory it unpacked the bundle into. Hardcoding
any absolute path here breaks the install on every machine but the build machine.

The field names above follow the published manifest spec. The schema version is authoritative and can
move, so implementation runs `mcpb validate` first and conforms to whatever the CLI reports. If
validation and this document disagree, the CLI wins and this document gets corrected.

## Build

`npm run bundle` runs `scripts/bundle.js`, a plain Node script with no dependencies:

1. `npm ci --omit=dev` — reinstall from `package-lock.json` so the bundle is reproducible. There are
   no devDependencies today; this is a guard against a future one leaking into the zip.
2. Read `version` from `package.json`.
3. `npx @anthropic-ai/mcpb pack . dist/lw3-mcp-<version>.mcpb`

A Node script rather than an inline npm script because interpolating the version into a filename is
not portable across PowerShell and sh, and this repo is developed on Windows.

## .mcpbignore

Excludes `cursor_config.json`, `.claude/`, `docs/`, `dist/`, `.git/`, `CLAUDE.md`, `logo.svg`, and
`assets/icon.svg`. The PNG ships; the vector source stays in the repo only.

The repository was cleaned up during design: `test-connection.js` (`452e975`) and
`Lightware_LW3_Tanulsagok.pdf` (`e8be79e`) were deleted, so neither needs an ignore rule. A stray
`logo.svg` in the repository root duplicates `assets/icon.svg` byte for byte and should be deleted.

## Verification

Two failure modes here are silent, so both get checked mechanically by `scripts/bundle.js` before it
reports success:

1. **`node_modules` must be inside the zip.** `.gitignore` lists `node_modules/`. If the packer honors
   gitignore rules, the bundle installs cleanly and then dies on first launch with an unresolvable
   import. The build extracts its own output and asserts `node_modules/@modelcontextprotocol` and
   `node_modules/multicast-dns` are present.
2. **The extracted copy must run.** Pipe a JSON-RPC `initialize` followed by `tools/list` into
   `node <extracted>/src/index.js` and assert eleven tools come back. This proves imports resolve from
   the staged tree rather than from the developer's working directory.

Neither check needs a Lightware device. Two things cannot be verified from the build machine and are
explicitly the operator's responsibility: a real drag-and-drop install into Claude Desktop, and a
`discover` against live hardware on the LAN.

## Out of scope

- `user_config`, pinned hosts, auto-connect at startup
- Auto-update; sideloaded bundles do not self-update, so a new version means republishing the file
- esbuild single-file bundling
- CHANGELOG.md, premature at 1.0.0 with four commits of history
- Code signing and enterprise MDM push; if silent org-wide deployment becomes a requirement it is a
  separate piece of work against current Claude Desktop admin documentation

## Risks

| Risk | Mitigation |
|---|---|
| Packer honors `.gitignore` and drops `node_modules` | Verification step 1 fails the build |
| Manifest schema differs from this document | `mcpb validate` before packing; CLI is authoritative |
| `npx` unreachable on the build machine | Build fails loudly; PowerShell `Compress-Archive` fallback exists but was deliberately not built |
| Packed bundle is large enough to be awkward for the file server | Not observed in practice: the packed artifact is ~2.5 MB, since the ~18 MB dependency tree compresses well. esbuild path stays available if a future dependency changes that |
