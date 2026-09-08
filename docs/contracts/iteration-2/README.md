# Iteration 2 — contract fixture pack

Pulse becomes the only source of online-player information. This directory pins the wire and HTTP
contracts (C1–C5 of the iteration-2 plan) as **bytes and JSON that every repo's tests consume**, so
the producer (Pulse) and each consumer (comms-gatekeeper, social-service-ea, worlds-content-server,
realm-provider, archipelago-workers' wire-contract tests) are checked against the same artefacts.

It lives here because archipelago-workers already hosts the iteration-1 wire-contract tests and is
the one repository every service in the plan depends on.

## Layout

| path | what | who consumes it |
|---|---|---|
| `pulse_presence.proto` | C1 verbatim (`decentraland.pulse.ParcelChangesBatch` on NATS `engine.parcel_changes`). Identical copy lives in `@dcl/protocol` at `proto/decentraland/pulse/pulse_presence.proto` | everyone |
| `parcel_changes/NN-*.bin` + `.json` | one batch per C1 guarantee, wire bytes + canonical JSON; `*.input.json` = producer-side input for the coalescing and canonicalization cases; `NOTES.json` = one line per fixture | Pulse encodes and compares **bytes**; consumers decode the bytes and compare **objects** |
| `parcel_changes/replay.json` | the ordered consumer scenario: expected presence map after every step (gatekeeper), expected ONLINE/OFFLINE events (social-service), gap + snapshot + second-server handling | comms-gatekeeper, social-service-ea, archipelago-workers contract tests |
| `http/*.json` | one golden `{request,status,body}` per C2 route, all derived from one peer set; `redirects.json` = legacy path table | Pulse (golden tests); worlds-content-server (`/realms` → `/live-data`); realm-provider (`/about`, `/health`); social-service (`/peers?all=true`) |
| `http/today/*.json` | today's archipelago-stats responses, probed 2026-09-04 (wallets replaced) | validators: R4 "no response-shape drift" |
| `hot-scenes/fixture.json` + `reference/` | stats' hot-scenes test cases + the source it ports (`hot-scenes-handler.ts`, `content.ts`) | comms-gatekeeper `/hot-scenes` |
| `scene-participants/*.json` | C3 resolution cases: land, world (mixed case), world + pointer, banned-filtered | comms-gatekeeper `/scene-participants` |
| `manifest.json` | sha256 of every fixture file | validators, CI |
| `tools/` | generators (`peerset.js` is the single source of the synthetic data) | maintainers |

## How to consume

1. **Copy, never reference.** Copy the files you need into your repo's test tree (e.g.
   `test/fixtures/iteration-2/`). CI has no sibling checkout. Do not edit copies; if a fixture is
   wrong, the contract is wrong — report a deviation, the pack is amended, everyone re-copies.
2. **Verify copies**: `sha256sum <copy>` must equal the entry in `manifest.json`.
3. **Pulse** (producer): build the batch from the scenario in `NN-*.json` (and the `*.input.json`
   for 05/06), serialize with Google.Protobuf, assert the bytes equal `NN-*.bin`. Golden HTTP tests:
   construct the boards from the peer set below, call the route, compare with `http/*.json` `body`
   and `status` (numeric tolerance below).
4. **Consumers**: decode `NN-*.bin` with your generated code, assert the decoded object equals the
   `.json` (mapping names per your codegen — the JSON uses protobuf-JSON lowerCamelCase). Then run
   `replay.json` through your state machine and assert `map` / `statusEvents` after each step.

## The peer set (`tools/peerset.js`)

All fixtures derive from five peers; positions are away from parcel-cell boundaries.

| key | address | realm | position (x,y,z) | parcel | lastPing | cluster |
|---|---|---|---|---|---|---|
| W1 | `0x…0001` | main | −0.31, 1.73, 4.62 | −1,0 | T0 | C1 |
| W2 | `0x…0002` | main | 2360.5, 1.5, −40.2 | 147,−3 | T0+6 | C2 |
| W3 | `0x…0003` | cozyfarm.dcl.eth | 8.0, 0.0, 8.0 | 0,0 | T0−14 | C3 |
| W4 | `0x…0004` | main | −5.0, 0.5, 10.0 | −1,0 | T0+10 | C1 |
| W5 | `0x…0005` | main | 2355.0, 0.0, −35.0 | 147,−3 | T0+20 | C2 |

T0 = `1788515567804` (2026-09-04T09:52:47.804Z). The HTTP goldens are read at pass time T0+30.
Extra wallets: `0x…0007` (second Pulse instance), `0x…0009` (never online),
`0x…00AB`/`0x…00ab` (mixed-case ingest → lowercase output).

Derived values, exactly as Pulse computes them:
- parcel = `(floor(x/16), floor(z/16))`
- island `center` = mean of member positions on all three axes (`ClusterTracker.Centroid`)
- island `radius` = farthest member distance from the centre **on the XZ plane** (`ClusterTracker.BuildCluster`)
- cluster ids `C{n}` come from one global counter, so they are unique across realms; `maxPeers` is 0

