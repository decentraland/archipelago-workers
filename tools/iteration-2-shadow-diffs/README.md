# Iteration-2 shadow-diff harness

Four small scripts that compare **today's answer** (LiveKit or client heartbeats) with **the
Pulse-fed answer**, and write one JSON line per run in one shared format. Every consumer is verified
against its Pulse-fed answer for **at least 7 days of shadow traffic** before the LiveKit or
heartbeat path is switched off — this harness is what that claim is read from.

No runtime dependencies: Node ≥ 20, built-in `fetch`, `fs`, `net`/`tls`, and `redis-cli` if the host
happens to have it. Nothing here is deployed with a service; it runs as a cron on an operator host.

```
tools/iteration-2-shadow-diffs/
  bin/shadow-diff.js      one entry point for the four diffs and the window summary
  src/diffs/*.js          one file per diff: a pure `compare*` function plus a thin `run`
  src/report.js           the shared report line and the tolerance arithmetic
  src/summarize.js        the window aggregate and the Markdown table
  src/prometheus.js       counter scraping for diff 1
  src/redis.js            RESP client / redis-cli wrapper for diff 3
  test/                   `node --test`, fixtures copied from the contract pack
```

## The four diffs

| # | name | today's answer | Pulse-fed answer | sample unit |
|---|---|---|---|---|
| 1 | `scene-participants` | LiveKit room members | comms-gatekeeper presence map | one `/scene-participants` request |
| 2 | `live-data` | worlds-content-server `/live-data` | Pulse `/realms`, filtered to `.dcl.eth` | one world name |
| 3 | `online-set` | social-service `PEERS_CACHE_KEY` | social-service `PEERS_CACHE_KEY_PULSE` | one address (counted, never named) |
| 4 | `hot-scenes` | archipelago-stats `/hot-scenes` | comms-gatekeeper `/hot-scenes` | one scene id in the top 100 |

Diff 1 is **counter-based**: comms-gatekeeper already compares both answers per request and
increments `presence_shadow_diff{kind=land|world}` by the size of the symmetric difference, so this
diff scrapes `/metrics` and subtracts the previous scrape (a state file next to the report). It
therefore cannot say which side an address was missing from, and leaves `onlyLegacy` / `onlyPulse`
at 0 with the raw difference count in `notes`. The other three see both answers directly and fill
all four counts.

Diff 3 never puts an address in its output. `compareOnlineSets` returns only
`sampleSize`/`agree`/`onlyLegacy`/`onlyPulse`/`notes`; there is no field that could carry a member,
and `test/no-addresses.test.js` drives all four diffs with wallet-bearing inputs and asserts that
neither the `.jsonl` nor stdout matches `0x[0-9a-fA-F]{8,}`.

## Running one diff

```bash
cd tools/iteration-2-shadow-diffs

OUT_DIR=/var/log/shadow-diffs SHADOW_DIFF_ENV=zone \
  WCS_URL=https://worlds-content-server.decentraland.zone \
  PULSE_URL=https://archipelago-ea-stats.decentraland.zone \
  node bin/shadow-diff.js live-data
```

Each run appends one line to `${OUT_DIR}/<diff>.jsonl` and prints a human summary:

```
[live-data] env=zone at=2026-09-05T10:00:00.000Z OUT OF TOLERANCE
  sample=2 agree=1 onlyLegacy=1 onlyPulse=0 disagree=1 (50.00%) allowed=5.00%
  explainedBy: no-comms peers visible to Pulse; <= 2 s batching; ~5 s vs webhook latency
  notes: worlds legacy=2 pulse=1; onlyLegacy: quiet.dcl.eth
```

A single run exits non-zero **only** when it could not collect a sample (a missing variable, an
unreachable endpoint, a `/metrics` page without the request counter). An out-of-tolerance verdict is
data, not a failure — one 03:00 sample of four peers is noise, and paging on it trains people to
ignore the cron. The verdict that matters is the window verdict, below.

The report line, identical for all four diffs:

