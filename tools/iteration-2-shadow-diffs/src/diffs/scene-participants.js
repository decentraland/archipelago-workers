'use strict'

// Diff 1 -- LiveKit vs the presence map, read off comms-gatekeeper's own counters. The service
// compares the two answers per request and increments, per `kind` (`land` / `world`):
//
//   presence_shadow_diff{kind}          the size of the symmetric difference  (the numerator)
//   presence_shadow_compare_total{kind} one per comparison that actually ran  (the denominator)
//
// The denominator is the number of comparisons, NOT the number of `/scene-participants` requests.
// gatekeeper's compare is gated on `shadowCompare && mapIsUsable` and its body is inside a
// catch-and-log, so a failing LiveKit side or a cold presence map leaves `presence_shadow_diff`
// flat while HTTP traffic keeps climbing. Divided by requests, that reads as a perfect week over a
// shadow that never executed; divided by comparisons, it reads as what it is -- no sample.
//
// This diff scrapes `/metrics` and subtracts the previous scrape (a per-env state file) to get
// "difference count / comparisons since the last run". The counters cannot say which side an
// address was missing from, so `onlyLegacy` and `onlyPulse` stay 0 and the raw counts go in `notes`.

const { authHeaders, fetchText: defaultFetchText, redactUrl, requireEnv } = require('../http')
const {
  hasSeries,
  parseLabelFilter,
  parsePrometheusText,
  parseScrapeUrls,
  sumCounterDeltas,
  sumSeries
} = require('../prometheus')
const { joinNotes } = require('../notes')
const { finishRun } = require('../finish-run')
const { resolveEnvLabel, resolveOutDir } = require('../report')
const { readState, writeState } = require('../state')

const DIFF = 'scene-participants'

const DEFAULT_DIFF_METRIC = 'presence_shadow_diff'
const DEFAULT_COMPARE_METRIC = 'presence_shadow_compare_total'
// Empty on purpose: sum the compare counter over every `kind`. A label filter is only needed when
// the compare counter is overridden with something else (a request counter on a gatekeeper that
// predates `presence_shadow_compare_total`).
const DEFAULT_COMPARE_LABELS = ''

// The three the brief pins, verbatim, then this diff's own shift (test/explained-by.test.js).
const EXPLAINED_BY = [
  'no-comms peers visible to Pulse',
  '<= 2 s batching',
  '~5 s vs webhook latency',
  'the ban filter is applied to the presence-map answer only'
]

const KINDS = ['land', 'world']

const NO_COMPARISONS = 'no comparisons in window'

// The counters one scraped page carries, per kind and in total.
const readCounters = (samples, { diffMetric, compareMetric, compareLabelFilter }) => {
  // The diff counter is absent until the first disagreement, which is a real zero, not an error.
  const counters = {
    diff: sumSeries(samples, diffMetric),
    compare: sumSeries(samples, compareMetric, compareLabelFilter)
  }
  for (const kind of KINDS) {
    counters[`diff.${kind}`] = sumSeries(samples, diffMetric, { kind })
    counters[`compare.${kind}`] = sumSeries(samples, compareMetric, { ...compareLabelFilter, kind })
  }
  return counters
}

