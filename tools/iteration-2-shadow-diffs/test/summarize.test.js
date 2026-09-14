'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test, describe } = require('node:test')

const { DEFAULT_WINDOW_DAYS, readJsonl, runSummarize, summarize, summarizeByEnv, toMarkdownTable } = require('../src/summarize')

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-09-05T10:00:00.000Z')

const runLine = (overrides = {}) => ({
  diff: 'live-data',
  at: NOW.toISOString(),
  env: 'zone',
  sampleSize: 40,
  agree: 39,
  onlyLegacy: 1,
  onlyPulse: 0,
  tolerance: { maxDisagreeRatio: 0.05 },
  withinTolerance: true,
  explainedBy: ['no-comms peers visible to Pulse'],
  notes: '',
  ...overrides
})

const daysAgo = (days) => new Date(NOW.getTime() - days * DAY).toISOString()

const withTempDir = (body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-diff-'))
  try {
    return body(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('summarize', () => {
  test('the default window is 7 days', () => {
    assert.equal(DEFAULT_WINDOW_DAYS, 7)
  })

  test('aggregates into the same shape plus runs and runsWithinTolerance', () => {
    const lines = [runLine({ at: daysAgo(1) }), runLine({ at: daysAgo(2) })]
    const aggregate = summarize(lines, { diff: 'live-data', now: NOW })

    assert.deepEqual(Object.keys(aggregate), [
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
      'notes',
      'runs',
      'runsWithinTolerance'
    ])
    assert.equal(aggregate.diff, 'live-data')
    assert.equal(aggregate.at, NOW.toISOString())
    assert.equal(aggregate.env, 'zone')
    assert.equal(aggregate.sampleSize, 80)
    assert.equal(aggregate.agree, 78)
    assert.equal(aggregate.onlyLegacy, 2)
    assert.equal(aggregate.onlyPulse, 0)
    assert.equal(aggregate.runs, 2)
    assert.equal(aggregate.runsWithinTolerance, 2)
    assert.equal(aggregate.withinTolerance, true)
  })

  test('the window verdict comes from the summed counts, not from the per-run flags', () => {
    // Both runs claim they were within tolerance; 10 of 100 says otherwise.
    const lines = [
      runLine({ sampleSize: 100, agree: 90, onlyLegacy: 10, onlyPulse: 0, withinTolerance: true }),
      runLine({ sampleSize: 100, agree: 90, onlyLegacy: 10, onlyPulse: 0, withinTolerance: true })
    ]
    const aggregate = summarize(lines, { diff: 'live-data', now: NOW })
    assert.equal(aggregate.runs, 2)
    assert.equal(aggregate.runsWithinTolerance, 2, 'counted from the per-run flags')
    assert.equal(aggregate.withinTolerance, false, '20 of 200 is outside 5%')
  })

  test('runsWithinTolerance counts the runs, so one bad run does not sink a big window', () => {
    const mixed = summarize(
      [
        runLine({ sampleSize: 1000, agree: 1000, onlyLegacy: 0, onlyPulse: 0 }),
        runLine({ sampleSize: 20, agree: 15, onlyLegacy: 5, onlyPulse: 0, withinTolerance: false })
      ],
      { diff: 'live-data', now: NOW }
    )
    assert.equal(mixed.runs, 2)
    assert.equal(mixed.runsWithinTolerance, 1)
    assert.equal(mixed.withinTolerance, true, '5 of 1020 is inside 5%')
  })

  test('drops runs older than the window and keeps the boundary run', () => {
    const lines = [
      runLine({ at: daysAgo(7) }),
      runLine({ at: new Date(NOW.getTime() - 7 * DAY - 1).toISOString() }),
      runLine({ at: daysAgo(0) })
    ]
    const aggregate = summarize(lines, { diff: 'live-data', now: NOW })
    assert.equal(aggregate.runs, 2)
  })

  test('the window length is overridable', () => {
    const lines = [runLine({ at: daysAgo(1) }), runLine({ at: daysAgo(3) })]
    assert.equal(summarize(lines, { diff: 'live-data', now: NOW, windowDays: 2 }).runs, 1)
    assert.equal(summarize(lines, { diff: 'live-data', now: NOW, windowDays: 30 }).runs, 2)
  })

  test('a run whose clock is slightly ahead is kept', () => {
    const lines = [runLine({ at: new Date(NOW.getTime() + 60_000).toISOString() })]
    assert.equal(summarize(lines, { diff: 'live-data', now: NOW }).runs, 1)
  })

  test('runs for another diff are ignored', () => {
    const lines = [runLine(), runLine({ diff: 'hot-scenes' })]
    assert.equal(summarize(lines, { diff: 'live-data', now: NOW }).runs, 1)
  })

  test('an env filter narrows the window', () => {
    const lines = [runLine({ env: 'zone' }), runLine({ env: 'org' })]
    assert.equal(summarize(lines, { diff: 'live-data', now: NOW }).env, 'zone+org')
    assert.equal(summarize(lines, { diff: 'live-data', now: NOW, env: 'org' }).runs, 1)
    assert.equal(summarize(lines, { diff: 'live-data', now: NOW, env: 'org' }).env, 'org')
  })

  test('an empty window is reported as zero runs, never NaN, and never within tolerance', () => {
    const aggregate = summarize([], { diff: 'live-data', now: NOW })
    assert.equal(aggregate.runs, 0)
    assert.equal(aggregate.sampleSize, 0)
    assert.equal(aggregate.withinTolerance, false, 'no runs is not a clean week')
    assert.match(aggregate.notes, /no runs/i)
  })

  test('a window of empty samples is never within tolerance, whatever the runs claimed', () => {
    // The window-level half of the same failure: 2016 runs that each sampled nothing must not
    // aggregate into a green week. `withinTolerance: true` on the runs is what a line written
    // before this rule looks like, and the window verdict is recomputed, so it does not survive.
    const empty = { sampleSize: 0, agree: 0, onlyLegacy: 0, onlyPulse: 0, withinTolerance: true }
    const aggregate = summarize([runLine(empty), runLine(empty)], { diff: 'live-data', now: NOW })

    assert.equal(aggregate.runs, 2)
    assert.equal(aggregate.sampleSize, 0)
    assert.equal(aggregate.runsWithinTolerance, 2, 'the per-run flags are reported as they were written')
    assert.equal(aggregate.withinTolerance, false, 'but the window verdict is not agreement')
    assert.match(aggregate.notes, /no samples in the window/i)
  })

  test('the union of the explanations is kept, in first-seen order and without repeats', () => {
    const lines = [
      runLine({ explainedBy: ['a', 'b'] }),
      runLine({ explainedBy: ['b', 'c'] })
    ]
    assert.deepEqual(summarize(lines, { diff: 'live-data', now: NOW }).explainedBy, ['a', 'b', 'c'])
  })

  test('a window with mixed tolerances takes the strictest and says so', () => {
    const lines = [runLine(), runLine({ tolerance: { maxDisagreeRatio: 0.01 } })]
    const aggregate = summarize(lines, { diff: 'live-data', now: NOW })
    assert.deepEqual(aggregate.tolerance, { maxDisagreeRatio: 0.01 })
    assert.match(aggregate.notes, /mixed tolerance/i)
  })

  test('a window with far fewer runs than the cron would produce says so', () => {
    // Gate step 1 is "runs consistent with the cron interval". windowDays plus the interval are
    // enough to compute the expected count, so the reader is not left counting by eye.
    const lines = [runLine({ at: daysAgo(1) }), runLine({ at: daysAgo(2) })]
    const aggregate = summarize(lines, { diff: 'live-data', now: NOW, intervalMinutes: 5 })

    assert.match(aggregate.notes, /run gap/i)
    assert.match(aggregate.notes, /2016/, 'the expected count for a 7 d window at 5 min')
  })

  test('a window whose runs match the interval says nothing about a gap', () => {
    const lines = [runLine({ at: daysAgo(1) }), runLine({ at: daysAgo(2) })]
    // Two runs are exactly what a 3.5-day interval produces over 7 days.
    const aggregate = summarize(lines, { diff: 'live-data', now: NOW, intervalMinutes: 7 * 24 * 30 })

    assert.doesNotMatch(aggregate.notes, /run gap/i)
  })

  test('the notes name the window and the run count', () => {
    const aggregate = summarize([runLine({ at: daysAgo(1) })], { diff: 'live-data', now: NOW })
    assert.match(aggregate.notes, /1 run/)
    assert.match(aggregate.notes, /7 d/)
    assert.match(aggregate.notes, /2026-08-29T10:00:00\.000Z/)
  })
})

describe('summarizeByEnv', () => {
  test('one aggregate per env, in first-seen order', () => {
    const lines = [runLine({ env: 'zone' }), runLine({ env: 'org' }), runLine({ env: 'zone' })]
    const rows = summarizeByEnv(lines, { diff: 'live-data', now: NOW })
    assert.deepEqual(
      rows.map((row) => [row.env, row.runs]),
      [
        ['zone', 2],
        ['org', 1]
      ]
    )
  })
})

describe('the Markdown table', () => {
  test('renders a header, a separator and one row per env', () => {
    const rows = summarizeByEnv([runLine({ env: 'zone' }), runLine({ env: 'org', withinTolerance: false, agree: 30, onlyLegacy: 10 })], {
      diff: 'live-data',
      now: NOW
    })
    const table = toMarkdownTable(rows, { diff: 'live-data', now: NOW, windowDays: 7 })
    const lines = table.split('\n').filter((line) => line.startsWith('|'))

    assert.equal(lines.length, 4)
    assert.match(lines[0], /\| env \|/)
    assert.match(lines[0], /runs within tolerance/)
    assert.match(lines[1], /^\|[- |]+\|$/)
    assert.match(lines[2], /\| zone \|/)
    assert.match(lines[3], /\| org \|/)
    assert.match(table, /live-data/)
    assert.match(table, /2\.50%/)
  })

  test('a row with no sample reads "no data" instead of a verdict', () => {
    const rows = summarizeByEnv([runLine({ sampleSize: 0, agree: 0, onlyLegacy: 0, onlyPulse: 0 })], {
      diff: 'live-data',
      now: NOW
    })
    const table = toMarkdownTable(rows, { diff: 'live-data', now: NOW, windowDays: 7 })
    const row = table.split('\n').filter((line) => line.startsWith('| zone'))[0]

    assert.match(row, /\| no data \|$/)
  })

  test('says so when there is nothing in the window', () => {
    const table = toMarkdownTable([], { diff: 'live-data', now: NOW, windowDays: 7 })
    assert.match(table, /no runs/i)
  })

  test('carries no addresses', () => {
    const rows = summarizeByEnv([runLine({ notes: 'legacy=4 pulse=4' })], { diff: 'online-set', now: NOW })
    assert.doesNotMatch(toMarkdownTable(rows, { diff: 'online-set', now: NOW, windowDays: 7 }), /0x[0-9a-fA-F]{4}/)
  })
})

describe('reading a .jsonl file', () => {
  test('reads one object per line and ignores blanks', () => {
    withTempDir((dir) => {
      fs.writeFileSync(
        path.join(dir, 'live-data.jsonl'),
        `${JSON.stringify(runLine())}\n\n${JSON.stringify(runLine({ at: daysAgo(1) }))}\n`
      )
      assert.equal(readJsonl(dir, 'live-data').length, 2)
    })
  })

  test('a missing file reads as no runs', () => {
    withTempDir((dir) => {
      assert.deepEqual(readJsonl(dir, 'live-data'), [])
    })
  })

  test('a truncated last line is skipped rather than killing the summary', () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'live-data.jsonl'), `${JSON.stringify(runLine())}\n{"diff":"live-`)
      assert.equal(readJsonl(dir, 'live-data').length, 1)
    })
  })
})

