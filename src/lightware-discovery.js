import mdns from 'multicast-dns';
import { EventEmitter } from 'events';
import os from 'node:os';

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

/**
 * The meta-query returns every service type on the network; keep the Lightware ones.
 * Requires the matched prefix to be followed by - or . to avoid false positives:
 * e.g., _restaurant._tcp.local (begins with "rest") or _larafoo._tcp.local (begins with "lara")
 * must be rejected, while _rest-http._tcp.local and _lara-https._tcp.local are kept.
 */
export const LIGHTWARE_SERVICE = /^_(lwr3|lara|webldc|rest|update-rest|serial\d+)(-|\.)/;

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
 *
 * RFC 6762 §16 requires case-insensitive name comparison, and nothing stops a
 * responder or an mDNS proxy echoing a different case than was queried. Every
 * map key here is lower-cased on write and on read; the values reported to
 * callers (modelName, hostname) keep whatever case the record actually had.
 */
export class DeviceRegistry {
  constructor() {
    this.instances = new Map(); // lower-cased label -> { modelName, serialNumber, hostname }
    this.addresses = new Map(); // lower-cased hostname -> ipAddress
  }

  noteInstance(instanceName) {
    const label = instanceLabel(instanceName);
    if (!label) return;
    const key = label.toLowerCase();
    const parsed = parseLightwareName(instanceName);
    const entry = this.instances.get(key) || {
      modelName: null,
      serialNumber: null,
      hostname: null,
    };
    if (parsed) {
      entry.modelName = parsed.product;
      entry.serialNumber = parsed.serial;
    }
    this.instances.set(key, entry);
  }

  noteHostname(instanceName, hostname) {
    this.noteInstance(instanceName);
    const entry = this.instances.get(instanceLabel(instanceName).toLowerCase());
    if (entry) entry.hostname = hostname;
  }

  noteAddress(hostname, ipAddress) {
    this.addresses.set(String(hostname).toLowerCase(), ipAddress);
  }

  list() {
    return [...this.instances.values()].map((entry) => ({
      modelName: entry.modelName,
      serialNumber: entry.serialNumber,
      ipAddress: entry.hostname ? this.addresses.get(entry.hostname.toLowerCase()) ?? null : null,
      hostname: entry.hostname,
    }));
  }
}

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

/**
 * Lightware device discovery using mDNS
 * Based on the POC implementation
 */
export class LightwareDiscovery extends EventEmitter {
  /**
   * @param {object} [factories] - injectable for tests
   * @param {(address: string) => object} [factories.createSocket]
   * @param {() => string[]} [factories.listInterfaces]
   */
  constructor(factories = {}) {
    super();
    this.createSocket =
      factories.createSocket || ((address) => mdns({ interface: address, bind: '0.0.0.0' }));
    this.listInterfaces = factories.listInterfaces || externalIPv4Addresses;
    this.sockets = [];
    this.registry = new DeviceRegistry();
    this.serviceTypes = new Set(KNOWN_SERVICE_TYPES);
    this.timers = [];
    this.discovering = false;
  }

  /**
   * One-shot discovery.
   * @param {number} [timeout] - window in milliseconds
   * @returns {Promise<Array<{modelName, serialNumber, ipAddress, hostname}>>}
   */
  async discover(timeout = 3000) {
    // stopDiscovery() clears every timer this instance owns. Without this guard, a
    // second concurrent call would clear the first call's pending resolve timer
    // out from under it, and nothing would ever settle the first call's promise.
    if (this.discovering) {
      throw new Error(
        'Discovery already in progress; await the pending discover() call before starting another.'
      );
    }
    this.discovering = true;
    try {
      this.stopDiscovery();
      this.registry = new DeviceRegistry();
      this.serviceTypes = new Set(lightwareServiceTypes());

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

      return this.registry.list();
    } finally {
      this.stopDiscovery();
      this.discovering = false;
    }
  }

  stopDiscovery() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    for (const socket of this.sockets) {
      try { socket.destroy(); } catch { /* already gone */ }
    }
    this.sockets = [];
  }

  /** Ask every socket for the service enumeration and every known service type. */
  sendQueries() {
    const names = [SERVICE_ENUMERATION, ...this.serviceTypes];
    for (const socket of this.sockets) {
      for (const name of names) {
        try { socket.query({ questions: [{ name, type: 'PTR' }] }); } catch { /* socket closing */ }
      }
    }
  }

  /**
   * Feed one response into the registry. Records may arrive on any socket and in
   * any order; the registry joins them at the end.
   */
  handleResponse(response, socket) {
    const records = [...(response.answers || []), ...(response.additionals || [])];

    for (const record of records) {
      if (!record || !record.data) continue;

      // RFC 6762 §16: name comparisons are case-insensitive. Nothing stops a
      // responder or an mDNS proxy echoing back different case than we queried
      // with, so every comparison against this.serviceTypes (which holds only
      // lower-case entries) normalises its input to lower case first.
      if (record.type === 'PTR' && String(record.name).toLowerCase() === SERVICE_ENUMERATION) {
        const type = String(record.data).toLowerCase();
        if (LIGHTWARE_SERVICE.test(type) && !this.serviceTypes.has(type)) {
          this.serviceTypes.add(type);
          try { socket.query({ questions: [{ name: type, type: 'PTR' }] }); } catch { /* closing */ }
        }
        continue;
      }

      // mDNS is broadcast: this response event fires for every announcement on
      // the segment, not only for answers to our own questions. A PTR/SRV only
      // describes a Lightware device when it answers a service type we asked
      // about (this.serviceTypes) — otherwise it's a foreign device (a
      // Chromecast, a smart plug, ...) that happened to also be on the wire.
      if (record.type === 'PTR') {
        if (this.serviceTypes.has(String(record.name).toLowerCase())) {
          this.registry.noteInstance(String(record.data));
        }
        continue;
      }

      if (record.type === 'SRV' && record.data.target) {
        const instanceName = String(record.name);
        const serviceType = instanceName.slice(instanceName.indexOf('.') + 1).toLowerCase();
        if (this.serviceTypes.has(serviceType)) {
          this.registry.noteHostname(instanceName, record.data.target);
          try {
            socket.query({ questions: [{ name: record.data.target, type: 'A' }] });
          } catch { /* closing */ }
        }
        continue;
      }

      if (record.type === 'A') {
        this.registry.noteAddress(String(record.name), record.data);
      }
    }
  }
}