// `targets` is one `{ url, text }` per gatekeeper task; each is subtracted against its own previous
// scrape and the deltas are summed (see `sumCounterDeltas`).
const compareSceneParticipants = ({ targets, previous, diffMetric, compareMetric, compareLabelFilter = {} }) => {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('at least one scrape target is required')
  }

  const counters = {}
  for (const { url, text } of targets) {
    const samples = parsePrometheusText(text)
    // A page with no compare counter under the configured name and labels means the metric name or
    // the label filter is wrong. Reading that as "no traffic" would report a clean empty sample
    // every run, forever.
    if (!hasSeries(samples, compareMetric, compareLabelFilter)) {
      throw new Error(`${compareMetric} is not exported by the /metrics page at ${redactUrl(url)}`)
    }
    counters[url] = readCounters(samples, { diffMetric, compareMetric, compareLabelFilter })
  }

  const previousTargets = previous === undefined || previous === null ? undefined : previous.targets
  const first = previousTargets === undefined
  const { deltas, newTargets, wentBackwards } = sumCounterDeltas(counters, previousTargets)

  // A counter that went backwards means the previous scrape and this one are not from the same
  // process lifetime, so that task has no measurable window. One task out of several is enough to
  // skip the whole run: reporting the rest would publish part of the traffic as all of it. The new
  // counters are kept as the next baseline; emitting a lifetime counter as a delta would look like
  // a clean, huge window at the service average ratio.
  if (wentBackwards.length > 0) {
    return {
      counterReset: true,
      reason:
        `counters went backwards since the previous scrape (${wentBackwards.map(redactUrl).join(', ')}): ` +
        'exporter restart, a rescheduled task, or a scrape through a load balancer; no window to measure',
      counters
    }
  }

  const compareDelta = deltas.compare
  const diffDelta = deltas.diff
  const sign = first ? '' : '+'
  const perKind = (prefix) => KINDS.map((kind) => `${kind}=${sign}${deltas[`${prefix}.${kind}`]}`).join(' ')

  const notes = joinNotes([
    // The distinction WP2's compare counter exists to make: a flat compare count is a shadow that
    // never ran, which is not the same fact as the two sources agreeing.
    compareDelta === 0 ? NO_COMPARISONS : undefined,
    (first ? 'first run: ' : '') +
      `diffAddresses=${sign}${diffDelta} (${perKind('diff')}); ` +
      `compares=${sign}${compareDelta} (${perKind('compare')})`,
    targets.length > 1 ? `targets=${targets.length}` : undefined,
    // A task that just scaled up has no previous scrape, so its whole (short) lifetime counter is
    // in this window. Worth saying: it is the one case where the sample is not exactly the window.
    first || newTargets.length === 0 ? undefined : `new targets=${newTargets.length}`,
    'counter-based: the direction of each difference is not observable'
  ])

  return {
    // No comparisons is an empty sample, and an empty sample is never within tolerance
    // (src/report.js) -- so a week of them fails the gate instead of passing it silently.
    sampleSize: compareDelta,
    // One comparison can disagree about several addresses, so the difference count can exceed the
    // comparison count; the ratio is then >= 1 and the run is out of tolerance, which is the point.
    agree: Math.max(0, compareDelta - diffDelta),
    onlyLegacy: 0,
    onlyPulse: 0,
    counters,
    notes
  }
}

const run = async ({ env = {}, fetchText = defaultFetchText, now = () => new Date(), out = console.log } = {}) => {
  const metricsUrl = requireEnv(env, 'GATEKEEPER_METRICS_URL')
  const outDir = resolveOutDir(env)
  const envLabel = resolveEnvLabel(env)

  const headers = authHeaders(env, 'GATEKEEPER_METRICS_URL')
  const targets = []
  for (const url of parseScrapeUrls(metricsUrl)) {
    // Sequentially: a handful of tasks, and one scrape at a time keeps the cron footprint flat.
    targets.push({ url, text: await fetchText(url, { headers }) })
  }

  const result = compareSceneParticipants({
    targets,
    previous: readState(outDir, DIFF, envLabel),
    diffMetric: env.SHADOW_DIFF_METRIC ?? DEFAULT_DIFF_METRIC,
    compareMetric: env.SHADOW_COMPARE_METRIC ?? DEFAULT_COMPARE_METRIC,
    compareLabelFilter: parseLabelFilter(env.SHADOW_COMPARE_LABELS ?? DEFAULT_COMPARE_LABELS)
  })

  const at = now().toISOString()

  if (result.counterReset === true) {
    // Logged, not thrown: a gatekeeper deploy is expected and must not page anyone, but the gap in
    // the window has to be visible in the cron log and must not become a data point.
    out(`[${DIFF}] env=${envLabel} at=${at} SKIPPED — ${result.reason}`)
    writeState(outDir, DIFF, envLabel, { at, targets: result.counters })
    return { diff: DIFF, at, env: envLabel, skipped: true, reason: result.reason }
  }

  const line = finishRun({
    diff: DIFF,
    env,
    now: () => new Date(at),
    out,
    counts: result,
    explainedBy: EXPLAINED_BY,
    notes: result.notes
  })
  // Written after the line so a crash mid-report replays the same window rather than losing it.
  writeState(outDir, DIFF, envLabel, { at, targets: result.counters })
  return line
}

module.exports = {
  DEFAULT_COMPARE_LABELS,
  DEFAULT_COMPARE_METRIC,
  DEFAULT_DIFF_METRIC,
  DIFF,
  EXPLAINED_BY,
  KINDS,
  NO_COMPARISONS,
  compareSceneParticipants,
  run
}
