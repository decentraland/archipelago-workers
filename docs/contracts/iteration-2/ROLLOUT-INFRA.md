# Iteration 2 — infrastructure checklist (WP9) and rollout gates

Operator-facing companion to the contract pack. Everything here is configuration; no code.

## CloudFlare rules — `archipelago-ea-stats.decentraland.{zone,org}`

Apply in `zone` first, then `org`, at rollout step 5 (after WP6 realm-provider is deployed).

| Path | Origin | Notes |
|---|---|---|
| `/hot-scenes` | comms-gatekeeper | bare `HotSceneInfo[]`; `503 {"ok":false,"error":"warming"}` while the presence map primes |
| everything else (`/realms*`, `/peers*`, `/comms/*`, `/parcels`, `/islands*`, `/status`, `/about`, `/health`) | Pulse HTTP | plain `HttpListener` on the container; front it with the existing ALB/NLB listener on a separate port; health check `GET /health` (200) |

Legacy paths answer `308` to `/realms/main/…` from Pulse itself (no CloudFlare rewrite needed). Served directly (all realms, no redirect): `/peers?id=`, `/comms/peers?id=`, `/peers?all=true`, `/comms/peers?all=true`, `/peers/:id`, `/comms/peers/:id`; `/status`, `/about`, `/health` and every `/realms/…` route are direct as well. `/core-status` retires — nothing points at it once realm-provider's Pulse/gatekeeper-only build (step 5) is deployed.

Rollback: revert the rule; archipelago-stats keeps running until step 9.

## Environment injection

No consumer carries a presence-source switch or a LiveKit fallback: WP2, WP4, WP5 and WP6 each have
exactly one presence implementation — Pulse's feed or HTTP surface — and the required config below
is validated at boot, failing the process when missing. There is no flip value for any of these: the
only rollback is redeploying the previous image (see Gates below).

| Service | Required config, injected before its cut-over deploy | Notes |
|---|---|---|
| comms-gatekeeper | `PULSE_URL` (with `NATS_URL`); `PRESENCE_PRIME_TTL_MS` 90000, `PRESENCE_SERVER_TTL_MS` 150000, `HOT_SCENES_REFRESH_MS` 10000, `HOT_SCENES_SCENE_TTL_MS` 300000 | boot fails without `PULSE_URL` when `NATS_URL` is set; `COMMS_ROOM_PREFIX` / `SCENE_ROOM_PREFIX` must equal worlds-content-server's (prod: verify, defaults are `world-` / `world-scene-room-`) |
| social-service-ea | `PULSE_URL` | required |
| worlds-content-server | `PULSE_URL` | required |
| realm-provider | `PULSE_URL`, `COMMS_GATEKEEPER_URL` | required — boot fails if either is missing |
| Pulse | `Presence:Enabled` (follows `Nats:Url` being set), `Presence:BatchIntervalMs` 2000, `Presence:SnapshotIntervalMs` 60000 | feed off without `NATS_URL` |
| archipelago-workers ws-connector | `WS_IDLE_TIMEOUT_SECONDS` 90, `HEARTBEAT_FORWARDING_ENABLED` true | the one remaining server-side switch: a publisher retirement, not a presence source |
| unity-explorer | feature flag `archipelago-heartbeats` (enabled = today) | client-side publisher retirement; step 7: disable, ramp to 100 % |
| iteration-1 keys (unchanged by iteration 2) | ws-connector `ISLAND_CHANGED_DEDUP_MS` 10000; gatekeeper `CLUSTER_ASSIGNMENT_MIRROR_TTL_MS` 3600000, `CLUSTER_TAKEOVER_RETRY_DELAY_MS` 100; Pulse `Clusters:SessionRetentionPasses` 300 | as shipped by iteration 1 |

`NATS_URL` is already shared by every NATS consumer. Pulse's HTTP port is `HttpService:Port` (5000).
The presence-source and shadow-compare switches this table carried earlier in the plan are gone from
every consumer; `.env.default` / `appsettings` keep any such retired key commented out — a
placeholder value would defeat `requireString`.

## Rollout sequence (from the plan, rev 3)

Rollback for every cut-over step is the **previous image**. Its preconditions are what orders the
tail: archipelago-stats, client heartbeats, the heartbeat intake and the LiveKit webhook publish
must all still exist for any previous image to work, so steps 7–9 come after every cut-over has
held.

