# Iteration 2 — infrastructure checklist (WP9) and rollout gates

Operator-facing companion to the contract pack. Everything here is configuration; no code.

## CloudFlare rules — `archipelago-ea-stats.decentraland.{zone,org}`

Apply in `zone` first, then `org`, at rollout step 5 (after WP6 realm-provider is deployed).

| Path | Origin | Notes |
|---|---|---|
| `/hot-scenes` | comms-gatekeeper | bare `HotSceneInfo[]`; `503 {"ok":false,"error":"warming"}` while the presence map primes |
| everything else (`/realms*`, `/peers*`, `/comms/*`, `/parcels`, `/islands*`, `/status`, `/about`, `/health`) | Pulse HTTP | plain `HttpListener` on the container; front it with the existing ALB/NLB listener on a separate port; health check `GET /health` (200) |

Legacy paths answer `308` to `/realms/main/…` from Pulse itself (no CloudFlare rewrite needed); `/peers?id=` and
`/comms/peers?id=` are served directly (all realms). `/core-status` retires — nothing points at it once realm-provider
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
| 7 | WP8 unity release, heartbeat flag ramps to 100 % | ≥ 95 % sessions on new build; ws-connector heartbeat rate → 0 | ramp down |
| 8 | ws-connector `HEARTBEAT_FORWARDING_ENABLED=false`; wcs `PUBLISH_PEER_WORLD_EVENTS=false`; delete social-service worlds-stats | no subscriber logs for retired subjects 48 h | redeploy previous images |
| 9 | WP3c delete `stats`; remove fallback flags; wcs remove `connected-world` | runbook verification green | redeploy last stats image + CF revert |

## Known risks to clear before step 6

- **Phantom peers after a hard client kill** (found in WP1 acceptance): the transport raises no disconnect, so a
  killed client stays present until the transport times out (observed: minutes). Archipelago's 60 s heartbeat
  timeout used to mask this. Pulse needs an input-idle timeout (no `MovementInput` for N s ⇒ treated as left) before
  LiveKit fallbacks are switched off.
- **`/realms` on realm-provider lists only `main`** today because catalyst `/about` has no `comms` block; WP6 keeps
  that behaviour. Decide separately whether third-party catalysts should be listed.
- **Semantic shift visible on place cards**: `connected_addresses` becomes "standing on the scene's parcels" and will
  finally agree with `user_count`. Tell product before step 6.
