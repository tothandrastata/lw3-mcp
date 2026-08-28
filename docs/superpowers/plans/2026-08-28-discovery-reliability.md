# Discovery Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `discover` find the devices that are actually on the network — including the ones it currently misses silently while LDC sees them.

**Architecture:** The record-handling logic becomes a pure, injectable `DeviceRegistry` that can be tested with synthetic packets and no network. Around it, `discover` queries the union of a known service-type list and a live meta-query enumeration, sends on every external IPv4 interface rather than whichever one the OS picks, and reports every Lightware instance it saw with `null` for whatever it could not learn.

**Tech Stack:** Node 22, ES modules, `node:test`, `multicast-dns`.

**Spec:** [2026-08-28-discovery-reliability-design.md](../specs/2026-08-28-discovery-reliability-design.md)

## Global Constraints

- **No new dependencies.** `dependencies` stays exactly `@modelcontextprotocol/sdk`, `multicast-dns`, `ws`.
- **Do not modify `src/lw3-protocol.js` or `src/transports/`.** This change is confined to discovery.
- **`src/index.js` changes only if `handleDiscover` needs it** — it currently maps four fields onto the output and those fields may now be `null`.
- **ES modules.** `.js` extensions on relative imports.
- **`_lmdmp._udp.local` is deliberately excluded** — a UDP management protocol, not an LW3 endpoint.
- **IPv6 and `AAAA` are out of scope.** Existing `AAAA` queries may stay but nothing consumes them.
- **The default discovery window stays 3000 ms**, and remains the `timeout` parameter.
- **Every Lightware instance seen is reported**, with `modelName`, `serialNumber`, `ipAddress` and `hostname` individually nullable. Nothing is dropped silently.
- Test script stays `"test": "node --test tests/*.js"`.

## Verified Facts

Measured on 2026-08-28 against a live network with a UCX-4x2-HC30 (`jimmy-hc30`, 192.168.2.104). Trust these; do not re-derive.

- Querying today's four service types returns **0 instances**. Querying `_lwr3-wss`, `_webldc-https`, `_rest-https`, `_update-rest-https` returns **4**, all named `UCX-4x2-HC30 00001234`.
- The device reports `HTTP.Enabled = false`, `HTTPS.Enabled = true` — which is why it advertises only the secure variants.
- The meta-query `_services._dns-sd._udp.local` returns the same 7 Lightware types at 2000, 3000 and 5000 ms windows. A 2000 ms window suffices.
- This machine has four external IPv4 interfaces, three virtual: `169.254.83.107` (Tailscale), `192.168.2.101` (LAN), `172.22.240.1` and `172.18.112.1` (Hyper-V).
- `multicast-dns` receives on all interfaces but transmits on one, `defaultInterface()`, which returns `'0.0.0.0'` on Windows — the OS chooses.
- `parseLightwareName('UCX-4x2-HC30 00001234')` parses; `parseLightwareName('jimmy-hc30')` returns null and the device is then dropped entirely.
- The filter `/^_(lwr3|lara|webldc|rest|update-rest|serial\d)/` keeps all six Lightware service types on that network and drops `_lmdmp._udp`, `_googlecast`, `_home-assistant`, `_ASUSTOR_NVR` and `_http`.

---

### Task 1: The pure discovery logic

Everything that interprets mDNS records, with no sockets. Today this logic is entangled with the live `mdns` instance, so none of it can be tested. Extracting it is what makes the rest of the work verifiable.

The current code also has an ordering bug this design removes: it fills in an IP address only when the A record arrives *after* the SRV, because it scans `tempDevices` at A-record time. The registry instead joins instances to addresses at the end, so record order stops mattering.

