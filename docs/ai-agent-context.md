# AI Agent Context

**Service Purpose:** Monorepo with one service supporting Decentraland's real-time layer: the WS Connector, the only entry point clients talk to. Players are grouped into clusters by proximity and each cluster maps to a LiveKit room.

> **Iterations 1 and 2 of the Archipelago ⇒ Pulse migration are complete on this side.** `archipelago-core` was removed in iteration 1 and `archipelago-stats` in iteration 2, leaving `ws-connector` as the only workspace. Pulse authors the clustering, publishes `engine.islands` / `engine.discovery` / `engine.parcel_changes`, and serves the online-player endpoints; comms-gatekeeper mints LiveKit connection strings, publishes `engine.peer.{addr}.island_changed`, and serves `/hot-scenes`. WS Connector keeps the socket and gained exactly two things in iteration 2: the heartbeat-republishing switch, and the `peer.{addr}.connect` announcement gatekeeper re-emits an island assignment from. Runbooks: [core-decommission-runbook.md](./core-decommission-runbook.md), [stats-decommission-runbook.md](./stats-decommission-runbook.md). Upstream design: `Pulse/docs/clustering-on-aoi.md`. Archived record of core's algorithm: [island-clustering-algorithm.md](./island-clustering-algorithm.md).

**Role in the real-time layer:** The WS Connector is the first connection a client makes on entering the world. It authenticates the client, publishes its heartbeats, and forwards island assignments for the lifetime of the session. The LiveKit connection string it forwards is what the client uses to join the voice/CRDT room.

---

## Services

### WS Connector (`/ws-connector`)

Persistent WebSocket gateway. Clients connect here and talk to nothing else.

**Key responsibilities:**
- ECDSA challenge-response auth at connect time using `@dcl/crypto` AuthChain
- Receives continuous position heartbeats from clients
- Publishes heartbeats and disconnects to NATS, unless `HEARTBEAT_FORWARDING_ENABLED=false`. Both subjects are consumer-less now: core read them until iteration 1 removed it, archipelago-stats until iteration 2 removed it
- Publishes `peer.{addr}.connect` on every successful handshake — never gated — so comms-gatekeeper re-emits that peer's current island assignment. This is what a reconnecting socket gets instead of the retired client heartbeat
- Subscribes to `engine.peer.{id}.island_changed` and forwards island assignment + LiveKit connection string (with embedded token) to the client
- Enforces the platform deny list at connection time
- Kicks duplicate sessions (same address reconnects evicts previous)

**Endpoint:** `/ws` (WebSocket)

**Connection liveness:** the socket is held open by the server, not by the client. uWebSockets pings
an idle connection (`sendPingsAutomatically`) and the client's automatic pong resets the idle timer,
so a client that sends nothing of its own — as iteration 2's heartbeat-free clients do — is never
dropped for silence and keeps receiving `island_changed`. `WS_IDLE_TIMEOUT_SECONDS` (default `90`)
therefore does **not** bound how long a client may stay quiet; it bounds how long a socket whose peer
has stopped answering pings — a dead or half-open connection — lingers before uWS reaps it. Raising
it makes ghost peers (and their `peersRegistry` entries) linger longer; `0` disables reaping
entirely and is for local debugging only. uWS accepts just `0` or values ≥ 8, rounded to multiples
of 4, and ws-connector refuses to start on anything in between.
`ws-connector/test/integration/ws-idle.spec.ts` pins the behaviour.

**Heartbeat retirement:** `HEARTBEAT_FORWARDING_ENABLED` (default `true`) controls whether the client
heartbeat is still republished as `peer.<addr>.heartbeat` and the session close as
`peer.<addr>.disconnect`. Iteration 2 retired both — archipelago-stats was their only consumer, and
Pulse reads positions from its own transport — so the switch exists to turn the intake off ahead of
deleting the code. With it off the heartbeat packet is still decoded and accepted (clients on old
builds keep sending it) and nothing else on the socket changes: the registry eviction on close,
`island_changed` forwarding, the idle pings. The value is read leniently and never fails a deploy:
`false`/`0`/`no`/`off` turn forwarding off, `true`/`1`/`yes`/`on`/blank/unset leave it on, and
anything else leaves it on with a warning naming the key and the value — a typo in the switch must
not take `/ws` down with it.

