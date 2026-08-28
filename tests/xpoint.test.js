import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, cellState, renderGridText, XP_NODE, VIDEO_NODE } from '../src/xpoint.js';

// Captured verbatim from a UCX-4x2-HC30 on 2026-08-28.
const xpLines = [
  'pw /V1/MEDIA/VIDEO/XP/I3.Lock=false',
  'pr /V1/MEDIA/VIDEO/XP/I3.SignalPresent=false',
  'pw /V1/MEDIA/VIDEO/XP/O1.Lock=false',
  'pw /V1/MEDIA/VIDEO/XP/O1.ConnectedSource=I5',
  'pr /V1/MEDIA/VIDEO/XP/O1.SignalPresent=true',
  'pw /V1/MEDIA/VIDEO/XP/O2.Lock=false',
  'pw /V1/MEDIA/VIDEO/XP/O2.ConnectedSource=I5',
  'pr /V1/MEDIA/VIDEO/XP/O2.SignalPresent=true',
  'n- /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE',
  'n- /V1/MEDIA/VIDEO/XP/O2/SWITCHABLE',
];

const videoLines = [
  'pw /V1/MEDIA/VIDEO/I1.Name=USB-C in 1',
  'pr /V1/MEDIA/VIDEO/I1.SignalPresent=false',
  'pw /V1/MEDIA/VIDEO/I2.Name=USB-C in 2',
  'pw /V1/MEDIA/VIDEO/I3.Name=HDMI in 3',
  'pw /V1/MEDIA/VIDEO/I4.Name=HDMI in 4',
  'pw /V1/MEDIA/VIDEO/I5.Name=Welcome Screen',
  'pr /V1/MEDIA/VIDEO/I5.SignalPresent=true',
  'pw /V1/MEDIA/VIDEO/O1.Name=HDMI out 1',
  'pr /V1/MEDIA/VIDEO/O1.SignalPresent=false',
  'pw /V1/MEDIA/VIDEO/O2.Name=HDMI out 2',
];

// Not a verbatim capture, unlike the arrays above: transcribed from ten
// consecutive reads on a UCX-4x2-HC30 over seven seconds (I5 routed to both
// outputs throughout), stable every time. Switchability is not uniform across
// destinations - O1 refuses I1, O2 allows it.
const switchableLines = [
  'pr /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE.0=OK',
  'pr /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE.I1=Busy',
  'pr /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE.I2=OK',
  'pr /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE.I3=OK',
  'pr /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE.I4=OK',
  'pr /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE.I5=OK',
  'pr /V1/MEDIA/VIDEO/XP/O2/SWITCHABLE.0=OK',
  'pr /V1/MEDIA/VIDEO/XP/O2/SWITCHABLE.I1=OK',
  'pr /V1/MEDIA/VIDEO/XP/O2/SWITCHABLE.I2=OK',
  'pr /V1/MEDIA/VIDEO/XP/O2/SWITCHABLE.I3=OK',
  'pr /V1/MEDIA/VIDEO/XP/O2/SWITCHABLE.I4=OK',
  'pr /V1/MEDIA/VIDEO/XP/O2/SWITCHABLE.I5=OK',
];

const grid = () => buildGrid({ xpLines, videoLines, switchableLines });

test('the node paths are the video crosspoint', () => {
  assert.equal(XP_NODE, '/V1/MEDIA/VIDEO/XP');
  assert.equal(VIDEO_NODE, '/V1/MEDIA/VIDEO');
});

test('sources lead with Disconnect, then inputs in numeric order', () => {
  assert.deepEqual(grid().sources.map((s) => s.port), ['0', 'I1', 'I2', 'I3', 'I4', 'I5']);
  assert.equal(grid().sources[0].name, 'Disconnect');
});

test('inputs beyond nine sort numerically, not as text', () => {
  const many = ['I2', 'I10', 'I1'].map((p) => `pw /V1/MEDIA/VIDEO/${p}.Name=in ${p}`);
  const g = buildGrid({ xpLines: [], videoLines: many, switchableLines: [] });
  assert.deepEqual(g.sources.map((s) => s.port), ['0', 'I1', 'I2', 'I10'],
    'string ordering would put I10 before I2');
});

test('ports carry their human names on both axes', () => {
  const g = grid();
  assert.equal(g.sources.find((s) => s.port === 'I5').name, 'Welcome Screen');
  assert.equal(g.destinations.find((d) => d.port === 'O1').name, 'HDMI out 1');
});

