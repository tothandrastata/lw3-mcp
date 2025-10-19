# LW3 MCP

An MCP (Model Context Protocol) server that provides a gateway to Lightware devices using the LW3 protocol. This server maintains a persistent connection to a Lightware device throughout the MCP session.

## Features

- **Persistent Connection**: Maintains a single connection to a Lightware device during the MCP session
- **LW3 Protocol Support**: Full implementation of the Lightware LW3 protocol
- **MCP Tools**: Exposes all LW3 commands as MCP tools

## Available Tools

### Connection Management

- **connect** - Connect to a Lightware device
  - `host` (required): Device IP address or hostname
  - `port` (optional): Device port (default: 6107)

- **disconnect** - Disconnect from the current device

- **status** - Get current connection status

### LW3 Protocol Commands

- **GET** - Read a property value
  - `nodepath` (required): Node path (e.g., "/V1/EDID")
  - `property` (required): Property name (e.g., "EdidStatus")

- **SET** - Set a property value
  - `nodepath` (required): Node path (e.g., "/V1/MANAGEMENT/NETWORK")
  - `property` (required): Property name (e.g., "HostName")
  - `value` (required): Value to set

- **GETALL** - Get all child nodes, properties and methods of a node
  - `path` (required): Node path (e.g., "/V1/MANAGEMENT/NETWORK")
  - Returns structured JSON with three categories:
    - `properties`: Array of objects with `nodepath`, `property`, `value`, and `writable` fields
    - `nodes`: Array of sub-path/node strings
    - `methods`: Array of objects with `nodepath` and `method` fields

- **GETROOT** - Get root structure of the device
  - No parameters required
  - Equivalent to `GETALL /V1/*`
  - Returns the complete device structure with properties, nodes, and methods at the root level

- **CALL** - Execute a method
  - `nodepath` (required): Node path (e.g., "/V1/EDID")
  - `method` (required): Method name (e.g., "switchAll" or "applySettings")
  - `params` (optional): Method parameters (e.g., "F49" will construct "switchAll(F49)")
  - Response format: `mO <nodepath:method>` for successful execution

- **OPEN** - Open a subscription to a property
  - `nodepath` (required): Node path (e.g., "/V1/EDID")
  - `property` (required): Property name (e.g., "EdidStatus")

- **MAN** - Get manual/documentation for a property or method
  - `nodepath` (required): Node path (e.g., "/V1/MEDIA/VIDEO/O1")
  - `item` (required): Property or method name (e.g., "Output5VMode")
  - Returns human-readable syntax and usage description

## Installation

```bash
npm install
```

## Usage

### As an MCP Server

Add to your MCP client configuration (e.g., Claude Desktop):

```json
{
  "mcpServers": {
    "lightware": {
      "command": "node",
      "args": ["c:\\Taurus\\mcp-lw3\\src\\index.js"]
    }
  }
}
```

### Example Workflow

1. Connect to a device:
   ```
   Use the "connect" tool with host "192.168.1.100"
   ```

2. Read a property:
   ```
   Use the "GET" tool with property "MEDIA.XP.VIDEO:1.SOURCE"
   ```

3. Set a property:
   ```
   Use the "SET" tool with property "MEDIA.XP.VIDEO:1.SOURCE" and value "2"
   ```

4. Get all properties:
   ```
   Use the "GETALL" tool
   ```

5. Disconnect when done:
   ```
   Use the "disconnect" tool
   ```

## LW3 Protocol

The LW3 protocol is Lightware's text-based control protocol. This server implements:

- Property reading (GET)
- Property writing (SET)
- Bulk property retrieval (GETALL)
- Method execution (CALL)
- Property subscriptions (OPEN)

### Protocol Details

- **Default Port**: 6107
- **Message Format**: Line-based text protocol
- **Response Format**:
  - Property reads: `pr<property>=<value>`
  - Errors: `er<error_code>`

## Project Structure

```
lw3-mcp/
├── src/
│   ├── index.js           # MCP server implementation
│   └── lw3-protocol.js    # LW3 protocol handler
├── package.json
├── README.md
└── CLAUDE.md
```

## Development

Run in development mode with auto-reload:

```bash
npm run dev
```

## Error Handling

The server includes comprehensive error handling:
- Connection errors are reported clearly
- Command timeouts (5 seconds)
- Validates connection state before executing commands
- Graceful cleanup on shutdown

## License

MIT
