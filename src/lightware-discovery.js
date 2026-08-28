import mdns from 'multicast-dns';
import { EventEmitter } from 'events';

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

/**
 * Lightware device discovery using mDNS
 * Based on the POC implementation
 */
export class LightwareDiscovery extends EventEmitter {
  constructor() {
    super();
    this.mdns = null;
    this.devices = new Map();
    this.tempDevices = new Map();
    this.discoveryTimeout = null;
  }

  /**
   * Start device discovery
   * @param {number} timeout - Discovery timeout in milliseconds (default: 3000)
   * @returns {Promise<Array>} Array of discovered devices
   */
  async discover(timeout = 3000) {
    return new Promise((resolve, reject) => {
      // Clear previous data
      this.devices.clear();
      this.tempDevices.clear();

      // Create mDNS instance
      this.mdns = mdns();

      // Listen for mDNS responses
      this.mdns.on('response', (response) => {
        this.handleResponse(response);
      });

      this.mdns.on('error', (error) => {
        console.error('[mDNS Error]', error);
      });

      // Query for Lightware devices
      this.queryLightwareDevices();

      // Set timeout to stop discovery
      this.discoveryTimeout = setTimeout(() => {
        this.stopDiscovery();
        resolve(Array.from(this.devices.values()));
      }, timeout);
    });
  }

  /**
   * Stop device discovery
   */
  stopDiscovery() {
    if (this.discoveryTimeout) {
      clearTimeout(this.discoveryTimeout);
      this.discoveryTimeout = null;
    }

    if (this.mdns) {
      this.mdns.destroy();
      this.mdns = null;
    }
  }

  /**
   * Query for Lightware devices
   */
  queryLightwareDevices() {
    // Query for common Lightware service types
    const serviceTypes = [
      '_lwr3._tcp.local',
      '_lara-https._tcp.local',
      '_webldc-http._tcp.local',
      '_rest-http._tcp.local'
    ];

    for (const serviceType of serviceTypes) {
      this.mdns.query({
        questions: [{ name: serviceType, type: 'PTR' }]
      });
    }
  }

  /**
   * Handle mDNS response
   */
  handleResponse(response) {
    if (!response.answers) return;

    // Process all answers and additionals to gather device information
    const allRecords = [...response.answers, ...(response.additionals || [])];

    for (const record of allRecords) {
      // PTR record contains service instance name
      if (record.type === 'PTR' && record.data) {
        const parsed = parseLightwareName(record.data);
        if (parsed) {
          const key = `${parsed.product}_${parsed.serial}`;
          const temp = this.tempDevices.get(key) || {};
          temp.modelName = parsed.product;
          temp.serialNumber = parsed.serial;
          this.tempDevices.set(key, temp);
        }
      }

      // SRV record contains hostname and port
      if (record.type === 'SRV' && record.data) {
        const hostname = record.data.target;
        const instanceName = record.name;
        const parsed = parseLightwareName(instanceName);

        if (parsed) {
          const key = `${parsed.product}_${parsed.serial}`;
          const temp = this.tempDevices.get(key) || {};
          temp.modelName = parsed.product;
          temp.serialNumber = parsed.serial;
          temp.hostname = hostname;
          this.tempDevices.set(key, temp);

          // Query for A record to get IP
          this.mdns.query([
            { name: hostname, type: 'A' },
            { name: hostname, type: 'AAAA' }
          ]);
        }
      }

      // A record contains IPv4 address
      if (record.type === 'A' && record.data) {
        const hostname = record.name;
        const ipAddress = record.data;

        // Try to match this IP to a temp device by hostname
        for (const [key, temp] of this.tempDevices.entries()) {
          if (temp.hostname === hostname) {
            temp.ipAddress = ipAddress;
            this.tempDevices.set(key, temp);

            // If we have all required info, create the device
            if (temp.modelName && temp.serialNumber && temp.ipAddress) {
              this.addDevice({
                modelName: temp.modelName,
                serialNumber: temp.serialNumber,
                ipAddress: temp.ipAddress,
                hostname: temp.hostname || hostname
              });
            }
          }
        }
      }
    }
  }

  /**
   * Add a device to the registry
   */
  addDevice(device) {
    const deviceKey = `${device.modelName}_${device.serialNumber}`;

    if (!this.devices.has(deviceKey)) {
      this.devices.set(deviceKey, device);
      this.emit('deviceDiscovered', device);
    }
  }

  /**
   * Get all discovered devices
   */
  getDevices() {
    return Array.from(this.devices.values());
  }
}
