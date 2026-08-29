import { EventEmitter } from 'node:events';
import { TcpTransport } from './transports/tcp.js';
import { WssTransport, AuthRequiredError } from './transports/wss.js';

/** How long to wait for a reply block to close before giving up. */
export const COMMAND_TIMEOUT_MS = 5000;

/** Any device error carries this marker, whatever its prefix: pE, mE, -E. */
const DEVICE_ERROR = /%E\d+:/;

/**
 * A bare general-error line, e.g. `er 3` or `er003` — no `%E` marker of its own.
 * Anchored at the start of the line, and requires the character right after
 * `er` to be a digit or whitespace, so a property or value that merely starts
 * with those two letters (`error`, `ergonomic`, `ErrorCount`) is not mistaken
 * for one.
 */
const GENERAL_ERROR = /^er[\s\d]/;

/** True if a reply line reports a device error, by either shape. */
function isErrorLine(line) {
  return DEVICE_ERROR.test(line) || GENERAL_ERROR.test(line);
}

/**
 * Turn the lines of a GETALL reply into structured form.
 * Lifted verbatim out of getAll's timer callback; the parsing itself is unchanged.
 */
export function parseGetAll(lines) {
  const result = { properties: [], nodes: [], methods: [] };

  lines.forEach((line) => {
    if (line.startsWith('pr ') || line.startsWith('pw ')) {
      const writable = line.startsWith('pw ');
      const match = line.match(/^p[rw] (.+?)\.([^=]+)=(.*)$/);
      if (match) {
        result.properties.push({
          nodepath: match[1],
          property: match[2],
          value: match[3],
          writable: writable,
        });
      }
    } else if (line.startsWith('n- ')) {
      result.nodes.push(line.substring(3));
    } else if (line.startsWith('m- ')) {
      const methodPath = line.substring(3);
      const colonIndex = methodPath.lastIndexOf(':');
      if (colonIndex !== -1) {
        result.methods.push({
          nodepath: methodPath.substring(0, colonIndex),
          method: methodPath.substring(colonIndex + 1),
        });
      } else {
        result.methods.push({ nodepath: methodPath, method: '' });
      }
    }
  });

  return result;
}

/**
 * LW3 Protocol Handler
 * Handles communication with Lightware devices using the LW3 protocol
 */
export class LW3Protocol extends EventEmitter {
  /**
   * @param {object} [factories] - transport constructors, injectable for tests
   */
  constructor(factories = {}) {
    super();
    this.createTcp = factories.createTcp || ((host, port) => new TcpTransport(host, port));
    this.createWss = factories.createWss || ((host, password) => new WssTransport(host, password));
    this.transport = null;
    this.transportKind = null;
    this.connected = false;
    this.host = null;
    this.port = null;
    this.buffer = '';
    // Keyed by signature. Each entry: { signature, resolve, reject, lines, timer }
    this.pendingCommands = new Map();
    this.commandId = 0;
    // Signature of the reply block currently being received, or null between blocks.
    this.currentBlock = null;
  }

  /**
   * Connect to a device: TCP first, secure WebSocket as a fallback.
   * @param {string} host
   * @param {number} [port] - TCP port, default 6107
   * @param {{password?: string}} [options] - admin password, if the device requires one
   */
  async connect(host, port = 6107, options = {}) {
    if (this.connected) throw new Error('Already connected to a device');

    // A caller that already knows how this device answers can say so. It matters
    // for wss: getConnectionInfo() reports port 443, and a plain TCP connect to
    // 443 SUCCEEDS on any device serving HTTPS -- so the probe below would treat
    // a TLS listener as an LW3 session and every command would time out against
    // it. Skipping straight to wss also saves the TCP timeout on reconnects.
    if (options.transport === 'wss') {
      const known = this.createWss(host, options.password);
      await known.connect();
      this.attachTransport(known, 'wss', host, 443);
      return;
    }

    let tcpFailure;
    const tcp = this.createTcp(host, port);
    try {
      await tcp.connect();
      this.attachTransport(tcp, 'tcp', host, port);
      return;
    } catch (error) {
      tcpFailure = error;
    }

    const wss = this.createWss(host, options.password);
    try {
      await wss.connect();
      this.attachTransport(wss, 'wss', host, 443);
      return;
    } catch (error) {
      // An auth challenge is actionable on its own: the caller asks the user
      // for a password. Burying it in a combined message would hide that.
      if (error instanceof AuthRequiredError || error.name === 'AuthRequiredError') throw error;
      throw new Error(
        `Could not connect to ${host}.\n` +
          `  TCP: ${tcpFailure.message}\n` +
          `  WSS: ${error.message}`
      );
    }
  }

  /**
   * Wire a connected transport into the protocol layer.
   */
  attachTransport(transport, kind, host, port) {
    this.transport = transport;
    this.transportKind = kind;
    this.host = host;
    this.port = port;
    this.connected = true;

    transport.on('data', (chunk) => this.handleData(chunk));
    transport.on('error', (error) => this.emit('error', error));
    transport.on('close', () => {
      this.connected = false;
      this.emit('disconnected');
    });

    this.emit('connected', { host, port, transport: kind });
  }

