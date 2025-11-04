# Archipelago Service

[![Coverage Status](https://coveralls.io/repos/github/decentraland/archipelago-workers/badge.svg?branch=coverage)](https://coveralls.io/github/decentraland/archipelago-workers?branch=coverage)

The Archipelago worker is a bundle of services designed to support a standalone realm in Decentraland. It consists of a `core` service that implements the established clustering logic to group users into islands based on their in-world positions. Additionally, the `ws-connector` service provides a WebSocket connection, exposed to Decentraland clients through the [Realm Provider](https://github.com/decentraland/realm-provider/). A `stats` service is also included, aggregating information about islands and peers, making it available for consumption.

## Getting Started

### Dependencies

- Node >= v16
- [NATS](https://nats.io/) running instance.
   - `NATS_URL` environment variable must be set. Eg: `NATS_URL=localhost:4222`

### Installation

Install Node dependencies:

```
yarn install
```

### Usage

Build and start the project:

```
yarn build
yarn start:local
```

### Test

Run unit and integration tests:

```
yarn test
```

### NATS messages:

- `peer.${address}.heartbeat`
- `peer.${address}.disconnect`
- `engine.peer.${address}.island_changed`
- `engine.discovery`
- `engine.islands`

## AI Agent Context

**Service Purpose:** Monorepo containing three services that implement the Archipelago protocol for clustering users into dynamic islands based on their positions in Decentraland's metaverse. The protocol enables scalable crowd management and efficient real-time communication.

**Key Capabilities:**

- **Core Service**: Implements island clustering algorithms, manages peer-to-island assignments, processes position updates, and publishes island change notifications via NATS
- **WebSocket Connector Service**: Manages WebSocket connections for Decentraland clients, handles Ethereum-based authentication, routes real-time messages (positions, chat, profiles), and maintains peer registry
- **Stats Service**: Provides REST API for monitoring and analytics, exposes island/peer/parcel statistics, aggregates core service data for observability

**Communication Pattern:** 
- Event-driven via NATS messaging (core service)
- Real-time bidirectional WebSocket connections (ws-connector service)
- Synchronous HTTP REST API (stats service)

**Technology Stack:**

- Runtime: Node.js 16+
- Language: TypeScript 4.x - 5.x
- HTTP Framework: @well-known-components/http-server
- WebSocket: ws library with @well-known-components/uws-http-server
- Component Architecture: @well-known-components (logger, metrics, nats, http-server, env-config-provider)

**External Dependencies:**

- Message Broker: NATS (peer heartbeats, disconnect events, island changes, discovery messages)
- Protocol: @dcl/protocol (Archipelago protocol definitions)
- Crypto: @dcl/crypto (Ethereum signature validation, AuthChain)
- Content: dcl-catalyst-client (for stats service to fetch content data)

**Project Structure:**

- `core/`: Island clustering engine, NATS subscribers, position processing
- `ws-connector/`: WebSocket handlers, peer registry, authentication flow
- `stats/`: REST API endpoints, Catalyst integration, data aggregation

**API Specification:** See `docs/openapi.yaml` for combined Stats and WebSocket Connector API documentation
