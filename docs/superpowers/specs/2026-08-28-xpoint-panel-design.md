# Crosspoint panel (MCP Apps)

**Date:** 2026-08-28
**Status:** Decided — shipping the model and the text tool only; panel deferred until host support is confirmed

> **Outcome (2026-08-29):** The probe described in "Gating unknown" below was run and came back
> inconclusive, not negative: Claude Desktop was running the *installed* `.mcpb` extension rather
> than this source tree, so the probed `src/index.js` was never the code actually executing, and
> the probe never fired. Whether Claude Desktop advertises `io.modelcontextprotocol/ui` is still
> unknown. Rather than reinstall a probe build to find out, the decision is to ship what does not
> depend on the answer: the grid model (`src/xpoint.js`) and the `xpoint` tool's text rendering,
> which are useful in any host. The HTML panel (Task 4 below) stays unbuilt until host support for
> MCP Apps is confirmed from a build actually running inside Claude Desktop.

## Goal

Give `lw3-mcp` a clickable video routing grid, rendered in the chat as an MCP App. Destinations as
rows, sources as columns; clicking a cell switches that source to that destination.

Routing today means running `GETALL /V1/MEDIA/VIDEO/XP/*`, reading a JSON dump to work out what is
connected where, then issuing a `SET` or a `CALL`. A grid is what Lightware's own LDC gives people,
and it is the interaction a matrix exists for.

## Gating unknown, to be settled first

**Whether Claude Desktop negotiates the MCP Apps extension is unverified.** Nothing renders without
it. Two attempts to determine it from this machine failed: the installed app's code is not in a
greppable form, and `%APPDATA%\Claude\logs` holds no handshake record — its newest MCP log predates
the current session by a week.

The implementation therefore begins with a probe: log the `initialize` request parameters in
`src/index.js`, restart Claude Desktop, and read whether the client advertises
`io.modelcontextprotocol/ui`. Three lines and a restart. If the answer is no, the text fallback
below is the whole deliverable and the HTML is not written.

## Verified device behaviour

Measured on 2026-08-28 against a UCX-4x2-HC30 (`jimmy-hc30`, 192.168.2.104).

- The video crosspoint is `/V1/MEDIA/VIDEO/XP`. It has **no properties of its own** — only the
  methods `switch`, `switchTakeover`, `switchAll`. Routing state is one level down.
- `/V1/MEDIA/VIDEO/XP/<out>` carries the state, and `ConnectedSource` is **writable**:
  ```
  pw /V1/MEDIA/VIDEO/XP/O2.ConnectedSource=I5
  pw /V1/MEDIA/VIDEO/XP/O2.Mute=false
  pw /V1/MEDIA/VIDEO/XP/O2.Lock=false
  pr /V1/MEDIA/VIDEO/XP/O2.SignalPresent=true
  pr /V1/MEDIA/VIDEO/XP/O2.Connected=true
  ```
  So routing needs no method call: a `SET` is sufficient.
- `/V1/MEDIA/VIDEO/XP/<out>/SWITCHABLE` publishes per-source switchability, read-only. It is
  **neither uniform nor static**. Two samples taken minutes apart, with the routing unchanged in
  between only in the sense that both outputs sat on `I5`:
  ```
  first sample   O1:  0=OK  I1=OK    I2=OK  I3=OK  I4=OK  I5=OK
                 O2:  0=OK  I1=Busy  I2=OK  I3=OK  I4=OK  I5=OK

  later sample   O1:  0=OK  I1=Busy  I2=OK  I3=OK  I4=OK  I5=OK
                 O2:  0=OK  I1=Busy  I2=OK  I3=OK  I4=OK  I5=OK
  ```
  `Busy` reflects the device's **internal wiring**: `I1` and the Welcome Screen (`I5`) are connected
  to the *same input of the internal crosspoint chip*. Only one of them can be in use at a time, so
  while `I5` is routed to any output, `I1` reads `Busy` on every destination. The set of disabled
  cells is therefore a consequence of the current routing and changes as a result of the user's own
  clicks — routing `I5` away from every output frees `I1` again.

  **The shape of that contention is not fully understood, and the panel must not assume it.** An
  earlier draft of this spec inferred "shared chip input, therefore `Busy` on every destination at
  once". Measurement contradicts that: with `I5` routed to *both* outputs, ten consecutive reads
  over seven seconds returned `O1.I1=Busy` and `O2.I1=OK`, stably, every time.

  So `SWITCHABLE` is stable per read but **not uniform across destinations**, and no rule relating
  it to the current routing has been established. The panel therefore treats it as opaque: read it
  per destination, honour whatever the device says, and never compute or predict it. This is the
  reason the model keys switchability per destination rather than per source.

  Two consequences for the panel: `SWITCHABLE` must be re-read after **every** switch, not only on
  the poll timer, or the grid will show availability that the user just invalidated. And the panel
  must display the device's own word (`Busy`) without inventing an explanation — the underlying
  resource model is internal to the device and not something this project represents.
