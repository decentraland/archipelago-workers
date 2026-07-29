# AI Agent Context

**Service Purpose:** Monorepo with two services supporting Decentraland's real-time layer: the WS Connector (the only entry point clients talk to) and Stats (read-only monitoring). Players are grouped into clusters by proximity and each cluster maps to a LiveKit room — but **neither the clustering nor the room tokens are produced here any more**.

> **Iteration 1 of the Archipelago ⇒ Pulse migration is complete on this side.** `archipelago-core` was removed. Pulse authors the clustering and publishes `engine.islands` / `engine.discovery`; comms-gatekeeper mints LiveKit connection strings and publishes `engine.peer.{addr}.island_changed`. WS Connector is unchanged; Stats keeps every endpoint until iteration 2. Runbook: [core-decommission-runbook.md](./core-decommission-runbook.md). Upstream design: `Pulse/docs/clustering-on-aoi.md`. Archived record of the removed algorithm: [island-clustering-algorithm.md](./island-clustering-algorithm.md).

**Role in the real-time layer:** The WS Connector is the first connection a client makes on entering the world. It authenticates the client, publishes its heartbeats, and forwards island assignments for the lifetime of the session — it does not compute them. The LiveKit connection string (including token) it forwards is minted by comms-gatekeeper and is what the client uses to join the voice/CRDT room.

---

## Services

### WS Connector (`/ws-connector`)

Persistent WebSocket gateway. Clients connect here and talk to nothing else; the services that compute their cluster (Pulse) and mint their room token (comms-gatekeeper) are behind it.

**Key responsibilities:**
- ECDSA challenge-response auth at connect time using `@dcl/crypto` AuthChain
- Receives continuous position heartbeats from clients
- Publishes heartbeats and disconnects to NATS for Stats to aggregate (Core consumed these until it was removed)
- Subscribes to `engine.peer.{id}.island_changed` and forwards island assignment + LiveKit connection string (with embedded token) to the client
- Enforces the platform deny list at connection time
- Kicks duplicate sessions (same address reconnects evicts previous)

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

