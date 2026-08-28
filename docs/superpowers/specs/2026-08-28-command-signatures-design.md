# LW3 command signatures, error detection, and removing OPEN

**Date:** 2026-08-28
**Status:** Approved, pending implementation

## Goal

Correlate every LW3 response with the command that caused it, using the protocol's own signature
mechanism. This fixes a class of bug affecting every tool that talks to a device, replaces GETALL's
one-second guess with real completion detection, stops multi-line replies being truncated, and makes
unsolicited subscription traffic identifiable instead of corrupting.

## The bugs this fixes

All three were reproduced against a UCX-4x2-HC30 (`jimmy-hc30`, 192.168.2.104) on 2026-08-28.

### Responses are attributed to the wrong command

`processResponse` hands each incoming line to whichever command sits at the head of
`pendingCommands`. Nothing ties a response to its request. A reply arriving after its window closes
lands on the next command instead.

Observed, in one run, calling `getAll('/V1/MANAGEMENT/DATETIME')` twice in a row:

```
call 2 -> {"properties":[],"nodes":[],"methods":[]}     the node's reply had not arrived yet
call 3 -> 2 nodes, 8 properties, 2 methods              it collected call 2's reply and its own
```

The node actually has 1 child node, 4 properties, and 1 method. So the first call reported nothing
and the second reported double. For `GET` this returns a wrong value; for `SET` and `CALL` it can
confirm a write that never happened, which is worse than an error.

`{"properties":[],"nodes":[],"methods":[]}` currently means "nothing arrived within one second",
which is indistinguishable from "this node is empty".

### Device errors are reported as successes

`processResponse` treats only lines starting `pE `, `mE `, or `er` as errors. The device also emits
`-E`:

```
lw3.open('/V1/MANAGEMENT/DATETIME.CurrentTime')
  -> RESOLVED as success: "-E OPEN /V1/MANAGEMENT/DATETIME.CurrentTime %E001: Syntax error"
```

The error text is handed back as if it were the value.

### OPEN has never worked, and working would be worse

`OPEN` takes a **node** path. `src/index.js` builds `nodepath.property`, which the device rejects
outright — masked by the error-detection bug above, so the tool has always reported success.

```
OPEN /V1/MANAGEMENT/DATETIME.CurrentTime  ->  -E ... %E001: Syntax error
OPEN /V1/MANAGEMENT/DATETIME              ->  o- /V1/MANAGEMENT/DATETIME
```

Had it worked it would have been more damaging: a live subscription streams unsolicited `CHG` lines
continuously — 15 lines in 5 idle seconds for `DATETIME` alone — and every one would have been
consumed as some other command's answer.

## Verified device behaviour

Signatures work, and the device brackets replies exactly as the protocol specifies:

```
> 0001#GETALL /V1/MANAGEMENT/DATETIME
  {0001
  pr /V1/MANAGEMENT/DATETIME.UpTime=0 days 11:09:54
  pr /V1/MANAGEMENT/DATETIME.CurrentTime=2026-08-28T18:51:48
  pr /V1/MANAGEMENT/DATETIME.UtcTime=2026-08-28T18:51:48Z
  pw /V1/MANAGEMENT/DATETIME.TimeZone=UTC
  m- /V1/MANAGEMENT/DATETIME:setTime
  n- /V1/MANAGEMENT/DATETIME/NTP
  }
```

Confirmed for `GET`, `GETALL`, and `CALL`. Round trip is ~30 ms, against the 1000 ms the current
GETALL always spends.

Also confirmed: `CLOSE /path` unsubscribes (`c- /path`), and a bare `OPEN` lists active
subscriptions. Neither is needed by this design; recorded because they were measured.

## Decisions

| Decision | Choice | Consequence |
|---|---|---|
| Signature support | Always on, no probe and no fallback | Single code path. A device on firmware without signatures fails on every command rather than degrading — see Risks |
| OPEN | Removed from the server and the manifest | 11 tools become 10. MCP cannot deliver push updates, and the tool has never functioned |
| Error detection | Match `%E\d+:` anywhere in the line | One rule covering `pE`, `mE`, `-E`, and any prefix not yet observed |
| Multi-line replies | `sendCommand` resolves with the block's lines | `GET nodepath.*` stops returning 1 of 9 |
| Concurrent commands | Still serial | Correlation makes them possible; nothing needs them |

## Architecture

The change is confined to `src/lw3-protocol.js`. The transports, the GETALL response parser, and
`src/index.js`'s tool handlers are untouched except where OPEN is removed.

