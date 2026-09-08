'use strict'

// Just enough Prometheus text parsing for diff 1. Counters only, no histograms, no exemplars:
// the harness reads two counters off the gatekeeper `/metrics` page and subtracts the previous
// scrape. Written by hand so the harness stays dependency-free.

// name{label="value",...} value [timestamp]
const SERIES = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?[ \t]+(.+)$/
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"/g
// `# HELP <name> …` / `# TYPE <name> <type>` — the only evidence a page gives that a metric exists
// but has never been incremented. prom-client emits both for every registered metric, and no sample
// line for a labelled counter until its first `inc()`, so this is what separates "this task has not
// compared yet" from "the metric name is wrong". Both spellings, with or without the space after
// `#`; a comment that is not HELP/TYPE, or one with no metric name, declares nothing.
const META = /^#[ \t]*(?:HELP|TYPE)[ \t]+([a-zA-Z_:][a-zA-Z0-9_:]*)(?:[ \t]|$)/

const unescapeLabelValue = (raw) => raw.replace(/\\(["\\n])/g, (_, ch) => (ch === 'n' ? '\n' : ch))

const parseLabels = (raw) => {
  const labels = {}
  if (!raw) {
    return labels
  }
  LABEL.lastIndex = 0
  let match
  while ((match = LABEL.exec(raw)) !== null) {
    labels[match[1]] = unescapeLabelValue(match[2])
  }
  return labels
}

// One scraped page: its sample lines, and the names of every metric it *declares* via HELP/TYPE.
// The two are different facts. A counter with `labelNames` publishes no sample line until its first
// increment, so a task that has not performed a single shadow comparison declares the counter and
// samples nothing — which is a zero for that window, not a missing metric.
const parseMetricPage = (text) => {
  const samples = []
  const declared = new Set()
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (line === '') {
      continue
    }
    if (line.startsWith('#')) {
      const meta = META.exec(line)
      if (meta !== null) {
        declared.add(meta[1])
      }
      continue
    }
    const match = SERIES.exec(line)
    if (!match) {
      continue
    }
    // The value is the first whitespace-separated token; anything after it is the scrape timestamp.
    const value = Number(match[3].trim().split(/[ \t]+/)[0])
    if (!Number.isFinite(value)) {
      // NaN, +Inf and -Inf carry no count we can subtract; skip the series rather than poison a sum.
      continue
    }
    samples.push({ name: match[1], labels: parseLabels(match[2]), value })
  }
  return { samples, declared }
}

// The samples alone, for the callers that do not care what else the page declares.
const parsePrometheusText = (text) => parseMetricPage(text).samples

const matchesLabels = (sample, filter) =>
  Object.entries(filter).every(([key, value]) => sample.labels[key] === String(value))

const sumSeries = (samples, name, filter = {}) =>
  samples.reduce(
    (total, sample) => (sample.name === name && matchesLabels(sample, filter) ? total + sample.value : total),
    0
  )

// Name AND labels: a sum of 0 cannot tell "nothing happened" from "the filter matches no series at
// all", and only the second is a configuration error. Callers use this to fail loudly on a drifted
// label value instead of publishing a clean empty sample every run.
const hasSeries = (samples, name, filter = {}) =>
  samples.some((sample) => sample.name === name && matchesLabels(sample, filter))

// `handler=/scene-participants,code=200` -> { handler: '/scene-participants', code: '200' }.
// Quotes are optional; a label value containing a comma cannot be expressed here (drop that label
// from the filter and let the sum cover it instead).
const parseLabelFilter = (raw) => {
  const text = String(raw ?? '').trim()
  if (text === '') {
    return {}
  }
  const filter = {}
  for (const pair of text.split(',')) {
    const entry = pair.trim()
    if (entry === '') {
      continue
    }
    const eq = entry.indexOf('=')
    if (eq <= 0) {
      throw new Error(`label filter must be key=value pairs, got "${entry}"`)
    }
    const key = entry.slice(0, eq).trim()
    const value = entry
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1')
    filter[key] = value
  }
  return filter
}

// The delta since the previous scrape, or `undefined` when there is no measurable window.
//
// A counter that went backwards means this scrape and the previous one did not come from the same
// process lifetime: the exporter restarted, or the scrape landed on another task. Taking the whole
// current value there would publish a lifetime counter as one five-minute window — a huge sample at
// the service's lifetime ratio, which reads green and is fiction. The caller must skip the run
// instead; `undefined` is what says so.
const counterDelta = (current, previous) => {
  if (previous === undefined || previous === null || !Number.isFinite(Number(previous))) {
    return current
  }
  return current < previous ? undefined : current - previous
}

// One scrape URL per gatekeeper task, comma-separated. Scraping a service through its load
// balancer is not supported and cannot be made to work with counter deltas: successive scrapes land
// on different tasks, whose lifetime counters are unrelated numbers, so half the runs read as a
// restart and the rest as an inflated jump. Point the harness at the task addresses (or at one
// Prometheus page that federates their raw per-instance series -- see the README) instead.
const parseScrapeUrls = (raw) => {
  const urls = []
  for (const part of String(raw ?? '').split(',')) {
    const url = part.trim()
    // A repeated entry is an env-file typo, and counting one task twice would double its traffic.
    if (url !== '' && !urls.includes(url)) {
      urls.push(url)
    }
  }
  if (urls.length === 0) {
    throw new Error('at least one scrape URL is required')
  }
  return urls
}

// Per-target counter state: `{ '<url>': { '<counter>': value } }` for this scrape and the previous
// one. Each target is subtracted against its own previous scrape and the deltas are summed, so a
// service with several tasks is measured once, not once per lifetime.
//
// Targets that cannot be subtracted are named rather than guessed at: `newTargets` had no previous
// scrape (a task that just scaled up, so its lifetime is short and its whole counter is close
// enough to the window), `wentBackwards` moved down (a restart, or the same address answering from
// a different process) and contributes nothing.
const sumCounterDeltas = (current, previous) => {
  const deltas = {}
  const newTargets = []
  const wentBackwards = []

  for (const [url, counters] of Object.entries(current)) {
    const raw = previous === undefined || previous === null ? undefined : previous[url]
    const before = raw !== null && typeof raw === 'object' ? raw : undefined
    if (before === undefined) {
      newTargets.push(url)
    }

    const measured = {}
    let backwards = false
    for (const [key, value] of Object.entries(counters)) {
      const delta = counterDelta(value, before === undefined ? undefined : before[key])
      if (delta === undefined) {
        backwards = true
        break
      }
      measured[key] = delta
    }
    if (backwards) {
      wentBackwards.push(url)
      continue
    }
    for (const [key, delta] of Object.entries(measured)) {
      deltas[key] = (deltas[key] ?? 0) + delta
    }
  }

  return { deltas, newTargets, wentBackwards }
}

module.exports = {
  counterDelta,
  hasSeries,
  parseLabelFilter,
  parseMetricPage,
  parsePrometheusText,
  parseScrapeUrls,
  sumCounterDeltas,
  sumSeries
}
