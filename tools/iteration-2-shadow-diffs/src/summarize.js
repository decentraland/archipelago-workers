'use strict'

// `summarize` aggregates a diff's .jsonl over a window into the same report shape plus `runs` and
// `runsWithinTolerance`, and prints a Markdown table ready to paste into the migration plan's
// Notion page. This is what the "7 days of shadow traffic within tolerance" gate is read from.

const fs = require('node:fs')
const path = require('node:path')

const {
  DEFAULT_MAX_DISAGREE_RATIO,
  DIFF_NAMES,
  disagreeCount,
  disagreeRatio,
  percent,
  resolveOutDir,
  withinTolerance
} = require('./report')
const { clampNotes } = require('./notes')

const DEFAULT_WINDOW_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

// The documented cron interval (README). Used only to say how many runs a full window would have
// produced: gate step 1 is "runs consistent with the cron interval", and counting 2 016 by eye is
// how a two-day outage gets signed off as a clean week.
const DEFAULT_INTERVAL_MINUTES = 5

// Below this share of the expected runs, `notes` calls out the gap. Not a verdict: a cron that
// started mid-window is a normal reason to be short, and the reader is the one who knows.
const RUN_GAP_THRESHOLD = 0.9

const expectedRuns = (windowDays, intervalMinutes) =>
  intervalMinutes > 0 ? Math.floor((windowDays * 24 * 60) / intervalMinutes) : 0

const assertKnownDiff = (diff) => {
  if (typeof diff !== 'string' || diff === '') {
    throw new Error(`a diff name is required; expected one of ${DIFF_NAMES.join(', ')}`)
  }
  if (!DIFF_NAMES.includes(diff)) {
    throw new Error(`unknown diff "${diff}"; expected one of ${DIFF_NAMES.join(', ')}`)
  }
}

const readJsonl = (dir, diff) => {
  let text
  try {
    text = fs.readFileSync(path.join(dir, `${diff}.jsonl`), 'utf8')
  } catch {
    return []
  }
  const lines = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') {
      continue
    }
    try {
      // A cron killed mid-append leaves a truncated last line; it is one lost run, not a failure.
      lines.push(JSON.parse(line))
    } catch {
      continue
    }
  }
  return lines
}

const toCount = (value) => {
  const count = Number(value)
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0
}

const inWindow = (line, since) => {
  const at = Date.parse(line.at)
  // An unparseable timestamp cannot be placed in the window, so it is not in it.
  // A run slightly in the future is a clock skew on the cron host, not a reason to drop it.
  return Number.isFinite(at) && at >= since
}

const selectRuns = (lines, { diff, now, windowDays, env }) => {
  const since = now.getTime() - windowDays * DAY_MS
  return lines.filter(
    (line) =>
      line !== null &&
      typeof line === 'object' &&
      line.diff === diff &&
      (env === undefined || line.env === env) &&
      inWindow(line, since)
  )
}

const summarize = (lines, options = {}) => {
  const diff = options.diff
  assertKnownDiff(diff)
  const now = options.now ?? new Date()
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS
  const intervalMinutes = options.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES
  const runs = selectRuns(lines, { diff, now, windowDays, env: options.env })
  const since = new Date(now.getTime() - windowDays * DAY_MS).toISOString()
  const expected = expectedRuns(windowDays, intervalMinutes)

  const totals = { sampleSize: 0, agree: 0, onlyLegacy: 0, onlyPulse: 0 }
  const explainedBy = []
  const envs = []
  let strictest = DEFAULT_MAX_DISAGREE_RATIO
  let mixedTolerance = false
  let runsWithinTolerance = 0
  let seenTolerance

  for (const run of runs) {
    totals.sampleSize += toCount(run.sampleSize)
    totals.agree += toCount(run.agree)
    totals.onlyLegacy += toCount(run.onlyLegacy)
    totals.onlyPulse += toCount(run.onlyPulse)
    if (run.withinTolerance === true) {
      runsWithinTolerance += 1
    }
    for (const reason of Array.isArray(run.explainedBy) ? run.explainedBy : []) {
      if (typeof reason === 'string' && !explainedBy.includes(reason)) {
        explainedBy.push(reason)
      }
    }
    if (typeof run.env === 'string' && !envs.includes(run.env)) {
      envs.push(run.env)
    }
    const ratio = run.tolerance && Number(run.tolerance.maxDisagreeRatio)
    if (Number.isFinite(ratio)) {
      if (seenTolerance !== undefined && ratio !== seenTolerance) {
        mixedTolerance = true
      }
      seenTolerance = seenTolerance === undefined ? ratio : Math.min(seenTolerance, ratio)
    }
  }
  if (seenTolerance !== undefined) {
    strictest = seenTolerance
  }

  const tolerance = { maxDisagreeRatio: strictest }
  const notes = clampNotes(
    [
      runs.length === 0
        ? `no runs in the ${windowDays} d window since ${since}`
        : `${runs.length} ${runs.length === 1 ? 'run' : 'runs'} in the ${windowDays} d window since ${since}`,
      `${runsWithinTolerance}/${runs.length} within their own tolerance`,
      // Runs happened and none of them sampled anything: the sources were silent, or a filter or a
      // shadow never matched. That is not a clean window, and `withinTolerance` says so too.
      runs.length > 0 && totals.sampleSize === 0
        ? 'no samples in the window: nothing was compared, so this is not agreement'
        : undefined,
      // Gate step 1, computed instead of eyeballed. A skipped diff-1 run (counter reset) and a dead
      // cron both land here, and the cron log's SKIPPED lines tell them apart.
      runs.length > 0 && expected > 0 && runs.length < expected * RUN_GAP_THRESHOLD
        ? `run gap: ${runs.length} of ~${expected} expected at ${intervalMinutes} min`
        : undefined,
      mixedTolerance ? `mixed tolerance across the window, strictest kept (${strictest})` : undefined
    ]
      .filter((part) => part !== undefined)
      .join('; ')
  )

  return {
    diff,
    at: now.toISOString(),
    env: options.env ?? (envs.length > 0 ? envs.join('+') : 'none'),
    sampleSize: totals.sampleSize,
    agree: totals.agree,
    onlyLegacy: totals.onlyLegacy,
    onlyPulse: totals.onlyPulse,
    tolerance,
    // The window verdict is recomputed from the summed counts: a per-run flag cannot see that a
    // string of small breaches adds up, nor that one bad run is noise in a big window.
    withinTolerance: withinTolerance({ sampleSize: totals.sampleSize, agree: totals.agree, tolerance }),
    explainedBy,
    notes,
    runs: runs.length,
    runsWithinTolerance
  }
}

