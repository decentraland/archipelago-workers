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

const { authHeaders, fetchText: defaultFetchText, requireEnv } = require('../http')
const { counterDelta, hasSeries, parseLabelFilter, parsePrometheusText, sumSeries } = require('../prometheus')
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

const EXPLAINED_BY = [
  'no-comms peers visible to Pulse',
  '<= 2 s batching',
  '~5 s vs webhook latency',
  'the ban filter is applied to the presence-map answer only'
]

const KINDS = ['land', 'world']

const NO_COMPARISONS = 'no comparisons in window'

const compareSceneParticipants = ({ text, previous, diffMetric, compareMetric, compareLabelFilter = {} }) => {
  const samples = parsePrometheusText(text)

  // A page with no compare counter under the configured name and labels means the metric name or
  // the label filter is wrong. Reading that as "no traffic" would report a clean empty sample every
  // run, forever.
  if (!hasSeries(samples, compareMetric, compareLabelFilter)) {
    throw new Error(`${compareMetric} is not exported by the scraped /metrics page`)
  }

  // The diff counter is absent until the first disagreement, which is a real zero, not an error.
  const counters = {
    diff: sumSeries(samples, diffMetric),
    compare: sumSeries(samples, compareMetric, compareLabelFilter)
  }
  for (const kind of KINDS) {
    counters[`diff.${kind}`] = sumSeries(samples, diffMetric, { kind })
    counters[`compare.${kind}`] = sumSeries(samples, compareMetric, { ...compareLabelFilter, kind })
  }

  const previousCounters = previous === undefined || previous === null ? undefined : previous.counters
  const first = previousCounters === undefined
  const delta = (key) => counterDelta(counters[key], first ? undefined : previousCounters[key])

  // A counter that went backwards means the previous scrape and this one are not from the same
  // process lifetime, so no window can be measured. The run is skipped with the new counters kept
  // as the next baseline; emitting the lifetime counter as a delta would look like a clean, huge
  // window at the service's average ratio.
  const wentBackwards = Object.keys(counters).filter((key) => delta(key) === undefined)
  if (wentBackwards.length > 0) {
    return {
      counterReset: true,
      reason:
        `counters went backwards since the previous scrape (${wentBackwards.join(', ')}): ` +
        'exporter restart or a scrape from another task; no window to measure',
      counters
    }
  }

  const compareDelta = delta('compare')
  const diffDelta = delta('diff')
  const sign = first ? '' : '+'
  const perKind = (prefix) => KINDS.map((kind) => `${kind}=${sign}${delta(`${prefix}.${kind}`)}`).join(' ')

  const notes = joinNotes([
    // The distinction WP2's compare counter exists to make: a flat compare count is a shadow that
    // never ran, which is not the same fact as the two sources agreeing.
    compareDelta === 0 ? NO_COMPARISONS : undefined,
    (first ? 'first run: ' : '') +
      `diffAddresses=${sign}${diffDelta} (${perKind('diff')}); ` +
      `compares=${sign}${compareDelta} (${perKind('compare')})`,
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

  const text = await fetchText(metricsUrl, { headers: authHeaders(env, 'GATEKEEPER_METRICS_URL') })
  const result = compareSceneParticipants({
    text,
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
    writeState(outDir, DIFF, envLabel, { at, counters: result.counters })
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
  writeState(outDir, DIFF, envLabel, { at, counters: result.counters })
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
