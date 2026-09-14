# Archipelago Workers

[![Coverage Status](https://coveralls.io/repos/github/decentraland/archipelago-workers/badge.svg?branch=coverage)](https://coveralls.io/github/decentraland/archipelago-workers?branch=coverage)

The Archipelago Workers is a monorepo containing the WebSocket gateway that Decentraland clients connect to. It is the repo's only service.

> **Clustering and online-player information have both moved out of this repo.** Iteration 1 of the Archipelago ⇒ Pulse migration **removed** `core`: Pulse authors the clustering and publishes `engine.islands` / `engine.discovery`, ws-connector now keys sockets by (wallet, session) and publishes `peer.{address}.connect` after every handshake, and comms-gatekeeper mints the LiveKit connection strings and publishes `engine.peer.{address}.island_changed.{session}`, falling back to the legacy `engine.peer.{address}.island_changed` for a session-less event. Iteration 2 **removed** `stats`: Pulse serves `/realms*`, `/peers*`, `/parcels`, `/islands*`, `/status`, `/about` and `/health`, comms-gatekeeper serves `/hot-scenes` and `/scene-participants` (realm-provider proxies `/hot-scenes`), and `/core-status` retired. The WebSocket Connector is what remains, and it is **not** unchanged by either: iteration 1 keyed it by (wallet, session) and added the connect announcement, and iteration 2 added server-side pings (`WS_IDLE_TIMEOUT_SECONDS`) and the `HEARTBEAT_FORWARDING_ENABLED` flag. Runbooks: [docs/core-decommission-runbook.md](docs/core-decommission-runbook.md), [docs/stats-decommission-runbook.md](docs/stats-decommission-runbook.md); [docs/island-clustering-algorithm.md](docs/island-clustering-algorithm.md) archives how core clustered.

## Table of Contents

- [Features](#features)
- [Dependencies](#dependencies)
- [API Documentation](#api-documentation)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Running the Service](#running-the-service)
- [Testing](#testing)

## Features

- **WebSocket Connector Service**: Provides real-time bidirectional WebSocket connections for Decentraland clients. Handles Ethereum-based authentication, routes real-time messages (positions, chat, profiles), maintains the peer registry (keyed by wallet and session), and forwards island assignments to clients. Not untouched by the migration: iteration 1 added the session key and the `peer.{address}.connect` announcement, iteration 2 added server-side pings and the `HEARTBEAT_FORWARDING_ENABLED` flag.

## Dependencies

- **[Realm Provider](https://github.com/decentraland/realm-provider/)**: Exposes WebSocket connections to Decentraland clients
- **Pulse**: Authors the peer clustering and publishes `engine.islands` / `engine.discovery`
- **comms-gatekeeper**: Mints LiveKit connection strings and publishes `engine.peer.{address}.island_changed.{session}`, falling back to the legacy `engine.peer.{address}.island_changed` for a session-less event
- **NATS**: Message broker for island assignments, the session-lifecycle `peer.{address}.connect`/`disconnect` events, and the peer heartbeat this service still republishes while `HEARTBEAT_FORWARDING_ENABLED` is true
- **@dcl/protocol**: Archipelago protocol definitions
- **@dcl/crypto**: Ethereum signature validation, AuthChain

## API Documentation

The API is fully documented using the [OpenAPI standard](https://swagger.io/specification/). The schema is located at [docs/openapi.yaml](docs/openapi.yaml).

It aggregates one service:
- **WebSocket Connector API**: Real-time communication endpoints (see [docs/ws-connector/openapi.yaml](docs/ws-connector/openapi.yaml))

The retired Stats API's endpoints are documented where they are served now: `Pulse/docs/openapi.yaml` for the realm-scoped `/realms*`, `/peers*`, `/parcels`, `/islands*`, `/status`, `/about` and `/health`, and comms-gatekeeper's spec for `/hot-scenes` and `/scene-participants`.

## Getting Started

### Prerequisites

Before running this service, ensure you have the following installed:

- **Node.js**: Version 24.x — see `.nvmrc`; the Docker image pins `node:24-trixie-slim`
- **Yarn**: Version 1.22.x or higher
- **Docker**: For containerized deployment and local development dependencies

### Installation

1. Clone the repository:

```bash
git clone https://github.com/decentraland/archipelago-workers.git
cd archipelago-workers
```

2. Install dependencies:

```bash
yarn install
```

3. Build the project:

```bash
yarn build
```

### Configuration

The service uses environment variables for configuration. Copy the example file and adjust as needed:

```bash
cp .env.default .env
```

See `.env.default` for available configuration options.

### Running the Service

#### Setting up the environment

In order to successfully run this service, external dependencies such as message brokers must be provided.

To do so, this repository provides you with a `docker-compose.yml` file for that purpose. In order to get the environment set up, run:

```bash
docker-compose up -d
```

This will start:
- NATS message broker on port `4222`

#### Running in development mode

To run the service in development mode:

```bash
yarn start:local
```

This starts the **WebSocket Connector Service**, the WebSocket gateway for clients.

It does not produce island assignments. For a client to receive one locally you also need Pulse publishing to the same broker and comms-gatekeeper subscribed to it.

### NATS Messages

The service communicates with Pulse and comms-gatekeeper over the following NATS message topics:

| Subject | Published by | Consumed by |
| --- | --- | --- |
| `peer.${address}.heartbeat` | WS Connector | nobody — stats was its only consumer; gated by `HEARTBEAT_FORWARDING_ENABLED`, retiring at rollout step 8 |
| `peer.${address}.disconnect` | WS Connector | nobody — same flag, same reason |
| `peer.${address}.connect` | WS Connector | comms-gatekeeper (grouped) — the session key of the new socket, UTF-8. Never gated |
| `peer.${address}.cluster_change` | Pulse | comms-gatekeeper (queue-grouped for LiveKit minting; ungrouped for the assignment mirror) — decodes `PeerClusterChange`; not consumed by this repo and its wire bytes are **not** pinned here |
| `engine.peer.${address}.island_changed.${session}` | comms-gatekeeper | WS Connector |
| `engine.peer.${address}.island_changed` | comms-gatekeeper | WS Connector — an assignment that carries no session, from an older Pulse — delivered to the newest socket of the address |
| `engine.discovery` | Pulse | nobody in this repo — fed stats' `/core-status`, which retired; wire bytes pinned in `ws-connector/test/contract/pulse-wire.spec.ts` |
| `engine.islands` | Pulse | nobody in this repo — fed stats' `/islands`, now served by Pulse; same fixture file |
| `engine.parcel_changes` | Pulse | comms-gatekeeper, social-service-ea — not consumed by this repo; wire bytes pinned in `ws-connector/test/contract/parcel-changes.spec.ts` |

This repo publishes three `peer.*` subjects — `heartbeat` and `disconnect`, gated by `HEARTBEAT_FORWARDING_ENABLED` and retiring at rollout step 8 (nobody in this repo consumes them or the two `engine.*` feeds from Pulse any more, since `stats` is gone), and `connect`, which is never gated. Of the rows above, only `engine.parcel_changes`, `engine.islands` and `engine.discovery` have their wire bytes pinned in `ws-connector/test/contract/` for the consumers that live elsewhere — `peer.${address}.cluster_change` is listed for the broker map only and is decoded by comms-gatekeeper, not by this repo. See [docs/stats-decommission-runbook.md](docs/stats-decommission-runbook.md).

## Testing

This service includes comprehensive test coverage with both unit and integration tests.

### Running Tests

Run all tests with coverage:

```bash
yarn test
```

Run tests in watch mode:

```bash
yarn test --watch
```

Run only unit tests:

```bash
yarn test test/unit
```

Run only integration tests:

```bash
yarn test test/integration
```

### Test Structure

- **Unit Tests**: Test individual components and functions in isolation
- **Integration Tests**: Test the complete request/response cycle and service interactions

For detailed testing guidelines and standards, refer to our [Testing Standards](https://github.com/decentraland/docs/tree/main/development-standards/testing-standards) documentation.

## AI Agent Context

For detailed AI Agent context, see [docs/ai-agent-context.md](docs/ai-agent-context.md).

---

**Note**: This repo holds one service. It is not a complete communication system on its own — Pulse owns the clustering and the online-player information, and comms-gatekeeper owns the LiveKit token minting.

