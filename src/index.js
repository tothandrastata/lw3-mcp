#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { LW3Protocol } from './lw3-protocol.js';
import { LightwareDiscovery } from './lightware-discovery.js';

/**
 * MCP Server for Lightware LW3 Protocol Gateway
 * Provides persistent connection and tools for interacting with Lightware devices
 */
class LW3MCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'lw3-mcp',
        version: '1.1.0',
      },
      {
        capabilities: {
          tools: {},
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
          name: 'OPEN',
          description: 'Open a subscription to a property on the connected Lightware device',
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
      ],
    }));

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

          case 'OPEN':
            return await this.handleOpen(args);

          case 'MAN':
            return await this.handleMan(args);

          case 'status':
            return await this.handleStatus();

          case 'discover':
            return await this.handleDiscover(args);

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
    const { host, port = 6107, password } = args;

    if (this.lw3.isConnected()) {
      throw new Error('Already connected. Please disconnect first.');
    }

    await this.lw3.connect(host, port, { password });
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

    const result = await this.lw3.getAll(path);

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

  async handleOpen(args) {
    this.ensureConnected();
    const { nodepath, property } = args;

    const fullPath = `${nodepath}.${property}`;
    const response = await this.lw3.open(fullPath);

    return {
      content: [
        {
          type: 'text',
          text: `Subscription opened for "${fullPath}"\nResponse: ${response}`,
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

  async handleStatus() {
    const info = this.lw3.getConnectionInfo();

    if (!info) {
      return {
        content: [
          {
            type: 'text',
            text: 'Status: Not connected',
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Status: Connected\nHost: ${info.host}\nPort: ${info.port}\nTransport: ${info.transport}`,
        },
      ],
    };
  }

  async handleDiscover(args) {
    const { timeout = 3000 } = args;

    const discovery = new LightwareDiscovery();

    try {
      const devices = await discovery.discover(timeout);

      if (devices.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No Lightware devices found on the network',
            },
          ],
        };
      }

      // Format devices as JSON for easy parsing
      const devicesJson = devices.map(device => ({
        modelName: device.modelName,
        serialNumber: device.serialNumber,
        ipAddress: device.ipAddress,
        hostname: device.hostname
      }));

      return {
        content: [
          {
            type: 'text',
            text: `Found ${devices.length} Lightware device(s):\n\n${JSON.stringify(devicesJson, null, 2)}`,
          },
        ],
      };
    } finally {
      discovery.stopDiscovery();
    }
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
    await this.server.connect(transport);
    console.error('MCP LW3 Gateway server running on stdio');
  }
}

// Start the server
const server = new LW3MCPServer();
server.run().catch(console.error);
