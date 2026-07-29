# Island Clustering Algorithm

> **Archived — the code this describes no longer exists in this repo.** Archipelago Core was
> removed in iteration 1 of the Archipelago ⇒ Pulse migration: Pulse authors the clustering
> and publishes `engine.islands`, and comms-gatekeeper mints the LiveKit connection strings.
> See [core-decommission-runbook.md](./core-decommission-runbook.md).
>
> Kept as the record of how islands used to form, because consumers still ask why island IDs
> churned on splits and why a 100-peer cap existed. Pulse's replacement is union-find over
> 100-unit grid cells with uncapped clusters (`Pulse/docs/clustering-on-aoi.md`).

How Archipelago Core grouped peers into islands. The implementation lived in
`core/src/adapters/engine.ts` and `core/src/logic/islands.ts`; read it in git history before
the removal commit. Everything below is past tense in effect, even where it reads present.

## Overview

The engine maintains two maps — `peers` and `islands` — and mutates them incrementally. There is no global re-clustering: islands evolve through **splits** and **merges** applied every flush cycle (`ARCHIPELAGO_FLUSH_FREQUENCY`, default 2s). The result approximates single-linkage (chain) clustering on the XZ plane with hysteresis.

Two distance thresholds create the hysteresis:

| Parameter | Default | Role |
| --- | --- | --- |
| `ARCHIPELAGO_JOIN_DISTANCE` | 64 | Islands closer than this merge |
| `ARCHIPELAGO_LEAVE_DISTANCE` | 80 | Peers farther apart than this split |

Because leave > join, a peer walking along an island's edge doesn't flap between islands.

**All distances are 2D.** `squaredDistance` uses only X and Z; height (Y) is ignored. Comparisons use squared distances (no sqrt except for island radius).

## Inputs (between flushes)

- **Heartbeat** (`peer.{addr}.heartbeat` via NATS): updates the peer's position and marks its island `_geometryDirty`. New peers go into `pendingNewPeers`.
- **Disconnect** (`peer.{addr}.disconnect`, `peer.{addr}.connect`, or 60s heartbeat timeout `CHECK_HEARTBEAT_INTERVAL`): removes the peer from its island, marks it dirty, deletes the island if empty, queues a `leave` update.

## Flush cycle

Each flush (`engine.flush()`) runs four phases:

### 1. Admit new peers

Every peer in `pendingNewPeers` gets its **own new single-peer island**. New peers are never placed directly into an existing island — they join one via the merge phase of the same flush. If island creation fails (transport error), the peer is removed and retried on its next heartbeat.

### 2. Collect affected islands

Only islands marked `_geometryDirty` (peer moved, joined, or left) are processed. Untouched islands are skipped entirely — this is the main scalability lever.

### 3. Split check (`checkSplitIsland`)

For each affected island, peers are partitioned into connected components using single-linkage at `leaveDistance`:

- Iterate peers; for each peer find all existing groups containing at least one member within `leaveDistance` (`intersectPeerGroup`).
- No group → start a new group. One or more groups → the peer bridges them; merge them all into one.

If more than one group remains, the island is disconnected: the **largest group keeps the original island** (and its ID — those peers get no update), and each remaining group becomes a new island (added to the affected set so it can immediately merge in phase 4). If creating a new island fails, its peers are put back into the original island rather than orphaned.

Consequence of single-linkage: an island can be arbitrarily large spatially as long as peers form a chain with < 80 units between links.

### 4. Merge check

For each affected island, find every other island it intersects with and merge. Two islands intersect (`intersectIslands`) when:

1. **Cheap test:** distance between centers ≤ radius₁ + radius₂ + `joinDistance` (bounding-circle prescreen), and
2. **Exact test:** some peer of one island is within `joinDistance` of some peer of the other.

Note the scan is against **all** islands, not just affected ones — an affected island can absorb a stationary one.

`mergeIslands` then works as follows:

