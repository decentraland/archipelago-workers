# AI Agent Context

**Service Purpose:** Monorepo with three services that implement island clustering for Decentraland's real-time layer. Players are dynamically grouped into islands based on proximity; each island maps to a LiveKit room. The WS Connector is the only entry point clients talk to — Archipelago Core is internal.

**Role in the real-time layer:** The WS Connector is the first connection a client makes on entering the world. It authenticates the client and drives the island assignment loop for the lifetime of the session. The LiveKit connection string (including token) that Archipelago returns is what the client uses to join the voice/CRDT room.

---

## Services

### WS Connector (`/ws-connector`)

Persistent WebSocket gateway. Clients connect here; they never talk to Archipelago Core directly.

**Key responsibilities:**
- ECDSA challenge-response auth at connect time using `@dcl/crypto` AuthChain
- Receives continuous position heartbeats from clients
- Publishes heartbeats and disconnects to NATS for Core to process
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

### Archipelago Core (`/core`)

Island clustering engine. Stateless relative to clients — it processes positions and publishes assignments.

**Key responsibilities:**
- Processes player position updates from NATS
- Dynamic island clustering: join distance 64 units, leave distance 80 units
- Calls the LiveKit API directly to generate room tokens and builds the `livekit:{host}?access_token={token}` connection string
- Publishes island assignments (`engine.peer.{id}.island_changed`) to NATS
- Publishes island topology (`engine.islands`) and service heartbeat (`engine.discovery`) every ~2 seconds

**Island flush cycle:** `ARCHIPELAGO_FLUSH_FREQUENCY` — default 2 seconds. Islands are recalculated on each flush.

**Peer heartbeat timeout:** `CHECK_HEARTBEAT_INTERVAL` — default 60 seconds. Peers with no heartbeat are removed.

---

### Archipelago Stats (`/stats`)

Read-only monitoring service. Not in the client data path.

**Key responsibilities:**
- Subscribes to NATS: `peer.*.heartbeat`, `peer.*.disconnect`, `engine.islands`, `engine.discovery`
- Aggregates peer count and island topology in memory
- Exposes REST endpoints for island/peer statistics and core service health
- Integrates with Catalyst for content server metadata

---

## NATS Message Reference

| Subject | Publisher | Subscriber | Content |
| --- | --- | --- | --- |
| `peer.{addr}.heartbeat` | WS Connector | Core, Stats | Protobuf `Heartbeat`: position (x,y,z), desired island preference |
| `peer.{addr}.disconnect` | WS Connector | Core, Stats | Empty — peer left |
| `engine.peer.{id}.island_changed` | Core | WS Connector | Protobuf `IslandChangedMessage`: island ID, LiveKit connection string with token, peer list |
| `engine.islands` | Core | Stats | Full island topology snapshot: IDs, centers, radii, max peers, peer lists |
| `engine.discovery` | Core | Stats | Service heartbeat: name, commit hash, timestamp, user count |

The `island_changed` message connection string format: `livekit:{host}?access_token={jwt}`

---

## Configuration Reference

| Variable | Default | Description |
| --- | --- | --- |
| `ARCHIPELAGO_FLUSH_FREQUENCY` | 2000ms | Island recalculation interval |
| `ARCHIPELAGO_JOIN_DISTANCE` | 64 units | Distance threshold to merge peers into same island |
| `ARCHIPELAGO_LEAVE_DISTANCE` | 80 units | Distance threshold to split peers into different islands |
| `CHECK_HEARTBEAT_INTERVAL` | 60000ms | Timeout before removing a peer with no heartbeat |

---

## Technology Stack

- Runtime: Node.js 16+
- Language: TypeScript 4.x–5.x
- HTTP framework: `@well-known-components/http-server`
- WebSocket: `ws` + `@well-known-components/uws-http-server`
- Component architecture: `@well-known-components` (logger, metrics, nats, http-server, env-config-provider)

**External dependencies:**
- **NATS**: All inter-service communication between WS Connector, Core, and Stats
- **LiveKit API**: Called by Core to generate room tokens
- **`@dcl/protocol`**: Protobuf definitions for Heartbeat, IslandChangedMessage
- **`@dcl/crypto`**: Ethereum signature validation, AuthChain
- **`dcl-catalyst-client`**: Stats service fetches content server data

---

## Project Structure

```
core/        Island clustering engine, NATS subscribers, position processing, LiveKit transport
ws-connector/  WebSocket handlers, peer registry, auth flow, NATS pub/sub
stats/       REST API endpoints, Catalyst integration, NATS subscribers, data aggregation
docs/        OpenAPI spec for Stats and WS Connector APIs
```

**API Specification:** See `docs/openapi.yaml` for Stats and WS Connector REST API documentation.

---

## Known Architectural Issues

- **Pulse endpoint is hardcoded in client.** Archipelago assigns LiveKit rooms dynamically but has no awareness of Pulse. There is no guarantee the players in a LiveKit room are the same set receiving avatar deltas from the same Pulse instance. The fix is to add a `pulseEndpoint` field to `island_changed`.
- **Heartbeat timeout is 60 seconds.** A player who disconnects ungracefully stays in the island for up to 60 seconds.
- **Island flush is 2 seconds.** Island membership changes lag behind actual position changes by up to 2 seconds.
