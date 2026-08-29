#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { LW3Protocol, parseGetAll } from './lw3-protocol.js';
import { LightwareDiscovery } from './lightware-discovery.js';
import { buildGrid, renderGridText, XP_NODE, VIDEO_NODE } from './xpoint.js';
import { buildUniversalGrid, renderUniversalGridText } from './univ-xpoint.js';

// The resource URI the xpoint tool points hosts at, and hosts fetch. Shared
// between the ListResources/ReadResource handlers and the tool's own _meta so
// there is exactly one string to keep in sync.
// Deliberately NOT 'ui://lw3-mcp/xpoint'. That URI was first published by
// 1.6.0, which had not yet declared the io.modelcontextprotocol/ui capability,
// so the host saw it as an ordinary resource. It has never rendered since --
// through eight releases, every change of content, size and result shape --
// while every freshly named probe URI rendered on its first use. That pattern
// is a host-side cache keyed by URI, and a new name is the only way past it.
const XPOINT_UI = 'ui://lw3-mcp/xpoint-panel-v2';

// The universal panel, served to univ_xpoint. A separate URI because a ui://
// URI is cached by the host from its first use and cannot be repurposed.
const UNIV_XPOINT_UI = 'ui://lw3-mcp/univ-xpoint-v1';


/**
 * MCP Server for Lightware LW3 Protocol Gateway
 * Provides persistent connection and tools for interacting with Lightware devices
 */
