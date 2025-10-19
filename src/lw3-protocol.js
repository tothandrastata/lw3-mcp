import net from 'net';
import { EventEmitter } from 'events';

/**
 * LW3 Protocol Handler
 * Handles communication with Lightware devices using the LW3 protocol
 */
export class LW3Protocol extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.connected = false;
    this.host = null;
    this.port = null;
    this.buffer = '';
    this.pendingCommands = new Map();
    this.commandId = 0;
  }

  /**
   * Connect to a Lightware device
   * @param {string} host - Device IP address or hostname
   * @param {number} port - Device port (default: 6107 for LW3)
   * @returns {Promise<void>}
   */
  connect(host, port = 6107) {
    return new Promise((resolve, reject) => {
      if (this.connected) {
        reject(new Error('Already connected to a device'));
        return;
      }

      this.host = host;
      this.port = port;
      this.socket = new net.Socket();

      this.socket.on('connect', () => {
        this.connected = true;
        this.emit('connected', { host, port });
        resolve();
      });

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('error', (error) => {
        this.emit('error', error);
        reject(error);
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.emit('disconnected');
      });

      this.socket.connect(port, host);
    });
  }

  /**
   * Disconnect from the device
   */
  disconnect() {
    return new Promise((resolve) => {
      if (!this.socket) {
        resolve();
        return;
      }

      this.socket.once('close', () => {
        this.socket = null;
        this.connected = false;
        this.buffer = '';
        this.pendingCommands.clear();
        resolve();
      });

      this.socket.end();
    });
  }

  /**
   * Handle incoming data from the device
   * @param {Buffer} data
   */
  handleData(data) {
    this.buffer += data.toString();

    // LW3 protocol uses line-based messages
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.substring(0, newlineIndex).trim();
      this.buffer = this.buffer.substring(newlineIndex + 1);

      if (line.length > 0) {
        this.processResponse(line);
      }
    }
  }

  /**
   * Process a response line from the device
   * @param {string} line
   */
  processResponse(line) {
    // LW3 responses typically follow patterns like:
    // pr <property>=<value>  (read-only property)
    // pw <property>=<value>  (read-write property)
    // m- <method>  (method indicator)
    // mO <method>  (method execution success)
    // mE <method> %E###: error message  (method error)
    // n- <path>  (node/sub-path indicator)
    // pE <property> %E###: error message  (property error)
    // er<error_code>  (general error)

    this.emit('response', line);

    // Resolve pending command if exists
    const firstPending = this.pendingCommands.values().next().value;
    if (firstPending) {
      // For multi-line responses (like GETALL), collect lines
      if (firstPending.collectMultiple) {
        if (line.startsWith('pr ') || line.startsWith('pw ') ||
            line.startsWith('n- ') || line.startsWith('m- ')) {
          // Collect property lines, node lines, and method lines
          firstPending.responses.push(line);
        } else if (line.startsWith('pE ') || line.startsWith('mE ') || line.startsWith('er')) {
          // Error response ends collection
          this.pendingCommands.delete(firstPending.id);
          firstPending.reject(new Error(`Device error: ${line}`));
        }
        // Otherwise ignore other lines and wait for timeout to resolve
      } else {
        // Single-line response
        this.pendingCommands.delete(firstPending.id);

        if (line.startsWith('pE ') || line.startsWith('mE ') || line.startsWith('er')) {
          firstPending.reject(new Error(`Device error: ${line}`));
        } else {
          firstPending.resolve(line);
        }
      }
    }
  }

  /**
   * Send a command to the device
   * @param {string} command
   * @returns {Promise<string>}
   */
  sendCommand(command) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        reject(new Error('Not connected to a device'));
        return;
      }

      const id = this.commandId++;
      this.pendingCommands.set(id, { id, resolve, reject });

      // Add newline if not present
      const cmd = command.endsWith('\n') ? command : command + '\n';

      this.socket.write(cmd, (error) => {
        if (error) {
          this.pendingCommands.delete(id);
          reject(error);
        }
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        if (this.pendingCommands.has(id)) {
          this.pendingCommands.delete(id);
          reject(new Error('Command timeout'));
        }
      }, 5000);
    });
  }

  /**
   * GET command - Read a property value
   * @param {string} property - Property path (e.g., "MEDIA.XP.VIDEO:1.SOURCE")
   * @returns {Promise<string>}
   */
  async get(property) {
    const response = await this.sendCommand(`GET ${property}`);
    // Return raw response from device
    return response;
  }

  /**
   * SET command - Set a property value
   * @param {string} property - Property path
   * @param {string} value - Value to set
   * @returns {Promise<string>}
   */
  async set(property, value) {
    const response = await this.sendCommand(`SET ${property}=${value}`);
    return response;
  }

  /**
   * GETALL command - Get all properties and nodes
   * @param {string} [path] - Optional property path to filter
   * @returns {Promise<{properties: Array, nodes: Array}>}
   */
  async getAll(path = '') {
    const command = path ? `GETALL ${path}` : 'GETALL';

    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        reject(new Error('Not connected to a device'));
        return;
      }

      const id = this.commandId++;
      this.pendingCommands.set(id, {
        id,
        resolve,
        reject,
        collectMultiple: true,
        responses: []
      });

      // Add newline if not present
      const cmd = command.endsWith('\n') ? command : command + '\n';

      this.socket.write(cmd, (error) => {
        if (error) {
          this.pendingCommands.delete(id);
          reject(error);
        }
      });

      // GETALL: Wait 1 second to collect all responses, then parse and resolve
      setTimeout(() => {
        if (this.pendingCommands.has(id)) {
          const pending = this.pendingCommands.get(id);
          this.pendingCommands.delete(id);

          // Parse responses into structured format
          const result = {
            properties: [],
            nodes: [],
            methods: []
          };

          pending.responses.forEach(line => {
            if (line.startsWith('pr ') || line.startsWith('pw ')) {
              // Property: pr /nodepath.property=value or pw /nodepath.property=value
              const writable = line.startsWith('pw ');
              const match = line.match(/^p[rw] (.+?)\.([^=]+)=(.*)$/);
              if (match) {
                result.properties.push({
                  nodepath: match[1],
                  property: match[2],
                  value: match[3],
                  writable: writable
                });
              }
            } else if (line.startsWith('n- ')) {
              // Node: n- /path/node
              const nodePath = line.substring(3);
              result.nodes.push(nodePath);
            } else if (line.startsWith('m- ')) {
              // Method: m- /nodepath:method
              const methodPath = line.substring(3);
              const colonIndex = methodPath.lastIndexOf(':');
              if (colonIndex !== -1) {
                result.methods.push({
                  nodepath: methodPath.substring(0, colonIndex),
                  method: methodPath.substring(colonIndex + 1)
                });
              } else {
                // Fallback if no colon found
                result.methods.push({
                  nodepath: methodPath,
                  method: ''
                });
              }
            }
          });

          resolve(result);
        }
      }, 1000);
    });
  }

  /**
   * CALL command - Execute a method
   * @param {string} method - Method path
   * @param {string[]} [params] - Optional parameters
   * @returns {Promise<string>}
   */
  async call(method, params = []) {
    const paramsStr = params.length > 0 ? ` ${params.join(' ')}` : '';
    const response = await this.sendCommand(`CALL ${method}${paramsStr}`);
    return response;
  }

  /**
   * OPEN command - Open a subscription
   * @param {string} property - Property path to subscribe to
   * @returns {Promise<string>}
   */
  async open(property) {
    const response = await this.sendCommand(`OPEN ${property}`);
    return response;
  }

  /**
   * MAN command - Get manual/documentation for a property, node, or method
   * @param {string} path - Path to get manual for
   * @returns {Promise<string>}
   */
  async man(path) {
    const response = await this.sendCommand(`MAN ${path}`);
    return response;
  }

  /**
   * GETROOT command - Get root structure using GETALL /V1/*
   * @returns {Promise<{properties: Array, nodes: Array, methods: Array}>}
   */
  async getRoot() {
    return await this.getAll('/V1/*');
  }

  /**
   * Check if connected
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Get connection info
   * @returns {object|null}
   */
  getConnectionInfo() {
    if (!this.connected) {
      return null;
    }
    return {
      host: this.host,
      port: this.port,
      connected: this.connected
    };
  }
}
