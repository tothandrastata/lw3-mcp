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
