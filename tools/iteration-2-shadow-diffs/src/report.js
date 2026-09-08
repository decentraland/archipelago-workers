'use strict'

// The one report shape every shadow diff writes, and the tolerance arithmetic behind
// `withinTolerance`. Nothing in here ever sees a wallet address: a diff hands over counts and a
// notes string it built itself.

const fs = require('node:fs')
const path = require('node:path')

const DIFF_NAMES = ['scene-participants', 'live-data', 'online-set', 'hot-scenes']

const DEFAULT_MAX_DISAGREE_RATIO = 0.05

// The report keys, in the order the brief prints them. Object key order is part of the format:
// the .jsonl lines are read by eye as often as by a parser.
const REPORT_KEYS = [
  'diff',
  'at',
  'env',
  'sampleSize',
  'agree',
  'onlyLegacy',
  'onlyPulse',
  'tolerance',
  'withinTolerance',
  'explainedBy',
  'notes'
]

// Slack for the float64 error in `maxDisagreeRatio * sampleSize`: 0.05 * 200 is 10.000000000000002
// and 3 / 60 is 0.049999999999999996, so an exact boundary must not read as a breach either way.
const RATIO_EPSILON = 1e-9

const assertCount = (name, value) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${value}`)
  }
}

const assertTolerance = (tolerance) => {
  const ratio = tolerance && tolerance.maxDisagreeRatio
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error(`tolerance.maxDisagreeRatio must be a number in [0, 1], got ${ratio}`)
  }
}

const disagreeCount = ({ sampleSize, agree }) => sampleSize - agree

const disagreeRatio = ({ sampleSize, agree }) => (sampleSize === 0 ? 0 : disagreeCount({ sampleSize, agree }) / sampleSize)

// An empty sample is NEVER within tolerance. Nothing was compared, so nothing agreed: a 0/0 run is
// an absence of evidence, and the cut-over gate is read off this flag. Answering `true` here is how
// a week of "the shadow never ran" (diff 1 with a flat compare counter, a label filter that matches
// nothing, a source that answers nothing) reads as a clean week. `notes` says why the sample is
// empty; the Markdown table shows such a row as "no data" rather than as a verdict.
const withinTolerance = ({ sampleSize, agree, tolerance }) => {
  if (sampleSize === 0) {
    return false
  }
  const disagree = disagreeCount({ sampleSize, agree })
  if (disagree <= 0) {
    return true
  }
  return disagree <= tolerance.maxDisagreeRatio * sampleSize + RATIO_EPSILON
}

const buildReportLine = (input) => {
  if (!DIFF_NAMES.includes(input.diff)) {
    throw new Error(`unknown diff "${input.diff}"; expected one of ${DIFF_NAMES.join(', ')}`)
  }
  if (typeof input.at !== 'string' || input.at.length === 0) {
    throw new Error('at must be an ISO-8601 timestamp string')
  }
  if (typeof input.env !== 'string' || input.env.length === 0) {
    throw new Error('env must be a non-empty string')
  }
  assertCount('sampleSize', input.sampleSize)
  assertCount('agree', input.agree)
  assertCount('onlyLegacy', input.onlyLegacy)
  assertCount('onlyPulse', input.onlyPulse)
  if (input.agree > input.sampleSize) {
    throw new Error(`agree (${input.agree}) cannot exceed sampleSize (${input.sampleSize})`)
  }
  const accounted = input.agree + input.onlyLegacy + input.onlyPulse
  if (accounted > input.sampleSize) {
    throw new Error(
      `agree + onlyLegacy + onlyPulse (${accounted}) cannot exceed sampleSize (${input.sampleSize}): ` +
        `onlyLegacy=${input.onlyLegacy} onlyPulse=${input.onlyPulse}`
    )
  }
  assertTolerance(input.tolerance)
  if (!Array.isArray(input.explainedBy) || input.explainedBy.some((entry) => typeof entry !== 'string')) {
    throw new Error('explainedBy must be an array of strings')
  }
  if (typeof input.notes !== 'string') {
    throw new Error('notes must be a string')
  }

  const line = {
    diff: input.diff,
    at: input.at,
    env: input.env,
    sampleSize: input.sampleSize,
    agree: input.agree,
    onlyLegacy: input.onlyLegacy,
    onlyPulse: input.onlyPulse,
    tolerance: { maxDisagreeRatio: input.tolerance.maxDisagreeRatio },
    withinTolerance: withinTolerance(input),
    explainedBy: [...input.explainedBy],
    notes: input.notes
  }
  // Cheap guard against a future edit reordering the shape the consumers read.
  const keys = Object.keys(line)
  if (keys.length !== REPORT_KEYS.length || keys.some((key, i) => key !== REPORT_KEYS[i])) {
    throw new Error(`report key order drifted: ${keys.join(',')}`)
  }
  return line
}

const envVarFor = (diff) => `MAX_DISAGREE_RATIO_${diff.toUpperCase().replace(/-/g, '_')}`

const readRatio = (env, name) => {
  const raw = env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return undefined
  }
  const value = Number(String(raw).trim())
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number in [0, 1], got "${raw}"`)
  }
  return value
}

const resolveTolerance = (diff, env = {}) => {
  if (!DIFF_NAMES.includes(diff)) {
    throw new Error(`unknown diff "${diff}"; expected one of ${DIFF_NAMES.join(', ')}`)
  }
  const perDiff = readRatio(env, envVarFor(diff))
  const global = readRatio(env, 'MAX_DISAGREE_RATIO')
  return { maxDisagreeRatio: perDiff ?? global ?? DEFAULT_MAX_DISAGREE_RATIO }
}

const resolveOutDir = (env = {}) =>
  env.OUT_DIR && String(env.OUT_DIR).trim() !== '' ? env.OUT_DIR : path.join(__dirname, '..', 'out')

const resolveEnvLabel = (env = {}) => (env.SHADOW_DIFF_ENV && String(env.SHADOW_DIFF_ENV).trim() !== '' ? env.SHADOW_DIFF_ENV : 'zone')

const appendReportLine = (dir, line) => {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${line.diff}.jsonl`)
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8')
  return file
}

const percent = (ratio) => `${(ratio * 100).toFixed(2)}%`

const formatHumanSummary = (line) => {
  // A zero-sample run has no verdict to print: "OUT OF TOLERANCE" would read as a disagreement
  // that was measured, and the whole point is that nothing was.
  const verdict = line.sampleSize === 0 ? 'NO DATA' : line.withinTolerance ? 'WITHIN TOLERANCE' : 'OUT OF TOLERANCE'
  const rows = [
    `[${line.diff}] env=${line.env} at=${line.at} ${verdict}`,
    `  sample=${line.sampleSize} agree=${line.agree} onlyLegacy=${line.onlyLegacy} onlyPulse=${line.onlyPulse}` +
      ` disagree=${disagreeCount(line)} (${percent(disagreeRatio(line))}) allowed=${percent(line.tolerance.maxDisagreeRatio)}`
  ]
  if (line.explainedBy && line.explainedBy.length > 0) {
    rows.push(`  explainedBy: ${line.explainedBy.join('; ')}`)
  }
  if (line.notes) {
    rows.push(`  notes: ${line.notes}`)
  }
  return rows.join('\n')
}

module.exports = {
  DEFAULT_MAX_DISAGREE_RATIO,
  DIFF_NAMES,
  REPORT_KEYS,
  appendReportLine,
  buildReportLine,
  disagreeCount,
  disagreeRatio,
  envVarFor,
  formatHumanSummary,
  percent,
  resolveEnvLabel,
  resolveOutDir,
  resolveTolerance,
  withinTolerance
}