// One aggregate per environment, in the order the environments first appear in the window.
const summarizeByEnv = (lines, options = {}) => {
  const diff = options.diff
  assertKnownDiff(diff)
  const now = options.now ?? new Date()
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS
  const envs = []
  for (const run of selectRuns(lines, { diff, now, windowDays, env: options.env })) {
    if (typeof run.env === 'string' && !envs.includes(run.env)) {
      envs.push(run.env)
    }
  }
  return envs.map((env) => summarize(lines, { ...options, diff, now, windowDays, env }))
}

const COLUMNS = [
  'env',
  'runs',
  'runs within tolerance',
  'sample',
  'agree',
  'onlyLegacy',
  'onlyPulse',
  'disagree',
  'tolerance',
  'verdict'
]

const toMarkdownTable = (rows, options = {}) => {
  const diff = options.diff
  const now = options.now ?? new Date()
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS
  const title = `**${diff}** — ${windowDays} d window ending ${now.toISOString()}`

  if (rows.length === 0) {
    return `${title}\n\n_no runs in the window_`
  }

  const body = rows.map((row) =>
    [
      row.env,
      String(row.runs),
      `${row.runsWithinTolerance}/${row.runs}`,
      String(row.sampleSize),
      String(row.agree),
      String(row.onlyLegacy),
      String(row.onlyPulse),
      `${disagreeCount(row)} (${percent(disagreeRatio(row))})`,
      percent(row.tolerance.maxDisagreeRatio),
      // Nothing was sampled, so there is no verdict to print: `OUT` would read as a measured
      // disagreement and `within` as measured agreement. Neither happened.
      row.sampleSize === 0 ? 'no data' : row.withinTolerance ? 'within' : 'OUT'
    ].join(' | ')
  )

  // No alignment colons: the separator row stays plain `---` cells.
  return [
    title,
    '',
    `| ${COLUMNS.join(' | ')} |`,
    `| ${COLUMNS.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row} |`)
  ].join('\n')
}

const parseArgs = (argv) => {
  const positional = []
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--window-days') {
      const raw = argv[i + 1]
      const value = Number(raw)
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`--window-days must be a positive number, got "${raw}"`)
      }
      options.windowDays = value
      i += 1
    } else if (arg === '--interval-minutes') {
      const raw = argv[i + 1]
      const value = Number(raw)
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`--interval-minutes must be a positive number, got "${raw}"`)
      }
      options.intervalMinutes = value
      i += 1
    } else if (arg === '--env') {
      options.env = argv[i + 1]
      i += 1
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option "${arg}"`)
    } else {
      positional.push(arg)
    }
  }
  return { diff: positional[0], ...options }
}

const resolveIntervalMinutes = (env = {}) => {
  const raw = env.CRON_INTERVAL_MINUTES
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_INTERVAL_MINUTES
  }
  const value = Number(String(raw).trim())
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`CRON_INTERVAL_MINUTES must be a positive number, got "${raw}"`)
  }
  return value
}

const runSummarize = ({ argv = [], env = {}, now = () => new Date(), out = console.log } = {}) => {
  const parsed = parseArgs(argv)
  assertKnownDiff(parsed.diff)

  const at = now()
  const windowDays = parsed.windowDays ?? DEFAULT_WINDOW_DAYS
  const lines = readJsonl(resolveOutDir(env), parsed.diff)
  const scope = {
    diff: parsed.diff,
    now: at,
    windowDays,
    env: parsed.env,
    intervalMinutes: parsed.intervalMinutes ?? resolveIntervalMinutes(env)
  }

  const aggregate = summarize(lines, scope)
  const table = toMarkdownTable(summarizeByEnv(lines, scope), scope)

  out(JSON.stringify(aggregate))
  out('')
  out(table)
  return { aggregate, table }
}

module.exports = {
  COLUMNS,
  DAY_MS,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_WINDOW_DAYS,
  expectedRuns,
  parseArgs,
  readJsonl,
  runSummarize,
  summarize,
  summarizeByEnv,
  toMarkdownTable
}