class LW3MCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'lw3-mcp',
        version: '1.12.1',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          // Without this the host treats ui://lw3-mcp/xpoint as an ordinary
          // resource and renders the tool's text instead of the panel. The
          // ui:// resource and the tool's _meta.ui are not enough on their
          // own — the extension has to be negotiated here, at initialize.
          // Shape per the MCP Apps spec, 2026-01-26.
          extensions: {
            'io.modelcontextprotocol/ui': {
              mimeTypes: ['text/html;profile=mcp-app'],
            },
          },
        },
      }
    );

    // Persistent LW3 connection
    this.lw3 = new LW3Protocol();

    // Setup error handling
    this.setupErrorHandlers();

    // Setup request handlers
    this.setupHandlers();
  }

  setupErrorHandlers() {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });

    this.lw3.on('error', (error) => {
      console.error('[LW3 Error]', error);
    });

    this.lw3.on('disconnected', () => {
      console.error('[LW3] Device disconnected');
    });
  }

  setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'connect',
          description: 'Connect to a Lightware device using LW3 protocol',
          inputSchema: {
            type: 'object',
            properties: {
              host: {
                type: 'string',
                description: 'Device IP address or hostname',
              },
              port: {
                type: 'number',
                description: 'Device port (default: 6107)',
                default: 6107,
              },
              password: {
                type: 'string',
                description:
                  'Admin password. Only needed if the device requires authentication — connect will tell you when it does.',
              },
              transport: {
                type: 'string',
                enum: ['auto', 'wss'],
                description:
                  'Leave unset. "wss" skips the TCP attempt for a device already known to answer only over secure WebSocket — a plain TCP connect to port 443 succeeds against any HTTPS listener and would be mistaken for an LW3 session.',
              },
            },
            required: ['host'],
          },
        },
        {
          name: 'disconnect',
          description: 'Disconnect from the current Lightware device',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'GET',
          description: 'Read a property value from the connected Lightware device',
          inputSchema: {
            type: 'object',
            properties: {
              nodepath: {
                type: 'string',
                description: 'Node path (e.g., "/V1/EDID")',
              },
              property: {
                type: 'string',
                description: 'Property name (e.g., "EdidStatus")',
              },
            },
            required: ['nodepath', 'property'],
          },
        },
        {
          name: 'SET',
          description: 'Set a property value on the connected Lightware device',
          inputSchema: {
            type: 'object',
            properties: {
              nodepath: {
                type: 'string',
                description: 'Node path (e.g., "/V1/MANAGEMENT/NETWORK")',
              },
              property: {
                type: 'string',
                description: 'Property name (e.g., "HostName")',
              },
              value: {
                type: 'string',
                description: 'Value to set',
              },
            },
            required: ['nodepath', 'property', 'value'],
          },
        },
        {
          name: 'GETALL',
          description: 'Get all child nodes, properties and methods of a node',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Node path (required, e.g., "/V1/MANAGEMENT/NETWORK")',
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'GETROOT',
          description: 'Get root structure of the device (equivalent to GETALL /V1/*)',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'CALL',
          description: 'Execute a method on the connected Lightware device',
          inputSchema: {
            type: 'object',
            properties: {
              nodepath: {
                type: 'string',
                description: 'Node path (e.g., "/V1/EDID")',
              },
              method: {
                type: 'string',
                description: 'Method name (e.g., "switchAll" or "applySettings")',
              },
              params: {
                type: 'string',
                description: 'Optional method parameters (e.g., "F49" for switchAll(F49))',
              },
            },
            required: ['nodepath', 'method'],
          },
        },
        {
          name: 'MAN',
          description: 'Get manual/documentation for a property or method',
          inputSchema: {
            type: 'object',
            properties: {
              nodepath: {
                type: 'string',
                description: 'Node path (e.g., "/V1/MEDIA/VIDEO/O1")',
              },
              item: {
                type: 'string',
                description: 'Property or method name (e.g., "Output5VMode" or "applySettings")',
              },
            },
            required: ['nodepath', 'item'],
          },
        },
        {
          name: 'status',
          description: 'Get the current connection status',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'discover',
          description: 'Discover Lightware devices on the local network using mDNS',
          inputSchema: {
            type: 'object',
            properties: {
              timeout: {
                type: 'number',
                description: 'Discovery timeout in milliseconds (default: 3000)',
                default: 3000,
              },
            },
          },
        },
        {
          name: 'univ_xpoint',
          description:
            'Show the crosspoint of any supported device family, detecting the routing dialect from what the device publishes. Use this for TPN-MMU and other non-I1/O1 devices; xpoint remains for the I1/O1 family.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
          _meta: { ui: { resourceUri: UNIV_XPOINT_UI } },
        },
        {
          name: 'xpoint',
          description:
            'Show the video crosspoint: which source is routed to each destination, and which sources each destination can switch to',
          inputSchema: {
            type: 'object',
            properties: {},
          },
          _meta: { ui: { resourceUri: XPOINT_UI } },
        },
      ],
    }));

    // Serve the crosspoint panel to hosts that support the MCP Apps UI
    // extension. Read from disk on every request rather than cached at
    // startup, so the bundle's on-disk HTML is always what gets served.
    const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
    const uiPath = join(uiDir, 'xpoint.html');
    const univPath = join(uiDir, 'univ-xpoint.html');

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      // Kept on one line: tests/manifest.test.js counts registered *tools* by
      // matching a 10-space-indented `name: '...'`, and this resource's own
      // `name` field would otherwise land at that same indent and be
      // miscounted as a 12th tool.
      resources: [
        { uri: XPOINT_UI, name: 'Crosspoint panel', mimeType: 'text/html;profile=mcp-app' },
        { uri: UNIV_XPOINT_UI, name: 'Crosspoint panel (all families)', mimeType: 'text/html;profile=mcp-app' },
      ],
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const files = { [XPOINT_UI]: uiPath, [UNIV_XPOINT_UI]: univPath };
      const file = files[request.params.uri];
      if (!file) {
        throw new Error(`Unknown resource: ${request.params.uri}`);
      }
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: 'text/html;profile=mcp-app',
            text: readFileSync(file, 'utf8'),
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'connect':
            return await this.handleConnect(args);

          case 'disconnect':
            return await this.handleDisconnect();

          case 'GET':
            return await this.handleGet(args);

          case 'SET':
            return await this.handleSet(args);

          case 'GETALL':
            return await this.handleGetAll(args);

          case 'GETROOT':
            return await this.handleGetRoot();

          case 'CALL':
            return await this.handleCall(args);

          case 'MAN':
            return await this.handleMan(args);

          case 'status':
            return await this.handleStatus();

          case 'discover':
            return await this.handleDiscover(args);

          case 'univ_xpoint':
            return await this.handleUniversalXpoint();

          case 'xpoint':
            return await this.handleXpoint();

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`,
            },
          ],
        };
      }
    });
  }

  async handleConnect(args) {
    const { host, port = 6107, password, transport } = args;

    if (this.lw3.isConnected()) {
      throw new Error('Already connected. Please disconnect first.');
    }

    await this.lw3.connect(host, port, { password, transport });
    const info = this.lw3.getConnectionInfo();

    return {
      content: [
        {
          type: 'text',
          text: `Successfully connected to ${info.host}:${info.port} over ${info.transport}`,
        },
      ],
    };
  }

  async handleDisconnect() {
    if (!this.lw3.isConnected()) {
      throw new Error('Not connected to any device');
    }

    await this.lw3.disconnect();

    return {
      content: [
        {
          type: 'text',
          text: 'Successfully disconnected',
        },
      ],
    };
  }

  async handleGet(args) {
    this.ensureConnected();
    const { nodepath, property } = args;

    const fullPath = `${nodepath}.${property}`;
    const value = await this.lw3.get(fullPath);

    return {
      content: [
        {
          type: 'text',
          text: `Property "${fullPath}" = ${value}`,
        },
      ],
    };
  }

  async handleSet(args) {
    this.ensureConnected();
    const { nodepath, property, value } = args;

    const fullPath = `${nodepath}.${property}`;
    const response = await this.lw3.set(fullPath, value);

    return {
      content: [
        {
          type: 'text',
          text: `Set "${fullPath}" = ${value}\nResponse: ${response}`,
        },
      ],
    };
  }

  async handleGetAll(args) {
    this.ensureConnected();
    const { path } = args;

    if (!path) {
      throw new Error('Node path is required for GETALL. Use GETROOT to get the root structure.');
    }

    // A trailing /* asks for the children's contents. Devices differ on whether
    // they accept the syntax (the Taurus emulator does not), so route it through
    // getAllDeep, which falls back to enumerating the children. Callers -- the
    // crosspoint panel among them -- then get the same answer from either.
    const result = path.endsWith('/*')
      ? parseGetAll(await this.lw3.getAllDeep(path.slice(0, -2)))
      : await this.lw3.getAll(path);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  async handleGetRoot() {
    this.ensureConnected();

    const result = await this.lw3.getRoot();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  async handleCall(args) {
    this.ensureConnected();
    const { nodepath, method, params } = args;

    // Construct method with parameters if provided
    // e.g., switchAll + F49 -> switchAll(F49)
    // Always include parentheses for method calls
    const methodWithParams = params ? `${method}(${params})` : `${method}()`;

    // Construct full path: /V1/EDID:switchAll(F49) or /V1/EDID:methodName()
    const fullPath = `${nodepath}:${methodWithParams}`;
    const response = await this.lw3.call(fullPath, []);

    return {
      content: [
        {
          type: 'text',
          text: `Method "${fullPath}" called\nResponse: ${response}`,
        },
      ],
    };
  }

  async handleMan(args) {
    this.ensureConnected();
    const { nodepath, item } = args;

    // Construct full path with property/method name
    const fullPath = `${nodepath}.${item}`;
    const response = await this.lw3.man(fullPath);

    return {
      content: [
        {
          type: 'text',
          text: response,
        },
      ],
    };
  }

  /**
   * What the MCP client declared about itself at initialize.
   *
   * Reported here rather than logged because some Claude Desktop builds write no
   * MCP server logs at all, which makes stderr an unreadable channel. A tool
   * response is the only place this is reliably visible.
   *
   * `clientInit` holds the raw initialize params rather than
   * server.getClientCapabilities(), which exposes only params.capabilities — an
   * extension advertised in a sibling field would be invisible to it.
   */
  /**
   * Whether the connected host negotiated the MCP Apps extension.
   *
   * The same test describeClient() reports, hoisted out because it now decides
   * what the xpoint tool puts into the conversation, not just what status says.
   */
  hostRendersApps() {
    return this.clientInit
      ? JSON.stringify(this.clientInit).includes('modelcontextprotocol/ui')
      : false;
  }

  describeClient() {
    const params = this.clientInit;
    if (!params) return 'Client: not recorded';

    const client = params.clientInfo || {};
    const name = [client.name, client.version].filter(Boolean).join(' ') || 'unnamed';
    const declared = Object.keys(params.capabilities || {});

    // The MCP Apps extension is advertised at initialize; the spec does not
    // guarantee where, so search the whole params object rather than one field.
    const ui = this.hostRendersApps() ? 'yes' : 'no';

    // Unmistakably headed, because it previously was not: a reader saw the client
    // name and capability list directly under the device status and concluded the
    // gateway had connected to some other local MCP process rather than a device.
    // The raw initialize params were the worst of it -- a JSON blob that reads
    // like a device banner -- so they are gone. Nothing here describes the device.
    return [
      '--- MCP host this gateway runs under (nothing here describes the device) ---',
      `Host application: ${name}`,
      `MCP protocol: ${params.protocolVersion || 'unstated'}`,
      `Host capabilities: ${declared.length ? declared.join(', ') : 'none declared'}`,
      `Renders MCP Apps panels: ${ui}`,
    ].join('\n');
  }

  async handleStatus() {
    const info = this.lw3.getConnectionInfo();

    const device = info
      ? `Status: Connected\nHost: ${info.host}\nPort: ${info.port}\nTransport: ${info.transport}`
      : 'Status: Not connected';

    return {
      content: [
        {
          type: 'text',
          text: `${device}\n\n${this.describeClient()}`,
        },
      ],
    };
  }

  async handleDiscover(args) {
    const { timeout = 3000 } = args;

    const discovery = new LightwareDiscovery();

    try {
      const devices = await discovery.discover(timeout);

      // An entry with neither ipAddress nor hostname gives `connect` nothing to
      // dial, so it must not be listed alongside devices that are actually
      // usable. It's still counted, just separately, so the total stays honest.
      const connectable = devices.filter((device) => device.ipAddress || device.hostname);
      const unresolvedCount = devices.length - connectable.length;

      if (connectable.length === 0) {
        const text =
          unresolvedCount > 0
            ? `No connectable Lightware devices found on the network ` +
              `(${unresolvedCount} device(s) detected but not resolved to an address or hostname within the timeout)`
            : 'No Lightware devices found on the network';
        return {
          content: [
            {
              type: 'text',
              text,
            },
          ],
        };
      }

      // Format devices as JSON for easy parsing
      const devicesJson = connectable.map(device => ({
        modelName: device.modelName,
        serialNumber: device.serialNumber,
        ipAddress: device.ipAddress,
        hostname: device.hostname
      }));

      let text = `Found ${connectable.length} Lightware device(s):\n\n${JSON.stringify(devicesJson, null, 2)}`;
      if (unresolvedCount > 0) {
        text += `\n\n(${unresolvedCount} additional device(s) detected but not resolved to an address or hostname within the timeout; not listed above.)`;
      }

      return {
        content: [
          {
            type: 'text',
            text,
          },
        ],
      };
    } finally {
      discovery.stopDiscovery();
    }
  }

  /**
   * Crosspoint for any supported device family.
   *
   * Deliberately separate from handleXpoint: that tool is in use against the
   * I1/O1 family and must not change behaviour. This one detects the routing
   * dialect from what the device publishes, so it works for TPN-MMU (ports
   * named after their stream, routing in SourceStream) as well.
   */
  async handleUniversalXpoint() {
    this.ensureConnected();

    let xpLines;
    try {
      xpLines = await this.lw3.getAllDeep(XP_NODE);
    } catch (error) {
      throw new Error(
        `Could not read the crosspoint at ${XP_NODE} — ${error.message}. ` +
          'This device may not have a video crosspoint, or may use a different node layout.'
      );
    }

    // SWITCHABLE is a child node per destination, so which destinations exist
    // has to be settled first -- and that is dialect-dependent, which is why the
    // grid is built twice rather than the ports guessed from their names.
    const provisional = buildUniversalGrid({ xpLines, switchableLines: [] });

    const switchableLines = [];
    const switchableErrors = [];
    for (const destination of provisional.destinations) {
      try {
        switchableLines.push(
          ...(await this.lw3.sendCommand(`GETALL ${XP_NODE}/${destination.port}/SWITCHABLE`))
        );
      } catch (error) {
        // A device without SWITCHABLE is normal, not a failure: buildUniversalGrid
        // treats a destination that published none as unrestricted.
        console.error(`[univ_xpoint] no SWITCHABLE for ${destination.port}:`, error.message);
        switchableErrors.push(`${destination.port}: ${error.message}`);
      }
    }

    const grid = buildUniversalGrid({ xpLines, switchableLines });

    const text = this.hostRendersApps()
      ? `Crosspoint panel opened (device family: ${grid.dialect || 'unrecognised'}). It shows ` +
        'the current routing, stays up to date, and switches when a cell is clicked. Do not ' +
        'restate the routing: it changes as the user clicks and any summary here goes stale.'
      : renderUniversalGridText(grid);

    return {
      content: [{ type: 'text', text }],
      structuredContent: { ...grid, connection: this.lw3.getConnectionInfo() },
      _meta: { ui: { resourceUri: UNIV_XPOINT_UI } },
    };
  }

  async handleXpoint() {
    this.ensureConnected();

    let xpLines;
    try {
      xpLines = await this.lw3.getAllDeep(XP_NODE);
    } catch (error) {
      throw new Error(
        `Could not read the video crosspoint at ${XP_NODE} — ${error.message}. ` +
          'This device may not have a video crosspoint, or may use a different node layout.'
      );
    }

    const videoLines = await this.lw3.getAllDeep(VIDEO_NODE);

    // SWITCHABLE is a child node per destination, so it needs one call each. A
    // timeout or a missing SWITCHABLE child on one destination must not cost the
    // caller the routing and port names already read successfully, so each read
    // is caught individually — buildGrid treats a destination with no switchable
    // data as unread (not as a device refusal), and renderGridText reports that
    // honestly rather than as a wall of failed cells.
    const destinations = [...new Set(
      xpLines.map((l) => l.match(/\/XP\/(O\d+)[./]/)?.[1]).filter(Boolean)
    )];
    const switchableLines = [];
    const switchableErrors = [];
    for (const port of destinations) {
      try {
        switchableLines.push(...(await this.lw3.sendCommand(`GETALL ${XP_NODE}/${port}/SWITCHABLE`)));
      } catch (error) {
        console.error(`[xpoint] Could not read SWITCHABLE for ${port}:`, error.message);
        switchableErrors.push(`${port}: ${error.message}`);
      }
    }

    const grid = buildGrid({ xpLines, videoLines, switchableLines });

    // The text rendering is the fallback for hosts that cannot draw the panel.
    // Where the panel does draw, this text is a snapshot taken now while the
    // panel goes on updating as the user clicks, so within a click or two the
    // conversation is describing routing that is no longer current -- in more
    // detail, and more confidently, than the panel it sits under. Say only what
    // stays true and let the panel speak for the routing.
    let text = this.hostRendersApps()
      ? 'Video crosspoint panel opened. It shows the current routing, stays up to ' +
        'date as it changes, and switches when a cell is clicked. Do not restate ' +
        'the routing: it changes as the user clicks and any summary here goes stale.'
      : renderGridText(grid);

    if (switchableErrors.length) {
      text +=
        `\n\nCould not read switchability for ${switchableErrors.length} destination(s) ` +
        '(reported above as "could not be read"):\n' +
        switchableErrors.map((e) => `  ${e}`).join('\n');
    }

    return {
      content: [{ type: 'text', text }],
      // The panel renders from this. It cannot fetch its own data: app-initiated
      // tool calls do not reach the server instance holding the LW3 connection,
      // so a panel that polled would show "Not connected" while the chat beside
      // it was connected. The host hands this straight to the view.
      //
      // The address travels with it so the panel's own instance can open its
      // own connection and perform switches directly. No password is included,
      // and none should be: the panel runs in a sandboxed frame and an admin
      // password does not belong there. A device that demands one simply falls
      // back to asking the conversation.
      structuredContent: { ...grid, connection: this.lw3.getConnectionInfo() },
      _meta: { ui: { resourceUri: XPOINT_UI } },
    };
  }

  ensureConnected() {
    if (!this.lw3.isConnected()) {
      throw new Error('Not connected to a device. Use the "connect" tool first.');
    }
  }

  async cleanup() {
    if (this.lw3.isConnected()) {
      await this.lw3.disconnect();
    }
  }

  async run() {
    const transport = new StdioServerTransport();

    // Record the client's initialize params so `status` can report which host we
    // are talking to and what it supports. Installed as a property setter before
    // connect() rather than wrapping transport.onmessage afterwards: connect()
    // calls transport.start(), which begins reading stdin, so a wrap applied
    // after it races the very first message — which is initialize, the only one
    // this cares about.
    let handler;
    Object.defineProperty(transport, 'onmessage', {
      configurable: true,
      get: () => handler,
      set: (fn) => {
        handler = (message, extra) => {
          if (message?.method === 'initialize') this.clientInit = message.params;
          fn?.(message, extra);
        };
      },
    });

    await this.server.connect(transport);
    console.error('MCP LW3 Gateway server running on stdio');
  }
}

// Start the server
const server = new LW3MCPServer();
server.run().catch(console.error);
