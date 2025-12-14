# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LW3 MCP** is an MCP (Model Context Protocol) server that provides a gateway to Lightware devices using the LW3 protocol. It maintains a persistent connection to a Lightware device throughout the MCP session.

## Architecture

### Key Components

- **[src/index.js](src/index.js)**: Main MCP server implementation
  - Handles MCP tool registration and requests
  - Manages the persistent LW3 connection
  - Implements 11 MCP tools with separated nodepath/property parameters

- **[src/lw3-protocol.js](src/lw3-protocol.js)**: LW3 protocol handler
  - Manages TCP socket connection to Lightware devices (default port 6107)
  - Implements LW3 command/response protocol
  - Handles line-based message parsing
  - Manages command queue with timeouts
  - Parses and structures GETALL responses

- **[src/lightware-discovery.js](src/lightware-discovery.js)**: mDNS device discovery
  - Discovers Lightware devices on the local network using multicast DNS
  - Queries for common Lightware service types (_lwr3, _lara-https, _webldc-http, _rest-http)
  - Extracts device information (model name, serial number, IP address, hostname)
  - Based on POC implementation from lara-builder/ai-agent-app/poc/mdns-discovery

### Design Patterns

- **Persistent Connection**: Single TCP connection per MCP session, maintained in the LW3Protocol instance
- **Event-Driven**: Uses EventEmitter for connection lifecycle events
- **Promise-Based**: All async operations return promises for clean error handling
- **Command Queue**: Maps pending commands to handle async responses
- **Separated Parameters**: All tools use separate `nodepath` and `property/method` parameters for clarity

## Available MCP Tools

### Device Discovery

1. **discover** - Discover Lightware devices on the local network
   - Parameters: `timeout` (optional, default: 3000ms)
   - Returns: JSON array of discovered devices with modelName, serialNumber, ipAddress, hostname
   - Uses mDNS to find devices advertising Lightware service types

### Connection Management

2. **connect** - Establish connection to a Lightware device
   - Parameters: `host` (required), `port` (optional, default: 6107)

3. **disconnect** - Close connection to the device
   - Parameters: none

4. **status** - Get current connection status
   - Parameters: none
   - Returns: connection info (host, port, connected status)

### LW3 Protocol Commands

All commands use **separated parameters** for better usability:

5. **GET** - Read a property value
   - Parameters:
     - `nodepath` (required): e.g., `/V1/EDID`
     - `property` (required): e.g., `EdidStatus`
   - Constructs: `GET /V1/EDID.EdidStatus`

6. **SET** - Set a property value
   - Parameters:
     - `nodepath` (required): e.g., `/V1/MANAGEMENT/NETWORK`
     - `property` (required): e.g., `HostName`
     - `value` (required): e.g., `jimmy-hc40`
   - Constructs: `SET /V1/MANAGEMENT/NETWORK.HostName=jimmy-hc40`

7. **GETALL** - Get all child nodes, properties, and methods of a node
   - Parameters:
     - `path` (required): node path, e.g., `/V1/MANAGEMENT/NETWORK`
   - Returns: Structured JSON with separated nodepath/property fields
   - Timeout: 1 second to collect all responses

