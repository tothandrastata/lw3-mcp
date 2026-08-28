# Lightware LW3 Gateway — Install

Adds eleven tools to Claude Desktop for discovering and controlling Lightware
devices over LW3.

## Requirements

- Claude Desktop, updated to a version with Settings > Extensions
- **Your computer must be on the same network as the device.** The gateway sends
  mDNS multicast to find devices and connects to them on TCP port 6107. A VPN
  that routes all traffic, or a guest network that blocks multicast, will make
  discovery return nothing.
- No Node.js or npm needed. Claude Desktop runs the server with its own runtime.

## Install

1. Download `lw3-mcp-<version>.mcpb`.
2. Open Claude Desktop and go to **Settings > Extensions**.
3. Drag the `.mcpb` file onto that window.
4. Confirm the install prompt.

## First use

Ask Claude:

- *"Discover Lightware devices on the network"* — lists model name, serial
  number, IP address, and hostname for everything it finds.
- *"Connect to 192.168.2.109"* — opens the LW3 connection. The hostname from
  discovery works too.
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

**Commands time out.** The device is reachable but not answering on port 6107.
Confirm LW3 is enabled on the device.

## Updating

Bundles do not update themselves. Download the newer `.mcpb` and drag it in
again; it replaces the installed version.

## Which version am I running?

Settings > Extensions lists the installed version. Compare it against the
filename on the file server.
