# Runbook: archipelago-stats removal

Iteration 2 of the [Archipelago ⇒ Pulse migration](https://app.notion.com/p/decentraland/Archipelago-Pulse-migration-plan-3a45f41146a58070b6b0dbe541bc7533),
rollout step 9. Operator-facing companion: the iteration-2 contract pack's
`docs/contracts/iteration-2/ROLLOUT-INFRA.md` (CloudFlare rules, environment keys, per-step gates).
Sibling runbook for iteration 1: [core-decommission-runbook.md](./core-decommission-runbook.md).

> Diverges from iteration 1 in the one way that matters: core was deleted with no rollback flag, so
> reverting it meant a revert plus a build. Stats is deleted **after** a CloudFlare rule has already
> moved its traffic, so the rollback is a config revert plus a redeploy of an image that still
> exists — cheaper, but see [Rollback](#rollback) for what it does *not* restore.

`archipelago-stats` has been **removed from this repository**. `ws-connector` is the only workspace
left. Online-player information is Pulse's responsibility.

## What changed

| | Before | After |
| --- | --- | --- |
| `/peers`, `/peers/{id}`, `/parcels`, `/islands`, `/islands/{id}`, `/status` (and every `/comms`-prefixed alias) | archipelago-stats, heartbeat-fed | **Pulse HTTP**, realm-scoped under `/realms/{realm}/…`; the legacy paths answer `308` |
| `/about`, `/health` | — | **Pulse HTTP** (`/health` is the CloudFlare origin health check) |
| `/hot-scenes` | archipelago-stats, joined against Catalyst | **comms-gatekeeper**, from its `engine.parcel_changes` presence map; `realm-provider` proxies it |
| `/scene-participants` | — | **comms-gatekeeper** |
| `/core-status` | archipelago-stats, from `engine.discovery` | **retired outright** — realm-provider stopped reading it at step 5 |
| Position intake | `peer.<addr>.heartbeat` from ws-connector | **Pulse reads positions from its own transport** — no NATS hop, and no client heartbeat |
| Peer removal | `peer.<addr>.disconnect` only, no time-based expiry | Pulse connection lifecycle, ~5 s cleanup |
| `engine.islands` / `engine.discovery` subscriber | archipelago-stats | **nobody**. Pulse still publishes both; their wire bytes stay pinned in `ws-connector/test/contract/pulse-wire.spec.ts` |
| Catalyst (`dcl-catalyst-client`) | a dependency of this repo, for `/hot-scenes` thumbnails | not a dependency of this repo at all — gatekeeper owns the scene lookup |
| Deploy jobs | `archipelago-ea-stats` in `docker-next.yml`, `docker-release.yml`, `manual-deploy.yml` | gone; nothing redeploys the service |
| OpenAPI | `docs/stats/openapi.yaml`, aggregated into `docs/openapi.yaml` | deleted. The realm-scoped successor is **`Pulse/docs/openapi.yaml`**; `docs/openapi.yaml` documents ws-connector only |

Two visible consequences that are not this repo's to fix:

- **`connected_addresses` changes meaning.** It becomes "standing on the scene's parcels" rather
  than "in a LiveKit room for the scene", and will finally agree with `user_count`. Place cards
  move. Product was told before step 6; it is not a regression.
- **`archipelago-ea-stats.decentraland.{org,zone}` still resolves.** The hostname is now a
  CloudFlare front for two other origins. Nothing in this repository serves it, so no deploy from
  here can change what it answers — which also means a stats-shaped incident after the cut is a
  Pulse or a gatekeeper incident.

## Preconditions

Rollout steps 1–8 must be done and their gates green. Verbatim from the plan's rollout table:

| Step | Change | Gate | Rollback |
|---|---|---|---|
| 5 | realm-provider proxy + Pulse `/about`; CloudFlare cut for all paths | consumers' error rates flat | revert CF rule (stats still running) |
| 6 | gatekeeper `LIVEKIT_PRESENCE_FALLBACK=false`; social-service + wcs `PRESENCE_SOURCE=pulse` | 24 h clean | flags back |
| 7 | unity-explorer release: heartbeats off behind flag; flag ramps to 100 % | ≥ 95 % sessions on new build; ws-connector heartbeat rate → 0 | flag ramps down |
| 8 | heartbeat intake off; wcs stops `peer.*.world.*` publish; delete social-service worlds-stats | no subscriber logs for retired subjects for 48 h | redeploy previous images |
| 9 | delete `stats`; remove fallback flags everywhere; wcs removes `/wallet/:wallet/connected-world` | runbook verification list green | redeploy last stats image + CF revert |

Steps 1–4 (places casing + ws pings, the Pulse feed and HTTP, gatekeeper's map in shadow,
social-service and wcs in shadow) are gated on WP10's diff tolerances and are prerequisites of
step 5; if step 5 is green they are done.

**The one precondition that is not a gate:** step 8 turned the *intake* off, not the code. Stats has
no time-based peer expiry, so from step 8 onward its peer map has been frozen, not empty — every
session that ended inside that window is still "online" in its `/peers`. That is harmless while
nothing reads it (step 5 moved the readers), and it is the reason the rollback below is not a clean
restore.

Set these for the commands below:

```bash
export STATS=https://archipelago-ea-stats.decentraland.org   # or the .zone host in dev
export WALLET=0x0000000000000000000000000000000000000001      # any wallet with a live session
```

## Verification before the cut

Run all of it against `zone` first, then `org`. Every check is a read; none of it changes state.

### 1. The CloudFlare rule is in place and pointing at the right origins

`/hot-scenes` must reach comms-gatekeeper and everything else must reach Pulse HTTP. Read the rule
in the CloudFlare dashboard for `archipelago-ea-stats.decentraland.{zone,org}` and confirm both
legs, then confirm the origin health check is `GET /health` → 200 against Pulse's listener port
(`HttpService:Port`, 5000).

The rule is the whole cut. If it is missing or half-applied, everything below still passes —
because stats is still answering — and deleting the workspace then takes the endpoints down with
it. Check the rule **first**, and check it in the zone you are about to cut.

### 2. The legacy paths redirect instead of answering

```bash
curl -i -s -o /dev/null -w '%{http_code} %{redirect_url}\n' $STATS/peers
curl -i -s -o /dev/null -w '%{http_code} %{redirect_url}\n' $STATS/parcels
```

Expected: `308` to `https://archipelago-ea-stats.decentraland.org/realms/main/peers` (and
`/realms/main/parcels`). The `308` comes from Pulse itself, not from a CloudFlare rewrite, so
seeing it is proof that Pulse is the origin — a `200` here means the rule did not take and stats is
still serving.

### 3. The wallet lookup answers with a realm

```bash
curl -s "$STATS/comms/peers?id=$WALLET" | jq
curl -s "$STATS/peers?id=$WALLET" | jq
```

Expected: `200`, with a `realm` field on the peer. Both spellings are served directly rather than
redirected, and they search across all realms, because the caller does not know the realm — that is
the whole point of the query form. A `404` for a wallet you can see in-world means the presence feed
is not populated, not that the route is wrong.

### 4. `/status` carries realms, and `/hot-scenes` is a bare array

```bash
curl -s $STATS/status | jq '{realms: (.realms | length), sample: .realms[0]}'
curl -s $STATS/hot-scenes | jq 'type, length'
```

Expected: a non-empty `realms` array from Pulse, and `"array"` from gatekeeper — a **bare**
`HotSceneInfo[]`, not an object wrapping one. `503 {"ok":false,"error":"warming"}` from
`/hot-scenes` means gatekeeper's presence map has not primed yet; retry, and do not cut until it
has, because places reads this path through realm-provider.

`/core-status` is expected to be gone. Nothing should point at it once realm-provider runs
`PRESENCE_SOURCE=pulse`; if something still calls it, find that caller before the cut.

### 5. Nothing is publishing the retired subjects

`peer.<addr>.heartbeat` and `peer.<addr>.disconnect` must have been silent for 48 h (step 8's gate).

**There is no ws-connector metric for this.** `ws-connector/src/metrics.ts` declares only the
default HTTP metrics and the logger's, so a heartbeat rate is not on `/metrics` and cannot be
graphed. Verify it the two ways that do work:

```bash
# on the broker, over a window long enough to cover an arrival and a departure
nats sub 'peer.*.heartbeat'
nats sub 'peer.*.disconnect'
```

and confirm the ws-connector deployment actually carries `HEARTBEAT_FORWARDING_ENABLED=false`.
Check the value character by character, and grep the ws-connector logs for `does not recognise`:
the flag is read leniently **by design**, so that a typo cannot take `/ws` down with it, which means
`HEARTBEAT_FORWARDING_ENABLED=fasle` leaves forwarding **on** and only warns. A flip that looks done
in the console and is not is the failure mode this check exists for.

### 6. The consumers are off the old sources

| Service | Key | Required value |
| --- | --- | --- |
| social-service-ea | `PRESENCE_SOURCE` | `pulse` |
| worlds-content-server | `PRESENCE_SOURCE` | `pulse` |
| comms-gatekeeper | `LIVEKIT_PRESENCE_FALLBACK` | `false` |
| realm-provider | `PRESENCE_SOURCE` | `pulse` |
| ws-connector | `HEARTBEAT_FORWARDING_ENABLED` | `false` |

Read them off the running deployments, not off a merged PR. `LIVEKIT_PRESENCE_FALLBACK=true`
anywhere means gatekeeper can still answer from LiveKit, which hides a broken Pulse feed for as
long as it takes someone to notice — that is step 6's gate, and it must have been off for 24 h.

## The cut

1. **Retire the `archipelago-ea-stats` deployment on the infra side**: the service, its target group
   and listener rule, its alarms, and the scrape target for its `/metrics`. Do the alarms first —
   retiring the service with alarms live pages someone about a service that was retired on purpose.
2. **Delete the workspace** — this PR. It removes `stats/`, `docs/stats/openapi.yaml`, the twelve
   stats path refs in `docs/openapi.yaml`, and the `archipelago-ea-stats` jobs from
   `docker-next.yml`, `docker-release.yml` and `manual-deploy.yml`.

Order matters only in that step 2 stops any *future* image from carrying the program. A running task
keeps its last good image until infra removes it, so merging this PR does not by itself take the
service down.

## Rollback

**Before you start, know the cost: a rollback restores the endpoints, not the data.**

The peer map is heartbeat-fed and has no time-based expiry, so a freshly redeployed stats starts
empty and fills only from sessions that begin *after* heartbeat intake is back on. Worse, clients on
heartbeat-free builds — ≥ 95 % of sessions by step 7 — never send a heartbeat at all, so they will
**not** repopulate it however long you wait. `/peers`, `/parcels` and `/hot-scenes` would come back
thin and stay thin: a wrong answer where the CloudFlare revert alone would have given a right one.

So **revert the CloudFlare rule first and check whether that alone fixes the incident.** Redeploying
stats is the second half, and it is worth doing only if the problem is that the *endpoints* are gone
rather than that Pulse's numbers are wrong.

1. **Revert the CloudFlare rule** for `archipelago-ea-stats.decentraland.{zone,org}`, in the zone
   that is on fire. If stats is still running — i.e. the cut's step 1 has not happened — this is the
   entire rollback, and it takes effect in seconds.
2. **Recreate the deployment**, if infra has already retired it: the service, target group, listener
   rule and configuration. Only two variables are stats' own (see
   [Retired configuration](#retired-configuration)), but the service will not start without its port
   and broker settings.
3. **Redeploy the last stats image**: tag **`0.2.2`**, commit **`537def1`**
   (`537def15e2609cf0ecc8ba5bd7ad400702e455c8`). Probed from the running service on 2026-09-08:
   `GET /status` → `{"version":"0.2.2","commitHash":"537def15e2609cf0ecc8ba5bd7ad400702e455c8"}`.
   **Do not reach for `latest`, or for the newest release tag.** `0.2.3` (`e320cd0`) is the most
   recent GitHub release, but prod does not run it — the release list and the running service
   disagree, and the running service is the one you are restoring. `manual-deploy.yml` can deploy an
   older tag, but **that workflow no longer lists `archipelago-ea-stats`**, so the choice entry has
   to go back first. Reverting this PR restores both the entry and the program.
4. **Turn heartbeat intake back on**: `HEARTBEAT_FORWARDING_ENABLED=true` on the ws-connector
   deployment (or clear the key — unset means on). Without this, stats has no writer at all and its
   peer map stays permanently empty; the endpoints answer `200` with nothing in them, which reads as
   "everyone left" to every consumer listed below.
5. Optionally re-ramp the unity-explorer `archipelago-heartbeats` flag, which is the only way
   already-running client builds start feeding the map again. That is a client release ramp, not a
   config flip, so plan in days.

Verify a rollback in dev before promoting it.

## Consumers to watch after the cut

These are the readers whose error rates gated step 5. Watch them for 24 h after the cut — and again
after any rollback, because a rollback puts them back on a peer map thinner than the one they were
reading:

- **places** — `/hot-scenes` through realm-provider; drives place cards and `connected_addresses`
- **sites** (`decentraland.org`) — the online-player counts on the landing pages
- **unity-explorer** — the `/status` health gate at startup; a non-200 there blocks clients from
  entering, so this is the consumer with a user-visible failure mode
- **referral** — reads player presence for reward eligibility
- **godot explorer** — its own `/status` gate, the same shape as unity's

## Retired configuration

Stats read almost nothing of its own. These go with the service; a rollback that recreates the
configuration needs them back:

| Removed | Value stats used | Where it went |
| --- | --- | --- |
| `CONTENT_URL` | unset, defaulting to `https://peer.decentraland.org/content/` | comms-gatekeeper, which does the scene lookup for `/hot-scenes` now |
| `HTTP_SERVER_PORT` | `5002` in `stats/.env.default` | — its own listener; Pulse's is `HttpService:Port` (`5000`) |

`COMMIT_HASH` and `CURRENT_VERSION` were injected by the Docker build for every service in the image
and are not stats-specific.

> **Do not remove `NATS_URL` while tidying.** Stats read it, but **ws-connector still does** — it is
> how `engine.peer.<addr>.island_changed` reaches a client, and without it no session gets a LiveKit
> connection string. The same warning applies to `COMMS_GATEKEEPER_URL`, for the reason recorded in
> [core-decommission-runbook.md](./core-decommission-runbook.md#retired-configuration): the ban check
> at the WS entry point **fails open**, so dropping the URL silently disables ban enforcement and the
> only signal is one `logger.warn` at boot.

## Follow-ups outside this repo

- **Metrics and dashboards.** Stats' `/metrics` disappears with the service. It declared only the
  default HTTP and logger metrics, so nothing bespoke is lost, but any panel or alert scoped to the
  `archipelago-ea-stats` job goes blind rather than red — repoint it at Pulse and gatekeeper.
- **Scrape and health targets.** Stats' `/health/live` and `/metrics` go with it. Pulse's `/metrics`
  is bearer-gated whenever `WKC_METRICS_BEARER_TOKEN` is set and answers a bodiless `401` without the
  header, which `curl -s` hides — a scrape configured without the token looks exactly like a service
  that publishes nothing.
- **The heartbeat code path in ws-connector.** `HEARTBEAT_FORWARDING_ENABLED` and the publish sites
  it guards are still in the tree. They come out in a follow-up, once a rollback that needs the
  intake is out of the question. Until then rollback step 4 is available, which is the point.
- **`/wallet/:wallet/connected-world`** in worlds-content-server retires in the same step, and the
  `PRESENCE_SOURCE` / `LIVEKIT_PRESENCE_FALLBACK` flags come out of all four consumers.

## What was not measured

No side-by-side comparison of stats' `/peers` against Pulse's was run at the moment of the cut.
WP10 diffed the two sources during steps 3 and 4 and held them within tolerance for 7 days, but that
was measured against a *live* stats — one whose peer map has been frozen since step 8. Any diff taken
after step 8 measures the freeze, not the migration, so there is no post-step-8 baseline and none can
be recovered.

Two residual gaps, neither of which stats covered either:

- **Input-idle clients.** A hard-killed client is detected by Pulse's transport keepalive in about
  5 s, but a client that keeps ACKing while sending no input shows a frozen `lastPing` in `/peers`
  and the feed carries no staleness field. Pulse needs an input-idle timeout. Stats had *no* expiry
  at all, so this is strictly better than what it replaces — but it is not zero.
- **`/realms` lists only `main`.** Catalyst `/about` carries no `comms` block, so realm-provider
  lists one realm. Whether third-party catalysts should be listed is a separate decision.