**Reconnects do not depend on that switch.** `peer.<addr>.connect`, published after every
successful handshake and gated by nothing, is what tells comms-gatekeeper to re-emit the peer's
current `engine.peer.<addr>.island_changed`. Gatekeeper otherwise publishes an assignment only when
Pulse reports a cluster change, so without the announcement a socket that reconnects while its
cluster is unchanged — a network blip, or the explorer's own `ForceFreshIslandAssignmentAsync` after
repeated LiveKit failures — would sit there with no island until the crowd moved; the next client
heartbeat used to cover that. Both halves had to be deployed before rollout step 7 turned client
heartbeats off ([stats-decommission-runbook.md](./stats-decommission-runbook.md#7-the-handshake-announcement-is-on-the-broker)).
A publish that the broker refuses is contained, logged and counted on
`ws_connector_peer_connect_publish_failures_total`: the handshake completes either way, because a
client with no island re-handshakes and a client with no socket is broken.

**Both retired subjects now have no subscriber at all**, so `false` is the value production wants:
the flag was flipped at rollout step 8 and the stats workspace was deleted at step 9. The switch stays in the
tree on purpose — it is the writer half of the stats rollback
([stats-decommission-runbook.md](./stats-decommission-runbook.md#rollback) step 4), and a redeployed
stats with the intake still off answers `200` with an empty peer map, which reads as "everyone left".
The code goes in a follow-up, once that rollback is out of the question.

The cost of the flip is recorded there too, and it is worth knowing why the ordering was strict:
stats had no time-based peer expiry, so with the intake off its peer map froze rather than emptied —
no arrivals, no departures, and every session that ended inside the off-window stayed "online" in
`/peers`, `/parcels` and `/hot-scenes`, which feeds places. That is why step 8 waited on the
CloudFlare cut (step 5) moving the readers to Pulse and comms-gatekeeper, *and* on heartbeat-free
clients reaching ≥ 95 % of sessions (step 7). It was never a free canary: flipping back resumes
publishing but cannot clear stale entries, because the sessions that left will never announce it.

**Wire-contract tests:** `ws-connector/test/contract/` pins what Pulse publishes, in bytes —
`pulse-wire.spec.ts` for `engine.discovery` / `engine.islands` (moved out of `stats` before iteration
2 deleted it) and `parcel-changes.spec.ts` for `engine.parcel_changes`, against fixtures copied
verbatim from the contract pack. ws-connector consumes none of these feeds; it is the workspace that
remains, and the feeds outlived their first consumer.

**Auth flow:**
```
Client connects
    ↓
WS Connector sends challenge (random nonce)
    ↓
Client signs with ephemeral key (AuthChain)
    ↓
WS Connector validates signature via @dcl/crypto
    ↓
Peer registered, heartbeats accepted
```

---

### Archipelago Core — removed

The `core` workspace no longer exists. Where each of its responsibilities went, verified against Pulse's source before deletion:

| Core did | Now handled by |
| --- | --- |
| Position intake from `peer.*.heartbeat` | Pulse reads positions from its own transport (`SnapshotBoard`) — no NATS hop |
| Peer expiry (60 s heartbeat timeout) | Pulse connection lifecycle, ~5 s cleanup |
| Clustering: 64/80 single-linkage, 100-peer cap | Pulse `ClusterTracker`: union-find over 100 u grid cells, **uncapped**, sticky `C{n}` IDs with a dwell debounce |
| `engine.islands` and `engine.discovery` | Pulse `NatsPublisher` — `max_peers = 0`, discovery every 10 s |
| `engine.peer.{addr}.island_changed`, LiveKit token minting, ban check at mint time | **comms-gatekeeper**, which subscribes to Pulse's `peer.{addr}.cluster_change` |
| `desiredRoom` → merge-target bias | Nothing. It only mattered when the 100-peer cap split a co-located crowd; uncapped clusters make that impossible, and no production client set it. The proto field survives on the wire and is read by nobody |

The gatekeeper hop exists because minting means issuing a signed LiveKit JWT and running a per-user ban check — token-issuer concerns, so Pulse publishes only the assignment it knows about. That hop is the one piece of core's job that is **not** Pulse's, and it lives in a separate repo.

Rollback is a revert plus an image rebuild, not a config flip — see [core-decommission-runbook.md](./core-decommission-runbook.md). The algorithm core implemented is archived in [island-clustering-algorithm.md](./island-clustering-algorithm.md).

---

### Archipelago Stats — removed

The `stats` workspace no longer exists. It was read-only monitoring, never in the client data path. Where each endpoint is served now:

| Stats served | Now served by |
| --- | --- |
| `/peers`, `/peers/{id}`, `/parcels`, `/islands`, `/islands/{id}`, `/status`, and every `/comms`-prefixed alias | **Pulse HTTP**, realm-scoped under `/realms/{realm}/…`. Pulse itself answers `308` to `/realms/main/…` from the collection paths — `/peers`, `/parcels`, `/islands`, `/islands/{id}` and their `/comms/…` copies. Answered **directly**, across all realms: `/status`, the `?id=<wallet>` / `?all=true` query forms of `/peers` **and** `/comms/peers`, and the single-peer path form `/peers/{id}` **and** `/comms/peers/{id}` (stats served that alias, so it stays live rather than redirecting) |
| `/about`, `/health` | **Pulse HTTP** — `/health` is the CloudFlare origin health check |
| `/hot-scenes` | **comms-gatekeeper**, from its `engine.parcel_changes` presence map; `realm-provider` proxies it. Gatekeeper also serves `/scene-participants` |
| `/core-status` | **retired outright** — realm-provider stopped reading it at rollout step 5 |
| Position intake from `peer.*.heartbeat` | **Pulse reads positions from its own transport** — no NATS hop, and no client heartbeat |
| Catalyst scene lookup for `/hot-scenes` thumbnails | comms-gatekeeper. `dcl-catalyst-client` is no longer a dependency of this repo |

`archipelago-ea-stats.decentraland.{org,zone}` still resolves: a CloudFlare rule fronts Pulse and comms-gatekeeper on that hostname, so the public URLs and response shapes stayed stable across the move. Nothing in this repo serves them.

Two properties of the removed service still explain the rollout's ordering and the shape of its rollback: it had **no** time-based peer expiry — it dropped a peer only on `peer.*.disconnect`, so a missed disconnect left one in `/peers`, `/parcels` and `/hot-scenes` indefinitely — and its peer map was fed only by heartbeats, so it cannot be restored, only refilled. See [stats-decommission-runbook.md](./stats-decommission-runbook.md). (`CHECK_HEARTBEAT_INTERVAL` was core's, not stats'.)

The `engine.islands` / `engine.discovery` wire contract survived the deletion, in `ws-connector/test/contract/pulse-wire.spec.ts`.

---

## NATS Message Reference

This repo **publishes** exactly three subjects, all from ws-connector — `peer.<addr>.connect` on
every successful handshake, ungated and the only one of the three with a consumer, plus the retired
pair `peer.<addr>.heartbeat` and `peer.<addr>.disconnect`, both gated by
`HEARTBEAT_FORWARDING_ENABLED` — and **subscribes** to exactly one:
`engine.peer.<addr>.island_changed` (ws-connector, `src/service.ts`). Deleting `stats` took the
other four subscriptions with it, and stats was the only subscriber the retired pair ever
had, so with the flag off at rollout step 8 this repo's broker traffic is one subject inbound and
one outbound. Every other row below is broker-map context with no endpoint in this repo:
`engine.islands` and `engine.discovery` (subscriber-less since the deletion),
`engine.parcel_changes` (consumed in other repos; its wire bytes are pinned here, in
`ws-connector/test/contract/parcel-changes.spec.ts`) and `peer.<addr>.cluster_change` (not pinned
here at all). Payload types come from `@dcl/protocol`.

| Subject | Publisher | Subscriber | Content |
| --- | --- | --- | --- |
| `engine.parcel_changes` | Pulse | comms-gatekeeper, social-service-ea | `decentraland.pulse.ParcelChangesBatch` — per-parcel presence deltas (snapshot or delta, `seq`-ordered), iteration 2's only source of online-player information. Nothing in this repo consumes it; its wire bytes are pinned in `ws-connector/test/contract/parcel-changes.spec.ts` |
| `peer.<addr>.cluster_change` | Pulse | comms-gatekeeper (queue group) | `decentraland.pulse.PeerClusterChange { cluster_id, realm }` — one peer's published cluster assignment changed; gatekeeper mints the LiveKit token from it |
| `engine.islands` | Pulse | **nobody** | `IslandStatusMessage` — full island topology, `C{n}` ids, `maxPeers: 0`. Fed stats' `GET /islands`, which Pulse serves itself now; still published, and still pinned in `ws-connector/test/contract/pulse-wire.spec.ts` |
| `engine.discovery` | Pulse | **nobody** | `ServiceDiscoveryMessage` — clustering-service heartbeat every 10 s, `current_time` as `uint64`. Fed stats' `/core-status`, which retired; pinned in the same spec |
| `engine.peer.<addr>.island_changed` | comms-gatekeeper | **ws-connector** | `IslandChangedMessage` — island id plus the LiveKit connection string with an embedded token; forwarded to that peer's socket unchanged. `peers` arrives empty by design |
| `peer.<addr>.connect` | **ws-connector** | comms-gatekeeper | empty payload — published on handshake so comms-gatekeeper re-emits the current island assignment. Lower-cased address. Not gated by `HEARTBEAT_FORWARDING_ENABLED`: gatekeeper's `island_changed` otherwise follows only a Pulse cluster change, so this is what a reconnecting socket has instead of the retired client heartbeat. Failures are counted on `ws_connector_peer_connect_publish_failures_total` |
| `peer.<addr>.heartbeat` | **ws-connector** | **nobody** | `Heartbeat` — the client's position, republished. archipelago-stats was its only consumer; gated by `HEARTBEAT_FORWARDING_ENABLED`, turned off at rollout step 8 |
| `peer.<addr>.disconnect` | **ws-connector** | **nobody** | empty payload — the session closed; was stats' only way of dropping a peer. comms-gatekeeper deliberately never subscribed (it expires assignments on a TTL instead). Gated by the same flag and retired with it |

## Technology Stack

- Runtime: Node.js 24 (`.nvmrc`, and the Dockerfile pins `node:24-trixie-slim`)
- Language: TypeScript 4.x–5.x
- HTTP framework: `@well-known-components/http-server`
- WebSocket: `ws` + `@well-known-components/uws-http-server`
- Component architecture: `@well-known-components` (logger, metrics, nats, http-server, env-config-provider)

**External dependencies:**
- **NATS**: All inter-service communication between WS Connector, Pulse and comms-gatekeeper
- **LiveKit API**: Called by comms-gatekeeper to generate room tokens — no longer from this repo
- **`@dcl/protocol`**: Protobuf definitions for Heartbeat, IslandChangedMessage, IslandStatusMessage, ServiceDiscoveryMessage. Pinned to the npm release of [protocol#453](https://github.com/decentraland/protocol/pull/453), which restores `ServiceStatus`/`ServiceDiscoveryMessage` with `current_time` as `uint64`
- **`@dcl/crypto`**: Ethereum signature validation, AuthChain

---

## Project Structure

```
ws-connector/  WebSocket handlers, peer registry, auth flow, NATS pub/sub — the only workspace
docs/          OpenAPI spec, the two removal runbooks, the archived clustering algorithm
```

**API Specification:** See `docs/openapi.yaml` for the WS Connector REST API. The retired Stats endpoints are documented where they are served now — `Pulse/docs/openapi.yaml` and comms-gatekeeper's spec.

---

## Known Architectural Issues

- **Cluster IDs are not unique beyond one Pulse process.** `C{n}` comes from a monotonic counter that resets on restart, so after a Pulse restart `C1` names a different crowd and comms-gatekeeper may map it onto the LiveKit room the previous `C1` used. Live-voice-room correctness, not cosmetics; tracked as an open question in `Pulse/docs/clustering-on-aoi.md` §7.
- **Reported island IDs do not match what clients receive.** Pulse's `GET /islands` serves cluster IDs (`C{n}`, the same ones it puts on `engine.islands`), while the `islandId` gatekeeper puts on the client wire is the room name (`island-C{n}`). Under core the two were identical. Nothing joins them today — clients read only `connStr` — but any tooling that correlates reported islands with client-reported ones must account for the `island-` prefix.
- **Clusters are uncapped, and no consumer re-partitions them — by design.** Pulse is the single source of cluster composition: comms-gatekeeper maps one cluster to one LiveKit room, `island-{clusterId}`, verbatim, with no sharding anywhere downstream. Nothing bounds co-located crowd size server-side, so the client's GPU is the binding constraint (unity-explorer's crowd-ghost work), and at capacity density a percolated cluster becomes one oversized room. If room/crowd size ever needs bounding it will be implemented in Pulse at the tracker level, never in consumers; the open question is tracked in `Pulse/docs/clustering-on-aoi.md` §7.
- **No in-repo rollback for the clustering path.** Reverting to core means reverting a commit and rebuilding the image; there is no configuration flip. The stats rollback is cheaper — a CloudFlare revert plus a redeploy — but it restores the endpoints, not their data: the peer map was heartbeat-fed, and heartbeat-free clients will not refill it. See [stats-decommission-runbook.md](./stats-decommission-runbook.md#rollback).
- **The topology change went unmeasured.** No shadow comparison was run between core's 64/80 single-linkage islands and Pulse's 100 u cell clusters, so the first evidence of a difference will be `GET /islands` in a live environment.
