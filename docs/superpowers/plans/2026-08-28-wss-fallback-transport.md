# WSS Fallback Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When TCP 6107 fails, fall back to LW3 over `wss://<host>/lw3`, prompting for the `admin` password when the device demands Basic auth.

**Architecture:** Split `src/lw3-protocol.js` at its existing seam. The command queue, line buffering, and GETALL parsing are transport-independent and stay untouched; underneath them goes a two-implementation transport interface. `LW3Protocol` gains transport-factory injection so the fallback logic is unit-testable without a device.

**Tech Stack:** Node 22, ES modules, `node:test`, `ws` (new dependency), `@anthropic-ai/mcpb@2.1.2`.

**Spec:** [2026-08-28-wss-fallback-transport-design.md](../specs/2026-08-28-wss-fallback-transport-design.md)

## Global Constraints

- **`ws` is the only new dependency permitted.** `dependencies` ends as exactly `@modelcontextprotocol/sdk`, `multicast-dns`, `ws`. Tests use built-in `node:test`.
- **ES modules.** `package.json` has `"type": "module"`; use `import`, and include `.js` extensions on relative imports.
- **The username is the literal `admin`.** Exported as a constant, not a parameter.
- **The WSS path is the literal `/lw3`.** Exported as a constant.
- **`rejectUnauthorized: false`** on the WSS connection — Lightware devices self-sign.
- **The connect response must not mention the unverified certificate.** Explicit product decision; the trade-off is recorded in the spec's Security posture section.
- **The password is never written to disk, never logged, and never included in an error message.**
- **TCP connect timeout is 3000 ms**, exported as a constant.
- **Do not change** `processResponse`, `getAll`, `sendCommand`'s 5-second command timeout, or the GETALL 1-second collection window.
- **The bundle must contain no `.node` binaries.** One artifact must work on every platform.
- Test script stays `"test": "node --test tests/*.js"`.

## Verified Facts

Measured against a UCX-4x2-HC30 (`jimmy-hc30`, 192.168.2.104) on 2026-08-28. Trust these; do not re-derive.

- `wss://192.168.2.104/lw3` with `Authorization: Basic` returns `101 Switching Protocols`. Without it, `401` with `WWW-Authenticate: Basic realm="Please login"`.
- The device certificate is self-signed (`DEPTH_ZERO_SELF_SIGNED_CERT`, subject and issuer both `CN=jimmy-hc30`). TLS succeeds only with `rejectUnauthorized: false`.
- **Each WebSocket text frame carries newline-delimited LW3 lines terminated `\r\n`.** A `GET` returned one frame `"pw /V1/MANAGEMENT/NETWORK.HostName=jimmy-hc30\r\n"`; a `GETALL` returned one frame holding five `n- ...\r\n` lines. So the transport needs no line logic — `handleData()` already buffers, splits on `\n`, and trims.
- Node's built-in `WebSocket` is unusable here: it cannot set an `Authorization` header and cannot accept a self-signed certificate.
- `ws` has an empty `dependencies` field; `bufferutil` and `utf-8-validate` are `peerDependenciesMeta` `optional: true`. A clean `npm install ws` adds one package and zero `.node` files.
- `ws` reports a non-101 handshake through its `unexpected-response` event, giving `(request, response)` with `response.statusCode`.

---

### Task 1: TCP transport with a connect timeout

Extracts today's socket handling behind the transport interface and adds the bounded connect that the fallback requires. `LW3Protocol.connect()` currently has no timeout of its own — it waits on the OS, which is the "seems stuck when connecting" symptom in `INSTALL.md` and `WALKTHROUGH.md`.

**Files:**
- Create: `src/transports/tcp.js`
- Create: `tests/tcp-transport.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces — the transport contract every implementation and consumer relies on:
  - `class TcpTransport extends EventEmitter`
  - `new TcpTransport(host: string, port: number)`
  - `connect(): Promise<void>` — resolves when ready to send; rejects on refusal, error, or timeout
  - `send(text: string): void`
  - `close(): Promise<void>`
  - Events after a successful `connect()`: `'data'` (a `string` chunk), `'close'`, `'error'` (an `Error`)
  - `export const CONNECT_TIMEOUT_MS = 3000`

- [ ] **Step 1: Write the failing test**

Create `tests/tcp-transport.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { TcpTransport, CONNECT_TIMEOUT_MS } from '../src/transports/tcp.js';

