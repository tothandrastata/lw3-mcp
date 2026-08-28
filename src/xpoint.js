/**
 * Turns LW3 GETALL output into a video crosspoint grid, and answers what state
 * each cell is in. Pure — no protocol, no sockets, no rendering beyond text.
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

/** Inputs and outputs sort by their number, so I10 follows I2 rather than I1. */
function byPortNumber(a, b) {
  return Number(a.slice(1)) - Number(b.slice(1));
}

export function buildGrid({ xpLines = [], videoLines = [], switchableLines = [] }) {
  const ports = new Map(); // port -> { name, signalPresent }
  const dest = new Map(); // port -> { connectedSource, locked }
  const switchable = {};

  // /V1/MEDIA/VIDEO/<port>.Name and .SignalPresent
  for (const line of videoLines) {
    const p = parseProperty(line);
    if (!p) continue;
    const port = p.path.startsWith(`${VIDEO_NODE}/`) ? p.path.slice(VIDEO_NODE.length + 1) : null;
    if (!port || !/^[IO]\d+$/.test(port)) continue;
    const entry = ports.get(port) || { name: null, signalPresent: null };
    if (p.prop === 'Name') entry.name = p.value;
    if (p.prop === 'SignalPresent') entry.signalPresent = asBool(p.value);
    ports.set(port, entry);
  }

  // /V1/MEDIA/VIDEO/XP/<out>.ConnectedSource and .Lock
  for (const line of xpLines) {
    const p = parseProperty(line);
    if (!p) continue;
    const port = p.path.startsWith(`${XP_NODE}/`) ? p.path.slice(XP_NODE.length + 1) : null;
    if (!port || !/^O\d+$/.test(port)) continue;
    const entry = dest.get(port) || { connectedSource: null, locked: false };
    if (p.prop === 'ConnectedSource') entry.connectedSource = p.value;
    if (p.prop === 'Lock') entry.locked = asBool(p.value);
    dest.set(port, entry);
  }

  // /V1/MEDIA/VIDEO/XP/<out>/SWITCHABLE.<src>=OK|Busy|...
  for (const line of switchableLines) {
    const p = parseProperty(line);
    if (!p) continue;
    const match = p.path.match(/\/XP\/(O\d+)\/SWITCHABLE$/);
    if (!match) continue;
    switchable[match[1]] = switchable[match[1]] || {};
    switchable[match[1]][p.prop] = p.value;
  }

  const named = (port) => ({
    port,
    name: ports.get(port)?.name || port,
    signalPresent: ports.get(port)?.signalPresent ?? null,
  });

  const inputs = [...ports.keys()].filter((p) => p.startsWith('I')).sort(byPortNumber);
  // Every destination the device mentioned, whether via VIDEO or XP.
  const outputs = [...new Set([...[...ports.keys()].filter((p) => p.startsWith('O')), ...dest.keys()])]
    .sort(byPortNumber);

  return {
    // '0' is the device's own token for "disconnect this destination".
    sources: [{ port: '0', name: 'Disconnect', signalPresent: null }, ...inputs.map(named)],
    destinations: outputs.map((port) => ({
      ...named(port),
      connectedSource: dest.get(port)?.connectedSource ?? null,
      locked: dest.get(port)?.locked ?? false,
    })),
    switchable,
  };
}

/**
 * What the view should draw for one cell.
 *
 * A cell is disabled when the destination is locked, or when the device does not
 * report the source as OK for it. Absence of information counts as disabled:
 * offering a click the device will refuse is worse than withholding one.
 */
export function cellState(grid, destPort, srcPort) {
  const destination = grid.destinations.find((d) => d.port === destPort);
  const selected = destination?.connectedSource === srcPort;

  if (!destination) return { selected: false, enabled: false, reason: 'Unknown destination' };
  if (destination.locked) return { selected, enabled: false, reason: 'Locked' };

  const status = grid.switchable[destPort]?.[srcPort];
  if (status === undefined) return { selected, enabled: false, reason: 'Unavailable' };
  if (status !== 'OK') return { selected, enabled: false, reason: status };

  return { selected, enabled: true, reason: null };
}

/** The same grid as text, for hosts that cannot render the panel. */
export function renderGridText(grid) {
  if (grid.destinations.length === 0) return 'No video crosspoint destinations were reported.';

  const lines = grid.destinations.map((d) => {
    const source = grid.sources.find((s) => s.port === d.connectedSource);
    const from = d.connectedSource ? `${source?.name || d.connectedSource}` : 'nothing';
    const flags = [d.locked ? 'locked' : null, d.signalPresent ? 'signal' : 'no signal']
      .filter(Boolean)
      .join(', ');
    return `  ${d.name} <- ${from}  (${flags})`;
  });

  const blocked = grid.destinations.flatMap((d) =>
    grid.sources
      .filter((s) => {
        const c = cellState(grid, d.port, s.port);
        return !c.enabled && !c.selected;
      })
      .map((s) => `  ${s.name} -> ${d.name}: ${cellState(grid, d.port, s.port).reason}`)
  );

  return [
    'Current routing:',
    ...lines,
    ...(blocked.length ? ['', 'Not currently switchable:', ...blocked] : []),
  ].join('\n');
}