```json
{ "diff": "live-data", "at": "2026-09-05T10:00:00.000Z", "env": "zone",
  "sampleSize": 42, "agree": 40, "onlyLegacy": 1, "onlyPulse": 1,
  "tolerance": { "maxDisagreeRatio": 0.05 }, "withinTolerance": true,
  "explainedBy": ["no-comms peers visible to Pulse", "<= 2 s batching", "~5 s vs webhook latency"],
  "notes": "…" }
```

`withinTolerance` is `disagree / sampleSize <= maxDisagreeRatio`, where `disagree = sampleSize -
agree`. An empty sample (`sampleSize: 0`) is 0 %, never `NaN`, and is within tolerance. The
comparison is inclusive at the boundary, with a small epsilon so an exact boundary is not lost to
float64 — `0.29 * 100` is `28.999999999999996`, and 29 in 100 against a 29 % tolerance is not a
breach.

## Environment variables

| variable | used by | default | notes |
|---|---|---|---|
| `OUT_DIR` | all | `<harness>/out` | where `<diff>.jsonl` and the state file live |
| `SHADOW_DIFF_ENV` | all | `zone` | the `env` label written into every line |
| `MAX_DISAGREE_RATIO` | all | `0.05` | global tolerance override, in `[0, 1]` |
| `MAX_DISAGREE_RATIO_<DIFF>` | all | — | per-diff override, wins over the global one; the diff name upper-snake-cased (`MAX_DISAGREE_RATIO_LIVE_DATA`) |
| `GATEKEEPER_METRICS_URL` | 1 | — | full URL of comms-gatekeeper's Prometheus page |
| `SHADOW_DIFF_METRIC` | 1 | `presence_shadow_diff` | |
| `SHADOW_REQUESTS_METRIC` | 1 | `http_requests_total` | **verify against the deployed page** — see the caveat below |
| `SHADOW_REQUESTS_LABELS` | 1 | `handler=/scene-participants` | comma-separated `key=value`; quotes optional |
| `WCS_URL` | 2 | — | worlds-content-server base URL; `/live-data` is appended |
| `PULSE_URL` | 2 | — | Pulse base URL; `/realms` is appended |
| `REDIS_URL` | 3 | — | `redis://[user:pass@]host[:port][/db]`, or `rediss://` for TLS |
| `PEERS_CACHE_KEY` | 3 | — | social-service's legacy online-set key |
| `PEERS_CACHE_KEY_PULSE` | 3 | — | social-service's Pulse-fed online-set key |
| `STATS_URL` | 4 | — | archipelago-stats base URL; `/hot-scenes` is appended |
| `GATEKEEPER_URL` | 4 | — | comms-gatekeeper base URL; `/hot-scenes` is appended |

A trailing slash on any base URL is fine. Base URLs must not carry a query string — the path is
appended verbatim.

**Diff 1, the request-counter name.** `presence_shadow_diff` is pinned by the contract and is exact.
The *request* counter is whatever the deployed comms-gatekeeper's HTTP middleware exports, which the
harness does not pin. Check the live page once per environment before trusting the ratio:

```bash
curl -s "$GATEKEEPER_METRICS_URL" | grep -E '^[a-z_]*http[a-z_]*\{?.*scene-participants'
```

If the name or labels differ (a `_count` suffix on a histogram, `route=` instead of `handler=`), set
`SHADOW_REQUESTS_METRIC` / `SHADOW_REQUESTS_LABELS`. A page with **no** series under the configured
name is a hard error, on purpose: reading it as "no traffic" would report a clean empty sample every
run, forever, and the gate would pass on nothing at all.

**Diff 3, credentials.** The password is read out of `REDIS_URL` and handed to `redis-cli` in
`REDISCLI_AUTH`, never in argv (argv is world-readable in `/proc`). Error messages redact the
credentials in the URL. Keep `REDIS_URL` in a root-owned `600` file, not in the crontab.

## The cron lines

Both environments run the same four diffs; only the endpoints and the `SHADOW_DIFF_ENV` label
differ. Put the variables in `/etc/shadow-diffs/zone.env` and `/etc/shadow-diffs/org.env`
(`chmod 600`, root-owned — `REDIS_URL` carries a password), and start `zone` first. `org` is added
only once `zone` has a clean window.

