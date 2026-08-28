import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_SERVICE_TYPES,
  LIGHTWARE_SERVICE,
  lightwareServiceTypes,
  instanceLabel,
  parseLightwareName,
  DeviceRegistry,
} from '../src/lightware-discovery.js';

test('the known list covers both the plain and the secure variants', () => {
  for (const t of [
    '_lwr3._tcp.local', '_lwr3-wss._tcp.local',
    '_webldc-http._tcp.local', '_webldc-https._tcp.local',
    '_rest-http._tcp.local', '_rest-https._tcp.local',
  ]) {
    assert.ok(KNOWN_SERVICE_TYPES.includes(t), `missing ${t}`);
  }
});

test('the filter keeps Lightware types and drops everything else', () => {
  for (const t of ['_lwr3._tcp.local', '_lwr3-wss._tcp.local', '_lara-https._tcp.local',
                   '_webldc-http._tcp.local', '_webldc-https._tcp.local', '_rest-http._tcp.local',
                   '_rest-https._tcp.local', '_update-rest-https._tcp.local', '_serial1._tcp.local', '_serial2._tcp.local',
                   '_serial10._tcp.local']) {
    assert.ok(LIGHTWARE_SERVICE.test(t), `should keep ${t}`);
  }
  // _lmdmp is a UDP management protocol, not an LW3 endpoint — deliberately excluded.
  // _restaurant and _larafoo are false positives: they begin with Lightware words but lack the - or . boundary.
  for (const t of ['_lmdmp._udp.local', '_googlecast._tcp.local', '_home-assistant._tcp.local',
                   '_ASUSTOR_NVR._tcp.local', '_http._tcp.local', '_restaurant._tcp.local', '_larafoo._tcp.local']) {
    assert.ok(!LIGHTWARE_SERVICE.test(t), `should drop ${t}`);
  }
});

test('service types are the union of the known list and the enumeration', () => {
  const types = lightwareServiceTypes(['_lwr3-brandnew._tcp.local', '_googlecast._tcp.local']);
  assert.ok(types.includes('_lwr3-brandnew._tcp.local'), 'a type only the meta-query knows must be queried');
  assert.ok(types.includes('_lwr3._tcp.local'), 'the known list must still be queried');
  assert.ok(!types.includes('_googlecast._tcp.local'), 'non-Lightware types must not be queried');
});

test('the union has no duplicates', () => {
  const types = lightwareServiceTypes(['_lwr3._tcp.local', '_lwr3._tcp.local']);
  assert.equal(new Set(types).size, types.length);
});

test('with no enumeration it falls back to the known list alone', () => {
  assert.deepEqual(lightwareServiceTypes(), KNOWN_SERVICE_TYPES);
});

test('instanceLabel strips the service type', () => {
  assert.equal(instanceLabel('UCX-4x2-HC30 00001234._lwr3-wss._tcp.local'), 'UCX-4x2-HC30 00001234');
  assert.equal(instanceLabel('jimmy-hc30.local'), 'jimmy-hc30');
});

test('parseLightwareName reads PRODUCT SERIAL, and returns null otherwise', () => {
  assert.deepEqual(parseLightwareName('UCX-4x2-HC30 00001234._lwr3-wss._tcp.local'),
    { product: 'UCX-4x2-HC30', serial: '00001234' });
  assert.equal(parseLightwareName('jimmy-hc30.local'), null);
});

test('a device seen under several service types is one entry', () => {
  const r = new DeviceRegistry();
  for (const type of ['_lwr3-wss', '_webldc-https', '_rest-https']) {
    r.noteInstance(`UCX-4x2-HC30 00001234.${type}._tcp.local`);
  }
  assert.equal(r.list().length, 1);
});

test('records fill an entry progressively, in any order', () => {
  const r = new DeviceRegistry();
  r.noteInstance('UCX-4x2-HC30 00001234._lwr3-wss._tcp.local');
  r.noteHostname('UCX-4x2-HC30 00001234._lwr3-wss._tcp.local', 'jimmy-hc30.local');
  r.noteAddress('jimmy-hc30.local', '192.168.2.104');
  assert.deepEqual(r.list(), [{
    modelName: 'UCX-4x2-HC30', serialNumber: '00001234',
    ipAddress: '192.168.2.104', hostname: 'jimmy-hc30.local',
  }]);
});