8. **GETROOT** - Get root structure (convenience wrapper for GETALL /V1/*)
   - Parameters: none
   - Returns: Same structured JSON as GETALL

9. **CALL** - Execute a method
   - Parameters:
     - `nodepath` (required): e.g., `/V1/EDID`
     - `method` (required): e.g., `switchAll`
     - `params` (optional): e.g., `F49`
   - Constructs: `CALL /V1/EDID:switchAll(F49)`

10. **OPEN** - Open a subscription to a property
    - Parameters:
      - `nodepath` (required): e.g., `/V1/EDID`
      - `property` (required): e.g., `EdidStatus`
    - Constructs: `OPEN /V1/EDID.EdidStatus`

11. **MAN** - Get manual/documentation
    - Parameters:
      - `nodepath` (required): e.g., `/V1/MEDIA/VIDEO/O1`
      - `item` (required): property or method name, e.g., `Output5VMode`
    - Constructs: `MAN /V1/MEDIA/VIDEO/O1.Output5VMode`

## LW3 Protocol Details

### Protocol Basics
- **Port**: 6107 (default)
- **Format**: Line-based text protocol
- **Encoding**: UTF-8
- **Line Terminator**: `\n`

### Command Format (as sent to device)
- GET: `GET <nodepath.property>` (e.g., `/V1/EDID.EdidStatus`)
- SET: `SET <nodepath.property>=<value>` (e.g., `/V1/MANAGEMENT/NETWORK.HostName=jimmy-hc40`)
- GETALL: `GETALL <nodepath>` (e.g., `/V1/MANAGEMENT/NETWORK`)
- CALL: `CALL <nodepath:method(params)>` (e.g., `/V1/EDID:switchAll(F49)`)
- OPEN: `OPEN <nodepath.property>` (e.g., `/V1/EDID.EdidStatus`)
- MAN: `MAN <nodepath.property>` (e.g., `/V1/MEDIA/VIDEO/O1.Output5VMode`)

### Response Format
- **Read-only property**: `pr <property>=<value>`
- **Read-write property**: `pw <property>=<value>`
- **Method indicator (in GETALL)**: `m- <method>`
- **Method execution success**: `mO <nodepath:method>` (CALL response)
- **Method error**: `mE <method> %E###: error message` (CALL error)
- **Node indicator (in GETALL)**: `n- <path>`
- **Property error**: `pE <property> %E###: error message`
- **General error**: `er<error_code>`

### GETALL/GETROOT Response Structure

Returns structured JSON with **separated nodepath and property/method names**:

```json
{
  "properties": [
    {
      "nodepath": "/V1/MANAGEMENT/NETWORK",
      "property": "HostName",
      "value": "jimmy-hc40",
      "writable": true
    },
    {
      "nodepath": "/V1/MANAGEMENT/NETWORK",
      "property": "IpAddress",
      "value": "192.168.2.109",
      "writable": false
    }
  ],
  "nodes": [
    "/V1/MANAGEMENT/NETWORK/AUTH",
    "/V1/MANAGEMENT/NETWORK/SERVICES"
  ],
  "methods": [
    {
      "nodepath": "/V1/MANAGEMENT/NETWORK",
      "method": "applySettings"
    }
  ]
}
```

**Benefits of separated structure:**
- Property values can be directly used as GET/SET/OPEN parameters
- Method values can be directly used as CALL parameters
- No need to parse paths manually

### Timeouts
- **Standard commands**: 5 seconds (GET, SET, CALL, OPEN, MAN)
- **GETALL/GETROOT**: 1 second (to collect multiple responses)

## Development Workflow

### Installation
```bash
npm install
```

### Running the Server
```bash
npm start
```

### Development Mode (with auto-reload)
```bash
npm run dev
```

### Testing with MCP Inspector
```bash
npx @modelcontextprotocol/inspector node src/index.js
```

### Using with Claude Desktop

Add to your Claude Desktop MCP configuration:
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

## Example Usage Flow

1. **Discover devices on the network:**
   ```
   Tool: discover
   Parameters: { "timeout": 3000 }
   Returns: [
     {
       "modelName": "UCX-4x3-HC40",
       "serialNumber": "D4349200",
       "ipAddress": "192.168.2.109",
       "hostname": "jimmy-hc40.local"
     },
     ...
   ]
   ```

2. **Connect to device:**
   ```
   Tool: connect
   Parameters: { "host": "jimmy-hc40.local" }
   ```

3. **Get root structure:**
   ```
   Tool: GETROOT
   Parameters: {}
   Returns: JSON with all root properties, nodes, and methods
   ```

4. **Read a property:**
   ```
   Tool: GET
   Parameters: { "nodepath": "/V1/EDID", "property": "EdidStatus" }
   Returns: "D1:E1;D1:E2;D1:E3;D1:E4"
   ```

5. **Set a property:**
   ```
   Tool: SET
   Parameters: {
     "nodepath": "/V1/MANAGEMENT/NETWORK",
     "property": "HostName",
     "value": "jimmy-hc40"
   }
   ```

6. **Call a method:**
   ```
   Tool: CALL
   Parameters: {
     "nodepath": "/V1/EDID",
     "method": "switchAll",
     "params": "F49"
   }
   Constructs: CALL /V1/EDID:switchAll(F49)
   ```

7. **Get documentation:**
   ```
   Tool: MAN
   Parameters: {
     "nodepath": "/V1/MEDIA/VIDEO/O1",
     "item": "Output5VMode"
   }
   Returns: Manual text describing the property
   ```

## Error Handling

The server handles multiple error types from the LW3 protocol:
- **Property errors** (`pE`): Invalid property access, non-existent properties
- **Method errors** (`mE`): Invalid method calls, invalid parameters
- **General errors** (`er`): Protocol-level errors

All errors are returned as error messages to the MCP client.

## Important Files

- **[package.json](package.json)**: Project metadata, name is `lw3-mcp`
- **[.gitignore](.gitignore)**: Excludes node_modules and logs
- **[test-connection.js](test-connection.js)**: Test script for direct LW3 protocol testing

## Conventions

- **ES6 modules**: Uses `type: "module"` in package.json
- **Error logging**: Errors logged to stderr
- **Connection lifecycle**: Connection maintained throughout MCP session, clean disconnection on SIGINT
- **Separated parameters**: All tools use separate nodepath/property parameters for clarity
- **Path separators**:
  - Properties use `.` (dot): `nodepath.property`
  - Methods use `:` (colon): `nodepath:method`
