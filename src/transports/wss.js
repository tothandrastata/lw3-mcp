import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { CONNECT_TIMEOUT_MS } from './tcp.js';

export const WSS_PATH = '/lw3';
export const WSS_USER = 'admin';

/**
 * Some Lightware devices send a non-compliant WebSocket close code when they
 * hang up, which ws reports as an 'error' (WS_ERR_INVALID_CLOSE_CODE) even
 * though the disconnect itself is normal and successful. It's a complaint
 * about the peer's close frame, raised while the connection is already
 * ending — no caller action can address it, so forwarding it as a fatal
 * 'error' just crashes a consumer with no error listener over what is
 * otherwise an ordinary close. Exported so tests can exercise the decision
 * directly instead of forcing a real socket to receive a bad close code.
 */
export function isSuppressedWsError(err) {
  return err?.code === 'WS_ERR_INVALID_CLOSE_CODE';
}

/**
 * The device answered the upgrade with 401. Thrown so the caller can tell the
 * user to supply a password, rather than reporting a generic failure.
 */
export class AuthRequiredError extends Error {
  constructor(passwordWasSupplied) {
    super(
      passwordWasSupplied
        ? 'The device rejected that password for the "admin" user. Ask the user for the correct one and call connect again.'
        : 'The device requires authentication. Ask the user for the "admin" password, then call connect again with it as the "password" argument.'
    );
    this.name = 'AuthRequiredError';
    this.passwordWasSupplied = passwordWasSupplied;
  }
}

/**
 * LW3 over secure WebSocket, the transport the device's own web UI uses.
 *
 * Each frame carries newline-delimited LW3 lines, so this emits payloads
 * verbatim and lets LW3Protocol do the splitting — the same code path the TCP
 * transport feeds.
 *
 * rejectUnauthorized is false because Lightware devices self-sign: traffic is
 * encrypted but the device identity is not verified. See the design spec.
 */
export class WssTransport extends EventEmitter {
  constructor(host, password) {
    super();
    this.host = host;
    this.password = password;
    this.url = `wss://${host}${WSS_PATH}`;
    this.ws = null;
    this.timeoutMs = CONNECT_TIMEOUT_MS;
  }

  headers() {
    if (!this.password) return {};
    const encoded = Buffer.from(`${WSS_USER}:${this.password}`).toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        headers: this.headers(),
        rejectUnauthorized: false,
        handshakeTimeout: this.timeoutMs,
      });
      this.ws = ws;
      let settled = false;

      // Rejects the connect() promise. Only wired up for the duration of the
      // connect attempt — removed once 'open' fires so a post-connect error
      // doesn't run this dead branch on top of the real error handler.
      const onConnectError = (err) => fail(new Error(`${this.url} — ${err.message}`));

      const fail = (err) => {
        if (settled) return;
        settled = true;
        ws.removeAllListeners();
        // terminate() emits 'error' asynchronously even when the socket
        // never finished connecting. Without a listener attached, that
        // 'error' event is unhandled and Node throws, crashing the whole
        // process — after the promise has already rejected, so nothing here
        // can catch it. Keep a no-op listener in place across teardown.
        ws.on('error', () => {});
        ws.terminate();
        this.ws = null;
        reject(err);
      };

      ws.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 401) fail(new AuthRequiredError(Boolean(this.password)));
        else fail(new Error(`${this.url} — HTTP ${res.statusCode}`));
      });

      ws.on('error', onConnectError);

      ws.on('open', () => {
        if (settled) return;
        settled = true;
        ws.off('error', onConnectError);
        ws.on('message', (data) => this.emit('data', data.toString()));
        ws.on('close', () => {
          // The socket is dead the moment 'close' fires — drop the
          // reference so a later close() sees nothing to wait on instead
          // of attaching a listener to an event that already happened.
          this.ws = null;
          this.emit('close');
        });
        ws.on('error', (err) => {
          if (isSuppressedWsError(err)) return;
          this.emit('error', err);
        });
        resolve();
      });
    });
  }

  send(text) {
    if (!this.ws) throw new Error('WSS transport is not connected');
    this.ws.send(text);
  }

  close() {
    return new Promise((resolve) => {
      const ws = this.ws;
      // Nothing to wait on: never connected, already torn down by a failed
      // connect / peer disconnect, or already closed. Waiting for a
      // 'close' event here would hang forever, since it already fired (or
      // never will).
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        this.ws = null;
        resolve();
        return;
      }
      ws.once('close', () => {
        this.ws = null;
        resolve();
      });
      ws.close();
    });
  }
}
