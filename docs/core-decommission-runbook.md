# Runbook: archipelago-core removal

Iteration 1 of the [Archipelago ⇒ Pulse migration](https://app.notion.com/p/decentraland/Archipelago-Pulse-migration-plan-3a45f41146a58070b6b0dbe541bc7533).
Upstream design: `Pulse/docs/clustering-on-aoi.md` §3.6–3.7 and §5.

`archipelago-core` has been **removed from this repository**. Island clustering is Pulse's
responsibility.

## What changed

| | Before | After |
| --- | --- | --- |
| Clustering author | archipelago-core | **Pulse** — union-find over 100 u grid cells, uncapped clusters, `C{n}` IDs |
| Per-peer assignment feed | `engine.peer.{addr}.island_changed` from core | **Pulse** publishes `peer.{addr}.cluster_change` |
| LiveKit conn-string minting | archipelago-core | **comms-gatekeeper**, which subscribes to `cluster_change` and re-publishes the same `engine.peer.{addr}.island_changed` |
| `engine.islands` / `engine.discovery` | archipelago-core | **Pulse** |
| WS Connector | forwards `island_changed` to clients | **unchanged** — no code change, no client protocol change |
| archipelago-stats | every endpoint | **unchanged** — client heartbeats stay in iteration 1, so `/peers`, `/parcels`, `/hot-scenes` are untouched. Only the topology source moved |

Two visible consequences of Pulse authoring the topology:

- `GET /islands` reports IDs as `C{n}` and `maxPeers: 0`. Clusters are uncapped, so
  advertising 0 is more honest than implying the old 100-peer bound. Nothing in stats compares
  `maxPeers` or parses IDs.
- `/core-status` reflects whoever publishes `engine.discovery`, which is now Pulse. The
  endpoint only ever exposed `{healthy, userCount}` — Pulse's `server_name` and commit hash are
  not in the response, so `realm-provider` needs no change.

## Preconditions

1. **comms-gatekeeper's `peer.{addr}.cluster_change` subscriber is live** in the target
   environment. This is the one responsibility that moved *outside* Pulse, and nothing in this
   repo can substitute for it: WS Connector forwards `island_changed`, it does not produce it.
   Without gatekeeper, clients get no LiveKit connection string.
2. Pulse is deployed with `Clusters:Enabled=true` (its default) and a broker URL — either
   `Nats__Url` or the flat `NATS_URL`, the same name archipelago's services read, so one
   injected secret serves both.
3. Infra has retired the `archipelago-ea-core` service. The deploy jobs are gone from this
   repo's workflows, so nothing redeploys it; a running task keeps its last good image until
   infra removes it.

Set these for the commands below:

```bash
export STATS=https://<stats-host>
export PULSE=https://<pulse-host>
```

## Verification after deploy

### 1. Pulse's feed is connected and publishing

```bash
curl -s $PULSE/metrics | grep -E 'dcl_pulse_nats_(connected|published_total|dropped_total)'
```

Expected: `dcl_pulse_nats_connected 1` and `published_total` climbing. `dropped_total` should
stay 0 — it is the actionable counter; `superseded` is expected under load. Because an
unresolved broker URL fails soft rather than erroring, this metric and the startup log are the
only signals that the secret actually arrived.

### 2. Stats serves the Pulse topology

```bash
curl -s $STATS/islands | jq '{count: (.islands | length), sample: .islands[0] | {id, maxPeers}}'
curl -s $STATS/core-status | jq
```

Expected: a `C{n}` ID with `maxPeers: 0`, and `{"healthy": true, "userCount": <n>}`.

If `healthy` is false while Pulse is publishing, check `current_time`: the health window is
`Date.now() - current_time < 90s`, and a `uint32`-truncated timestamp reads permanently
unhealthy. `ServiceStatus.current_time` must be `uint64`
([protocol#453](https://github.com/decentraland/protocol/pull/453)); this repo pins the release
that contains it and `stats/test/unit/pulse-topology.spec.ts` guards the round trip.

### 3. The heartbeat-fed endpoints are unaffected

```bash
curl -s $STATS/peers | jq '.peers | length'
curl -s $STATS/parcels | jq '.parcels | length'
curl -s $STATS/hot-scenes | jq 'length'
```

These are built from `peer.*.heartbeat`, which WS Connector still publishes, so the cutover
should not move them. They retire in iteration 2.

### 4. Clients are actually getting rooms

The end of the chain is gatekeeper, not this repo. Confirm that
`engine.peer.{addr}.island_changed` is flowing and that clients join LiveKit rooms — stats being
healthy proves Pulse is clustering, not that anyone got a token.

## Rollback

Core no longer exists in the tree, so rollback is a code change, not a config flip:

1. **Stop Pulse's feed first** — clear `Nats:Url` / `NATS_URL` on the Pulse deployment and
   restart. Clustering keeps running inside Pulse (its metrics stay populated); only the feed
   stops. Verify `dcl_pulse_nats_connected 0`.
   This ordering is not optional: if core is publishing `engine.peer.{addr}.island_changed`
   while gatekeeper is also publishing it, WS Connector forwards both and clients flap between
   LiveKit rooms.
2. **Revert the removal** — `git revert` the `feat!: remove archipelago-core` commit, rebuild
   the image, and deploy it to `archipelago-ea-core`. This requires the service and its
   configuration (`LIVEKIT_*`, `ARCHIPELAGO_*`, `NATS_URL`) still to exist on the infra side; if
   infra has already retired it, they must be recreated. `manual-deploy.yml` can deploy an
   older tag instead, provided the service still exists — but that workflow no longer lists
   `archipelago-ea-core`, so it needs the entry back.
3. **Disable the gatekeeper subscriber.**

This is slower and heavier than the kill switch an earlier revision of this plan provided. It
is the accepted cost of removing the code: verify the cutover in dev before promoting it.

## Retired configuration

These variables were removed with the service:

| Removed | Pulse equivalent |
| --- | --- |
| `ARCHIPELAGO_JOIN_DISTANCE` (64) | `SpatialHashAreaOfInterest:CellSize` (100 u cells; join band 0–283 u) |
| `ARCHIPELAGO_LEAVE_DISTANCE` (80) | — no equivalent; cell adjacency has no hysteresis pair |
| `ARCHIPELAGO_FLUSH_FREQUENCY` (2 s) | `Clusters:PassIntervalMs` (1 s), plus `Clusters:DwellPasses` (3) before a reassignment publishes |
| `ROOM_PREFIX` (`I`) | `Clusters:IdPrefix` (`C`) |
| `LIVEKIT_ISLAND_SIZE` (100) | — no equivalent; clusters are uncapped and gatekeeper shards rooms |
| `CHECK_HEARTBEAT_INTERVAL` (60 s) | — Pulse cleans up departed peers in ~5 s |
| `LIVEKIT_API_KEY` / `_SECRET` / `_HOST` | Held by comms-gatekeeper, which mints the tokens now |
| `COMMS_GATEKEEPER_URL` (core's ban check) | Gatekeeper checks its own store at mint time |

## Follow-ups outside this repo

- **Metric renames.** `dcl_archipelago_peers_count` and `dcl_archipelago_islands_count` are
  gone. Pulse exposes `dcl_pulse_clusters`, `dcl_pulse_cluster_passes_total`,
  `dcl_pulse_cluster_pass_duration_us_total`, `dcl_pulse_cluster_reassignments_total`, and for
  the feed `dcl_pulse_nats_{published,dropped,superseded,reconnects}_total` plus
  `dcl_pulse_nats_connected`. Dashboards and alerts pointing at the old names go blind rather
  than red — repoint them.
- **Scrape and health targets.** Core's `/health` and `/metrics` disappear with the service.
- **Cluster ID uniqueness.** `C{n}` comes from a per-process counter, so it resets on a Pulse
  restart and collides across instances. After a restart, `C1` names a different crowd and
  gatekeeper may map it onto the LiveKit room the previous `C1` used. Tracked as an open
  question in `Pulse/docs/clustering-on-aoi.md` §7 — live-voice-room correctness, not cosmetics.
- **Uncapped crowds.** Nothing bounds co-located crowd size server-side any more; the client
  GPU becomes the binding constraint (unity-explorer's crowd-ghost work) and gatekeeper owns
  room sharding.

## What was not measured

No shadow comparison was run between core's topology and Pulse's. The two algorithms differ
substantially — peer-pairwise single-linkage at 64/80 with a 100-peer cap, versus cell
adjacency at 100 u with no cap — so expect fewer, larger clusters, and complete collapse into
one cluster on a densely populated realm (percolation, `Pulse/docs/clustering-on-aoi.md` §3.2).
`GET /islands` is the place to look if cluster sizes seem wrong after cutover.
