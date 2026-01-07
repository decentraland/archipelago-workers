# Archipelago Workers

[![Coverage Status](https://coveralls.io/repos/github/decentraland/archipelago-workers/badge.svg?branch=coverage)](https://coveralls.io/github/decentraland/archipelago-workers?branch=coverage)

The Archipelago Workers is a monorepo containing three services that implement the Archipelago protocol for clustering users into dynamic islands based on their positions in Decentraland's metaverse. The protocol enables scalable crowd management and efficient real-time communication for standalone realms.

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

- **Core Service**: Implements island clustering algorithms that dynamically group users into islands based on their in-world positions. Manages peer-to-island assignments, processes position updates, and publishes island change notifications via NATS.
- **WebSocket Connector Service**: Provides real-time bidirectional WebSocket connections for Decentraland clients. Handles Ethereum-based authentication, routes real-time messages (positions, chat, profiles), and maintains peer registry.
- **Stats Service**: Aggregates information about islands and peers, providing REST API endpoints for monitoring, analytics, and observability of the Archipelago system.

## Dependencies

- **[Realm Provider](https://github.com/decentraland/realm-provider/)**: Exposes WebSocket connections to Decentraland clients
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

This will start all three services:
- **Core Service**: Island clustering engine
- **WebSocket Connector Service**: WebSocket gateway for clients
- **Stats Service**: REST API for monitoring and analytics

### NATS Messages

The services communicate via the following NATS message topics:

- `peer.${address}.heartbeat` - Peer heartbeat messages
- `peer.${address}.disconnect` - Peer disconnect events
- `engine.peer.${address}.island_changed` - Island assignment changes
- `engine.discovery` - Service discovery messages
- `engine.islands` - Island status reports

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

**Note**: This is a monorepo containing three separate services. Each service can be run independently, but they work together to provide the complete Archipelago communication system.