describe('the summarize command', () => {
  test('prints the aggregate JSON line and the table', () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'live-data.jsonl'), `${JSON.stringify(runLine({ at: daysAgo(1) }))}\n`)
      const printed = []
      const { aggregate, table } = runSummarize({
        argv: ['live-data'],
        env: { OUT_DIR: dir },
        now: () => NOW,
        out: (text) => printed.push(text)
      })

      assert.equal(aggregate.runs, 1)
      assert.match(table, /\| zone \|/)
      const output = printed.join('\n')
      assert.ok(output.includes(JSON.stringify(aggregate)))
      assert.ok(output.includes('| zone |'))
    })
  })

  test('CRON_INTERVAL_MINUTES reaches the continuity check', () => {
    withTempDir((dir) => {
      const printed = []
      fs.writeFileSync(
        path.join(dir, 'live-data.jsonl'),
        `${JSON.stringify(runLine({ at: daysAgo(1) }))}\n`
      )

      runSummarize({
        argv: ['live-data'],
        env: { OUT_DIR: dir, CRON_INTERVAL_MINUTES: '5' },
        now: () => NOW,
        out: (text) => printed.push(text)
      })

      assert.match(printed.join('\n'), /run gap/i)
    })
  })

  test('--window-days and --env are honoured', () => {
    withTempDir((dir) => {
      fs.writeFileSync(
        path.join(dir, 'live-data.jsonl'),
        [runLine({ at: daysAgo(1), env: 'zone' }), runLine({ at: daysAgo(5), env: 'org' })]
          .map((line) => JSON.stringify(line))
          .join('\n')
      )
      const { aggregate } = runSummarize({
        argv: ['live-data', '--window-days', '3', '--env', 'zone'],
        env: { OUT_DIR: dir },
        now: () => NOW,
        out: () => {}
      })
      assert.equal(aggregate.runs, 1)
      assert.equal(aggregate.env, 'zone')
    })
  })

  test('an unknown diff name is rejected', () => {
    withTempDir((dir) => {
      assert.throws(() => runSummarize({ argv: ['nope'], env: { OUT_DIR: dir }, out: () => {} }), /unknown diff/i)
      assert.throws(() => runSummarize({ argv: [], env: { OUT_DIR: dir }, out: () => {} }), /diff/i)
    })
  })

  test('a non-numeric --window-days is rejected', () => {
    withTempDir((dir) => {
      assert.throws(
        () => runSummarize({ argv: ['live-data', '--window-days', 'lots'], env: { OUT_DIR: dir }, out: () => {} }),
        /window-days/
      )
    })
  })
})
