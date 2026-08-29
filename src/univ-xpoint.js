/**
 * Dialect-aware video crosspoint model.
 *
 * src/xpoint.js models one device family: ports named I1/O1, routing in
 * ConnectedSource, names in Name. The TPN-MMU family names its ports after the
 * stream (41759AEC60DF_S0, 2D66D972A0C8_D0), routes with SourceStream and names
 * with StreamAlias, so that model produces an empty grid for it.
 *
 * This is a separate module rather than a generalisation of src/xpoint.js
 * because the `xpoint` tool is in use and must not change behaviour. The two
 * will converge once this one has been exercised against real hardware.
 *
 * Nothing here talks to a device. It turns GETALL reply lines into a grid, and
 * decides what each cell means.
 */

export const XP_NODE = '/V1/MEDIA/VIDEO/XP';
export const VIDEO_NODE = '/V1/MEDIA/VIDEO';

/** The device reports booleans as the strings "true" and "false". */
const asBool = (value) => value === 'true';

/** `pw /path.Prop=value` -> { path, prop, value }; anything else -> null. */
function parseProperty(line) {
  const match = line.match(/^p[rw] (.+?)\.([^=]+)=(.*)$/);
  return match ? { path: match[1], prop: match[2], value: match[3] } : null;
}

/**
 * How a device family identifies its ports and states its routing.
 *
 * `disconnect` is the value that clears a destination, or null where no such
 * value is known. Offering a Disconnect control whose value we are guessing is
 * worse than not offering one: on real hardware a wrong token could be accepted
 * as a stream name and route something unintended.
 */
export const DIALECTS = {
  ucx: {
    id: 'ucx',
    describe: 'I1/O1 ports, ConnectedSource routing',
    isSource: (port) => /^I\d+$/.test(port),
    isDestination: (port) => /^O\d+$/.test(port),
    routeProp: 'ConnectedSource',
    nameProp: 'Name',
    lockProp: 'Lock',
    disconnect: '0',
    sortKey: (port) => Number(port.slice(1)),
  },
  tpn: {
    id: 'tpn',
    describe: 'stream-named ports (…_S0 / …_D0), SourceStream routing',
    isSource: (port) => /_S\d+$/.test(port),
    isDestination: (port) => /_D\d+$/.test(port),
    routeProp: 'SourceStream',
    nameProp: 'StreamAlias',
    lockProp: null,
    // Confirmed against real hardware. The emulator could not settle it: it
    // accepts anything at all, '0', '' and 'none' alike.
    disconnect: '0',
    sortKey: null,
  },
};

/**
 * Work out which family a device belongs to from what it published.
 *
 * Deliberately keyed on the routing property rather than on port-name shape:
 * the property is what the panel has to write, so a device whose ports look
 * unfamiliar but whose routing is recognised is still usable, while one whose
 * routing we cannot write is not -- however its ports are named.
 *
 * @returns {{dialect: object|null, reason: string}}
 */
export function detectDialect(xpLines) {
  const props = new Set();
  for (const line of xpLines) {
    const p = parseProperty(line);
    if (p) props.add(p.prop);
  }

  for (const dialect of [DIALECTS.ucx, DIALECTS.tpn]) {
    if (props.has(dialect.routeProp)) return { dialect, reason: `matched on ${dialect.routeProp}` };
  }

  return {
    dialect: null,
    reason: props.size
      ? `no known routing property among: ${[...props].sort().join(', ')}`
      : 'the crosspoint reported no properties at all',
  };
}

/**
 * Build the grid.
 *
 * Ports come from the XP node here, unlike src/xpoint.js which reads names from
 * /V1/MEDIA/VIDEO. TPN publishes StreamAlias on both, and reading one node
 * rather than two halves the round trips.
 */
