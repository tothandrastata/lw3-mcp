# Secure WebSocket fallback transport

**Date:** 2026-08-28
**Status:** Approved, pending implementation

## Goal

When a device refuses or ignores TCP 6107, fall back to LW3 over secure WebSocket at
`wss://<host>/lw3`. When that endpoint demands HTTP Basic authentication, return an error that
tells the caller to ask the user for the `admin` password, then retry with it.

This widens the set of devices the gateway can reach: a device with the raw LW3 service disabled,
or one reachable only through its HTTPS port, is currently unusable and would become usable.

## Verified against real hardware

Confirmed on 2026-08-28 against a UCX-4x2-HC30 (`jimmy-hc30`, 192.168.2.104, firmware as shipped).
These are measurements, not assumptions.

| Fact | Evidence |
|---|---|
| The device exposes three network services | `/V1/MANAGEMENT/NETWORK/SERVICES` lists `HTTP`, `HTTPS`, `LW3`, `SERIAL1`, `SERIAL2` |
| HTTP is off, HTTPS is on | `HTTP.Enabled = false` (port 80), `HTTPS.Enabled = true` (port 443) |
| Raw LW3 has no authentication at all | `SERVICES/LW3` exposes only `Port` and `Enabled` — no `AuthenticationEnabled`, unlike HTTP and HTTPS |
| `/lw3` is a real endpoint behind Basic auth | `GET /lw3` returns `401` with `WWW-Authenticate: Basic realm="Please login"`, while every other path 302s to `/login/login.html` |
| The certificate is self-signed | TLS handshake reports `DEPTH_ZERO_SELF_SIGNED_CERT`; subject and issuer are both `CN=jimmy-hc30` |
| WSS + Basic auth works | A hand-rolled upgrade with `Authorization: Basic` returned `101 Switching Protocols` |
| **Frames carry newline-delimited LW3 lines** | `GET` returned one frame, `"pw /V1/MANAGEMENT/NETWORK.HostName=jimmy-hc30\r\n"`; `GETALL` returned one frame containing five `n- ...\r\n` lines |
| Lines terminate `\r\n` over WSS | Visible in both payloads above |

The framing result is the important one: it means the transport needs no line logic of its own.

## Decisions

| Decision | Choice | Consequence |
|---|---|---|
| WebSocket client | Add the `ws` dependency | Node's built-in `WebSocket` cannot set an `Authorization` header and cannot accept a self-signed certificate; both are mandatory here |
| Password delivery | `password` parameter on the `connect` tool | Works in every MCP client with no protocol extensions; the password is never written to disk |
| Self-signed certificate | Accept, without mentioning it in the connect response | Encrypted but unauthenticated — see Security posture |
| Username | Hardcoded `admin` | The only account that currently exists; a constant, trivially parameterised later |

## Architecture

Split `src/lw3-protocol.js` at the seam it already has. The command queue, line buffering, and
GETALL parsing are transport-independent and stay exactly as they are. Underneath them goes a
transport interface:

```
send(text: string): void
events: 'data' (raw text chunk), 'close', 'error'
```

Two implementations, each in its own file:

- `src/transports/tcp.js` — today's `net.Socket` on port 6107, behaviour unchanged
- `src/transports/wss.js` — `ws` against `wss://<host>/lw3`, with `Authorization: Basic` and
  `rejectUnauthorized: false`

`LW3Protocol.handleData()` already buffers and splits on `\n`, then trims each line — which absorbs
the `\r` seen over WSS. `WssTransport` therefore emits each frame's payload as a `data` chunk and
does nothing else. No parallel line logic, no normalisation layer.

This keeps the genuinely new code in one small file that can be understood and tested alone, and
leaves the parsing code — the part that already works against real devices — untouched.

## Connect sequence

`connect(host, port = 6107, { password } = {})`:

1. Attempt TCP on `port`, bounded by a **3-second timeout**.
2. On refusal, timeout, or unreachable host, attempt `wss://<host>/lw3`.
3. If that returns `401` and no password was supplied, reject with a distinct, recognisable error:
   authentication is required and the caller should ask the user for the `admin` password.
4. If a password was supplied, retry the upgrade with `Authorization: Basic base64("admin:" + password)`.

A TCP failure is the only trigger for the fallback. If TCP connects, WSS is never attempted.

### The connect timeout is required, and fixes a known defect