test('an address arriving before its SRV is still joined', () => {
  const r = new DeviceRegistry();
  // This is the ordering the old code dropped: it only scanned for a match at A-record time.
  r.noteAddress('jimmy-hc30.local', '192.168.2.104');
  r.noteInstance('UCX-4x2-HC30 00001234._lwr3-wss._tcp.local');
  r.noteHostname('UCX-4x2-HC30 00001234._lwr3-wss._tcp.local', 'jimmy-hc30.local');
  assert.equal(r.list()[0].ipAddress, '192.168.2.104');
});

test('a device whose name does not parse is reported, not dropped', () => {
  const r = new DeviceRegistry();
  r.noteInstance('jimmy-hc30._lwr3-wss._tcp.local');
  r.noteHostname('jimmy-hc30._lwr3-wss._tcp.local', 'jimmy-hc30.local');
  r.noteAddress('jimmy-hc30.local', '192.168.2.104');
  assert.deepEqual(r.list(), [{
    modelName: null, serialNumber: null,
    ipAddress: '192.168.2.104', hostname: 'jimmy-hc30.local',
  }], 'the old code discarded this device entirely');
});

test('two unparsed devices do not collide', () => {
  const r = new DeviceRegistry();
  r.noteInstance('alpha._lwr3-wss._tcp.local');
  r.noteHostname('alpha._lwr3-wss._tcp.local', 'alpha.local');
  r.noteInstance('beta._lwr3-wss._tcp.local');
  r.noteHostname('beta._lwr3-wss._tcp.local', 'beta.local');
  assert.equal(r.list().length, 2, 'the old key collapsed these into one undefined_undefined entry');
});

test('a device with no A record is still reported, by hostname', () => {
  const r = new DeviceRegistry();
  r.noteInstance('UCX-4x2-HC30 00001234._lwr3-wss._tcp.local');
  r.noteHostname('UCX-4x2-HC30 00001234._lwr3-wss._tcp.local', 'jimmy-hc30.local');
  const [d] = r.list();
  assert.equal(d.ipAddress, null);
  assert.equal(d.hostname, 'jimmy-hc30.local', 'connect accepts a hostname, so this is still usable');
});

test('an empty registry lists nothing', () => {
  assert.deepEqual(new DeviceRegistry().list(), []);
});

// RFC 6762 §16 requires case-insensitive name comparison, and nothing stops a
// responder or an mDNS proxy echoing back different case than was queried.

test('an instance label differing only in case between the PTR data and the SRV name is one device, not two', () => {
  const r = new DeviceRegistry();
  r.noteInstance('UCX-4x2-HC30 00001234._lwr3-wss._tcp.local'); // as seen in the PTR
  r.noteHostname('ucx-4x2-hc30 00001234._lwr3-wss._tcp.local', 'jimmy-hc30.local'); // as seen in the SRV
  const list = r.list();
  assert.equal(list.length, 1,
    'case must not split one device into two incomplete entries; the old code keyed by exact-case label');
  assert.equal(list[0].hostname, 'jimmy-hc30.local');
});

test('an A-record name differing in case from the SRV target still resolves the address', () => {
  const r = new DeviceRegistry();
  r.noteInstance('UCX-4x2-HC30 00001234._lwr3-wss._tcp.local');
  r.noteHostname('UCX-4x2-HC30 00001234._lwr3-wss._tcp.local', 'Jimmy-HC30.local');
  r.noteAddress('JIMMY-hc30.LOCAL', '192.168.2.104'); // A record name, different case than the SRV target
  const [d] = r.list();
  assert.equal(d.ipAddress, '192.168.2.104',
    'case-insensitive address lookup must still join the A record to its device');
  assert.equal(d.hostname, 'Jimmy-HC30.local', 'the reported hostname keeps its original case');
});
