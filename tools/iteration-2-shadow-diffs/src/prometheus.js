'use strict'

// Just enough Prometheus text parsing for diff 1. Counters only, no histograms, no exemplars:
// the harness reads two counters off the gatekeeper `/metrics` page and subtracts the previous
// scrape. Written by hand so the harness stays dependency-free.

// name{label="value",...} value [timestamp]
const SERIES = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?[ \t]+(.+)$/
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"/g

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

const parsePrometheusText = (text) => {
  const samples = []
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (line === '' || line.startsWith('#')) {
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
  return samples
}

const matchesLabels = (sample, filter) =>
  Object.entries(filter).every(([key, value]) => sample.labels[key] === String(value))

const sumSeries = (samples, name, filter = {}) =>
  samples.reduce(
    (total, sample) => (sample.name === name && matchesLabels(sample, filter) ? total + sample.value : total),
    0
  )

const hasSeries = (samples, name) => samples.some((sample) => sample.name === name)

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

// A counter that went backwards means the exporter restarted, so everything it now reports has
// accumulated since the last run: take the whole value.
const counterDelta = (current, previous) => {
  if (previous === undefined || previous === null || !Number.isFinite(Number(previous))) {
    return current
  }
  return current < previous ? current : current - previous
}

module.exports = { counterDelta, hasSeries, parseLabelFilter, parsePrometheusText, sumSeries }
