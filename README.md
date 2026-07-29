# Archipelago Workers

[![Coverage Status](https://coveralls.io/repos/github/decentraland/archipelago-workers/badge.svg?branch=coverage)](https://coveralls.io/github/decentraland/archipelago-workers?branch=coverage)

The Archipelago Workers is a monorepo containing two services that support Decentraland's real-time communication layer: a WebSocket gateway for clients and a stats API for monitoring.

> **Island clustering has moved to Pulse.** In iteration 1 of the Archipelago ⇒ Pulse migration the `core` service was **removed** from this repo: Pulse authors the clustering and publishes `engine.islands` / `engine.discovery`, and comms-gatekeeper mints the LiveKit connection strings and publishes `engine.peer.{address}.island_changed`. The WebSocket Connector is unchanged, and the Stats Service keeps every endpoint until iteration 2. See [docs/core-decommission-runbook.md](docs/core-decommission-runbook.md), and [docs/island-clustering-algorithm.md](docs/island-clustering-algorithm.md) for the archived record of how core clustered.

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

- **WebSocket Connector Service**: Provides real-time bidirectional WebSocket connections for Decentraland clients. Handles Ethereum-based authentication, routes real-time messages (positions, chat, profiles), maintains the peer registry, and forwards island assignments to clients. Untouched by the migration.
- **Stats Service**: Aggregates information about islands and peers, providing REST API endpoints for monitoring, analytics, and observability. Its peer map is still built from client heartbeats; its island topology now comes from Pulse, so `GET /islands` reports cluster IDs as `C{n}` with `maxPeers: 0` (clusters are uncapped).

## Dependencies

- **[Realm Provider](https://github.com/decentraland/realm-provider/)**: Exposes WebSocket connections to Decentraland clients
- **Pulse**: Authors the peer clustering and publishes `engine.islands` / `engine.discovery`
- **comms-gatekeeper**: Mints LiveKit connection strings and publishes `engine.peer.{address}.island_changed`
- **[Catalyst](https://github.com/decentraland/catalyst)**: Content server for fetching scene data (used by stats service)
- **NATS**: Message broker for peer heartbeats, disconnect events, island changes, and discovery messages
- **@dcl/protocol**: Archipelago protocol definitions
- **@dcl/crypto**: Ethereum signature validation, AuthChain

## API Documentation

The API is fully documented using the [OpenAPI standard](https://swagger.io/specification/). The schema is located at [docs/openapi.yaml](docs/openapi.yaml).

The monorepo includes:
- **Stats Service API**: REST endpoints for monitoring and analytics (see [docs/stats/openapi.yaml](docs/stats/openapi.yaml))
- **WebSocket Connector API**: Real-time communication endpoints (see [docs/ws-connector/openapi.yaml](docs/ws-connector/openapi.yaml))

## Getting Started

### Prerequisites

Before running this service, ensure you have the following installed:

- **Node.js**: Version 18.x or higher (LTS recommended)
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

In order to successfully run these services, external dependencies such as message brokers must be provided.

To do so, this repository provides you with a `docker-compose.yml` file for that purpose. In order to get the environment set up, run:

```bash
docker-compose up -d
```

This will start:
- NATS message broker on port `4222`

#### Running in development mode

To run all services in development mode:

```bash
yarn start:local
```

This will start both services:
- **WebSocket Connector Service**: WebSocket gateway for clients
- **Stats Service**: REST API for monitoring and analytics

Neither produces island assignments. For a client to receive one locally you also need Pulse publishing to the same broker and comms-gatekeeper subscribed to it.

### NATS Messages

The services communicate via the following NATS message topics:

| Subject | Published by | Consumed by |
| --- | --- | --- |
| `peer.${address}.heartbeat` | WS Connector | Stats |
| `peer.${address}.disconnect` | WS Connector | Stats |
| `peer.${address}.cluster_change` | Pulse | comms-gatekeeper |
| `engine.peer.${address}.island_changed` | comms-gatekeeper | WS Connector |
| `engine.discovery` | Pulse | Stats — feeds `/core-status` |
| `engine.islands` | Pulse | Stats — feeds `/islands` |

Only the two `peer.*` subjects are published by this repo. `engine.islands` from Pulse reports cluster IDs as `C{n}` and `maxPeers: 0`; `GET /islands` passes both through unchanged.

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

**Note**: This is a monorepo containing two separate services. Each can be run independently. They no longer form a complete communication system on their own — Pulse and comms-gatekeeper own the clustering and the LiveKit token minting.