**Files:**
- Modify: `src/lightware-discovery.js` (add module-level exports; `parseLightwareName` moves off the class)
- Create: `tests/discovery-logic.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces, all exported from `src/lightware-discovery.js`:
  - `KNOWN_SERVICE_TYPES: string[]`
  - `LIGHTWARE_SERVICE: RegExp`
  - `lightwareServiceTypes(enumerated?: string[]): string[]` — union of the known list and the filtered enumeration, deduplicated
  - `instanceLabel(name: string): string` — the instance label, i.e. everything before the first dot
  - `parseLightwareName(name: string): { product: string, serial: string } | null`
  - `class DeviceRegistry` with `noteInstance(instanceName)`, `noteHostname(instanceName, hostname)`, `noteAddress(hostname, ipAddress)`, and `list(): Array<{modelName, serialNumber, ipAddress, hostname}>`

  Task 2 drives the registry from live packets.

- [ ] **Step 1: Write the failing tests**

Create `tests/discovery-logic.test.js`:

```js
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
  for (const t of ['_lwr3-wss._tcp.local', '_webldc-https._tcp.local', '_rest-https._tcp.local',
                   '_update-rest-https._tcp.local', '_serial1._tcp.local', '_serial2._tcp.local']) {
    assert.ok(LIGHTWARE_SERVICE.test(t), `should keep ${t}`);
  }
  // _lmdmp is a UDP management protocol, not an LW3 endpoint — deliberately excluded.
  for (const t of ['_lmdmp._udp.local', '_googlecast._tcp.local', '_home-assistant._tcp.local',
                   '_ASUSTOR_NVR._tcp.local', '_http._tcp.local']) {
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL with `SyntaxError: … does not provide an export named 'DeviceRegistry'`. The existing 61 tests still pass.

- [ ] **Step 3: Add the module-level logic**

At the top of `src/lightware-discovery.js`, below the imports, add:

```js
/**
 * Service types Lightware devices are known to advertise. Both the plain and the
 * secure variants: a device with its HTTP service disabled publishes only the
 * -https/-wss forms, and querying just the plain ones makes it invisible.
 */
export const KNOWN_SERVICE_TYPES = [
  '_lwr3._tcp.local',
  '_lwr3-wss._tcp.local',
  '_lara-https._tcp.local',
  '_webldc-http._tcp.local',
  '_webldc-https._tcp.local',
  '_rest-http._tcp.local',
  '_rest-https._tcp.local',
  '_update-rest-https._tcp.local',
];

/** The meta-query returns every service type on the network; keep the Lightware ones. */
export const LIGHTWARE_SERVICE = /^_(lwr3|lara|webldc|rest|update-rest|serial\d)/;

/** The standard DNS-SD query that enumerates a network's service types. */
export const SERVICE_ENUMERATION = '_services._dns-sd._udp.local';

/**
 * Which service types to query: the known list, plus anything Lightware-looking
 * the network told us about. Either source alone can miss a device — a new
 * firmware name, or a device that ignores the meta-query — so both are used.
 */
export function lightwareServiceTypes(enumerated = []) {
  const discovered = enumerated.filter((t) => LIGHTWARE_SERVICE.test(t));
  return [...new Set([...KNOWN_SERVICE_TYPES, ...discovered])];
}

/** The instance label: everything before the first dot. */
export function instanceLabel(name) {
  return String(name).split('.')[0];
}

/**
 * Read "PRODUCT-NAME SERIALNUMBER" out of an instance name.
 * Returns null for any other shape — the caller reports the device anyway.
 */
export function parseLightwareName(name) {
  const match = instanceLabel(name).match(/^([\w-]+)\s+([A-F0-9]+)$/i);
  return match ? { product: match[1], serial: match[2] } : null;
}

/**
 * Accumulates mDNS records into devices.
 *
 * Instances are keyed by their label, so one device advertising several service
 * types is one entry. Addresses are kept separately and joined at list() time,
 * which makes record arrival order irrelevant — the previous implementation only
 * matched an address to a device if the A record arrived after the SRV.
 */
export class DeviceRegistry {
  constructor() {
    this.instances = new Map(); // label -> { modelName, serialNumber, hostname }
    this.addresses = new Map(); // hostname -> ipAddress
  }

  noteInstance(instanceName) {
    const label = instanceLabel(instanceName);
    if (!label) return;
    const parsed = parseLightwareName(instanceName);
    const entry = this.instances.get(label) || {
      modelName: null,
      serialNumber: null,
      hostname: null,
    };
    if (parsed) {
      entry.modelName = parsed.product;
      entry.serialNumber = parsed.serial;
    }
    this.instances.set(label, entry);
  }

  noteHostname(instanceName, hostname) {
    this.noteInstance(instanceName);
    const entry = this.instances.get(instanceLabel(instanceName));
    if (entry) entry.hostname = hostname;
  }

  noteAddress(hostname, ipAddress) {
    this.addresses.set(hostname, ipAddress);
  }

  list() {
    return [...this.instances.values()].map((entry) => ({
      modelName: entry.modelName,
      serialNumber: entry.serialNumber,
      ipAddress: entry.hostname ? this.addresses.get(entry.hostname) ?? null : null,
      hostname: entry.hostname,
    }));
  }
}
```

Then delete the `parseLightwareName(name)` **method** from the class — the module-level function replaces it. Leave every other method alone for now; Task 2 rewires them.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`

Expected: PASS, 75 tests (61 existing + 14 new), 0 failures, pristine output.

- [ ] **Step 5: Commit**

```bash
git add src/lightware-discovery.js tests/discovery-logic.test.js
git commit -m "Extract discovery record handling into a testable registry"
```

---

### Task 2: Query every interface, and every service type

With the logic extracted, the socket layer becomes small: create one mDNS socket per external IPv4 interface, run the meta-query and the service queries on all of them, feed every record into the registry, and resolve with whatever it holds.

**Files:**
- Modify: `src/lightware-discovery.js` (constructor, `discover`, `stopDiscovery`, `queryLightwareDevices`, `handleResponse`; delete `addDevice`, `getDevices`, `tempDevices`)
- Create: `tests/discovery-sockets.test.js`

**Interfaces:**
- Consumes: `lightwareServiceTypes`, `instanceLabel`, `DeviceRegistry`, `SERVICE_ENUMERATION`, `KNOWN_SERVICE_TYPES` from Task 1.
- Produces:
  - `new LightwareDiscovery(factories?)` where `factories` is `{ createSocket?: (address) => mdnsSocket, listInterfaces?: () => string[] }`, both defaulting to the real implementations
  - `discover(timeout = 3000): Promise<Array<{modelName, serialNumber, ipAddress, hostname}>>`
  - `stopDiscovery(): void`

- [ ] **Step 1: Write the failing tests**

Create `tests/discovery-sockets.test.js`:

```js
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

test('every socket is destroyed when the scan ends', async () => {
  const { discovery, sockets } = build(['192.168.2.101', '172.22.240.1']);
  await discovery.discover(150);
  assert.ok(sockets.every((s) => s.destroyed), 'a leaked socket keeps a multicast membership open');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL. `LightwareDiscovery`'s constructor ignores the factories, so it builds real sockets and the assertions about `sockets` fail or the calls time out.

- [ ] **Step 3: Rewire the class**

In `src/lightware-discovery.js`, add `os` to the imports:

```js
import os from 'node:os';
```

Replace the constructor:

```js
  /**
   * @param {object} [factories] - injectable for tests
   * @param {(address: string) => object} [factories.createSocket]
   * @param {() => string[]} [factories.listInterfaces]
   */
  constructor(factories = {}) {
    super();
    this.createSocket = factories.createSocket || ((address) => mdns({ interface: address }));
    this.listInterfaces = factories.listInterfaces || externalIPv4Addresses;
    this.sockets = [];
    this.registry = new DeviceRegistry();
    this.serviceTypes = new Set(KNOWN_SERVICE_TYPES);
    this.timers = [];
  }
```

Add this module-level helper next to the other exports:

```js
/**
 * Every external IPv4 address on this machine.
 *
 * multicast-dns receives on all interfaces but transmits on one, chosen by the
 * OS. On a machine with virtual adapters that choice can land on a Hyper-V
 * switch, and the query never reaches the LAN. One socket per address removes
 * the guess.
 */
export function externalIPv4Addresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}
```

Replace `discover`:

```js
  /**
   * One-shot discovery.
   * @param {number} [timeout] - window in milliseconds
   * @returns {Promise<Array<{modelName, serialNumber, ipAddress, hostname}>>}
   */
  async discover(timeout = 3000) {
    this.stopDiscovery();
    this.registry = new DeviceRegistry();
    this.serviceTypes = new Set(KNOWN_SERVICE_TYPES);

    const addresses = this.listInterfaces();
    const candidates = addresses.length > 0 ? addresses : [undefined];

    for (const address of candidates) {
      try {
        const socket = this.createSocket(address);
        socket.on('response', (response) => this.handleResponse(response, socket));
        socket.on('error', (error) => console.error('[mDNS Error]', address, error.message));
        this.sockets.push(socket);
      } catch (error) {
        // A disconnected adapter or a permission failure must not fail the scan.
        console.error('[mDNS] skipping interface', address, error.message);
      }
    }

    if (this.sockets.length === 0) {
      throw new Error(
        `Discovery could not open a socket on any network interface (tried: ${addresses.join(', ') || 'none'})`
      );
    }

    // Three rounds inside the window: the PTR -> SRV -> A chase needs more than one shot.
    this.sendQueries();
    for (const fraction of [1 / 3, 2 / 3]) {
      this.timers.push(setTimeout(() => this.sendQueries(), Math.floor(timeout * fraction)));
    }

    await new Promise((resolve) => this.timers.push(setTimeout(resolve, timeout)));

    const devices = this.registry.list();
    this.stopDiscovery();
    return devices;
  }
```

Replace `stopDiscovery`:

```js
  stopDiscovery() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    for (const socket of this.sockets) {
      try { socket.destroy(); } catch { /* already gone */ }
    }
    this.sockets = [];
  }
```

Replace `queryLightwareDevices` with:

```js
  /** Ask every socket for the service enumeration and every known service type. */
  sendQueries() {
    const names = [SERVICE_ENUMERATION, ...this.serviceTypes];
    for (const socket of this.sockets) {
      for (const name of names) {
        try { socket.query({ questions: [{ name, type: 'PTR' }] }); } catch { /* socket closing */ }
      }
    }
  }
```

Replace `handleResponse`:

```js
  /**
   * Feed one response into the registry. Records may arrive on any socket and in
   * any order; the registry joins them at the end.
   */
  handleResponse(response, socket) {
    const records = [...(response.answers || []), ...(response.additionals || [])];

    for (const record of records) {
      if (!record || !record.data) continue;

      if (record.type === 'PTR' && record.name === SERVICE_ENUMERATION) {
        const type = String(record.data);
        if (LIGHTWARE_SERVICE.test(type) && !this.serviceTypes.has(type)) {
          this.serviceTypes.add(type);
          try { socket.query({ questions: [{ name: type, type: 'PTR' }] }); } catch { /* closing */ }
        }
        continue;
      }

      if (record.type === 'PTR') {
        this.registry.noteInstance(String(record.data));
        continue;
      }

      if (record.type === 'SRV' && record.data.target) {
        this.registry.noteHostname(String(record.name), record.data.target);
        try {
          socket.query({ questions: [{ name: record.data.target, type: 'A' }] });
        } catch { /* closing */ }
        continue;
      }

      if (record.type === 'A') {
        this.registry.noteAddress(String(record.name), record.data);
      }
    }
  }
```

Finally delete the `addDevice(device)` and `getDevices()` methods — the registry replaces both — and remove `this.devices` / `this.tempDevices` if any reference remains.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`

Expected: PASS, 83 tests (75 from Task 1 + 8 new), 0 failures.

- [ ] **Step 5: Confirm nothing references the removed state**

Run: `grep -n "tempDevices\|this.devices\|addDevice\|getDevices\|this.mdns" src/lightware-discovery.js src/index.js`

Expected: no output. Any hit is a reference to state this task deleted.

- [ ] **Step 6: Find the device that discovery currently misses**

Run:

```bash
node -e 'import("./src/lightware-discovery.js").then(async ({LightwareDiscovery})=>{
const d=new LightwareDiscovery(); const r=await d.discover(4000); d.stopDiscovery();
console.log(JSON.stringify(r,null,2)); });'
```

Expected: at least one device. On the network this was written against, `UCX-4x2-HC30` / `00001234` / `192.168.2.104` / `jimmy-hc30.local` — which today's code returns nothing for.

If this returns `[]` while the device is reachable, stop and report it rather than adjusting the test to pass.

- [ ] **Step 7: Commit**

```bash
git add src/lightware-discovery.js tests/discovery-sockets.test.js
git commit -m "Query every interface and both plain and secure service types"
```

---

### Task 3: Documentation

`CLAUDE.md` and `README.md` both describe the discovery behaviour this change replaces, including the service-type list and the silent drop.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the behaviour built in Tasks 1 and 2.
- Produces: nothing.

- [ ] **Step 1: Find the stale claims**

Run: `grep -n "_lwr3\|_lara\|_rest-http\|_webldc\|mDNS\|discover\|Discovery" CLAUDE.md README.md`

Read each hit in context. The claims that are now false:

- The four-service-type list, wherever it appears.
- Any statement that devices are dropped, or reported only when model, serial and IP are all known.
- Any statement implying a single mDNS socket.

- [ ] **Step 2: Rewrite those passages**

The behaviour to describe, in each document's existing voice:

- Discovery queries the union of a known service-type list — both plain and `-https`/`-wss` variants — and whatever Lightware-looking types the network's own `_services._dns-sd._udp.local` enumeration reports.
- The secure variants matter: a device with its HTTP service disabled advertises only those, and querying the plain names alone makes it invisible.
- One mDNS socket is opened per external IPv4 interface, because `multicast-dns` transmits on only one interface otherwise and the OS may pick a virtual adapter.
- Every Lightware instance found is reported. `modelName` and `serialNumber` are `null` when the instance name is not `PRODUCT SERIAL`; `ipAddress` is `null` when no A record arrived. Nothing is discarded silently.
- Queries are re-issued three times inside the window to cover the PTR → SRV → A chase.
- `_lmdmp._udp.local` is excluded deliberately: a UDP management protocol, not an LW3 endpoint.

Keep `CLAUDE.md` concise; it is an orientation document.

- [ ] **Step 3: Verify no stale claim survives**

Run: `grep -n "_lara-https\|_webldc-http\b\|_rest-http\b" CLAUDE.md README.md`

Expected: hits only where the plain variant is listed *alongside* its secure counterpart. A lone plain-variant list is the stale claim.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "Document the discovery fixes"
```

---

## Manual verification against real hardware

- [ ] `discover` finds `jimmy-hc30` — the device it misses today while LDC sees it.
- [ ] Run it three times; the result is stable across runs.
- [ ] The returned entry carries a usable `ipAddress` or `hostname`.

## Done when

- `npm test` passes with 83 tests.
- `discover` returns the device that today's code returns nothing for.
- `npm run bundle` exits 0.