Unchanged by iteration 1, deliberately: the peer map is still built from client heartbeats, so `/peers`, `/parcels` and `/hot-scenes` behave exactly as before. Only the source of the island topology moved. Two visible effects: `GET /islands` serves `C{n}` IDs with `maxPeers: 0` (uncapped clusters — it read `100` while core published this feed), and `/core-status` now reports Pulse's health. `/core-status` only ever exposed `{healthy, userCount}`, so Pulse's `server_name` and commit hash are invisible to `realm-provider` and it needs no change. The health check is `Date.now() − current_time < 90 s`, which is why `ServiceStatus.current_time` must stay `uint64` ([protocol#453](https://github.com/decentraland/protocol/pull/453)) — a truncated timestamp reads permanently unhealthy. `stats/test/unit/pulse-topology.spec.ts` guards all of this against real protobuf bytes.

Endpoint migration to Pulse and comms-gatekeeper, plus heartbeat removal, is iteration 2.

---

## NATS Message Reference

Only the two `peer.*` subjects are published by this repo.

| Subject | Publisher | Subscriber | Content |
| --- | --- | --- | --- |
| `peer.{addr}.heartbeat` | WS Connector | Stats | Protobuf `Heartbeat`: position (x,y,z). `desiredRoom` is still on the wire, read by nobody |
| `peer.{addr}.disconnect` | WS Connector | Stats | Empty — peer left |
| `peer.{addr}.cluster_change` | **Pulse** | comms-gatekeeper | Protobuf `decentraland.pulse.PeerClusterChange`: cluster ID, realm. Wallet lower-cased in the subject. Not consumed by this repo |
| `engine.peer.{id}.island_changed` | **comms-gatekeeper** | WS Connector | Protobuf `IslandChangedMessage`: island ID, LiveKit connection string with token, peer list |
| `engine.islands` | **Pulse** | Stats | Full topology snapshot: IDs (`C{n}`), centers, radii, `max_peers = 0`, peer lists |
| `engine.discovery` | **Pulse** | Stats | Service heartbeat every 10 s: `server_name = "pulse"`, commit hash, `current_time` (`uint64` epoch ms), user count |

The `island_changed` message connection string format: `livekit:{host}?access_token={jwt}`

---

## Configuration Reference

The clustering variables were removed with `core`. Each surviving service reads its own `.env.default`: `HTTP_SERVER_PORT`, `HTTP_SERVER_HOST`, `NATS_URL`, plus `COMMS_GATEKEEPER_URL` for WS Connector.

| Variable | Read by | Notes |
| --- | --- | --- |
| `NATS_URL` | both | Broker. Also the name Pulse accepts, so one injected secret serves both |
| `COMMS_GATEKEEPER_URL` | WS Connector | Gates the handshake ban check and the ban sweep. **Fails open** — unset means every handshake is allowed, signalled only by a boot-time warning. Core read this too; it survived core's removal |
| `ETH_NETWORK`, `HANDSHAKE_TIMEOUT`, `BAN_SWEEP_INTERVAL_MS` | WS Connector | Have code-level defaults; not listed in `.env.default` |

Removed with `core`, with their Pulse equivalents:

| Removed variable | Was | Pulse equivalent |
| --- | --- | --- |
| `ARCHIPELAGO_FLUSH_FREQUENCY` | `2.0` — island recalculation interval in **seconds**, multiplied by 1000 in code | `Clusters:PassIntervalMs` (`1000`, milliseconds) + `Clusters:DwellPasses` (`3`) |
| `ARCHIPELAGO_JOIN_DISTANCE` | 64 units to merge | `SpatialHashAreaOfInterest:CellSize` (100 u cells, join band 0–283 u) |
| `ARCHIPELAGO_LEAVE_DISTANCE` | 80 units to split | none — cell adjacency has no hysteresis pair |
| `ROOM_PREFIX` | island ID prefix `I` | `Clusters:IdPrefix` (`C`) |
| `LIVEKIT_ISLAND_SIZE` | 100-peer island cap | none — clusters are uncapped; gatekeeper shards rooms |
| `CHECK_HEARTBEAT_INTERVAL` | 60000ms peer expiry | none — Pulse cleans up in ~5s |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_HOST` | core minted tokens; all three required at startup | held by comms-gatekeeper |

---

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
- **Clusters are uncapped.** Nothing bounds co-located crowd size server-side any more, so the client's GPU becomes the binding constraint (unity-explorer's crowd-ghost work) and comms-gatekeeper owns room sharding.
- **No in-repo rollback for the clustering path.** Reverting to core means reverting a commit and rebuilding the image; there is no configuration flip. Stats' peer map is unaffected either way, being heartbeat-fed.
- **The topology change went unmeasured.** No shadow comparison was run between core's 64/80 single-linkage islands and Pulse's 100 u cell clusters, so the first evidence of a difference will be `GET /islands` in a live environment.

Resolved by the migration:

- ~~**Pulse endpoint is hardcoded in client.**~~ Pulse authors the clustering itself, so a cluster's members and the Pulse instance serving their avatar deltas cannot disagree by construction.
- ~~**Heartbeat timeout is 60 seconds.**~~ For clustering: Pulse cleans up departed peers in ~5 s. Note that stats has **no** time-based expiry of its own — `CHECK_HEARTBEAT_INTERVAL` was core's, and stats drops a peer only on `peer.*.disconnect`. A missed disconnect leaves a peer in `/peers`, `/parcels` and `/hot-scenes` indefinitely, which is unchanged by this migration and retires with the heartbeats in iteration 2.
- ~~**Island flush is 2 seconds.**~~ Pulse's tracker passes run every 1 s, with a dwell debounce before a reassignment publishes.