  /**
   * Disconnect from the device
   */
  async disconnect() {
    if (!this.transport) return;
    await this.transport.close();
    this.transport = null;
    this.transportKind = null;
    this.connected = false;
    this.buffer = '';
    this.currentBlock = null;

    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Connection closed while command was in flight: ${pending.signature}`));
    }
    this.pendingCommands.clear();
  }

  /**
   * Buffer incoming text and split it into LW3 lines.
   * Lines arrive `\r\n`-terminated over WSS and `\n`-terminated over TCP;
   * trim() absorbs the difference.
   * @param {string} chunk
   */
  handleData(chunk) {
    this.buffer += chunk;

    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.substring(0, newlineIndex).trim();
      this.buffer = this.buffer.substring(newlineIndex + 1);

      if (line.length > 0) {
        this.processResponse(line);
      }
    }
  }

  /** Next 4-hex-digit command signature, wrapping at 0xFFFF. */
  nextSignature() {
    const signature = this.commandId.toString(16).padStart(4, '0').toUpperCase();
    this.commandId = (this.commandId + 1) & 0xffff;
    return signature;
  }

  /**
   * Route one line from the device.
   *
   * The device brackets each reply as `{XXXX` … `}`, where XXXX is the signature
   * of the command that caused it. A line outside any block is therefore not a
   * reply to anything — it is subscription traffic or a banner — and must never
   * be attributed to a pending command.
   */
  processResponse(line) {
    this.emit('response', line);

    if (/^\{[0-9A-Fa-f]{4}$/.test(line)) {
      this.currentBlock = line.slice(1).toUpperCase();
      const pending = this.pendingCommands.get(this.currentBlock);
      if (pending) pending.lines = [];
      return;
    }

    if (line === '}') {
      const signature = this.currentBlock;
      this.currentBlock = null;
      if (!signature) return;

      const pending = this.pendingCommands.get(signature);
      if (!pending) return; // already timed out; its lines were emitted as unsolicited

      this.pendingCommands.delete(signature);
      clearTimeout(pending.timer);

      const failure = pending.lines.find((l) => isErrorLine(l));
      if (failure) pending.reject(new Error(`Device error: ${failure}`));
      else pending.resolve(pending.lines);
      return;
    }

    if (this.currentBlock === null) {
      this.emit('unsolicited', line);
      return;
    }

    const pending = this.pendingCommands.get(this.currentBlock);
    if (pending) pending.lines.push(line);
    else this.emit('unsolicited', line);
  }

  /**
   * Send one command and resolve with the lines of its reply block.
   * @param {string} command
   * @returns {Promise<string[]>}
   */
  sendCommand(command) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.transport) {
        reject(new Error('Not connected to a device'));
        return;
      }

      const signature = this.nextSignature();

      const timer = setTimeout(() => {
        if (this.pendingCommands.has(signature)) {
          this.pendingCommands.delete(signature);
          reject(new Error(`Command timeout: ${command}`));
        }
      }, COMMAND_TIMEOUT_MS);

      this.pendingCommands.set(signature, { signature, resolve, reject, lines: [], timer });

      try {
        this.transport.send(`${signature}#${command}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pendingCommands.delete(signature);
        reject(error);
      }
    });
  }

  async get(property) {
    return (await this.sendCommand(`GET ${property}`)).join('\n');
  }

  async set(property, value) {
    return (await this.sendCommand(`SET ${property}=${value}`)).join('\n');
  }

  /**
   * GETALL - a node's children, its own properties, and its methods.
   * @param {string} [path]
   * @returns {Promise<{properties: Array, nodes: Array, methods: Array}>}
   */
  async getAll(path = '') {
    const command = path ? `GETALL ${path}` : 'GETALL';
    return parseGetAll(await this.sendCommand(command));
  }

  /**
   * Read a node's children *with their contents*.
   *
   * `GETALL <node>/*` asks the device to descend one level and report each
   * child's properties. Real Lightware hardware answers it; the Taurus emulator
   * rejects it with %E002:Not exists while answering plain `GETALL <node>`,
   * which lists the children but none of their properties -- not the same thing,
   * and not enough for callers that need the values.
   *
   * So: try the wildcard, and where it is unsupported, enumerate the children
   * and read each one. That costs 1+N commands instead of 1, which is why it is
   * a fallback rather than the default.
   *
   * @param {string} nodePath - node path with no trailing slash or wildcard
   * @returns {Promise<string[]>} raw reply lines, wildcard-shaped either way
   */
  async getAllDeep(nodePath) {
    try {
      return await this.sendCommand(`GETALL ${nodePath}/*`);
    } catch (wildcardError) {
      let listing;
      try {
        listing = await this.sendCommand(`GETALL ${nodePath}`);
      } catch (plainError) {
        // Neither form worked, so the node is the problem, not the dialect.
        // Report the wildcard failure: it is the command callers expect.
        throw wildcardError;
      }

      const lines = [...listing];
      for (const child of listing.filter((l) => l.startsWith('n- '))) {
        const childPath = child.slice(3).trim();
        try {
          lines.push(...(await this.sendCommand(`GETALL ${childPath}`)));
        } catch (childError) {
          // One unreadable child must not cost the caller the rest of the tree.
          this.emit('unsolicited', `GETALL ${childPath} failed: ${childError.message}`);
        }
      }
      return lines;
    }
  }

  async call(method, params = []) {
    const paramsStr = params.length > 0 ? ` ${params.join(' ')}` : '';
    return (await this.sendCommand(`CALL ${method}${paramsStr}`)).join('\n');
  }

  /**
   * MAN command - Get manual/documentation for a property, node, or method
   * @param {string} path - Path to get manual for
   * @returns {Promise<string>}
   */
  async man(path) {
    return (await this.sendCommand(`MAN ${path}`)).join('\n');
  }

  /**
   * GETROOT command - Get root structure using GETALL /V1/*
   * @returns {Promise<{properties: Array, nodes: Array, methods: Array}>}
   */
  async getRoot() {
    return parseGetAll(await this.getAllDeep('/V1'));
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
    if (!this.connected) return null;
    return {
      host: this.host,
      port: this.port,
      connected: this.connected,
      transport: this.transportKind,
    };
  }
}
