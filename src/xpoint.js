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

  const published = grid.switchable[destPort];

  // No SWITCHABLE data for this destination at all -- the node was unreadable, or
  // the device does not implement it (the Taurus emulator does not). That is not
  // the device refusing a switch, it is the device publishing no restrictions, so
  // blocking every source would invent a rule rather than honour one. A switch the
  // device will not accept still fails visibly at the SET.
  //
  // Distinct from a destination that DID publish switchability without mentioning
  // this source: there the device has spoken, and we honour it.
  if (published === undefined) return { selected, enabled: true, reason: null };

  const status = published[srcPort];
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
    // signalPresent is `null` when the device never reported it, deliberately kept
    // distinct in buildGrid from `false` (device explicitly said no signal). Folding
    // both into "no signal" would tell the reader a definite negative about a line
    // that was simply never read.
    const signal =
      d.signalPresent === true ? 'signal' : d.signalPresent === false ? 'no signal' : 'signal not reported';
    const flags = [d.locked ? 'locked' : null, signal].filter(Boolean).join(', ');
    return `  ${d.name} <- ${from}  (${flags})`;
  });

  const canSwitch = [];
  const blocked = [];
  const unread = [];

  for (const d of grid.destinations) {
    if (d.locked) {
      // Every cell of a locked destination carries the same reason; say it once
      // instead of once per source.
      blocked.push(`  ${d.name}: locked`);
      continue;
    }

    // Compute each cell's state exactly once and reuse it for both lists below.
    const cells = grid.sources.map((s) => ({ source: s, state: cellState(grid, d.port, s.port) }));

    const available = cells
      .filter(({ state }) => state.enabled && !state.selected)
      .map(({ source }) => source.name);
    if (available.length) {
      canSwitch.push(`  ${d.name} can switch to: ${available.join(', ')}`);
    }

      // A destination that published no switchability at all. Its cells are
      // enabled -- the device stated no restriction, so we invent none -- but the
      // reader still needs telling that nothing was read, which is a different
      // fact from the device having answered 'OK'. Reported once per destination
      // here rather than once per source.
      if (grid.switchable[d.port] === undefined) {
        unread.push(d.name);
      }

    for (const { source, state } of cells) {
      if (state.enabled || state.selected || state.reason === 'Unavailable') continue;
      blocked.push(`  ${d.name} <- ${source.name}: ${state.reason}`);
    }
  }

  const sections = ['Current routing:', ...lines];

  if (canSwitch.length) sections.push('', 'Can switch to:', ...canSwitch);
  if (blocked.length) sections.push('', 'Not currently switchable:', ...blocked);
  if (unread.length) sections.push('', `Switchability could not be read for: ${unread.join(', ')}`);

  return sections.join('\n');
}