- `0` is a legitimate source meaning disconnect. `MAN …:switch` states: *"Use `0` character as
  `<in>` to disconnect destination."*
- Ports carry writable human names: `I1`="USB-C in 1", `I5`="Welcome Screen", `O1`="HDMI out 1".
- This model has 5 inputs and 2 outputs.
- `Mute` and `Lock` exist on **both** sources and destinations, not just destinations.
- `MAN /V1/MEDIA/VIDEO/XP/O1.Lock` → *"If true, output is locked"*.
- Routing and names are two calls — `GETALL /V1/MEDIA/VIDEO/XP/*` and `GETALL /V1/MEDIA/VIDEO/*` —
  measured at **552 ms** together. `SWITCHABLE` is a child node per destination and is **not**
  included in that sweep, so a full read is 2 + N calls, N being the destination count. On this
  model that is four calls, roughly one second. On a device with many destinations that cost is what
  would force a longer poll interval.

## Decisions

| Decision | Choice | Consequence |
|---|---|---|
| Panel scope | Switching only | Clicking a cell is the sole write the panel performs |
| Mute and lock | Read, never written | A locked destination shows as disabled instead of failing mysteriously |
| Data source | Poll the device directly | No cache to invalidate; the panel cannot show state the device does not hold |
| Refresh | Every 3 seconds, paused when hidden, and immediately after any switch | 2 + N calls per poll, ~1 s on this model. The post-switch read is required, not an optimisation: a switch changes which sources are `Busy` |
| Write mechanism | `SET …ConnectedSource` | `ConnectedSource` is writable; no new command path |
| Tool surface | One new tool, one `ui://` resource | The view reads and writes through the existing `GETALL` and `SET` tools |
| Host without UI support | Text rendering of the same matrix | The tool stays useful in MCP Inspector and any non-UI client |

### Why not server-push

The panel polls because the extension has no mechanism for a server to push into a rendered view.
The specification describes only host-to-view notifications — lifecycle and host-context — and
states the alternative directly: *"Views can request fresh data by calling tools... This pattern
enables interactive, self-updating views."*

This was checked because reinstating the `OPEN` subscription was considered as a way to drive the
panel live. It cannot: subscriptions would keep fresh state server-side, but the view would still
have to poll to see it. Direct polling was chosen instead, leaving an `OPEN`-backed cache as a later
optimisation if the traffic ever justifies it.

## Architecture

### Tool

One new MCP tool, `xpoint`. It requires an established connection, reads the grid, and returns:

- the UI resource reference, via `_meta.ui.resourceUri: "ui://lw3-mcp/xpoint"`
- a text rendering of the same matrix as its content

Both are always returned. A host that negotiated the UI extension renders the panel; one that did
not shows the text. The tool is never useless.

### Resource

One resource, `ui://lw3-mcp/xpoint`, MIME `text/html;profile=mcp-app`, served from a single
self-contained HTML file. No external requests: the host enforces a restrictive CSP, so all CSS and
JavaScript are inline and there are no fonts, images or CDN references.

