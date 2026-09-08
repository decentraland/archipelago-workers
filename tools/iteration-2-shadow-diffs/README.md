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
| 1 | `scene-participants` | LiveKit room members | comms-gatekeeper presence map | one shadow comparison gatekeeper performed |
| 2 | `live-data` | worlds-content-server `/live-data` | Pulse `/realms`, filtered to `.dcl.eth` | one world name |
| 3 | `online-set` | social-service `PEERS_CACHE_KEY` | social-service `PEERS_CACHE_KEY_PULSE` | one address (counted, never named) |
| 4 | `hot-scenes` | archipelago-stats `/hot-scenes` | comms-gatekeeper `/hot-scenes` | one scene id in the top 100 |

Diff 1 is **counter-based**. comms-gatekeeper compares both answers per request and increments two
counters per `kind` (`land` / `world`):

| counter | meaning | role here |
|---|---|---|
| `presence_shadow_diff{kind}` | addresses in the symmetric difference | the numerator |
| `presence_shadow_compare_total{kind}` | comparisons that actually produced two answers | the denominator |

so this diff scrapes `/metrics` and subtracts the previous scrape (a per-environment state file next
to the report) to get *difference count / comparisons since the last run*, per `kind` and in total.

**The denominator is comparisons, not HTTP requests.** gatekeeper's compare runs only
`if (shadowCompare && mapIsUsable)` and its body is inside a catch-and-log, so a failing LiveKit
side (bad credentials, room-list timeout, rate limit) or a presence map still cold after a deploy
leaves `presence_shadow_diff` flat while `/scene-participants` traffic keeps climbing. Divided by
requests, that reads as `sampleSize: 940, agree: 940, withinTolerance: true` every five minutes —
a perfect week over a shadow that never executed. Divided by comparisons it reads as what it is:
`sampleSize: 0`, `withinTolerance: false`, `notes: "no comparisons in window"`. This is what
`presence_shadow_compare_total`'s own help text was written to prevent, and 4xx/5xx responses and
the `503 warming` answers that never reach the compare are out of the denominator by construction.

Diff 1 cannot say which side an address was missing from, so it leaves `onlyLegacy` / `onlyPulse` at
0 with the raw counts in `notes`. The other three see both answers directly and fill all four
counts.

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

# diff 1 additionally needs the metrics scrape target(s) and, where /metrics is protected, a token
OUT_DIR=/var/log/shadow-diffs SHADOW_DIFF_ENV=zone \
  GATEKEEPER_METRICS_URL=https://gk-task-1.internal:5000/metrics,https://gk-task-2.internal:5000/metrics \
  GATEKEEPER_METRICS_TOKEN="$(cat /etc/shadow-diffs/gatekeeper-metrics.token)" \
  node bin/shadow-diff.js scene-participants
```

Each run appends one line to `${OUT_DIR}/<diff>.jsonl` and prints a human summary:

```
[live-data] env=zone at=2026-09-05T10:00:00.000Z OUT OF TOLERANCE
  sample=2 agree=1 onlyLegacy=1 onlyPulse=0 disagree=1 (50.00%) allowed=5.00%
  explainedBy: no-comms peers visible to Pulse; <= 2 s batching; ~5 s vs webhook latency
  notes: worlds legacy=2 pulse=1; onlyLegacy: quiet.dcl.eth
```

A single run exits non-zero **only** on a configuration or transport failure (a missing variable, an
unreachable endpoint, a `/metrics` page that does not export the configured counter). An
out-of-tolerance verdict is data, not a failure — one 03:00 sample of four peers is noise, and
paging on it trains people to ignore the cron. The verdict that matters is the window verdict, below.

Two situations write **no line at all** and still exit 0, because there is genuinely nothing to
sample and a fabricated sample would be worse than a gap: diff 1 when the gatekeeper counters went
*backwards* since the previous scrape (an exporter restart, or a scrape that landed on another
task — the run logs `SKIPPED — counters went backwards …` and keeps the new counters as the next
baseline), and diff 4 while gatekeeper answers `503 warming` (that one does write a line, with
`sampleSize: 0`; see below). Grep the cron log for `SKIPPED` when `runs` is short of the expected
count.

The report line, identical for all four diffs:

```json
{ "diff": "live-data", "at": "2026-09-05T10:00:00.000Z", "env": "zone",
  "sampleSize": 42, "agree": 40, "onlyLegacy": 1, "onlyPulse": 1,
  "tolerance": { "maxDisagreeRatio": 0.05 }, "withinTolerance": true,
  "explainedBy": ["no-comms peers visible to Pulse", "<= 2 s batching", "~5 s vs webhook latency"],
  "notes": "…" }
