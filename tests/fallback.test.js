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
