import WebSocket from 'ws';
import { EventEmitter } from 'node:events';

export const WSS_PATH = '/lw3';
export const WSS_USER = 'admin';

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
      });
      this.ws = ws;
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        ws.removeAllListeners();
        ws.terminate();
        reject(err);
      };

      ws.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 401) fail(new AuthRequiredError(Boolean(this.password)));
        else fail(new Error(`${this.url} — HTTP ${res.statusCode}`));
      });

      ws.on('error', (err) => fail(new Error(`${this.url} — ${err.message}`)));

      ws.on('open', () => {
        if (settled) return;
        settled = true;
        ws.on('message', (data) => this.emit('data', data.toString()));
        ws.on('close', () => this.emit('close'));
        ws.on('error', (err) => this.emit('error', err));
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
      if (!this.ws) return resolve();
      this.ws.once('close', () => {
        this.ws = null;
        resolve();
      });
      this.ws.close();
    });
  }
}