```

`withinTolerance` is `disagree / sampleSize <= maxDisagreeRatio`, where `disagree = sampleSize -
agree`. The comparison is inclusive at the boundary, with a small epsilon so an exact boundary is
not lost to float64 — `0.29 * 100` is `28.999999999999996`, and 29 in 100 against a 29 % tolerance
is not a breach.

**An empty sample is never within tolerance.** `sampleSize: 0` ratios as 0 %, never `NaN`, but the
verdict is `false` and `notes` says why: nothing was compared, so nothing agreed, and the gate is
read off this flag. A window whose runs all have an empty sample verdicts `false` as well, and the
Markdown table prints such a row as `no data` instead of a verdict — the failure mode this rules
out is a whole week of "the source answered nothing" reading as a whole week of agreement.

## Environment variables

| variable | used by | default | notes |
|---|---|---|---|
| `OUT_DIR` | all | `<harness>/out` | `<diff>.jsonl` here, `state/<env>-<diff>.json` beside it; may be shared between environments |
| `SHADOW_DIFF_ENV` | all | `zone` | the `env` label written into every line |
| `MAX_DISAGREE_RATIO` | all | `0.05` | global tolerance override, in `[0, 1]` |
| `MAX_DISAGREE_RATIO_<DIFF>` | all | — | per-diff override, wins over the global one; the diff name upper-snake-cased (`MAX_DISAGREE_RATIO_LIVE_DATA`) |
| `GATEKEEPER_METRICS_URL` | 1 | — | comms-gatekeeper's Prometheus page: **one URL per task**, comma-separated (see the load-balancer caveat) |
| `SHADOW_DIFF_METRIC` | 1 | `presence_shadow_diff` | the numerator; pinned by the contract |
| `SHADOW_COMPARE_METRIC` | 1 | `presence_shadow_compare_total` | the denominator: comparisons performed, not requests served |
| `SHADOW_COMPARE_LABELS` | 1 | *(empty)* | comma-separated `key=value` (quotes optional); empty sums the compare counter over every `kind` |
| `WCS_URL` | 2 | — | worlds-content-server base URL; `/live-data` is appended |
| `PULSE_URL` | 2 | — | Pulse base URL; `/realms` is appended |
| `REDIS_URL` | 3 | — | `redis://[user:pass@]host[:port][/db]`, or `rediss://` for TLS |
| `PEERS_CACHE_KEY` | 3 | — | social-service's legacy online-set key |
| `PEERS_CACHE_KEY_PULSE` | 3 | — | social-service's Pulse-fed online-set key |
| `STATS_URL` | 4 | — | archipelago-stats base URL; `/hot-scenes` is appended |
| `GATEKEEPER_URL` | 4 | — | comms-gatekeeper base URL; `/hot-scenes` is appended |
| `METRICS_BEARER_TOKEN` | all | — | one `Authorization: Bearer` token for every endpoint that has no token of its own |
| `GATEKEEPER_METRICS_TOKEN` | 1 | — | token for `GATEKEEPER_METRICS_URL`; **`/metrics` answers 401 without it** wherever the service has a metrics token configured |
| `WCS_TOKEN` / `PULSE_TOKEN` | 2 | — | per-endpoint tokens for `WCS_URL` / `PULSE_URL` |
| `STATS_TOKEN` / `GATEKEEPER_TOKEN` | 4 | — | per-endpoint tokens for `STATS_URL` / `GATEKEEPER_URL` |

A trailing slash on any base URL is fine. Base URLs must not carry a query string — the path is
appended verbatim.

**Diff 1, one scrape URL per task — do not scrape through a load balancer.** Counter deltas need
successive scrapes to come from the same process. A public service URL sends each scrape to whatever
task the load balancer picks, and those tasks' lifetime counters are unrelated numbers: roughly half
the runs would see the counter go *down* and the rest an inflated jump, so the window's sample would
be tens of times the real traffic and its ratio would converge on the service's lifetime average —
a disagreement rate that jumps to 30 % on day 8 could not move the verdict.

The harness will not paper over that. Give `GATEKEEPER_METRICS_URL` one address per task,
comma-separated:

```bash
GATEKEEPER_METRICS_URL=https://gk-task-1.internal:5000/metrics,https://gk-task-2.internal:5000/metrics
```

Each target is subtracted against **its own** previous scrape and the deltas are summed, so the
sample is the whole service's traffic measured once. Three cases are handled explicitly and none of
them is guessed at:

* a task that **just appeared** (a scale-up) has no previous scrape, so its whole lifetime counter
  is taken — it is a young process, so that is close to the window — and `notes` says
  `new targets=1`;
