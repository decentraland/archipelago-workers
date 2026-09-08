# Iteration 2 — infrastructure checklist (WP9) and rollout gates

Operator-facing companion to the contract pack. Everything here is configuration; no code.

## CloudFlare rules — `archipelago-ea-stats.decentraland.{zone,org}`

Apply in `zone` first, then `org`, at rollout step 5 (after WP6 realm-provider is deployed).

| Path | Origin | Notes |
|---|---|---|
| `/hot-scenes` | comms-gatekeeper | bare `HotSceneInfo[]`; `503 {"ok":false,"error":"warming"}` while the presence map primes |
| everything else (`/realms*`, `/peers*`, `/comms/*`, `/parcels`, `/islands*`, `/status`, `/about`, `/health`) | Pulse HTTP | plain `HttpListener` on the container; front it with the existing ALB/NLB listener on a separate port; health check `GET /health` (200) |

Legacy paths answer `308` to `/realms/main/…` from Pulse itself (no CloudFlare rewrite needed). Served directly (all realms, no redirect): `/peers?id=`, `/comms/peers?id=`, `/peers?all=true`, `/comms/peers?all=true`, `/peers/:id`, `/comms/peers/:id`; `/status`, `/about`, `/health` and every `/realms/…` route are direct as well. `/core-status` retires — nothing points at it once realm-provider
runs `PRESENCE_SOURCE=pulse`.

Rollback: revert the rule; archipelago-stats keeps running until step 9.

## Environment injection

| Service | Keys | Default (= today) | Flip value |
|---|---|---|---|
| Pulse | `Presence:Enabled` (follows `Nats:Url` being set), `Presence:BatchIntervalMs` 2000, `Presence:SnapshotIntervalMs` 60000 | feed off without `NATS_URL` | inject `NATS_URL` (step 2) |
| comms-gatekeeper | `PULSE_URL`, `PRESENCE_MAP_ENABLED` false, `HOT_SCENES_REFRESH_MS` 10000, `HOT_SCENES_SCENE_TTL_MS` 300000, `LIVEKIT_PRESENCE_FALLBACK` true, `SHADOW_COMPARE_PRESENCE` false; `COMMS_ROOM_PREFIX` / `SCENE_ROOM_PREFIX` must equal worlds-content-server's (prod: verify, defaults are `world-` / `world-scene-room-`) | LiveKit answers | step 3: `PRESENCE_MAP_ENABLED=true`, `SHADOW_COMPARE_PRESENCE=true`; step 6: `LIVEKIT_PRESENCE_FALLBACK=false` |
| social-service-ea | `PULSE_URL`, `PRESENCE_SOURCE` archipelago (`ARCHIPELAGO_STATS_URL` stays until the flag is removed) | heartbeats + stats poll | step 4: `both` (shadow, logs the diff); step 6: `pulse` |
| worlds-content-server | `PULSE_URL`, `PRESENCE_SOURCE` livekit, `PUBLISH_PEER_WORLD_EVENTS` true | LiveKit counts | step 4: `both`; step 6: `pulse`; step 8: `PUBLISH_PEER_WORLD_EVENTS=false` |
| realm-provider | `PULSE_URL`, `COMMS_GATEKEEPER_URL`, `PRESENCE_SOURCE` archipelago (`ARCHIPELAGO_STATS_URL` stays until removed) | stats aggregation + `/core-status` | step 5: `pulse` (startup fails loudly if either URL is missing) |
| archipelago-workers ws-connector | `WS_IDLE_TIMEOUT_SECONDS` 90, `HEARTBEAT_FORWARDING_ENABLED` true | unchanged | step 8: `HEARTBEAT_FORWARDING_ENABLED=false` |
| unity-explorer | feature flag `archipelago-heartbeats` (enabled = today) | heartbeats sent | step 7: disable, ramp to 100 % |

`NATS_URL` is already shared by every NATS consumer. Pulse's HTTP port is `HttpService:Port` (5000).

## Gates (from the plan's rollout table)

| Step | Change | Gate | Rollback |
|---|---|---|---|
| 1 | WP7 places casing fix; WP3a ws pings | deployed; no idle-disconnect spike | revert |
| 2 | WP1 Pulse feed + HTTP | `engine.parcel_changes` shows snapshots + deltas; C2 routes return data | `Presence:Enabled=false` |
| 3 | WP2 gatekeeper map + `/hot-scenes` in shadow | WP10 diffs 1 and 4 within tolerance 7 days | `PRESENCE_MAP_ENABLED=false` |
| 4 | WP4 social-service `both`; WP5 wcs `both` | WP10 diffs 2 and 3 within tolerance 7 days | `PRESENCE_SOURCE=archipelago` / `livekit` |
| 5 | WP6 realm-provider `pulse`; CloudFlare cut | consumers' error rates flat (places, sites, unity `/status`, referral) | revert CF rule |
| 6 | gatekeeper fallback off; social-service + wcs `pulse` | 24 h clean | flags back |
| 7 | WP8 unity release, heartbeat flag ramps to 100 % | ≥ 95 % sessions on new build; retired subjects silent on the broker (the client reads the flag once at launch, so allow ≥ 24 h for live sessions to cycle after the ramp) | ramp down (takes effect on next launch) |
| 8 | ws-connector `HEARTBEAT_FORWARDING_ENABLED=false`; wcs `PUBLISH_PEER_WORLD_EVENTS=false`; delete social-service worlds-stats | no subscriber logs for retired subjects 48 h | redeploy previous images |
| 9 | WP3c delete `stats`; remove fallback flags; wcs remove `connected-world` | runbook verification green | redeploy last stats image + CF revert |

## Known risks to clear before step 6

- **WebSocket reconnects lose their island without heartbeats** (found in the WP8 review): gatekeeper only emits `island_changed` on a Pulse cluster change, so a reconnecting socket gets nothing until the crowd changes. Fix in flight: ws-connector publishes `peer.{address}.connect` on handshake (WP3d) and gatekeeper re-mints the current assignment on it (WP2 A9). Both must be deployed before step 7 (client heartbeats off).
- **Silent clients** (refined after the WP1 review): a hard-killed client is detected by the transport keepalive in about 5 s in production and emits its exit entry (the minutes-long lingering seen in local acceptance came from the Development config's 5-minute `Transport:PeerTimeoutMs`). The residual gap is a client that keeps ACKing but stops sending input: `/peers` shows a frozen `lastPing` and the feed carries no staleness field. Pulse needs an input-idle timeout (no `MovementInput` for N s => treated as left) before LiveKit fallbacks are switched off.
- **`/realms` on realm-provider lists only `main`** today because catalyst `/about` has no `comms` block; WP6 keeps
  that behaviour. Decide separately whether third-party catalysts should be listed.
- **Semantic shift visible on place cards**: `connected_addresses` becomes "standing on the scene's parcels" and will
  finally agree with `user_count`. Tell product before step 6.