const listen = (handler) =>
  new Promise((resolve) => {
    const server = net.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

test('the connect timeout is 3 seconds', () => {
  assert.equal(CONNECT_TIMEOUT_MS, 3000);
});

test('connects, receives data as strings, and closes', async () => {
  const server = await listen((sock) => {
    sock.on('data', (d) => sock.write(`echo:${d.toString()}`));
  });
  const { port } = server.address();
  const t = new TcpTransport('127.0.0.1', port);
  await t.connect();

  const received = await new Promise((resolve) => {
    t.once('data', resolve);
    t.send('ping\n');
  });
  assert.equal(typeof received, 'string', 'transports emit strings, not Buffers');
  assert.equal(received, 'echo:ping\n');

  await t.close();
  server.close();
});

test('rejects when the port is refused', async () => {
  // Bind then immediately close, so the port is almost certainly unused.
  const server = await listen(() => {});
  const { port } = server.address();
  await new Promise((r) => server.close(r));

  const t = new TcpTransport('127.0.0.1', port);
  await assert.rejects(() => t.connect(), (err) => {
    assert.match(err.message, /127\.0\.0\.1/, 'the error names the host and port it tried');
    return true;
  });
});

test('rejects with a timeout error when the peer never completes the handshake', async () => {
  // 198.51.100.0/24 is TEST-NET-2 (RFC 5737): routable-looking, never answers.
  const t = new TcpTransport('198.51.100.1', 6107);
  t.timeoutMs = 150; // keep the test fast; the constant itself is asserted above
  await assert.rejects(() => t.connect(), (err) => {
    assert.match(err.message, /timed out/i);
    return true;
  });
});

test('emits close after the peer disconnects', async () => {
  const server = await listen((sock) => sock.end());
  const { port } = server.address();
  const t = new TcpTransport('127.0.0.1', port);
  await t.connect();
  await new Promise((resolve) => t.once('close', resolve));
  server.close();
});

test('close() resolves when called after the peer disconnected', async () => {
  const server = await listen((sock) => sock.end());
  try {
    const { port } = server.address();
    const t = new TcpTransport('127.0.0.1', port);
    await t.connect();
    await new Promise((resolve) => t.once('close', resolve));

    // Race close() against a short timer so a regression hangs the test
    // instead of hanging the whole suite (and leaving this server's
    // listening socket open forever).
    const hang = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('close() hung')), 1000)
    );
    await Promise.race([t.close(), hang]);
  } finally {
    server.close();
  }
});

test('close() resolves when called after a failed connect', async () => {
  // Bind then immediately close, so the port is almost certainly unused.
  const server = await listen(() => {});
  const { port } = server.address();
  await new Promise((r) => server.close(r));

  const t = new TcpTransport('127.0.0.1', port);
  await assert.rejects(() => t.connect());

  // Give the socket torn down by the failed connect a moment to actually
  // finish its own internal 'close' before we call close() ourselves —
  // otherwise a lucky ordering could mask the bug this guards against.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const hang = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('close() hung')), 1000)
  );
  await Promise.race([t.close(), hang]);
});