* a task whose counter **went backwards** (a restart, or a rescheduled task reusing an address)
  makes the whole run log `SKIPPED` and write no line: reporting the remaining tasks would publish
  part of the traffic as all of it;
* a task that **disappeared** simply stops contributing; the traffic it served since the last scrape
  is lost, which is a small under-count rather than an invented one.

If per-task addresses are not reachable from the cron host, do not point this at the service URL:
query a Prometheus that has already summed the tasks (`sum(presence_shadow_diff)` /
`sum(presence_shadow_compare_total)`) and set `SHADOW_COMPARE_METRIC` / `SHADOW_DIFF_METRIC` against
its `/federate` output, or run the cron on the same network as the tasks.

**Diff 1, checking the two counters once per environment.** Both are exported by comms-gatekeeper
itself (`src/metrics.ts`), so the defaults need no configuration — but check the live page once,
because a `/metrics` page that does not carry them at all is the one failure that cannot be
distinguished from silence:

```bash
curl -s -H "Authorization: Bearer $GATEKEEPER_METRICS_TOKEN" "$GATEKEEPER_METRICS_URL" \
  | grep -E '^presence_shadow_(diff|compare_total)'
```

Expect one line per `kind`. A page with **no** series matching the configured name *and* label
filter is a hard error, on purpose: reading it as "no traffic" would report a clean empty sample
every run, forever, and the gate would pass on nothing at all. A page that carries the counter but
whose compare count has not moved since the previous scrape is not an error — that is the
`no comparisons in window` line above, `withinTolerance: false`, and it is a real finding about the
shadow rather than about the harness.

`SHADOW_COMPARE_METRIC` / `SHADOW_COMPARE_LABELS` exist for a gatekeeper deployed before
`presence_shadow_compare_total` existed; the closest substitute is
`SHADOW_COMPARE_METRIC=http_requests_total` with
`SHADOW_COMPARE_LABELS=handler=/scene-participants,code=200`. Note what that costs: requests that
never reached the compare are back in the denominator, so the ratio is diluted and a shadow that
never ran can read as agreement again. Prefer deploying the counter.

**Authenticating a scrape.** Every fetched URL takes an optional `Authorization: Bearer` header.
For a `<NAME>_URL` variable the harness reads `<NAME>_TOKEN`, then `<NAME>_BEARER_TOKEN`, then the
shared `METRICS_BEARER_TOKEN`; the first non-empty one wins, and no header is sent when all three
are unset. This is not optional in practice for diff 1: `@dcl/http-server`'s `/metrics` route
answers `401` unless the request carries its bearer token, and the contract pack records `/metrics`
as bearer-protected in deployment (`docs/contracts/iteration-2/http/redirects.json`), so without a
token diff 1 collects nothing at all for the whole shadow period in that environment.

The token is only ever a request header. It is not logged, not printed in a summary and not in any
error message — `test/http.test.js` pins that a 401 failure names the URL and the status and does
not carry the token, and that credentials embedded in a URL (`https://user:pass@host/…`) are
stripped out of every message. Keep the tokens in the same root-owned `600` env file as `REDIS_URL`.

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

5 minutes gives ~2 000 *runs* per diff per week, enough that a real regression shows up as a ratio
rather than as one loud line. Diff 1's `sampleSize` is not the run count: it is the number of
*comparisons* gatekeeper performed in the window, summed over its tasks, so it tracks
`/scene-participants` traffic. If the weekly total is orders of magnitude away from the traffic you
expect, the scrape targets are wrong (a load balancer in front of them) before anything else is.

`OUT_DIR` may be shared between the two environments. Every report line carries its own `env` and
the summary splits on it, and diff 1's counter state is **per environment**: it lives in
`${OUT_DIR}/state/<env>-<diff>.json`, keyed by `SHADOW_DIFF_ENV`, so the `zone` and `org` crons
cannot overwrite each other's previous scrape. Sharing one state file across environments would make
each run read the other deployment's lifetime counters as its own baseline — a huge sample at the
service's lifetime ratio, roughly every second run, with nothing in `notes` to say so. If you change
`SHADOW_DIFF_ENV` for an existing cron, its next run is a first run again (it has no baseline under
the new label) and reports the lifetime counters once; drop that line before reading the window.

Nothing rotates `<diff>.jsonl` — it is a few MB a week and it is the evidence; archive it after the
cut-over rather than truncating it.

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

A window whose runs summed to **no sample at all** — every run empty, or no runs in the window —
verdicts `withinTolerance: false`, says `no samples in the window` / `no runs` in `notes`, and its
table row reads `no data` instead of `within` or `OUT`. `--gate` therefore exits 1 on it: an absence
of evidence must not open a cut-over. Both halves are pinned by tests, per run and per window.

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