`LW3Protocol.connect()` currently has no timeout of its own: it resolves on the socket's `connect`
event and rejects on `error`, so a silently dropped connection waits on the operating system. That
is the "It seems stuck when connecting" symptom documented in `INSTALL.md` and `WALKTHROUGH.md`,
and it was raised during the bundle review.

A fallback cannot trigger without a bounded first attempt, so this work must add the timeout. Three
seconds is fast enough not to read as a hang and generous for a LAN.

## Error contract

The `connect` tool's failure modes must be distinguishable, because the caller acts differently on
each:

| Condition | Behaviour |
|---|---|
| TCP succeeds | Connected. WSS never attempted. |
| TCP fails, WSS succeeds | Connected. |
| TCP fails, WSS returns 401, no password given | Error naming authentication as the cause and the `admin` user, so the model knows to ask the user for it |
| TCP fails, WSS returns 401, password given | Error stating the supplied password was rejected — distinct from the previous case, so the model asks again rather than looping |
| TCP fails, WSS fails for any other reason | Error reporting both failures, so the user is not told only about the second |

That last row matters: reporting only the WSS failure would hide why the normal path did not work.

## Security posture

The WSS transport sets `rejectUnauthorized: false`. Lightware devices self-sign, with the
certificate's CN set to the device hostname and no chain to any trusted root, so verification
cannot succeed without pinning infrastructure that a LAN tool does not warrant.

The consequence, recorded deliberately: **traffic is encrypted but the device identity is not
verified.** An attacker positioned between the client and the device could present their own
certificate and be accepted. On a trusted office LAN this is an acceptable trade, and it is
strictly better than the status quo, since the existing TCP path on 6107 is neither encrypted nor
authenticated.

It was decided that the connect response will not mention this. The trade is recorded here rather
than surfaced at runtime.

The password lives in memory for the duration of the session only. It is never written to disk,
never logged, and never included in an error message.

## The `ws` dependency and bundle portability

Adding `ws` breaks the project's standing no-new-dependencies rule; the rule is being relaxed
deliberately, because the built-in client cannot do the job.

`ws` is pure JavaScript. Measured on 2026-08-28: its `dependencies` field is empty, and its two
native add-ons `bufferutil` and `utf-8-validate` are declared under `peerDependenciesMeta` as
`optional: true`. A clean `npm install ws` into an empty project added exactly one package and zero
`.node` binaries.

So the portability risk is small, not zero: an explicit install of either add-on, or a future
release promoting them out of optional, would compile native code into `node_modules` and cost the
bundle its single-artifact-for-every-OS property — which the whole packaging approach rests on.

The build must therefore keep proving that property. `scripts/verify-bundle.js` currently checks
that specific dependencies are present; it will also assert that the unpacked bundle contains **no
`.node` binaries**. This turns a property that has so far been true by luck into one the build
enforces.

## Testing

- **Transport selection** — unit tests over the fallback decision: TCP success skips WSS; TCP
  refusal triggers WSS; each error path produces its distinct message. The transports are stubbed;
  no device needed.
- **Line handling** — a test feeding `\r\n`-terminated payloads through the parsing path, pinning
  the behaviour the WSS framing depends on. This is currently untested and works by accident.
- **Bundle portability** — the new no-native-binaries assertion in `verify-bundle.js`.
- **Against real hardware** — one manual check against `jimmy-hc30` with credentials, since no
  automated test can hold a device password.

## Out of scope

- Certificate pinning or trust-on-first-use
- Any credential store, keychain integration, or password persistence
- Usernames other than `admin`
- Preferring WSS over TCP, or a manual transport selector — TCP stays the default and WSS is
  strictly a fallback
- Reconnection or transport switching after a connection has been established

## Risks

| Risk | Mitigation |
|---|---|
| `ws` pulls in compiled optional deps and breaks single-artifact portability | Low: a clean install adds one pure-JS package and zero `.node` files, measured. The build asserts no `.node` files in the packed bundle regardless, so a future regression fails loudly |
| Another firmware frames LW3 differently over WebSocket | Verified on one device and one firmware only. The parser handles both one-line and many-lines-per-frame, which covers the plausible variations, but a device that omits newlines entirely would need revisiting |
| The 3-second timeout is too short on a congested network | The `connect` tool keeps its explicit `port` argument, and a slow device can still be reached directly once diagnosed |
| A device offers `/lw3` at a different path | Verified on one model. If others differ, the path becomes a parameter |