test('close() is safe to call twice in a row', async () => {
  const server = await listen((sock) => sock.end());
  try {
    const { port } = server.address();
    const t = new TcpTransport('127.0.0.1', port);
    await t.connect();
    await new Promise((resolve) => t.once('close', resolve));

    const hang = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('close() hung')), 1000)
    );
    await Promise.race([t.close(), hang]);
    await Promise.race([t.close(), hang]);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`

Expected: FAIL with `Cannot find module '../src/transports/tcp.js'`. The existing 10 tests still pass.

- [ ] **Step 3: Write the transport**

Create `src/transports/tcp.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`

Expected: PASS, 18 tests (10 existing + 8 new), 0 failures, pristine output.

- [ ] **Step 5: Commit**

```bash
git add src/transports/tcp.js tests/tcp-transport.test.js
git commit -m "Add TCP transport with a bounded connect timeout"
```

---

### Task 2: Secure WebSocket transport

**Files:**
- Create: `src/transports/wss.js`
- Create: `tests/wss-transport.test.js`
- Modify: `package.json` (add the `ws` dependency)

**Interfaces:**
- Consumes: the transport contract shape from Task 1 (`connect`/`send`/`close`, `'data'`/`'close'`/`'error'`). `WssTransport` implements the same contract but does **not** import from `tcp.js`.
- Produces:
  - `class WssTransport extends EventEmitter`
  - `new WssTransport(host: string, password: string | undefined)`
  - `connect(): Promise<void>`, `send(text: string): void`, `close(): Promise<void>`, same events
  - `class AuthRequiredError extends Error` with `name === 'AuthRequiredError'` and a boolean `passwordWasSupplied` field
  - `export const WSS_PATH = '/lw3'`
  - `export const WSS_USER = 'admin'`

  Task 3 imports `WssTransport` and `AuthRequiredError`.

- [ ] **Step 1: Install the dependency**

Run: `npm install ws`

Then confirm it brought no native code — the bundle's cross-platform portability depends on this:

Run: `find node_modules -name "*.node" | head`
Expected: no output.

- [ ] **Step 2: Write the failing test**

Create `tests/wss-transport.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  WssTransport,
  AuthRequiredError,
  WSS_PATH,
  WSS_USER,
  isSuppressedWsError,
} from '../src/transports/wss.js';

// Answers any upgrade request with a bare 401, the way a Lightware device
// does when the admin password is required. Listens on port 0 so tests never
// collide, and never touches a real device or the network.
const listenWithAuthChallenge = () =>
  new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

// Regression test for a crash reproduced against a real device: connect()'s
// fail() helper used to call ws.removeAllListeners() and then ws.terminate(),
// which strips the 'error' listener before terminate() asynchronously emits
// one. An unhandled 'error' event on an EventEmitter throws, which — with
// nothing left to catch it — took down the whole Node process instead of
// merely rejecting connect()'s promise. 401 is the primary path for a
// password-protected device, so this was a crash on the feature's main flow.
test('connect() rejects (does not crash the process) when the device answers 401 with no password', async () => {
  const server = await listenWithAuthChallenge();
  try {
    const { port } = server.address();
    const t = new WssTransport('127.0.0.1', undefined);
    t.url = `ws://127.0.0.1:${port}/lw3`;

    await assert.rejects(() => t.connect(), (err) => {
      assert.equal(err.name, 'AuthRequiredError');
      assert.equal(err.passwordWasSupplied, false);
      return true;
    });

    // If fail() left ws without an 'error' listener, terminate()'s async
    // 'error' event throws here (or shortly after), crashing the whole test
    // process before this timer ever fires. Reaching this line at all is
    // the proof the process survived.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    server.close();
  }
});

test('connect() rejects (does not crash the process) when the device answers 401 with a password supplied', async () => {
  const server = await listenWithAuthChallenge();
  try {
    const { port } = server.address();
    const t = new WssTransport('127.0.0.1', 'hunter2');
    t.url = `ws://127.0.0.1:${port}/lw3`;

    await assert.rejects(() => t.connect(), (err) => {
      assert.equal(err.name, 'AuthRequiredError');
      assert.equal(err.passwordWasSupplied, true);
      return true;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    server.close();
  }
});

// Regression test for a hang reproduced against a real device: fail() called
// ws.terminate() but never cleared this.ws. A caller that catches
// AuthRequiredError and calls close() before deciding whether to retry then
// found close() attaching a 'close' listener to a socket whose 'close' had
// already fired — and calling .close() on it is a no-op once readyState is
// CLOSED — so the promise never settled. This must fail against the
// unfixed code.
test('close() after a failed connect resolves', async () => {
  const server = await listenWithAuthChallenge();
  try {
    const { port } = server.address();
    const t = new WssTransport('127.0.0.1', undefined);
    t.url = `ws://127.0.0.1:${port}/lw3`;

    await t.connect().catch(() => {});

    // Race close() against a short timer so a regression hangs the test
    // instead of hanging the whole suite (and leaving this server's
    // listening socket open forever).
    const hang = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('close() hung')), 1000)
    );
    await Promise.race([t.close(), hang]);
  } finally {
    server.close();
  }
});

