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
