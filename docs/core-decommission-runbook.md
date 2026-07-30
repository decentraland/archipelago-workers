# Runbook: archipelago-core removal

Iteration 1 of the [Archipelago ⇒ Pulse migration](https://app.notion.com/p/decentraland/Archipelago-Pulse-migration-plan-3a45f41146a58070b6b0dbe541bc7533).
Upstream design: `Pulse/docs/clustering-on-aoi.md` §3.6–3.7 and §5.

> Diverges from §5: core was deleted rather than kept behind a rollback flag, and the shadow
> comparison was dropped. The §3.6–3.7 feed and configuration details still hold.

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
2. Pulse is deployed with `Clusters:Enabled=true` and a broker URL. **Check `Enabled`
   explicitly** — `appsettings.json` ships `true`, but the C# property has no initializer, so a
   deployment whose configuration omits the `Clusters` section clusters nothing while looking
   healthy. The broker URL is read from either `Nats__Url` or the flat `NATS_URL`, the same name
   archipelago's services read, so one injected secret serves both; `Nats__Url` wins when both
   are set.
3. Infra has retired the `archipelago-ea-core` service. The deploy jobs are gone from this
   repo's workflows, so nothing redeploys it; a running task keeps its last good image until
   infra removes it.

Set these for the commands below:

```bash
export STATS=https://<stats-host>
export PULSE=http://<pulse-host>:5000
export PULSE_METRICS_TOKEN=<WKC_METRICS_BEARER_TOKEN of that deployment>
```

## Verification after deploy

### 1. Pulse's feed is connected and publishing

Pulse gates `/metrics` on a bearer token whenever `WKC_METRICS_BEARER_TOKEN` is set, and
answers a bodiless 401 without it — which `curl -s` hides, so a missing header looks exactly
like "Pulse is not publishing". Send the token, and drop `-s` if you get no output:

```bash
curl -s -H "Authorization: Bearer $PULSE_METRICS_TOKEN" $PULSE/metrics \
  | grep -E 'dcl_pulse_nats_(connected|published_total|publish_failed_total|dropped_total)'
```

Expected: `dcl_pulse_nats_connected 1` and `published_total` climbing.

- `publish_failed_total` must stay 0. It counts publishes that threw — timeout, connect
  failure, oversized payload, rejected subject — so a broken path to the broker shows up here
  while `dropped_total` stays 0 and `published_total` simply stops moving.
- `dropped_total` must stay 0 too, but it means something different: the outbox evicted an
  assignment because more than `Nats:ChannelCapacity` distinct peers had one pending. That is a
  capacity signal.
- `superseded_total` climbing is expected under load and harmless.

Because an unresolved broker URL fails soft rather than erroring, these metrics and the startup
log are the only signals that the secret actually arrived.

### 2. Stats serves the Pulse topology

```bash
curl -s $STATS/islands | jq '{count: (.islands | length), peers: (.islands | map(.peers | length) | add), sample: .islands[0] | {id, maxPeers}}'
curl -s $STATS/core-status | jq
```

Expected: a `C{n}` ID with `maxPeers: 0`, a **non-zero peer total**, and
`{"healthy": true, "userCount": <n>}`.

Check the peer total, not just the island count. `/islands` joins Pulse's wallet list against
stats' own heartbeat-derived peer map, silently skipping wallets it does not know. Every island
reporting `peers: []` means the join is failing even though the topology arrived — and an
island-count-only check would pass.

If `/islands` is empty while Pulse's `published_total` climbs, suspect a **subject prefix
mismatch**: Pulse applies `Nats:SubjectPrefix` to every subject and stats subscribes to the
unprefixed names. A deployment carrying `Nats__SubjectPrefix=staging.` publishes to
`staging.engine.islands`, which nothing here reads — no error on either side.

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

**Before you start, know the cost:** step 1 stops `cluster_change`, `engine.islands` *and*
`engine.discovery` together, and step 2 takes a build and a deploy. For that whole window
nothing publishes `engine.peer.{addr}.island_changed`, so **no new session gets an island
assignment or a LiveKit connection string**, and `/core-status` flips to `healthy: false` after
90 s — which is what `realm-provider` reads. Plan the window; do not start it mid-incident
expecting a quick recovery.

1. **Disable the gatekeeper subscriber**, or otherwise stop it publishing
   `engine.peer.{addr}.island_changed`. Do this first: it is the only durable half. Clearing an
   env var on the Pulse deployment is undone by the next CI deploy that re-injects the secret,
   and at that moment gatekeeper would resume publishing alongside a re-enabled core — which is
   exactly the dual-publish flap the ordering exists to prevent.
2. **Stop Pulse's feed** — clear **both** `Nats__Url` and `NATS_URL` on the Pulse deployment and
   restart. Clearing one is not enough: the flat `NATS_URL` alias fills the key when
   `Nats__Url` is unset, so leaving either populated keeps the feed alive. Clustering keeps
   running inside Pulse (its metrics stay populated); only the feed stops. Verify
   `dcl_pulse_nats_connected 0`.
3. **Revert the removal** — `git revert` the `feat!: remove archipelago-core` commit, rebuild
   the image, and deploy it to `archipelago-ea-core`. This requires the service and its
   configuration still to exist on the infra side; if infra has already retired it, both must be
   recreated, with every variable from the table below — note the exact names and units there,
   since all of core's LiveKit settings are `requireString` and it exits at startup if one is
   missing. `manual-deploy.yml` can deploy an older tag instead, provided the service still
   exists — but that workflow no longer lists `archipelago-ea-core`, so it needs the entry back.

Verify the cutover in dev before promoting it.

## Retired configuration

These variables were removed with the service. Values are exactly as core read them — a
rollback that recreates the config must match, especially the flush frequency, which is in
**seconds**, not milliseconds:

| Removed | Value core used | Pulse equivalent |
| --- | --- | --- |
| `ARCHIPELAGO_JOIN_DISTANCE` | `64` (units) | `SpatialHashAreaOfInterest:CellSize` (100 u cells; join band 0–283 u) |
| `ARCHIPELAGO_LEAVE_DISTANCE` | `80` (units) | — no equivalent; cell adjacency has no hysteresis pair |
| `ARCHIPELAGO_FLUSH_FREQUENCY` | `2.0` — **seconds**, multiplied by 1000 in code | `Clusters:PassIntervalMs` (`1000`), plus `Clusters:DwellPasses` (`3`) before a reassignment publishes |
| `CHECK_HEARTBEAT_INTERVAL` | `60000` (ms) | — Pulse cleans up departed peers in ~5 s |
| `ARCHIPELAGO_STATUS_UPDATE_INTERVAL` | `10000` (ms) | `Nats:DiscoveryIntervalMs` (`10000`) |
| `ROOM_PREFIX` | unset, defaulting to `I` | `Clusters:IdPrefix` (`C`) |
| `LIVEKIT_ISLAND_SIZE` | unset, defaulting to `100` | — no equivalent; clusters are uncapped and gatekeeper shards rooms |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_HOST` | required — core exited at startup without them | Held by comms-gatekeeper, which mints the tokens now |

> **Do not remove `COMMS_GATEKEEPER_URL`.** Core read it too, but **WS Connector still does** —
> it gates the per-handshake ban check and the periodic ban sweep
> ([ban-checker.ts](../ws-connector/src/adapters/ban-checker.ts)). The check **fails open**: with
> the URL unset, every handshake is allowed and the only signal is one `logger.warn` at boot.
> Dropping it while tidying core's variables silently disables ban enforcement at the WS entry
> point.

## Follow-ups outside this repo

- **Metric renames.** `dcl_archipelago_peers_count` and `dcl_archipelago_islands_count` are
  gone. Pulse exposes `dcl_pulse_clusters`, `dcl_pulse_cluster_passes_total`,
  `dcl_pulse_cluster_pass_duration_us_total`, `dcl_pulse_cluster_reassignments_total`, and the
  feed counters listed in step 1. Dashboards and alerts on the old names go blind rather than
  red — repoint them.
- **Scrape and health targets.** Core's `/health` and `/metrics` disappear with the service.

Standing caveats that are not cutover actions — uncapped crowds, per-process cluster ID
collisions, the unmeasured topology change — are in
[ai-agent-context.md](./ai-agent-context.md#known-architectural-issues).

## What was not measured

No shadow comparison was run between core's topology and Pulse's. The two algorithms differ
substantially — peer-pairwise single-linkage at 64/80 with a 100-peer cap, versus cell
adjacency at 100 u with no cap — so expect fewer, larger clusters.

At capacity on a full-size realm the partition effectively collapses: Pulse's own benchmark
measures **2 clusters with the larger holding 4091 of 4095 peers**
(`Pulse/docs/clustering-on-aoi.md` §3.2). That follows from the 100 u cell size, and it is why
gatekeeper's LiveKit room sharding is load-bearing. Sparse and mid-density realms are
unaffected.

`GET /islands` is the place to look if cluster sizes seem wrong after cutover.