```cron
# /etc/cron.d/shadow-diffs-zone
SHELL=/bin/bash
HARNESS=/opt/archipelago-workers/tools/iteration-2-shadow-diffs
*/5 * * * *  deploy  set -a; . /etc/shadow-diffs/zone.env; set +a; node $HARNESS/bin/shadow-diff.js scene-participants >> /var/log/shadow-diffs/zone.log 2>&1
*/5 * * * *  deploy  set -a; . /etc/shadow-diffs/zone.env; set +a; node $HARNESS/bin/shadow-diff.js live-data          >> /var/log/shadow-diffs/zone.log 2>&1
*/5 * * * *  deploy  set -a; . /etc/shadow-diffs/zone.env; set +a; node $HARNESS/bin/shadow-diff.js online-set         >> /var/log/shadow-diffs/zone.log 2>&1
*/5 * * * *  deploy  set -a; . /etc/shadow-diffs/zone.env; set +a; node $HARNESS/bin/shadow-diff.js hot-scenes         >> /var/log/shadow-diffs/zone.log 2>&1
# the daily paste for the migration plan
0 9 * * *    deploy  set -a; . /etc/shadow-diffs/zone.env; set +a; for d in scene-participants live-data online-set hot-scenes; do node $HARNESS/bin/shadow-diff.js summarize $d; done > /var/log/shadow-diffs/zone-summary.md 2>&1
```

```cron
# /etc/cron.d/shadow-diffs-org  — same shape, org endpoints, offset so the two do not collide
SHELL=/bin/bash
HARNESS=/opt/archipelago-workers/tools/iteration-2-shadow-diffs
2-59/5 * * * *  deploy  set -a; . /etc/shadow-diffs/org.env; set +a; node $HARNESS/bin/shadow-diff.js scene-participants >> /var/log/shadow-diffs/org.log 2>&1
2-59/5 * * * *  deploy  set -a; . /etc/shadow-diffs/org.env; set +a; node $HARNESS/bin/shadow-diff.js live-data          >> /var/log/shadow-diffs/org.log 2>&1
2-59/5 * * * *  deploy  set -a; . /etc/shadow-diffs/org.env; set +a; node $HARNESS/bin/shadow-diff.js online-set         >> /var/log/shadow-diffs/org.log 2>&1
2-59/5 * * * *  deploy  set -a; . /etc/shadow-diffs/org.env; set +a; node $HARNESS/bin/shadow-diff.js hot-scenes         >> /var/log/shadow-diffs/org.log 2>&1
0 9 * * *       deploy  set -a; . /etc/shadow-diffs/org.env; set +a; for d in scene-participants live-data online-set hot-scenes; do node $HARNESS/bin/shadow-diff.js summarize $d; done > /var/log/shadow-diffs/org-summary.md 2>&1
```

5 minutes gives ~2 000 samples per diff per week, enough that a real regression shows up as a ratio
rather than as one loud line. `OUT_DIR` may be shared between the two environments: every line
carries its own `env` and the summary splits on it. Nothing rotates `<diff>.jsonl` — it is a few MB
a week and it is the evidence; archive it after the cut-over rather than truncating it.

Diffs 2, 3 and 4 need their sources to be running in shadow mode first, per the rollout table in
`docs/contracts/iteration-2/ROLLOUT-INFRA.md`: diffs 1 and 4 gate step 3
(`PRESENCE_MAP_ENABLED=true`, `SHADOW_COMPARE_PRESENCE=true`), diffs 2 and 3 gate step 4
(social-service and worlds-content-server on `PRESENCE_SOURCE=both`).

## Summarizing a window

```bash
node bin/shadow-diff.js summarize live-data                       # 7 days, every env
node bin/shadow-diff.js summarize hot-scenes --window-days 14     # a longer window
node bin/shadow-diff.js summarize online-set --env org            # one env
node bin/shadow-diff.js summarize live-data --gate                # exit 1 if out of tolerance
```

It prints the aggregate as **the same JSON shape** plus `runs` and `runsWithinTolerance`, then a
Markdown table, one row per environment, ready to paste:

```
**live-data** — 7 d window ending 2026-09-05T10:00:00.000Z

| env | runs | runs within tolerance | sample | agree | onlyLegacy | onlyPulse | disagree | tolerance | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| zone | 2016 | 2011/2016 | 84302 | 84115 | 121 | 66 | 187 (0.22%) | 5.00% | within |
```

