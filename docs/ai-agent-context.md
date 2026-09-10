# AI Agent Context

**Service Purpose:** Monorepo with two services supporting Decentraland's real-time layer: the WS Connector (the only entry point clients talk to) and Stats (read-only monitoring). Players are grouped into clusters by proximity and each cluster maps to a LiveKit room.

> **Iteration 1 of the Archipelago ⇒ Pulse migration is complete on this side.** `archipelago-core` was removed. Pulse authors the clustering and publishes `engine.islands` / `engine.discovery`; comms-gatekeeper mints LiveKit connection strings and publishes `engine.peer.{addr}.island_changed`. WS Connector gained one publish — `peer.{addr}.connect` on a completed handshake, which comms-gatekeeper answers by re-announcing the wallet's island; Pulse's feed is edge-triggered, so without it a client that reconnects standing still is never given a room. Stats keeps every endpoint until iteration 2. Runbook: [core-decommission-runbook.md](./core-decommission-runbook.md). Upstream design: `Pulse/docs/clustering-on-aoi.md`. Archived record of the removed algorithm: [island-clustering-algorithm.md](./island-clustering-algorithm.md).

**Role in the real-time layer:** The WS Connector is the first connection a client makes on entering the world. It authenticates the client, publishes its heartbeats, and forwards island assignments for the lifetime of the session. The LiveKit connection string it forwards is what the client uses to join the voice/CRDT room.

---

## Services

### WS Connector (`/ws-connector`)

Persistent WebSocket gateway. Clients connect here and talk to nothing else.

