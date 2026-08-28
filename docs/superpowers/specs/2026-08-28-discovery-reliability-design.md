# mDNS discovery reliability

**Date:** 2026-08-28
**Status:** Approved, pending implementation

## Goal

Make `discover` find the devices that are actually on the network. Today it misses devices that
other tools see, silently and reproducibly.

## The bugs

All measured on 2026-08-28 against a live network containing a UCX-4x2-HC30 (`jimmy-hc30`,
192.168.2.104).

### The queried service types are not the ones devices advertise

`src/lightware-discovery.js` queries four service types. The device advertises none of them:

| Queried | Present on the network |
|---|---|
| `_lwr3._tcp.local` | `_lwr3-wss._tcp.local` |
| `_webldc-http._tcp.local` | `_webldc-https._tcp.local` |
| `_rest-http._tcp.local` | `_rest-https._tcp.local` |
| `_lara-https._tcp.local` | absent |

Measured directly:

```
our four service types   : 0 instances
the ones actually present: 4 instances
    UCX-4x2-HC30 00001234._lwr3-wss._tcp.local
    UCX-4x2-HC30 00001234._webldc-https._tcp.local
    UCX-4x2-HC30 00001234._rest-https._tcp.local
    UCX-4x2-HC30 00001234._update-rest-https._tcp.local
```

This explains the reported instability exactly. The same device reports `HTTP.Enabled = false` and
`HTTPS.Enabled = true`, so it advertises only the secure variants. A device with HTTP enabled
advertises the plain variants and **is** found. Discovery is therefore deterministic per device
configuration, which across a mixed estate looks like flakiness.

### Queries are transmitted on one interface, chosen by the OS

`multicast-dns` joins the multicast group on every interface (`allInterfaces()`) but transmits on
one: `socket.setMulticastInterface(opts.interface || defaultInterface())`. On Windows,
`defaultInterface()` returns `'0.0.0.0'`, delegating the choice to the routing table.

This machine has four external IPv4 interfaces, three of them virtual:

```
Tailscale                          169.254.83.107
vEthernet (WSLBridge)              192.168.2.101   <- the LAN
vEthernet (Default Switch)         172.22.240.1
vEthernet (WSL Hyper-V firewall)   172.18.112.1
```

The OS currently picks correctly — responses from other LAN devices were observed — so this is not
the active cause. It is a latent failure that would take out discovery wholesale and would look
genuinely random, which is why it is being fixed alongside.

### Devices whose name does not parse are discarded without trace

`parseLightwareName` requires `PRODUCT SERIAL`:

```
"UCX-4x2-HC30 00001234"  -> parses
"jimmy-hc30"             -> DROPPED
```

`addDevice` is only reached when `modelName`, `serialNumber` and `ipAddress` are all present, so an
instance that does not match, or whose A record has not arrived, is dropped. Nothing is logged.

### A fixed single-shot window cannot cover the PTR → SRV → A chase

Each service type is queried once at t=0. Discovery then needs PTR, then SRV, then A — three round
trips inside one 3000 ms window. A device that answers slowly is dropped rather than reported
incompletely.

## Verified behaviour to build on

- The standard meta-query `_services._dns-sd._udp.local` reliably enumerates the network's service
  types. Measured at 2000 ms, 3000 ms and 5000 ms windows: 7 Lightware types returned every time,
  identically. A 2000 ms window is sufficient.
- The device answers `_lwr3-wss`, `_webldc-https`, `_rest-https`, `_update-rest-https`,
  `_serial1`, `_serial2`, and `_lmdmp._udp`.

## Decisions

| Decision | Choice | Consequence |
|---|---|---|
| Service types | Union of meta-query enumeration and a known list | Survives a firmware inventing a name *and* one that ignores the meta-query |
| Interfaces | One socket per external IPv4 interface | Queries reach the LAN regardless of the OS's routing choice |
| Incomplete devices | Reported with `null` for what is unknown | A device you can connect to is never hidden because its name had an unexpected shape |
| Timing | Re-issue queries three times inside the window | The chase gets more than one chance without adding a completion state machine |
| Testability | Constructor-injected socket factory | The parsing, merging and dedup logic becomes testable without a network |

## Architecture

The change stays in `src/lightware-discovery.js`. `src/index.js`'s `handleDiscover` is unchanged
except that the objects it formats may now carry `null` fields.

### Service type resolution

