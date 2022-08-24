# Archipelago Service

## Getting Started

### Dependencies

- Node >= v16
- [NATS](https://nats.io/) running instance.
   - `NATS_URL` environment variable must be set. Eg: `NATS_URL=localhost:4222`

### Installation

Install Node dependencies:

```
npm install
```

### Usage

Build and start the project:

```
make build
npm run start
```

### Test

Run unit and integration tests:

```
make build
npm run test
```

### Environment Variables

#### NATS

- `NATS_URL` (required): URL of the NATS instance to be connected to

#### Server

- `HTTP_SERVER_PORT`: (Defaults to 5000)
- `HTTP_SERVER_HOST`: (Defaults to 0.0.0.0)

#### Archipelago

- `ARCHIPELAGO_FLUSH_FREQUENCY`: Frequency in seconds for islands/peers updates in Archipelago (Defaults to 2.0)
- `ARCHIPELAGO_JOIN_DISTANCE`: (Defaults to 64)
- `ARCHIPELAGO_LEAVE_DISTANCE`: (Defaults to 80)
- `ARCHIPELAGO_MAX_PEERS_PER_ISLAND`: (Defaults to 100)
- `ARCHIPELAGO_PARCEL_SIZE`: (Defaults to 16)
- `ARCHIPELAGO_METRICS_INTERVAL`: Frequency in milliseconds for updating Prometheus metrics (Defaults to 10000)
- `ARCHIPELAGO_STATUS_UPDATE_INTERVAL`: Frequency in milliseconds for updating Archipelago status information (Defaults to 10000)
- `CHECK_HEARTBEAT_INTERVAL`: Frequency in milliseconds for checking the last peer update and assume it is active (Defaults to 60000)
