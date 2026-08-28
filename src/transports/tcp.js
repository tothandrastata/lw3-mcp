import net from 'node:net';
import { EventEmitter } from 'node:events';

/** Bounded connect attempt. Without this the OS decides how long a silently
 *  dropped connection hangs, and the WSS fallback can never trigger. */
export const CONNECT_TIMEOUT_MS = 3000;

/**
 * LW3 over a raw TCP socket — the device's native transport on port 6107.
 * Emits 'data' as strings; line splitting belongs to LW3Protocol.
 */
export class TcpTransport extends EventEmitter {
  constructor(host, port = 6107) {
    super();
    this.host = host;
    this.port = port;
    this.timeoutMs = CONNECT_TIMEOUT_MS;
    this.socket = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`TCP ${this.host}:${this.port} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.on('data', (d) => this.emit('data', d.toString()));
        socket.on('close', () => this.emit('close'));
        socket.on('error', (err) => this.emit('error', err));
        resolve();
      });

      socket.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`TCP ${this.host}:${this.port} — ${err.message}`));
      });

      socket.connect(this.port, this.host);
    });
  }

  send(text) {
    if (!this.socket) throw new Error('TCP transport is not connected');
    this.socket.write(text);
  }

  close() {
    return new Promise((resolve) => {
      if (!this.socket) return resolve();
      this.socket.once('close', () => {
        this.socket = null;
        resolve();
      });
      this.socket.end();
    });
  }
}
