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

For detailed AI Agent context, see [docs/ai-agent-context.md](docs/ai-agent-context.md).