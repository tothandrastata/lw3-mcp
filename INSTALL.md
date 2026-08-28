# Lightware LW3 Gateway — Install

Adds eleven tools to Claude Desktop for discovering and controlling Lightware
devices over LW3.

Prefer step-by-step pictures? See [WALKTHROUGH.md](WALKTHROUGH.md).

## Requirements

- Claude Desktop, updated to a version with Settings > Extensions
- **Your computer must be on the same network as the device.** The gateway sends
  mDNS multicast to find devices and connects to them on TCP port 6107. A VPN
  that routes all traffic, or a guest network that blocks multicast, will make
  discovery return nothing.
- No Node.js or npm needed. Claude Desktop runs the server with its own runtime.

## Install

1. Download the bundle:
   **https://github.com/tothandrastata/lw3-mcp/releases/latest/download/lw3-mcp.mcpb**
2. Open Claude Desktop → **Settings** → **Extensions**, under the
   **Desktop app** heading in the left sidebar.
3. Drag the downloaded `lw3-mcp.mcpb` onto the line reading
   **"Drag .MCPB or .DXT files here to install"**. If the drop does not
   register, use **Advanced settings** just above it to install from a file.
4. Confirm the install prompt.

That link always serves the newest release. To pin a specific version instead,
take it from the [releases page](https://github.com/tothandrastata/lw3-mcp/releases)
— for example `.../releases/download/v1.0.0/lw3-mcp.mcpb`.

## First use

Ask Claude:

- *"Discover Lightware devices on the network"* — lists model name, serial
  number, IP address, and hostname for everything it finds.
- *"Connect to 192.168.2.109"* — opens the LW3 connection. The hostname from
  discovery works too, though on a locked-down corporate machine `.local` mDNS
  names sometimes fail to resolve even when the device itself is reachable; the
  IP address is the safer bet if that happens.
- *"Show me the root structure"* — dumps the device tree.
- *"Read /V1/MANAGEMENT/NETWORK.HostName"*

The connection stays open for the whole Claude Desktop session. Only one device
at a time; ask Claude to disconnect before connecting to another.

## Troubleshooting

**Discovery finds nothing.** Check that you are on the same subnet as the device
and not on a VPN. Failing that, connect directly by IP address; discovery is a
convenience, not a prerequisite.

**"Not connected to a device".** Ask Claude to connect first. The connection does
not survive a Claude Desktop restart.

**Connection hangs without error.** Traffic to port 6107 is being silently dropped,
usually by a full-tunnel VPN or firewall. Disconnect from the VPN, verify you're on
the same subnet as the device, and check the address from discovery in case it's wrong.

**Commands time out.** The device is reachable but not answering on port 6107.
Confirm LW3 is enabled on the device.

## Updating

Bundles do not update themselves. Download from the same link again and drag it
in; it replaces the installed version.

## Which version am I running?

Settings > Extensions lists the installed version. Compare it against the newest
tag on the [releases page](https://github.com/tothandrastata/lw3-mcp/releases).
The downloaded file is named `lw3-mcp.mcpb` with no version in it, so the
Extensions pane is the reliable place to check.