## replay.json semantics

`steps[*].map` is the expected presence map for a seq-aware consumer after applying that batch.
`steps[*].statusEvents` is the **per-change derivation** (every change maps to ONLINE or OFFLINE, one event per entry)
before the consumer's own dedupe: a consumer that publishes only on status change (social-service's
`notifyPeerStatusChange`) emits a subset — e.g. `02-delta-move` derives `ONLINE(W2)` but publishes nothing, because W2
was already ONLINE. Assert the two halves separately: the pure mapping equals `statusEvents` verbatim; the published
stream equals `statusEvents` folded through a running status map (only transitions survive).

## Numeric tolerance

Pulse computes positions, centroids and radii in `float32`; goldens are written with up to six
decimals. Compare `position[*]`, `center[*]`, `radius` with an absolute tolerance of `1e-3`.
Everything else (ids, addresses, realms, parcels, counts, timestamps, ordering) is exact.

## Ordering (normative for C2)

- `/realms`: `peers` desc, then `name` asc
- peers lists (every route): `address` asc
- `/parcels`: `peersCount` desc, then `x` asc, then `y` asc
- `/islands`: id in natural order (C1 < C2 < C10); members by `address` asc

## Redirects (C2)

`/peers`, `/parcels`, `/islands`, `/islands/:id` and the `/comms/`-prefixed copies answer
`308 Location: /realms/main/…` preserving the query string. Exception: `/peers` and `/comms/peers`
with an `id` or `all` query parameter, and `/peers/:id` / `/comms/peers/:id`, are handled directly (all realms) — see `http/redirects.json`.
Realm path segments match case-insensitively; responses carry the canonical lowercase realm.
An unknown realm is an empty realm (200, empty list), never 404.

## Protobuf-JSON conventions in `parcel_changes/*.json`

- proto3 defaults are omitted: no `"snapshot": false`, no `"x": 0`, no `"seq": 0`
- `"parcel": {}` means **present, (0,0)** — the world origin; consumers must treat it as a placement
- `parcel` key **absent** means the peer left that realm/instance
- `seq`/`serverTime` are plain numbers (all values < 2^53)
- the bytes are what Google.Protobuf emits for the same message (field order, defaults omitted);
  protobufjs produces identical bytes as long as defaults are not set on the source object

## Realm canonicalization

Realms and addresses are lowercased at Pulse ingest (handshake and teleport) — `06-mixed-case`
pins it. Consumers still compare case-insensitively and treat a non-lowercase value on the wire
(`07-invalid-mixed-case-realm.bin`) as a contract violation to log, not as a reason to drop state.
`main` is Genesis City; worlds are `<name>.dcl.eth`; local-scene realms are `lsd:sha256:…`.

## Regenerating

```bash
cd docs/contracts/iteration-2
node tools/gen-parcel-changes.js && node tools/gen-http-goldens.js && node tools/manifest.js
# CI / validators:
node tools/gen-parcel-changes.js --check && node tools/gen-http-goldens.js --check && node tools/manifest.js --check
```

`protobufjs` is resolved from the repository's `node_modules` (a transitive dependency of `@dcl/protocol`).

## scene-participants fixtures — what is contractual

In `scene-participants/*.json` the `catalyst.returns` / `worlds.returns` objects are illustrative mocks; only the
scene `parcels` (and the pointer → scene resolution) are contractual. The real `fetchWorldSceneByPointer` type in
comms-gatekeeper is `{ entityId, parcels }`. The `body` and `status` are exact.

## C1 §2 clarification (raised by WP1)

"Every exit path emits exactly one parcel-absent entry" applies to peers that previously received a non-null
entry. A peer dropped before its first placement (e.g. in `PENDING_AUTH`) was never on the feed and emits nothing.
Pulse's `/about` may carry additional fields beyond `commitHash` and `userCount` (e.g. `featureFlagOverrides`);
consumers read the two documented keys.

## Consumer rule — additions (raised by WP2 review)

- **Prime entries** (from `/peers?all=true`) carry no `server_name`. Keep them until a publisher re-asserts the wallet
  (ownership transfers) or until a prime TTL (≈ snapshot interval + margin, 90 s) expires. Never drop them on another
  publisher's snapshot.
- **Publisher liveness.** A `server_name` silent for more than ≈ 2.5 × the snapshot interval (150 s) is presumed gone:
  drop its entries and forget its `seq`. When it returns it starts with a snapshot, as on any restart.

## Subjects (addendum)

- `peer.{address}.connect` — published by ws-connector after every successful handshake (empty payload, lowercase
  address). comms-gatekeeper re-emits the peer's current `engine.peer.{address}.island_changed` on it, so a
  reconnecting WebSocket gets its island back without a cluster change (this is what heartbeats used to provide).