test('a port with no Name falls back to its port id', () => {
  const g = buildGrid({ xpLines: [], videoLines: ['pr /V1/MEDIA/VIDEO/I7.SignalPresent=true'], switchableLines: [] });
  assert.equal(g.sources.find((s) => s.port === 'I7').name, 'I7');
});

test('destinations carry routing, lock and signal', () => {
  const o1 = grid().destinations.find((d) => d.port === 'O1');
  assert.equal(o1.connectedSource, 'I5');
  assert.equal(o1.locked, false);
  assert.equal(o1.signalPresent, false, 'signal comes from /VIDEO/O1, not /VIDEO/XP/O1');
});

test('signal presence is a boolean, not the string "false"', () => {
  const i5 = grid().sources.find((s) => s.port === 'I5');
  assert.equal(i5.signalPresent, true);
  assert.equal(grid().sources.find((s) => s.port === 'I1').signalPresent, false);
});

test('switchability is read per destination', () => {
  const g = grid();
  assert.equal(g.switchable.O1.I1, 'Busy');
  assert.equal(g.switchable.O1.I2, 'OK');
  assert.equal(g.switchable.O2.I1, 'OK');
});

test('the same source is Busy on one destination and OK on another, per cellState', () => {
  const g = grid();
  assert.equal(g.switchable.O1.I1, 'Busy');
  assert.equal(g.switchable.O2.I1, 'OK', 'switchability is not uniform across destinations');

  const onO1 = cellState(g, 'O1', 'I1');
  assert.equal(onO1.enabled, false);
  assert.equal(onO1.reason, 'Busy');

  const onO2 = cellState(g, 'O2', 'I1');
  assert.equal(onO2.enabled, true);
  assert.equal(onO2.reason, null);
});

test('a known destination missing a source from its SWITCHABLE map reads Unavailable', () => {
  const g = buildGrid({
    xpLines: ['pw /V1/MEDIA/VIDEO/XP/O1.Lock=false'],
    videoLines: [],
    switchableLines: ['pr /V1/MEDIA/VIDEO/XP/O1/SWITCHABLE.I2=OK'],
  });
  const c = cellState(g, 'O1', 'I1');
  assert.equal(c.enabled, false);
  assert.equal(c.reason, 'Unavailable', 'a known destination with no entry for this source is not the same as an unknown destination');
});

test('the currently routed cell is selected', () => {
  assert.equal(cellState(grid(), 'O1', 'I5').selected, true);
  assert.equal(cellState(grid(), 'O1', 'I2').selected, false);
});

test('a cell the device will not accept is disabled, carrying the device word', () => {
  const c = cellState(grid(), 'O1', 'I1');
  assert.equal(c.enabled, false);
  assert.equal(c.reason, 'Busy', 'the device word is shown, not an invented explanation');
});

test('an OK cell is enabled with no reason', () => {
  assert.deepEqual(cellState(grid(), 'O1', 'I2'), { selected: false, enabled: true, reason: null });
});

test('every cell of a locked destination is disabled', () => {
  const locked = xpLines.map((l) => l.replace('O2.Lock=false', 'O2.Lock=true'));
  const g = buildGrid({ xpLines: locked, videoLines, switchableLines });
  assert.equal(cellState(g, 'O2', 'I2').enabled, false);
  assert.equal(cellState(g, 'O2', 'I2').reason, 'Locked');
  assert.equal(cellState(g, 'O1', 'I2').enabled, true, 'the other destination is unaffected');
});

test('Disconnect is offered when the device says so', () => {
  assert.equal(cellState(grid(), 'O1', '0').enabled, true);
});

test('an unknown cell is disabled rather than assumed switchable', () => {
  const c = cellState(grid(), 'O9', 'I1');
  assert.equal(c.enabled, false, 'absence of information must not read as permission');
});

test('the text rendering names every destination and its current source', () => {
  const text = renderGridText(grid());
  assert.match(text, /HDMI out 1/);
  assert.match(text, /HDMI out 2/);
  assert.match(text, /Welcome Screen/, 'the current source is named, not just its port id');
  assert.match(text, /Busy/, 'unavailable sources are visible in text too');
});

test('an empty device yields an empty grid, not a crash', () => {
  const g = buildGrid({ xpLines: [], videoLines: [], switchableLines: [] });
  assert.deepEqual(g.destinations, []);
  assert.deepEqual(g.sources, [{ port: '0', name: 'Disconnect', signalPresent: null }]);
});