Two numbers, deliberately different:

* **`runsWithinTolerance`** counts runs whose own flag was true. It answers "how often did a single
  sample look bad", which is mostly a question about small samples at quiet hours.
* **`withinTolerance`** is recomputed from the **summed** counts. It answers "over the window, how
  much did the two answers actually disagree". A window can be within tolerance with a handful of
  bad runs in it (one 5-in-20 sample against 1 000 clean ones), and a window of runs that each
  passed can still be out of tolerance if every one of them sat just under the line. The gate reads
  this one.

Mixed tolerances inside a window take the strictest and say so in `notes`. Runs older than the
window are dropped (the boundary run is kept); a run whose clock is slightly ahead is kept, since
that is cron-host skew rather than a bad sample.

## The cut-over gate

A consumer may be switched off its LiveKit or heartbeat path when, for the diffs that cover it:

1. **≥ 7 days** of continuous runs in the environment being cut over, `runs` consistent with the
   cron interval (a gap means the cron was down, not that the answers agreed);
2. the window `withinTolerance` is `true` in `zone`, then in `org`;
3. **the symmetric difference is explained only by the documented semantic shifts** — the
   `explainedBy` entries, which are the same three-to-four causes each diff was built around:
   no-comms peers that Pulse can see and LiveKit cannot, the ≤ 2 s feed batching interval, the
   ~5 s transport keepalive versus webhook latency, and for `/hot-scenes` the refresh window and
   scene TTL. Anything else in `notes` — a world only one side has lasted hours, a scene id neither
   refresh window explains, a `usersMismatch` that grows with load — is **not** explained, and the
   cut-over waits regardless of the ratio.

Point 3 is the one that cannot be automated, and it is the point of the harness: the ratio says how
big the difference is, `notes` says whether it is the difference we predicted. A green ratio over a
difference nobody can name is a failed gate.

Known unexplained-difference sources still open at the time of writing (see "Known risks" in
`ROLLOUT-INFRA.md`): a client that keeps ACKing the transport but stops sending input is still
counted online by Pulse, and `presence_shadow_diff` compares the ban-filtered map answer with the
unfiltered LiveKit answer, so a freshly banned wallet counts as a difference. Expect a small,
non-zero floor on diffs 1 and 3 from both.

## Where the results go

The daily `summarize` output is pasted into the **iteration-2 migration plan page in Notion**, under
the rollout table, one table per diff per environment — that page is where the step 3, 4 and 6 gates
are signed off, and the `.jsonl` files under `OUT_DIR` on the cron host are the raw evidence behind
it. Attach or link the relevant `<diff>.jsonl` when a gate is contested; do not paste raw lines into
the page, since the table is the reviewed artefact. If the plan page moves, update this section
rather than the cron.

## Tests

```bash
cd tools/iteration-2-shadow-diffs
node --test          # or: npm test / npm run shadow-diffs:test
```

152 tests, no network and no Redis: the `compare*` functions are pure, and the `run` functions take
`fetchJson` / `fetchText` / `readSet` / `now` / `out` as injectable parameters, so a run is tested
end to end against fixture bodies and a temporary `OUT_DIR`.

Fixtures under `test/fixtures/iteration-2/` are **copies** of the contract pack's goldens
(`http/realms.json`, `http/today/hot-scenes.json`); `test/fixture-integrity.test.js` checks their
sha256 against `docs/contracts/iteration-2/manifest.json`, so a drifted copy fails the suite. The
pack has no `/live-data` golden and no gatekeeper `/hot-scenes` probe, so `live-data.json` and
`hot-scenes-gatekeeper.json` are hand-written and say so in their own `note` field.

These specs are `.test.js` on `node --test` and are **not** part of the repository's jest run: the
harness is not a yarn workspace, the root `jest.config.js` projects only into `ws-connector` and
`stats`, and both match `<rootDir>/test/**/*.spec.ts` only. `test/repo-root.test.js` asserts each of
those facts, so a future change to the root config that would pull these files into `yarn test`
fails here first.
