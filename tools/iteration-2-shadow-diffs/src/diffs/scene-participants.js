'use strict'

// Diff 1 -- LiveKit vs the presence map, read off comms-gatekeeper's own counters. The service
// already compares the two answers per request and increments `presence_shadow_diff{kind=land|world}`
// by the size of the symmetric difference, so this diff scrapes `/metrics` and subtracts the
// previous scrape (state file) to get "diff count / request count since the last run".
//
// The counter cannot say which side an address was missing from, so `onlyLegacy` and `onlyPulse`
// stay 0 here and the raw difference count goes in the notes.

const { fetchText: defaultFetchText, requireEnv } = require('../http')
const { counterDelta, hasSeries, parseLabelFilter, parsePrometheusText, sumSeries } = require('../prometheus')
const { joinNotes } = require('../notes')
const { finishRun } = require('../finish-run')
const { resolveEnvLabel, resolveOutDir } = require('../report')
const { readState, writeState } = require('../state')

const DIFF = 'scene-participants'

const DEFAULT_DIFF_METRIC = 'presence_shadow_diff'
const DEFAULT_REQUESTS_METRIC = 'http_requests_total'
const DEFAULT_REQUESTS_LABELS = 'handler=/scene-participants'

const EXPLAINED_BY = [
  'no-comms peers visible to Pulse',
  '<= 2 s batching',
  'the ban filter is applied to the presence-map answer only'
]

const KINDS = ['land', 'world']

const compareSceneParticipants = ({ text, previous, diffMetric, requestsMetric, requestsLabelFilter }) => {
  const samples = parsePrometheusText(text)

  // A page with no request counter means the metric name or the label filter is wrong. Reading that
  // as "no traffic" would report a clean empty sample every run, forever.
  if (!hasSeries(samples, requestsMetric)) {
    throw new Error(`${requestsMetric} is not exported by the scraped /metrics page`)
  }

  // The diff counter is absent until the first disagreement, which is a real zero, not an error.
  const counters = {
    diff: sumSeries(samples, diffMetric),
    requests: sumSeries(samples, requestsMetric, requestsLabelFilter)
  }
  for (const kind of KINDS) {
    counters[`diff.${kind}`] = sumSeries(samples, diffMetric, { kind })
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

  const requestsDelta = delta('requests')
  const diffDelta = delta('diff')
  const sign = first ? '' : '+'

  const notes = joinNotes([
    (first ? 'first run: ' : '') +
      `diffAddresses=${sign}${diffDelta} ` +
      KINDS.map((kind) => `${kind}=${sign}${delta(`diff.${kind}`)}`).join(' ') +
      ` requests=${sign}${requestsDelta}`,
    'counter-based: the direction of each difference is not observable'
  ])

  return {
    sampleSize: requestsDelta,
    // One request can disagree about several addresses, so the difference count can exceed the
    // request count; the ratio is then >= 1 and the run is out of tolerance, which is the point.
    agree: Math.max(0, requestsDelta - diffDelta),
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

  const text = await fetchText(metricsUrl)
  const result = compareSceneParticipants({
    text,
    previous: readState(outDir, DIFF, envLabel),
    diffMetric: env.SHADOW_DIFF_METRIC ?? DEFAULT_DIFF_METRIC,
    requestsMetric: env.SHADOW_REQUESTS_METRIC ?? DEFAULT_REQUESTS_METRIC,
    requestsLabelFilter: parseLabelFilter(env.SHADOW_REQUESTS_LABELS ?? DEFAULT_REQUESTS_LABELS)
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
  DEFAULT_DIFF_METRIC,
  DEFAULT_REQUESTS_LABELS,
  DEFAULT_REQUESTS_METRIC,
  DIFF,
  EXPLAINED_BY,
  compareSceneParticipants,
  run
}