test('close() is safe to call twice in a row', async () => {
  const server = await listenWithAuthChallenge();
  try {
    const { port } = server.address();
    const t = new WssTransport('127.0.0.1', undefined);
    t.url = `ws://127.0.0.1:${port}/lw3`;

    await t.connect().catch(() => {});

    const hang = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('close() hung')), 1000)
    );
    await Promise.race([t.close(), hang]);
    await Promise.race([t.close(), hang]);
  } finally {
    server.close();
  }
});

// Regression test for a crash reproduced against a real device: on a
// successful, ordinary disconnect the device sends a non-compliant close
// code, which ws reports as an 'error' (WS_ERR_INVALID_CLOSE_CODE). The
// post-open handler used to re-emit every 'error' verbatim, and an 'error'
// event with no listener throws and kills the process — over what is
// otherwise a normal close the caller can do nothing about. Tested directly
// against the exported predicate rather than forcing a real socket to
// receive a bad close code.
test('isSuppressedWsError suppresses WS_ERR_INVALID_CLOSE_CODE', () => {
  const badCloseCode = Object.assign(new RangeError('invalid status code 1006'), {
    code: 'WS_ERR_INVALID_CLOSE_CODE',
  });
  assert.equal(isSuppressedWsError(badCloseCode), true);
});

test('isSuppressedWsError does not suppress other errors', () => {
  assert.equal(isSuppressedWsError(new Error('boom')), false);
  assert.equal(
    isSuppressedWsError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })),
    false
  );
});

test('targets the /lw3 endpoint as the admin user', () => {
  assert.equal(WSS_PATH, '/lw3');
  assert.equal(WSS_USER, 'admin');
});

test('builds a wss URL from the host', () => {
  const t = new WssTransport('192.168.2.104', undefined);
  assert.equal(t.url, 'wss://192.168.2.104/lw3');
});

test('sends no Authorization header when no password was given', () => {
  const t = new WssTransport('device.local', undefined);
  assert.deepEqual(t.headers(), {});
});

test('sends Basic auth for the admin user when a password was given', () => {
  const t = new WssTransport('device.local', 'secret');
  const expected = 'Basic ' + Buffer.from('admin:secret').toString('base64');
  assert.equal(t.headers().Authorization, expected);
});

test('AuthRequiredError distinguishes "no password yet" from "password rejected"', () => {
  const first = new AuthRequiredError(false);
  const retry = new AuthRequiredError(true);

  assert.equal(first.name, 'AuthRequiredError');
  assert.equal(first.passwordWasSupplied, false);
  assert.match(first.message, /admin/, 'names the account the user must supply a password for');

  assert.equal(retry.passwordWasSupplied, true);
  assert.match(retry.message, /rejected/i, 'a rejected password must read differently, or the model retries forever');
  assert.notEqual(first.message, retry.message);
});

