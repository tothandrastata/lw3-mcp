import mdns from 'multicast-dns';
import { EventEmitter } from 'events';

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
        const parsed = this.parseLightwareName(record.data);
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
        const parsed = this.parseLightwareName(instanceName);

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
   * Parse Lightware device name from mDNS service instance
   * Format: "PRODUCT-NAME SERIALNUMBER" or just the service instance prefix
   */
  parseLightwareName(name) {
    // Remove service type suffix if present (e.g., "._lwr3._tcp.local")
    const cleanName = name.split('.')[0];

    // Match pattern: "PRODUCT-NAME SERIALNUMBER"
    // Examples: "UCX-4x2-HC30 00001234", "TPN-CTU-X50 00008839"
    const match = cleanName.match(/^([\w-]+)\s+([A-F0-9]+)$/i);
    if (match) {
      return {
        product: match[1],
        serial: match[2]
      };
    }

    return null;
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