`src/index.js` currently declares only the `tools` capability. It gains `resources`.

### The view

The iframe acts as an MCP client over `postMessage` and uses the tools that already exist:

- **Read** — `GETALL /V1/MEDIA/VIDEO/XP/*` for routing, signal and switchability; `GETALL
  /V1/MEDIA/VIDEO/*` for port names.
- **Write** — `SET` on `/V1/MEDIA/VIDEO/XP/<out>.ConnectedSource`.

No new device-facing surface is added, and the view inherits the correlation, error detection and
transport fallback already built and tested.

### Grid model

A pure function turns the lines of those two `GETALL` responses into the structure the view renders:

```js
{
  sources:      [{ port: 'I1', name: 'USB-C in 1', signalPresent: true }, ...],
  destinations: [{ port: 'O1', name: 'HDMI out 1', signalPresent: false,
                   connectedSource: 'I5', locked: false }, ...],
  switchable:   { O1: { '0': 'OK', I1: 'OK', ... }, O2: { I1: 'Busy', ... } },
}
```

Sources are ordered `0` (Disconnect) first, then `I1…In` numerically. This function holds all the
parsing and is where the tests live.

### Layout

Rows are destinations, columns are sources, with `Disconnect` as the leading column. Each cell shows
whether it is the current route. Port names label both axes, with signal presence marked. A cell is
disabled when its `SWITCHABLE` value is not `OK`, or when its destination is locked; the reason —
`Busy`, `Locked` — is shown on the cell rather than left as an unexplained grey.

A last-updated time is displayed, so a panel that has stopped polling looks stale rather than
current.

## Error handling

| Condition | Behaviour |
|---|---|
| Not connected to a device | The tool returns the existing "Not connected" error; no panel |
| `/V1/MEDIA/VIDEO/XP` absent | Clear error naming the node, not an empty grid — this model's structure is not universal |
| A `SET` is rejected | The cell reverts to the device's reported state and the error text is shown; the panel never displays a route the device did not confirm |
| A poll fails | The last known grid stays visible, marked stale with the error; polling continues |
| Host did not negotiate the UI extension | Text rendering only |

## Testing

- **Grid model** — unit tests over the pure function with captured device output: routing read
  correctly; names applied to both axes; `0` ordered first; a `Busy` cell marked unswitchable; a
  locked destination marked; signal presence carried; a destination with no `ConnectedSource`
  handled.
- **Text fallback** — the same model rendered as text, asserted to name every destination and its
  current source.
- **Tool wiring** — `xpoint` declares the resource URI, and the resource is served with the
  documented MIME type.
- **Manual, against real hardware** — the panel renders; the current route matches the device;
  clicking a cell switches it and the device confirms; the `I1 → O2` cell is disabled and labelled
  `Busy`.

The HTML itself is not meaningfully unit-testable here and no attempt is made to pretend otherwise.
Its correctness rests on the manual pass.

## Out of scope

- Mute and lock as controls. Nothing in the panel writes anything but `ConnectedSource`.
- Audio crosspoint, `switchTakeover`, presets, `switchAll`.
- Any second view: device tree browser, status dashboard, discovery picker.
- Reinstating `OPEN`, and any server-side cache.
- Multi-device panels. The panel shows the one connected device.

## Risks

| Risk | Mitigation |
|---|---|
| Claude Desktop does not support MCP Apps | Settled by the probe before any UI is written; the text fallback ships regardless |
| The node structure differs on another model | Verified on one model. A missing `/V1/MEDIA/VIDEO/XP` produces a clear error naming the node |
| Polling every 3 seconds is visible in the conversation | Unknown whether view-initiated tool calls appear in the transcript. If they do and it is noisy, lengthen the interval or switch to refresh-on-action |
| The HTML is verified only by hand | Accepted. The parsing is where the logic lives and it is tested; the rendering is thin |
| A large matrix makes the grid unusable | This model is 5×2. A device with 32×32 would need scrolling or a different layout, which is not designed for here |
