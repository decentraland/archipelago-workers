# Archipelago Service

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