export function buildUniversalGrid({ xpLines = [], switchableLines = [] }) {
  const { dialect, reason } = detectDialect(xpLines);
  if (!dialect) return { dialect: null, reason, sources: [], destinations: [], switchable: {} };

  const ports = new Map(); // port -> { name, signalPresent, route, locked }

  for (const line of xpLines) {
    const p = parseProperty(line);
    if (!p) continue;
    if (!p.path.startsWith(`${XP_NODE}/`)) continue;
    const port = p.path.slice(XP_NODE.length + 1);
    if (port.includes('/')) continue; // a child node such as SWITCHABLE

    const entry = ports.get(port) || { name: null, signalPresent: null, route: null, locked: false };
    if (p.prop === dialect.nameProp) entry.name = p.value;
    if (p.prop === 'SignalPresent') entry.signalPresent = asBool(p.value);
    if (p.prop === dialect.routeProp) entry.route = p.value;
    if (dialect.lockProp && p.prop === dialect.lockProp) entry.locked = asBool(p.value);
    ports.set(port, entry);
  }

  const switchable = {};
  for (const line of switchableLines) {
    const p = parseProperty(line);
    if (!p) continue;
    const match = p.path.match(/\/XP\/(.+)\/SWITCHABLE$/);
    if (!match) continue;
    switchable[match[1]] = switchable[match[1]] || {};
    switchable[match[1]][p.prop] = p.value;
  }

  const order = (a, b) => {
    if (dialect.sortKey) return dialect.sortKey(a) - dialect.sortKey(b);
    // Alias order where the device gave names, port order otherwise: RX3_D0
    // reads better than 511A0DAA865F_D0 and groups the way an operator expects.
    const an = ports.get(a)?.name || a;
    const bn = ports.get(b)?.name || b;
    return an.localeCompare(bn, undefined, { numeric: true });
  };

  const describe = (port) => ({
    port,
    name: ports.get(port)?.name || port,
    signalPresent: ports.get(port)?.signalPresent ?? null,
  });

  const sourcePorts = [...ports.keys()].filter(dialect.isSource).sort(order);
  const destPorts = [...ports.keys()].filter(dialect.isDestination).sort(order);

  // Only where the token is known. See DIALECTS.tpn.disconnect.
  const disconnectColumn = dialect.disconnect === null
    ? []
    : [{ port: dialect.disconnect, name: 'Disconnect', signalPresent: null }];

  return {
    dialect: dialect.id,
    reason,
    routeProp: dialect.routeProp,
    // The view needs it: clicking a routed cell disconnects that destination,
    // so the panel writes this value rather than a source port.
    disconnect: dialect.disconnect,
    sources: [...disconnectColumn, ...sourcePorts.map(describe)],
    destinations: destPorts.map((port) => ({
      ...describe(port),
      connectedSource: ports.get(port)?.route ?? null,
      locked: ports.get(port)?.locked ?? false,
    })),
    switchable,
  };
}

/**
 * What the view should draw for one cell.
 *
 * Same rules as src/xpoint.js: a destination that published no switchability at
 * all is switchable (the device stated no restriction, so none is invented);
 * one that published it without mentioning a source is not.
 */
export function cellState(grid, destPort, srcPort) {
  const destination = grid.destinations.find((d) => d.port === destPort);
  if (!destination) return { selected: false, enabled: false, reason: 'Unknown destination' };

  const selected = destination.connectedSource === srcPort;
  if (destination.locked) return { selected, enabled: false, reason: 'Locked' };

  const published = grid.switchable[destPort];
  if (published === undefined) return { selected, enabled: true, reason: null };

  const status = published[srcPort];
  if (status === undefined) return { selected, enabled: false, reason: 'Unavailable' };
  if (status !== 'OK') return { selected, enabled: false, reason: status };

  return { selected, enabled: true, reason: null };
}

/** The same grid as text, for hosts that cannot render the panel. */
export function renderUniversalGridText(grid) {
  if (!grid.dialect) {
    return `This device's crosspoint was not recognised: ${grid.reason}.`;
  }
  if (grid.destinations.length === 0) {
    return `No crosspoint destinations were reported (dialect: ${grid.dialect}).`;
  }

  const lines = grid.destinations.map((d) => {
    const source = grid.sources.find((s) => s.port === d.connectedSource);
    const from = d.connectedSource ? source?.name || d.connectedSource : 'nothing';
    const signal =
      d.signalPresent === true ? 'signal' : d.signalPresent === false ? 'no signal' : 'signal not reported';
    const flags = [d.locked ? 'locked' : null, signal].filter(Boolean).join(', ');
    return `  ${d.name} <- ${from}  (${flags})`;
  });

  const sections = [`Crosspoint (${grid.dialect}: ${grid.reason}):`, ...lines];

  const unread = grid.destinations.filter((d) => grid.switchable[d.port] === undefined).map((d) => d.name);
  if (unread.length) sections.push('', `Switchability could not be read for: ${unread.join(', ')}`);

  return sections.join('\n');
}