```
knownTypes           = the hardcoded list, both plain and secure variants
enumeratedTypes      = meta-query results filtered by LIGHTWARE_SERVICE
serviceTypes         = union of the two
```

`LIGHTWARE_SERVICE` matches `_lwr3`, `_lara`, `_webldc`, `_rest`, `_update-rest`, and `_serial`
followed by a digit. `_lmdmp._udp.local` is deliberately excluded: it is a UDP management protocol,
not an LW3 endpoint, and a device advertising only it is not something `connect` can use.

The known list is:

```
_lwr3._tcp.local            _lwr3-wss._tcp.local
_webldc-http._tcp.local     _webldc-https._tcp.local
_rest-http._tcp.local       _rest-https._tcp.local
_lara-https._tcp.local      _update-rest-https._tcp.local
```

### Interfaces

`os.networkInterfaces()` is enumerated for external IPv4 addresses. One `multicast-dns` socket is
created per address, with `{ interface: <address> }`. All sockets receive into the same handler and
the same device map, so a device seen on two interfaces merges rather than duplicating.

If no external IPv4 interface exists, one default socket is created, matching today's behaviour.

A socket that fails to bind — a disconnected adapter, a permission failure — is skipped, and
discovery proceeds on the rest. One dead adapter must not fail the whole scan.

### Timing

Within the window, every service-type query is issued at t=0, t=window/3 and t=2*window/3. The
meta-query runs on the same schedule. A records are still requested on receipt of an SRV, as today.

The window remains the `timeout` parameter, default 3000 ms.

### Result shape

```js
{
  modelName: string | null,     // null when the instance name did not parse
  serialNumber: string | null,  // null when the instance name did not parse
  ipAddress: string | null,     // null when no A record arrived in time
  hostname: string | null,      // null when no SRV arrived
}
```

Every Lightware instance seen is reported. An entry with no `ipAddress` still carries a `hostname`,
which `connect` accepts.

### Deduplication

Keyed on the first available of: `serialNumber`, `hostname`, `ipAddress`. The current key,
`modelName_serialNumber`, collapses every unparsed device into a single `undefined_undefined` entry.

Merging is additive: a later packet supplying an A record fills the `ipAddress` of an entry already
created from a PTR.

## Error handling

| Condition | Behaviour |
|---|---|
| A socket fails to bind or errors | That interface is skipped; the scan continues on the others |
| No interface yields a socket | Reject with an error naming the failure — a silent empty result would be indistinguishable from "no devices" |
| Meta-query returns nothing | The known list still runs; no error |
| An instance name does not parse | Reported with `modelName` and `serialNumber` null |
| No devices found | Resolve with `[]`, as today |

## Testing

- **Service type resolution** — union logic over synthetic meta-query results: a type only the
  meta-query knows, a type only the known list has, a duplicate in both, and a non-Lightware type
  that must be filtered out.
- **Name parsing** — `PRODUCT SERIAL` parses; a bare hostname yields nulls rather than being
  dropped.
- **Merging and dedup** — a PTR then an SRV then an A for one device produce one entry, progressively
  filled. Two devices produce two. An unparsed device does not collide with another unparsed device.
- **Partial reporting** — a device with a PTR and SRV but no A is returned with a hostname and a
  null `ipAddress`.
- **Interface fan-out** — with a stubbed factory, a machine with three external addresses creates
  three sockets and queries on each; a socket that throws on creation is skipped and the others
  still run.
- **Against real hardware** — one manual pass confirming `jimmy-hc30` is found, which it is not
  today.

All but the last use the injected socket factory and need no network.

## Out of scope

- IPv6 and `AAAA` records
- Continuous or background discovery; `discover` stays a one-shot call
- `_lmdmp._udp.local`
- Probing discovered devices to confirm they speak LW3
- Any change to `connect`

## Risks

| Risk | Mitigation |
|---|---|
| One socket per interface multiplies traffic on a machine with many adapters | Bounded by the adapter count, three queries each inside one short window. Negligible against normal mDNS chatter |
| A future firmware uses a service name the prefix filter misses | The known list is the second path; both would have to miss it |
| Reporting partial devices confuses a caller expecting complete records | The fields are explicitly nullable and documented; `handleDiscover` already serialises whatever it is given |
| Verified against one device on one network | The failure it fixes was reproduced directly, and the union approach does not depend on that device's specific names |
