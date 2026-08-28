import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LightwareDiscovery, SERVICE_ENUMERATION } from '../src/lightware-discovery.js';

/** Stands in for one multicast-dns socket. */
class FakeSocket extends EventEmitter {
  constructor(address) { super(); this.address = address; this.queries = []; this.destroyed = false; }
  query(arg) { this.queries.push(arg); }
  destroy() { this.destroyed = true; }
  /** Feed a response in, as the real socket would. */
  respond(answers) { this.emit('response', { answers, additionals: [] }); }
}

const build = (addresses, { failOn = [] } = {}) => {
  const sockets = [];
  const discovery = new LightwareDiscovery({
    listInterfaces: () => addresses,
    createSocket: (address) => {
      if (failOn.includes(address)) throw new Error(`cannot bind ${address}`);
      const s = new FakeSocket(address);
      sockets.push(s);
      return s;
    },
  });
  return { discovery, sockets };
};

test('creates one socket per external interface', async () => {
  const { discovery, sockets } = build(['192.168.2.101', '172.22.240.1', '169.254.83.107']);
  const p = discovery.discover(150);
  await p;
  assert.deepEqual(sockets.map((s) => s.address),
    ['192.168.2.101', '172.22.240.1', '169.254.83.107'],
    'transmitting on only one interface is what makes discovery look random');
});

test('an interface that will not bind is skipped, and the rest still run', async () => {
  const { discovery, sockets } = build(['192.168.2.101', '172.22.240.1'], { failOn: ['172.22.240.1'] });
  const devices = await discovery.discover(150);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].address, '192.168.2.101');
  assert.deepEqual(devices, [], 'one dead adapter must not fail the whole scan');
});

test('rejects when no interface yields a socket', async () => {
  const { discovery } = build(['192.168.2.101'], { failOn: ['192.168.2.101'] });
  await assert.rejects(() => discovery.discover(150), (err) => {
    assert.match(err.message, /interface/i,
      'an empty array here would be indistinguishable from "no devices found"');
    return true;
  });
});

test('asks for the service-type enumeration as well as the known types', async () => {
  const { discovery, sockets } = build(['192.168.2.101']);
  await discovery.discover(150);
  const asked = sockets[0].queries.flatMap((q) => (q.questions || q).map((x) => x.name));
  assert.ok(asked.includes(SERVICE_ENUMERATION), 'the meta-query is how new service names are found');
  assert.ok(asked.includes('_lwr3-wss._tcp.local'), 'the secure variant is what the test device advertises');
  assert.ok(asked.includes('_lwr3._tcp.local'), 'the plain variant must still be asked for');
});

test('queries are re-issued during the window, not sent once', async () => {
  const { discovery, sockets } = build(['192.168.2.101']);
  await discovery.discover(400);
  const rounds = sockets[0].queries.filter((q) =>
    (q.questions || []).some((x) => x.name === SERVICE_ENUMERATION)).length;
  assert.ok(rounds >= 2,
    `the PTR->SRV->A chase needs more than one shot; saw ${rounds} enumeration queries`);
});

test('a service type learned from the enumeration gets queried', async () => {
  const { discovery, sockets } = build(['192.168.2.101']);
  const p = discovery.discover(400);
  sockets[0].respond([{ type: 'PTR', name: SERVICE_ENUMERATION, data: '_lwr3-brandnew._tcp.local' }]);
  await p;
  const asked = sockets[0].queries.flatMap((q) => (q.questions || []).map((x) => x.name));
  assert.ok(asked.includes('_lwr3-brandnew._tcp.local'));
});

test('builds a device from records arriving across two interfaces', async () => {
  const { discovery, sockets } = build(['192.168.2.101', '172.22.240.1']);
  const p = discovery.discover(300);
  sockets[0].respond([
    { type: 'PTR', name: '_lwr3-wss._tcp.local', data: 'UCX-4x2-HC30 00001234._lwr3-wss._tcp.local' },
  ]);
  sockets[1].respond([
    { type: 'SRV', name: 'UCX-4x2-HC30 00001234._lwr3-wss._tcp.local', data: { target: 'jimmy-hc30.local' } },
    { type: 'A', name: 'jimmy-hc30.local', data: '192.168.2.104' },
  ]);
  assert.deepEqual(await p, [{
    modelName: 'UCX-4x2-HC30', serialNumber: '00001234',
    ipAddress: '192.168.2.104', hostname: 'jimmy-hc30.local',
  }], 'the same device on two interfaces is one entry, not two');
});

test('a PTR for a service type we did not query is ignored', async () => {
  const { discovery, sockets } = build(['192.168.2.101']);
  const p = discovery.discover(150);
  sockets[0].respond([
    { type: 'PTR', name: '_googlecast._tcp.local',
      data: 'd9d84bbe-0c29-910f-db15-e6b9fcc04173._googlecast._tcp.local' },
    { type: 'PTR', name: '_lwr3-wss._tcp.local',
      data: 'UCX-4x2-HC30 00001234._lwr3-wss._tcp.local' },
  ]);
  const devices = await p;
  assert.deepEqual(devices, [{
    modelName: 'UCX-4x2-HC30', serialNumber: '00001234',
    ipAddress: null, hostname: null,
  }], 'mDNS is broadcast: an unsolicited _googlecast PTR must not become a phantom device');
});

test('a service type learned from the enumeration is still accepted, foreign types still rejected', async () => {
  const { discovery, sockets } = build(['192.168.2.101']);
  const p = discovery.discover(150);
  sockets[0].respond([
    { type: 'PTR', name: SERVICE_ENUMERATION, data: '_lwr3-brandnew._tcp.local' },
  ]);
  sockets[0].respond([
    { type: 'PTR', name: '_googlecast._tcp.local', data: 'foreign-cast._googlecast._tcp.local' },
    { type: 'PTR', name: '_lwr3-brandnew._tcp.local',
      data: 'UCX-9000 ABCDEF01._lwr3-brandnew._tcp.local' },
  ]);
  const devices = await p;
  assert.deepEqual(devices, [{
    modelName: 'UCX-9000', serialNumber: 'ABCDEF01',
    ipAddress: null, hostname: null,
  }], 'a Lightware-shaped type learned via the enumeration must still be queried and accepted');
});

test('every socket is destroyed when the scan ends', async () => {
  const { discovery, sockets } = build(['192.168.2.101', '172.22.240.1']);
  await discovery.discover(150);
  assert.ok(sockets.every((s) => s.destroyed), 'a leaked socket keeps a multicast membership open');
});