test('no error message leaks the password', () => {
  const t = new WssTransport('device.local', 'hunter2');
  const messages = [
    new AuthRequiredError(true).message,
    new AuthRequiredError(false).message,
    t.url,
  ];
  for (const m of messages) assert.doesNotMatch(m, /hunter2/);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`

Expected: FAIL with `Cannot find module '../src/transports/wss.js'`.

- [ ] **Step 4: Write the transport**

Create `src/transports/wss.js`:

```js
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';

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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`

Expected: PASS, 30 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/transports/wss.js tests/wss-transport.test.js
git commit -m "Add secure WebSocket transport with Basic auth"
```

---

### Task 3: Fallback in LW3Protocol

The behavioural core. `LW3Protocol` stops owning a socket and drives a transport instead, trying TCP first and WSS second.

**Files:**
- Modify: `src/lw3-protocol.js` (constructor, `connect`, `disconnect`, `handleData`, `sendCommand`, `getConnectionInfo`)
- Create: `tests/fallback.test.js`

**Interfaces:**
- Consumes: `TcpTransport`, `CONNECT_TIMEOUT_MS` from `../transports/tcp.js`; `WssTransport`, `AuthRequiredError` from `../transports/wss.js`.
- Produces:
  - `new LW3Protocol(factories?)` where `factories` is `{ createTcp?: (host, port) => Transport, createWss?: (host, password) => Transport }`. Both default to the real transports, so `new LW3Protocol()` keeps working unchanged.
  - `connect(host, port = 6107, options = {}): Promise<void>` — `options.password` is the admin password.
  - `getConnectionInfo()` gains a `transport` field, `'tcp'` or `'wss'`.

  Task 4 calls `connect(host, port, { password })`.

- [ ] **Step 1: Write the failing test**

Create `tests/fallback.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LW3Protocol } from '../src/lw3-protocol.js';
import { AuthRequiredError } from '../src/transports/wss.js';

/** Minimal stand-in for a transport: connects or fails on command. */
class FakeTransport extends EventEmitter {
  constructor(failWith = null) {
    super();
    this.failWith = failWith;
    this.sent = [];
    this.closed = false;
  }
  async connect() { if (this.failWith) throw this.failWith; }
  send(text) { this.sent.push(text); }
  async close() { this.closed = true; }
}

const build = ({ tcp, wss }) => {
  const made = {};
  const lw3 = new LW3Protocol({
    createTcp: () => (made.tcp = tcp),
    createWss: (_h, password) => { made.wssPassword = password; return (made.wss = wss); },
  });
  return { lw3, made };
};

test('uses TCP when it connects, and never builds a WSS transport', async () => {
  const tcp = new FakeTransport();
  const wss = new FakeTransport();
  const { lw3, made } = build({ tcp, wss });
  await lw3.connect('device.local');

  assert.equal(lw3.isConnected(), true);
  assert.equal(lw3.getConnectionInfo().transport, 'tcp');
  assert.equal(made.wss, undefined, 'WSS must not be attempted when TCP succeeds');
});

test('falls back to WSS when TCP fails', async () => {
  const tcp = new FakeTransport(new Error('TCP device.local:6107 — ECONNREFUSED'));
  const wss = new FakeTransport();
  const { lw3 } = build({ tcp, wss });
  await lw3.connect('device.local');

  assert.equal(lw3.isConnected(), true);
  assert.equal(lw3.getConnectionInfo().transport, 'wss');
});

test('passes the password through to the WSS transport', async () => {
  const { lw3, made } = build({
    tcp: new FakeTransport(new Error('refused')),
    wss: new FakeTransport(),
  });
  await lw3.connect('device.local', 6107, { password: 'secret' });
  assert.equal(made.wssPassword, 'secret');
});

test('surfaces an auth challenge unchanged, so the caller can ask for a password', async () => {
  const { lw3 } = build({
    tcp: new FakeTransport(new Error('refused')),
    wss: new FakeTransport(new AuthRequiredError(false)),
  });
  await assert.rejects(() => lw3.connect('device.local'), (err) => {
    assert.equal(err.name, 'AuthRequiredError');
    assert.equal(err.passwordWasSupplied, false);
    return true;
  });
  assert.equal(lw3.isConnected(), false);
});

test('reports both failures when neither transport works', async () => {
  const { lw3 } = build({
    tcp: new FakeTransport(new Error('TCP device.local:6107 — ECONNREFUSED')),
    wss: new FakeTransport(new Error('wss://device.local/lw3 — EHOSTUNREACH')),
  });
  await assert.rejects(() => lw3.connect('device.local'), (err) => {
    assert.match(err.message, /ECONNREFUSED/, 'the TCP failure must not be hidden');
    assert.match(err.message, /EHOSTUNREACH/, 'the WSS failure must be reported too');
    return true;
  });
});

test('sends commands through whichever transport connected', async () => {
  const wss = new FakeTransport();
  const { lw3 } = build({ tcp: new FakeTransport(new Error('refused')), wss });
  await lw3.connect('device.local');
  lw3.sendCommand('GET /V1/X.Y').catch(() => {}); // no reply arrives; we only assert the write
  assert.deepEqual(wss.sent, ['GET /V1/X.Y\n']);
});

test('splits CRLF-terminated lines, the framing the WSS transport delivers', async () => {
  const tcp = new FakeTransport();
  const { lw3 } = build({ tcp, wss: new FakeTransport() });
  await lw3.connect('device.local');

  const lines = [];
  lw3.on('response', (line) => lines.push(line));

  // One frame carrying five lines, exactly as the device sent it over WSS.
  tcp.emit('data',
    'n- /V1/MANAGEMENT/NETWORK/SERVICES/HTTP\r\n' +
    'n- /V1/MANAGEMENT/NETWORK/SERVICES/HTTPS\r\n' +
    'n- /V1/MANAGEMENT/NETWORK/SERVICES/LW3\r\n');

  assert.deepEqual(lines, [
    'n- /V1/MANAGEMENT/NETWORK/SERVICES/HTTP',
    'n- /V1/MANAGEMENT/NETWORK/SERVICES/HTTPS',
    'n- /V1/MANAGEMENT/NETWORK/SERVICES/LW3',
  ], 'no stray \\r may survive, or every parsed value gains a trailing carriage return');
});

test('reassembles a line split across two chunks', async () => {
  const tcp = new FakeTransport();
  const { lw3 } = build({ tcp, wss: new FakeTransport() });
  await lw3.connect('device.local');

  const lines = [];
  lw3.on('response', (line) => lines.push(line));
  tcp.emit('data', 'pw /V1/X.Y=hel');
  assert.deepEqual(lines, [], 'a partial line must not be emitted');
  tcp.emit('data', 'lo\r\n');
  assert.deepEqual(lines, ['pw /V1/X.Y=hello']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`

Expected: FAIL. `new LW3Protocol({...})` ignores the factories today, so `connect` opens a real socket to `device.local` and the tests error or time out.

- [ ] **Step 3: Rewrite the connection layer**

In `src/lw3-protocol.js`, replace the `net` import, the constructor, `connect`, `disconnect`, `handleData`, the write inside `sendCommand`, and `getConnectionInfo`. Leave `processResponse`, `getAll`, `call`, `get`, `set`, `open`, `man`, `getRoot`, and `isConnected` exactly as they are.

Replace the import at the top of the file:

```js
import { EventEmitter } from 'node:events';
import { TcpTransport } from './transports/tcp.js';
import { WssTransport, AuthRequiredError } from './transports/wss.js';
```

Replace the constructor:

```js
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
    this.pendingCommands = new Map();
    this.commandId = 0;
  }
```

Replace `connect` with the fallback sequence:

```js
  /**
   * Connect to a device: TCP first, secure WebSocket as a fallback.
   * @param {string} host
   * @param {number} [port] - TCP port, default 6107
   * @param {{password?: string}} [options] - admin password, if the device requires one
   */
  async connect(host, port = 6107, options = {}) {
    if (this.connected) throw new Error('Already connected to a device');

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
```

Replace `disconnect`:

```js
  async disconnect() {
    if (!this.transport) return;
    await this.transport.close();
    this.transport = null;
    this.transportKind = null;
    this.connected = false;
    this.buffer = '';
    this.pendingCommands.clear();
  }
```

Replace `handleData` — transports now emit strings:

```js
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
```

In `sendCommand`, replace the guard and the write. Leave the 5-second timeout untouched:

```js
      if (!this.connected || !this.transport) {
        reject(new Error('Not connected to a device'));
        return;
      }

      const id = this.commandId++;
      this.pendingCommands.set(id, { id, resolve, reject });

      const cmd = command.endsWith('\n') ? command : command + '\n';

      try {
        this.transport.send(cmd);
      } catch (error) {
        this.pendingCommands.delete(id);
        reject(error);
        return;
      }
```

`getAll` has its own copy of the guard and the write. Replace the top of its promise body — everything from the guard down to and including the `this.socket.write(...)` call — with:

```js
      if (!this.connected || !this.transport) {
        reject(new Error('Not connected to a device'));
        return;
      }

      const id = this.commandId++;
      this.pendingCommands.set(id, {
        id,
        resolve,
        reject,
        collectMultiple: true,
        responses: [],
      });

      const cmd = command.endsWith('\n') ? command : command + '\n';

      try {
        this.transport.send(cmd);
      } catch (error) {
        this.pendingCommands.delete(id);
        reject(error);
        return;
      }
```

Leave everything below it — the 1-second `setTimeout` that collects and parses responses — exactly as it is.

Replace `getConnectionInfo`:

```js
  getConnectionInfo() {
    if (!this.connected) return null;
    return {
      host: this.host,
      port: this.port,
      connected: this.connected,
      transport: this.transportKind,
    };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`

Expected: PASS, 38 tests, 0 failures.

- [ ] **Step 5: Check nothing still references the old socket field**

Run: `grep -n "this.socket" src/lw3-protocol.js`
Expected: no output. Any hit is a code path that would throw at runtime — fix it before committing.

- [ ] **Step 6: Commit**

```bash
git add src/lw3-protocol.js tests/fallback.test.js
git commit -m "Fall back to secure WebSocket when TCP 6107 fails"
```

---

### Task 4: Expose the password through the connect tool

**Files:**
- Modify: `src/index.js` (the `connect` entry in `ListToolsRequestSchema`, and `handleConnect`)
- Modify: `tests/manifest.test.js` is **not** touched — the manifest's tool list is unchanged, since no tool is added or removed.

**Interfaces:**
- Consumes: `connect(host, port, { password })` and `getConnectionInfo().transport` from Task 3.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the parameter to the tool schema**

In `src/index.js`, in the `connect` tool's `inputSchema.properties`, after the `port` property, add:

```js
              password: {
                type: 'string',
                description:
                  'Admin password. Only needed if the device requires authentication — connect will tell you when it does.',
              },
```

Leave `required: ['host']` unchanged: the password is optional, and demanding it up front would prompt users who do not need it.

- [ ] **Step 2: Pass it through the handler**

Replace `handleConnect` in `src/index.js` with:

```js
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
```

- [ ] **Step 3: Verify the server still starts and lists 11 tools**

Run: `npm test`
Expected: PASS, 38 tests, 0 failures — the manifest drift tests confirm the tool list is unchanged.

Run: `node scripts/verify-bundle.js dist/lw3-mcp-1.0.0.mcpb`
Expected: `OK: bundle unpacks, dependencies present, server lists 11 tools`. This runs the *previously built* bundle, so it is only a sanity check that nothing in the working tree broke the old artifact; Task 5 rebuilds.

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "Accept an admin password on the connect tool"
```

---

### Task 5: Keep the bundle single-artifact portable

One `.mcpb` works on Windows, macOS, and Linux only because every dependency is pure JavaScript. That has been true by luck; adding `ws` makes it worth enforcing.

**Files:**
- Modify: `scripts/verify-bundle.js` (add a native-binary assertion)
- Modify: `tests/verify-bundle.test.js` (cover it)

**Interfaces:**
- Consumes: `REQUIRED_ENTRIES`, `assertRequiredEntries`, `listFilesRecursive` from `scripts/verify-bundle.js`.
- Produces: `assertNoNativeBinaries(entries: string[]): void` — throws listing every offending path; returns `undefined` when clean. Exported alongside the existing helpers.

- [ ] **Step 1: Write the failing test**

Append to `tests/verify-bundle.test.js`:

```js
import { assertNoNativeBinaries } from '../scripts/verify-bundle.js';

test('accepts a bundle with no compiled addons', () => {
  assert.doesNotThrow(() =>
    assertNoNativeBinaries(['src/index.js', 'node_modules/ws/index.js', 'manifest.json'])
  );
});

test('rejects compiled addons and names every one', () => {
  assert.throws(
    () =>
      assertNoNativeBinaries([
        'src/index.js',
        'node_modules/bufferutil/build/Release/bufferutil.node',
        'node_modules/utf-8-validate/build/Release/validation.node',
      ]),
    (err) => {
      assert.match(err.message, /bufferutil\.node/);
      assert.match(err.message, /validation\.node/, 'both offenders must be listed, not just the first');
      assert.match(err.message, /platform/i, 'the message must say why this matters');
      return true;
    }
  );
});

test('is case-insensitive, since Windows paths may not be', () => {
  assert.throws(() => assertNoNativeBinaries(['node_modules/x/Binding.NODE']));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`

Expected: FAIL — `assertNoNativeBinaries` is not exported from `scripts/verify-bundle.js`.

- [ ] **Step 3: Implement the assertion**

In `scripts/verify-bundle.js`, add after `assertRequiredEntries`:

```js
/**
 * One .mcpb is meant to install on Windows, macOS, and Linux. That only holds
 * while every dependency is pure JavaScript — a compiled addon is built for one
 * platform and silently breaks the other two.
 */
export function assertNoNativeBinaries(entries) {
  const native = entries.filter((e) => e.toLowerCase().endsWith('.node'));
  if (native.length === 0) return;
  throw new Error(
    `Bundle contains compiled native addons:\n  ${native.join('\n  ')}\n\n` +
      'The bundle is built once and installed on every platform, so a compiled ' +
      'addon makes it work only on the machine that built it. Reinstall without ' +
      'optional native dependencies before shipping.'
  );
}
```

Then call it inside `verifyBundle`, immediately after the existing `assertRequiredEntries(...)` call:

```js
    const entries = listFilesRecursive(root);
    assertRequiredEntries(entries);
    assertNoNativeBinaries(entries);
```

(The existing line reads `assertRequiredEntries(listFilesRecursive(root));` — hoist the list into a variable so both assertions share it rather than walking the tree twice.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`

Expected: PASS, 41 tests, 0 failures.

- [ ] **Step 5: Build and verify the real bundle**

Run: `npm run bundle`

Expected: the five build steps run and the final line reads roughly
`OK  C:\Taurus\lw3-mcp\dist\lw3-mcp-1.0.0.mcpb  (2.5 MB, 11 tools)`.

The bundle now contains `ws`, so it will be slightly larger. If the native-binary assertion fails here, something installed a compiled addon — reinstall with `npm ci --omit=dev` and investigate rather than weakening the check.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-bundle.js tests/verify-bundle.test.js
git commit -m "Fail the build if the bundle contains native addons"
```

---

## Manual verification against real hardware

No automated test can hold a device password, so this last check is manual and is the only proof the whole path works end to end.

- [ ] Confirm `jimmy-hc30` is reachable: `node -e "import('./src/lightware-discovery.js').then(async ({LightwareDiscovery})=>{const d=new LightwareDiscovery();console.log(await d.discover(4000));d.stopDiscovery();})"`
- [ ] Connect over TCP as normal and confirm `status` reports `transport: tcp`.
- [ ] Force the fallback by connecting with a port nothing listens on — for example `connect(host, 6108, { password })` — and confirm it lands on `wss` and that a `GET` returns a real value.
- [ ] Connect with a wrong password and confirm the error says the password was *rejected*, not that authentication is *required*. Those two messages drive different behaviour in the model.

## Done when

- `npm test` passes with 41 tests.
- `npm run bundle` exits 0, reporting a path, a size, and `11 tools`.
- A device answers over `wss` when its TCP port is unreachable.