- Sort candidates by peer count descending, ties broken by lower `sequenceId` (older island wins). Islands carry a monotonically increasing `sequenceId` from creation.
- The biggest/oldest island seeds the "survivors" list. Each remaining island tries to merge into a survivor, in order; if none can take it, it becomes a survivor itself.
- **Capacity:** a merge is allowed only if `target.peers + source.peers ≤ maxPeers` (`LIVEKIT_ISLAND_SIZE`, default 100). Oversized crowds therefore stay as multiple islands even when spatially connected.
- **Preferred island:** before trying survivors in order, the source island's peers vote with their `preferedIslandId`; the most-voted survivor is tried first. Preferences only work toward islands bigger/older than the source. The preference came from `desiredRoom` on the heartbeat, and it only ever mattered when the 100-peer cap split a co-located crowd — which is why it died with the cap: Pulse's clusters are uncapped. The proto field survives on the wire and is read by nobody.
- Merging is directional: source peers are appended to the target island, get new connection strings for the target's room, and the source island is deleted. Peers already in the target island are untouched (no reconnection).

### Updates out

Every peer that changed island gets a `changeTo` update carrying the island ID and a LiveKit connection string (`livekit:{host}?access_token={jwt}`, 5-minute token). Updates are published to `engine.peer.{id}.island_changed` after the flush. `leave` updates are tracked but not published. Only the *last* update per peer per flush survives (map keyed by peer ID), so a split immediately followed by a merge produces a single `changeTo`.

## Island geometry

`center` = mean of peer positions (XZ); `radius` = distance from center to the farthest peer. Both are computed lazily via getters and cached; any mutation sets `_geometryDirty` and the next access recalculates. Geometry is only used for the merge prescreen and for the `engine.islands` stats report.

## Transport interaction (LiveKit)

`createIsland` and `mergeIntoIfPossible` call `transport.getConnectionStrings(peerIds, islandId)`, which mints a LiveKit token per peer and runs a ban check against comms-gatekeeper (fail-open, 1s timeout, concurrency-capped):

- Peers **omitted** from the result (banned) are evicted from the engine so they aren't retried every flush; a fresh heartbeat re-enters them.
- These calls `await`, and NATS disconnect callbacks can fire mid-await. Both code paths re-validate afterwards: disconnected peers are filtered out, and merges re-check that both islands still exist and capacity still holds.

## Properties and edge cases

- **Complexity:** exact merge test is O(n·m) peer pairs per island pair, and the merge scan is O(affected × all islands); the bounding-circle prescreen and the dirty-island filter keep the common case cheap.
- **Island IDs are not stable across splits for minority groups:** only the largest fragment keeps the ID.
- **New peer flow:** join → own island → merged into a nearby island within the same flush (if within `joinDistance` and capacity allows).
- **Latency:** membership changes lag real positions by up to one flush interval (2s); ungraceful disconnects linger up to 60s.
- **Determinism:** outcomes depend on iteration order of peers (splits) and islands (merges); the algorithm is greedy, not optimal.

## Tuning

| Variable | Default | Effect |
| --- | --- | --- |
| `ARCHIPELAGO_JOIN_DISTANCE` | 64 | Larger → islands merge more aggressively |
| `ARCHIPELAGO_LEAVE_DISTANCE` | 80 | Larger → islands split less readily; gap vs join distance controls flap resistance |
| `ARCHIPELAGO_FLUSH_FREQUENCY` | 2000 ms | Recluster interval |
| `LIVEKIT_ISLAND_SIZE` | 100 | Hard cap on island size (merge-blocking) |
| `CHECK_HEARTBEAT_INTERVAL` | 60000 ms | Peer expiry without heartbeat |

None of these variables exist any more — they were removed with the service. The [runbook](./core-decommission-runbook.md) lists the Pulse-side equivalents (`Clusters:PassIntervalMs`, `Clusters:IdPrefix`, the spatial-grid cell size) and the two settings with no equivalent at all: leave distance and the island size cap.
