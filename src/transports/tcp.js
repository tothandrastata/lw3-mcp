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
        this.socket = null;
        reject(new Error(`TCP ${this.host}:${this.port} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      // Rejects the connect() promise. Only wired up for the duration of the
      // connect attempt — removed once 'connect' fires so a post-connect
      // error doesn't run this dead branch on top of the real error handler.
      const onConnectError = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        this.socket = null;
        reject(new Error(`TCP ${this.host}:${this.port} — ${err.message}`));
      };

      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('error', onConnectError);
        socket.on('data', (d) => this.emit('data', d.toString()));
        socket.on('close', () => {
          // The socket is dead the moment 'close' fires — drop the
          // reference so a later close() sees nothing to wait on instead
          // of attaching a listener to an event that already happened.
          this.socket = null;
          this.emit('close');
        });
        socket.on('error', (err) => this.emit('error', err));
        resolve();
      });

      socket.once('error', onConnectError);

      try {
        socket.connect(this.port, this.host);
      } catch (err) {
        // A synchronous throw (e.g. an invalid port) never reaches the
        // timeout or the 'error' handler above, so clean up here.
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          this.socket = null;
          reject(err);
        }
      }
    });
  }

  send(text) {
    if (!this.socket) throw new Error('TCP transport is not connected');
    this.socket.write(text);
  }

  close() {
    return new Promise((resolve) => {
      const socket = this.socket;
      // Nothing to wait on: never connected, already torn down by a failed
      // connect / peer disconnect, or already destroyed. Waiting for a
      // 'close' event here would hang forever, since it already fired (or
      // never will).
      if (!socket || socket.destroyed) {
        this.socket = null;
        resolve();
        return;
      }
      socket.once('close', () => {
        this.socket = null;
        resolve();
      });
      socket.end();
    });
  }
}