**Key responsibilities:**
- ECDSA challenge-response auth at connect time using `@dcl/crypto` AuthChain
- Receives continuous position heartbeats from clients
- Publishes heartbeats and disconnects to NATS for Stats to aggregate (Core consumed these until it was removed)
- Publishes `peer.{addr}.connect` once a handshake completes, carrying the session key (the auth chain's ephemeral address), so comms-gatekeeper can re-announce that wallet's island to that device
- Subscribes to `engine.peer.{addr}.island_changed.{session}` (and, during the transition, the legacy `engine.peer.{addr}.island_changed`) and forwards the island assignment + LiveKit connection string (with embedded token) to the client
- Enforces the platform deny list at connection time
- Registers sockets by (wallet, session key) and forwards `engine.peer.{addr}.island_changed.{session}` only to the socket holding that session. A second device of the same wallet coexists; only the same device's zombie socket is replaced (and told `kicked`)
- De-duplicates a repeated `island_changed` for the same island to the same socket within `ISLAND_CHANGED_DEDUP_MS` (default 10 s): the client already holds a token for that room, and a second string for it would make it join the room it is joining. Counted by `dcl_ws_connector_island_changed_deduplicated_total`.

**Endpoint:** `/ws` (WebSocket)

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

### Archipelago Stats (`/stats`)

Read-only monitoring service. Not in the client data path.

**Key responsibilities:**
- Subscribes to NATS: `peer.*.heartbeat`, `peer.*.disconnect`, `engine.islands`, `engine.discovery`
- Aggregates peer count and island topology in memory
- Exposes REST endpoints for island/peer statistics and clustering-service health
- Integrates with Catalyst for content server metadata

Unchanged by iteration 1, deliberately: the peer map is still heartbeat-fed, so `/peers`, `/parcels` and `/hot-scenes` behave exactly as before. Only the island topology's source moved — `GET /islands` now serves `C{n}` IDs with `maxPeers: 0`, and `/core-status` reports Pulse's health without changing its response shape. `stats/test/unit/pulse-topology.spec.ts` pins the wire contract.

Stats has **no** time-based peer expiry: it drops a peer only on `peer.*.disconnect`, so a missed disconnect leaves one in `/peers`, `/parcels` and `/hot-scenes` indefinitely. `CHECK_HEARTBEAT_INTERVAL` was core's, not stats'.

Endpoint migration to Pulse and comms-gatekeeper, plus heartbeat removal, is iteration 2.

---

## NATS Message Reference

Every `peer.*` subject is published by this repo; the `engine.*` ones are published elsewhere
and consumed here. None of these carry a queue group, so each subscribing replica receives its
own copy — except comms-gatekeeper's `connect` subscription, which is grouped so exactly one of
its replicas answers.

| Subject | Publisher | Subscriber | Content |
| --- | --- | --- | --- |
| `peer.{addr}.heartbeat` | WS Connector | Stats | `Heartbeat` (position) |
| `peer.{addr}.disconnect` | WS Connector | Stats | empty; published when any one socket of the wallet closes, so with two devices the first to leave announces the wallet while the other is still connected (Stats' peer map is heartbeat-fed, so it recovers on the next heartbeat) |
| `peer.{addr}.connect` | WS Connector | comms-gatekeeper (grouped) | the session key of the new socket, UTF-8 |
| `engine.peer.{addr}.island_changed.{session}` | comms-gatekeeper | WS Connector (every replica) | `IslandChangedMessage`, delivered only to the socket holding `{session}` |
| `engine.peer.{addr}.island_changed` | comms-gatekeeper | WS Connector (every replica) | `IslandChangedMessage` (transition; behind `LEGACY_ISLAND_CHANGED_FORWARDING`) |
| `engine.islands` | Pulse | Stats | cluster topology |
| `engine.discovery` | Pulse | Stats | service discovery heartbeat |

## Technology Stack

- Runtime: Node.js 24 (`.nvmrc`, and the Dockerfile pins `node:24-trixie-slim`)
- Language: TypeScript 4.x–5.x
- HTTP framework: `@well-known-components/http-server`
- WebSocket: `ws` + `@well-known-components/uws-http-server`
- Component architecture: `@well-known-components` (logger, metrics, nats, http-server, env-config-provider)

**External dependencies:**
- **NATS**: All inter-service communication between WS Connector, Stats, Pulse and comms-gatekeeper
- **LiveKit API**: Called by comms-gatekeeper to generate room tokens — no longer from this repo
- **`@dcl/protocol`**: Protobuf definitions for Heartbeat, IslandChangedMessage, IslandStatusMessage, ServiceDiscoveryMessage. Pinned to the npm release of [protocol#453](https://github.com/decentraland/protocol/pull/453), which restores `ServiceStatus`/`ServiceDiscoveryMessage` with `current_time` as `uint64`
- **`@dcl/crypto`**: Ethereum signature validation, AuthChain
- **`dcl-catalyst-client`**: Stats service fetches content server data

---

## Project Structure

```
ws-connector/  WebSocket handlers, peer registry, auth flow, NATS pub/sub
stats/         REST API endpoints, Catalyst integration, NATS subscribers, data aggregation
docs/          OpenAPI specs, the removal runbook, the archived clustering algorithm
```

**API Specification:** See `docs/openapi.yaml` for Stats and WS Connector REST API documentation.

---

## Known Architectural Issues

- **Cluster IDs are not unique beyond one Pulse process.** `C{n}` comes from a monotonic counter that resets on restart, so after a Pulse restart `C1` names a different crowd and comms-gatekeeper may map it onto the LiveKit room the previous `C1` used. Live-voice-room correctness, not cosmetics; tracked as an open question in `Pulse/docs/clustering-on-aoi.md` §7.
- **Stats island IDs no longer match what clients receive.** `GET /islands` serves Pulse's cluster IDs (`C{n}`, from `engine.islands`), while the `islandId` gatekeeper puts on the client wire is the room name (`island-C{n}`). Under core the two were identical. Nothing joins them today — clients read only `connStr` — but any tooling that correlates stats islands with client-reported ones must account for the `island-` prefix.
- **Clusters are uncapped, and no consumer re-partitions them — by design.** Pulse is the single source of cluster composition: comms-gatekeeper maps one cluster to one LiveKit room, `island-{clusterId}`, verbatim, with no sharding anywhere downstream. Nothing bounds co-located crowd size server-side, so the client's GPU is the binding constraint (unity-explorer's crowd-ghost work), and at capacity density a percolated cluster becomes one oversized room. If room/crowd size ever needs bounding it will be implemented in Pulse at the tracker level, never in consumers; the open question is tracked in `Pulse/docs/clustering-on-aoi.md` §7.
- **No in-repo rollback for the clustering path.** Reverting to core means reverting a commit and rebuilding the image; there is no configuration flip. Stats' peer map is unaffected either way, being heartbeat-fed.
- **Two instances on one device are one session.** The session key is the cached ephemeral address, shared by every process on a device; their sockets replace each other and the island feed reaches whichever registered last. Not a product scenario.
- **The topology change went unmeasured.** No shadow comparison was run between core's 64/80 single-linkage islands and Pulse's 100 u cell clusters, so the first evidence of a difference will be `GET /islands` in a live environment.
- **`/status` `userCount` counts sockets, not wallets.** Since sockets are registered per (wallet, session), a wallet connected from two devices counts twice.