| Step | Change | Gate to proceed | Rollback |
|---|---|---|---|
| **0** | Iteration 1 cut over per environment: archipelago-workers #128 (ws-connector) deployed, then Pulse #34, then comms-gatekeeper #283 **including the parking commit**; `@dcl/protocol` registry release re-pinned. Social-service WP4 deployed first (step 3a) **or** its legacy `peer.*.connect` handler removed on `main` beforehand | `dcl_pulse_cluster_takeovers_total == dcl_gatekeeper_cluster_takeover_evicted_total + …_absent_total`; `…_failed_total` flat; core at zero; two-device manual test (§7 of the supersede spec) passes; LiveKit version recorded | Previous images, gatekeeper first (per its runbook) |
| 1 | WP7 places casing fix (merged); WP3a `sendPingsAutomatically` | Deployed; ws idle test green in prod logs (no idle disconnect spike) | Previous image |
| 2 | WP1 Pulse: publisher on (`Presence:Enabled` follows `NATS_URL`), HTTP routes up | `nats sub` shows snapshots + deltas; C2 routes return data; a two-device takeover shows one placement and no exit on the feed | `Presence:Enabled=false`; routes are read-only |
| 3 | WP2 gatekeeper: presence map serves `/hot-scenes` and `/scene-participants` from the deploy (`PULSE_URL` injected first) | WP10 diffs 1 and 4, previous image vs new, within tolerance over the sample window in `zone`, then the `org` canary | Previous image (LiveKit-backed `/scene-participants`; realm-provider still aggregating) |
| 3a | WP4 social-service: Pulse-only build (`PULSE_URL` injected first) | WP10 diff 3 (previous deployment's `PEERS_CACHE_KEY` vs Pulse `/peers?all=true`) within tolerance over the sample window | Previous image (needs stats + heartbeats alive) |
| 4 | WP5 worlds-content-server: Pulse-only build, `peer.*.world.*` publish gone — **after 3a** | WP10 diff 2 within tolerance over the sample window; sites' Discover renders unchanged | Previous image (re-publishes `peer.*.world.*`, harmless) |
| 5 | WP6 realm-provider: proxy + Pulse `/about` — **after 3 and 2**; WP9 CloudFlare cut for all `archipelago-ea-stats.*` paths | Consumers' error rates flat (places, sites, unity `/status` health gate, referral); `/hot-scenes` p95 down | Previous image + revert CF rule (stats still running) |
| 6 | Verification hold: every cut-over service on its Pulse-only build for 24 h; harness summaries posted | 24 h clean | — |
| 7 | WP8 unity-explorer release: heartbeats off behind flag, decorator removed, same-island guard included; flag ramps to 100 % | ≥ 95 % of sessions on the new build; step 0 verified in the same environment (connect re-announce live); ws-connector heartbeat rate → 0; the client reads the flag at launch, so allow ≥ 24 h after the ramp | Flag ramps down (takes effect on next launch) |
| 8 | WP3b heartbeat intake off (`HEARTBEAT_FORWARDING_ENABLED=false`) | No subscriber logs for the retired subjects for 48 h; `peer.*.connect` still observed on the broker | Flag back (the last flag flip in the plan) |
| 9 | WP3c delete `stats`; WP5 remove `/wallet/:wallet/connected-world` | Runbook verification list green | Redeploy last stats image + CF revert (documented cost in runbook) |

## Known risks to clear before step 6

- **WebSocket reconnects lose their island without heartbeats**: fixed by iteration 1 (ws-connector `7fb1c02`,
  gatekeeper `105b845` plus its parking commit) — connect signal + session-gated re-announce; no iteration-2 work
  in flight.
- **Silent clients** (refined after the WP1 review): a hard-killed client is detected by the transport keepalive in about 5 s in production and emits its exit entry (the minutes-long lingering seen in local acceptance came from the Development config's 5-minute `Transport:PeerTimeoutMs`). The residual gap is a client that keeps ACKing but stops sending input: `/peers` shows a frozen `lastPing` and the feed carries no staleness field. Pulse needs an input-idle timeout (no `MovementInput` for N s => treated as left) before LiveKit fallbacks are switched off.
- **`/realms` on realm-provider lists only `main`** today because catalyst `/about` has no `comms` block; WP6 keeps
  that behaviour. Decide separately whether third-party catalysts should be listed.
- **Semantic shift visible on place cards**: `connected_addresses` becomes "standing on the scene's parcels" and will
  finally agree with `user_count`. Tell product before step 6.
- **Rollback is a redeploy, and it has preconditions.** A previous image of social-service,
  worlds-content-server or realm-provider reads archipelago-stats, heartbeats or LiveKit webhooks.
  Those exist until steps 8–9, so a cut-over can be rolled back for as long as the tail has not run;
  after step 8 a rollback of social-service needs heartbeat intake re-enabled first, after step 9 it
  needs the last stats image redeployed. The runbook says so.
- **A Pulse outage is now visible.** With no LiveKit fallback, Pulse or NATS being down means
  `/hot-scenes` and `/scene-participants` answer `503`, `/live-data` serves its last cached answer
  then `503`, and social-service stops flipping statuses until the next snapshot. This is the
  accepted trade-off; the WP10 gate and the step-6 hold are what make it deliberate.
