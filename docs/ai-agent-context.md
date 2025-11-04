# AI Agent Context

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