### Sending

`sendCommand` and `getAll` prefix each command with a signature:

```
<4 hex digits>#<command>\n      e.g.  001A#GETALL /V1/MANAGEMENT/DATETIME
```

The counter starts at 0, increments per command, and wraps at `0xFFFF`. It is formatted with
`toString(16).padStart(4, '0').toUpperCase()`. The pending-command map is keyed by that signature
string rather than by the current numeric id.

### Receiving

`processResponse` becomes a small state machine over three line shapes:

| Line | Meaning | Action |
|---|---|---|
| `{XXXX` | a reply block opens | Look up pending command `XXXX`; make it current |
| `}` | the current block ends | Resolve that command with its collected lines |
| anything else, inside a block | part of the current reply | Append to the current command's lines |
| anything else, outside a block | unsolicited | Emit as an `unsolicited` event; never attribute to a command |

That last row is what makes subscription traffic safe: a line that is not inside a block is by
definition not a reply.

A block whose signature matches no pending command is discarded, with the lines emitted as
unsolicited. That happens if a command has already timed out.

### Resolving and errors

- A command resolves with `string[]` — the lines of its block. `get`, `set`, `call`, and `man` join
  them with newlines for display; `getAll` feeds them to the existing parser unchanged.
- If any line in the block matches `/%E\d+:/`, the command rejects with that line as the message.
- `getAll` no longer resolves on a timer. It resolves when `}` arrives.
- The existing 5-second timeout is retained and repurposed: it is now the deadline for `}` to
  arrive, not the window in which to guess. On expiry the command rejects with a timeout error and
  its pending entry is removed.

## Error contract

| Condition | Behaviour |
|---|---|
| Block completes, no error line | Resolve with the block's lines |
| Block contains a line matching `%E\d+:` | Reject with that line |
| No `}` within 5 seconds | Reject with a timeout naming the command |
| Block arrives for an unknown signature | Discard; emit lines as unsolicited |
| Line arrives outside any block | Emit as unsolicited; no command affected |

## Removing OPEN

- Delete the tool from `ListToolsRequestSchema`, the `switch`, and `handleOpen` in `src/index.js`.
- Delete the entry from `manifest.json`'s `tools` array.
- Delete `LW3Protocol.open()`.
- The manifest drift tests assert parity between `manifest.json` and `src/index.js`, and one asserts
  a count of 11 registered tools. That count becomes 10 and the test must be updated with it —
  deliberately, so the number cannot drift silently.

`CHG` lines are still handled: they arrive outside any block and are emitted as unsolicited, which
costs nothing and protects against a subscription left open by another client.

## Testing

- **Framing** — unit tests over `processResponse` driven through a fake transport: a single-line
  block, a multi-line block, two blocks arriving in the wrong order relative to their requests, a
  block for an unknown signature, and lines outside any block.
- **The reported bug** — the exact sequence that produced it: two `getAll` calls to the same node,
  asserting the first returns the node's real contents and the second is not doubled.
- **Error detection** — each of `pE`, `mE`, and `-E` rejects, and a success line containing no
  `%E\d+:` resolves.
- **Multi-line** — a `GET` whose block holds nine lines returns all nine.
- **Timeout** — a block that never closes rejects at the deadline rather than hanging.
- **Tool count** — the existing manifest drift tests, updated to 10.
- **Against real hardware** — one manual pass: the DATETIME sequence, a `GET nodepath.*`, and
  confirmation that `GETALL` now returns in well under a second.

## Out of scope

- Concurrent in-flight commands
- Any replacement for OPEN: subscription buffering, a changes-polling tool, or `CLOSE`
- Falling back to unsigned commands on firmware that rejects signatures
- The `discover` tool, which uses mDNS and shares none of this code

## Risks

| Risk | Mitigation |
|---|---|
| Firmware without signature support fails on every command | Accepted deliberately. The failure is loud and immediate rather than subtle, and `%E001: Syntax error` on the first command points straight at it |
| The signature counter wraps into a still-pending command | 65,536 commands would have to be issued while one remains outstanding, and commands are serial with a 5-second deadline. Not reachable in practice |
| A device brackets replies differently on another model | Verified on one model and firmware. The state machine ignores lines it does not recognise rather than failing, so an unexpected shape degrades to a timeout, not a crash |
| Removing OPEN breaks an existing user | It has never worked in any released version — it returned a syntax error reported as success. Nothing can depend on it |
