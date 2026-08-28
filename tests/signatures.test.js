import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LW3Protocol, parseGetAll, COMMAND_TIMEOUT_MS } from '../src/lw3-protocol.js';

/** Transport stand-in that records what was sent and lets a test feed lines back. */
class FakeTransport extends EventEmitter {
  constructor() { super(); this.sent = []; }
  async connect() {}
  send(text) { this.sent.push(text); }
  async close() {}
  /** Deliver device output, exactly as a transport would. */
  reply(...lines) { this.emit('data', lines.join('\r\n') + '\r\n'); }
}

const connected = async () => {
  const transport = new FakeTransport();
  const lw3 = new LW3Protocol({ createTcp: () => transport });
  await lw3.connect('device.local');
  return { lw3, transport };
};

/** The 4-hex signature the protocol put on the Nth command it sent. */
const sigOf = (transport, n = 0) => transport.sent[n].match(/^([0-9A-F]{4})#/)[1];

test('commands are prefixed with a 4-hex-digit signature', async () => {
  const { lw3, transport } = await connected();
  lw3.sendCommand('GET /V1/X.Y').catch(() => {});
  assert.match(transport.sent[0], /^[0-9A-F]{4}#GET \/V1\/X\.Y\n$/);
});

test('each command gets a distinct signature', async () => {
  const { lw3, transport } = await connected();
  lw3.sendCommand('GET /V1/A.B').catch(() => {});
  lw3.sendCommand('GET /V1/C.D').catch(() => {});
  assert.notEqual(sigOf(transport, 0), sigOf(transport, 1));
});

test('resolves with the lines of its own block', async () => {
  const { lw3, transport } = await connected();
  const p = lw3.sendCommand('GET /V1/X.Y');
  const s = sigOf(transport);
  transport.reply(`{${s}`, 'pw /V1/X.Y=hello', '}');
  assert.deepEqual(await p, ['pw /V1/X.Y=hello']);
});

test('a multi-line block returns every line, not just the first', async () => {
  const { lw3, transport } = await connected();
  const p = lw3.sendCommand('GET /V1/MANAGEMENT/NETWORK.*');
  const s = sigOf(transport);
  transport.reply(`{${s}`,
    'pw /V1/MANAGEMENT/NETWORK.DhcpEnabled=true',
    'pr /V1/MANAGEMENT/NETWORK.IpAddress=192.168.2.104',
    'pw /V1/MANAGEMENT/NETWORK.HostName=jimmy-hc30',
    '}');
  assert.equal((await p).length, 3, 'GET nodepath.* used to return 1 of these');
});

test('replies arriving out of order each go to the right command', async () => {
  const { lw3, transport } = await connected();
  const first = lw3.sendCommand('GET /V1/FIRST.P');
  const second = lw3.sendCommand('GET /V1/SECOND.P');
  const s1 = sigOf(transport, 0), s2 = sigOf(transport, 1);

  // The device answers the second command first.
  transport.reply(`{${s2}`, 'pw /V1/SECOND.P=two', '}');
  transport.reply(`{${s1}`, 'pw /V1/FIRST.P=one', '}');

  assert.deepEqual(await first, ['pw /V1/FIRST.P=one'],
    'this is the bug: without signatures the first command took the second reply');
  assert.deepEqual(await second, ['pw /V1/SECOND.P=two']);
});

test('lines outside any block are unsolicited and touch no pending command', async () => {
  const { lw3, transport } = await connected();
  const unsolicited = [];
  lw3.on('unsolicited', (l) => unsolicited.push(l));

  const p = lw3.sendCommand('GET /V1/X.Y');
  const s = sigOf(transport);
  // A subscription update lands mid-flight — the exact traffic OPEN produced.
  transport.reply('CHG /V1/MANAGEMENT/DATETIME.CurrentTime=2026-08-28T18:54:05');
  transport.reply(`{${s}`, 'pw /V1/X.Y=hello', '}');

  assert.deepEqual(await p, ['pw /V1/X.Y=hello'], 'the CHG line must not pollute the reply');
  assert.deepEqual(unsolicited, ['CHG /V1/MANAGEMENT/DATETIME.CurrentTime=2026-08-28T18:54:05']);
});

test('a block for an unknown signature is discarded, not misapplied', async () => {
  const { lw3, transport } = await connected();
  const unsolicited = [];
  lw3.on('unsolicited', (l) => unsolicited.push(l));

  const p = lw3.sendCommand('GET /V1/X.Y');
  const s = sigOf(transport);
  transport.reply('{FFFF', 'pw /V1/STALE.P=old', '}');   // a timed-out command's late reply
  transport.reply(`{${s}`, 'pw /V1/X.Y=hello', '}');

  assert.deepEqual(await p, ['pw /V1/X.Y=hello']);
  assert.deepEqual(unsolicited, ['pw /V1/STALE.P=old']);
});

test('rejects on every device error shape, matched by pattern not prefix', async () => {
  for (const bad of [
    'pE /V1/MANAGEMENT/NETWORK.NoSuchProperty %E002: Not exists',
    '-E OPEN /V1/MANAGEMENT/DATETIME.CurrentTime %E001: Syntax error',
    'mE /V1/X:method %E004: Invalid',
  ]) {
    const { lw3, transport } = await connected();
    const p = lw3.sendCommand('GET /V1/X.Y');
    const s = sigOf(transport);
    transport.reply(`{${s}`, bad, '}');
    await assert.rejects(() => p, (err) => {
      assert.match(err.message, /%E\d+:/, `should have rejected on: ${bad}`);
      return true;
    });
  }
});

test('a value containing digits and a colon is not mistaken for an error', async () => {
  const { lw3, transport } = await connected();
  const p = lw3.sendCommand('GET /V1/MANAGEMENT/DATETIME.CurrentTime');
  const s = sigOf(transport);
  const line = 'pr /V1/MANAGEMENT/DATETIME.CurrentTime=2026-08-28T18:51:48';
  transport.reply(`{${s}`, line, '}');
  assert.deepEqual(await p, [line]);
});

test('rejects with a timeout if the block never closes', async () => {
  const { lw3, transport } = await connected();
  const p = lw3.sendCommand('GET /V1/X.Y');
  const s = sigOf(transport);
  transport.reply(`{${s}`, 'pw /V1/X.Y=hello');   // no closing brace
  await assert.rejects(() => p, (err) => {
    assert.match(err.message, /timeout/i);
    assert.match(err.message, /GET \/V1\/X\.Y/, 'the message should name the command that timed out');
    return true;
  });
});

test('the command timeout is 5 seconds', () => {
  assert.equal(COMMAND_TIMEOUT_MS, 5000);
});

test('getAll resolves as soon as the block closes, not after a fixed wait', async () => {
  const { lw3, transport } = await connected();
  const started = Date.now();
  const p = lw3.getAll('/V1/MANAGEMENT/DATETIME');
  const s = sigOf(transport);
  transport.reply(`{${s}`,
    'pr /V1/MANAGEMENT/DATETIME.UpTime=0 days 11:09:54',
    'pw /V1/MANAGEMENT/DATETIME.TimeZone=UTC',
    'm- /V1/MANAGEMENT/DATETIME:setTime',
    'n- /V1/MANAGEMENT/DATETIME/NTP',
    '}');
  const result = await p;
  assert.ok(Date.now() - started < 200, 'GETALL used to always wait a full second');
  assert.equal(result.properties.length, 2);
  assert.equal(result.methods.length, 1);
  assert.equal(result.nodes.length, 1);
});

test('the reported bug: two GETALLs on one node, neither empty nor doubled', async () => {
  const { lw3, transport } = await connected();
  const block = (s) => [`{${s}`,
    'pr /V1/MANAGEMENT/DATETIME.UpTime=0 days 11:09:54',
    'pr /V1/MANAGEMENT/DATETIME.CurrentTime=2026-08-28T18:51:48',
    'pr /V1/MANAGEMENT/DATETIME.UtcTime=2026-08-28T18:51:48Z',
    'pw /V1/MANAGEMENT/DATETIME.TimeZone=UTC',
    'm- /V1/MANAGEMENT/DATETIME:setTime',
    'n- /V1/MANAGEMENT/DATETIME/NTP',
    '}'];

  const p1 = lw3.getAll('/V1/MANAGEMENT/DATETIME');
  transport.reply(...block(sigOf(transport, 0)));
  const first = await p1;

  const p2 = lw3.getAll('/V1/MANAGEMENT/DATETIME');
  transport.reply(...block(sigOf(transport, 1)));
  const second = await p2;

  for (const [label, r] of [['first', first], ['second', second]]) {
    assert.equal(r.properties.length, 4, `${label} call: the node has 4 properties`);
    assert.equal(r.methods.length, 1, `${label} call: 1 method`);
    assert.equal(r.nodes.length, 1, `${label} call: 1 child node`);
  }
});

test('parseGetAll keeps the existing structure', () => {
  const r = parseGetAll([
    'pw /V1/MANAGEMENT/NETWORK.HostName=jimmy-hc30',
    'pr /V1/MANAGEMENT/NETWORK.IpAddress=192.168.2.104',
    'n- /V1/MANAGEMENT/NETWORK/AUTH',
    'm- /V1/MANAGEMENT/NETWORK:applySettings',
  ]);
  assert.deepEqual(r.properties[0],
    { nodepath: '/V1/MANAGEMENT/NETWORK', property: 'HostName', value: 'jimmy-hc30', writable: true });
  assert.equal(r.properties[1].writable, false);
  assert.deepEqual(r.nodes, ['/V1/MANAGEMENT/NETWORK/AUTH']);
  assert.deepEqual(r.methods, [{ nodepath: '/V1/MANAGEMENT/NETWORK', method: 'applySettings' }]);
});
