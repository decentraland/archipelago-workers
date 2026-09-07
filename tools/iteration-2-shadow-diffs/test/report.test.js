'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test, describe } = require('node:test')

const {
  DEFAULT_MAX_DISAGREE_RATIO,
  DIFF_NAMES,
  appendReportLine,
  buildReportLine,
  disagreeCount,
  disagreeRatio,
  formatHumanSummary,
  resolveTolerance
} = require('../src/report')

const BASE = {
  diff: 'live-data',
  at: '2026-09-05T10:00:00.000Z',
  env: 'zone',
  sampleSize: 42,
  agree: 40,
  onlyLegacy: 1,
  onlyPulse: 1,
  tolerance: { maxDisagreeRatio: 0.05 },
  explainedBy: ['no-comms peers visible to Pulse', '<= 2 s batching', '~5 s vs webhook latency'],
  notes: 'nightly cron'
}

describe('report line', () => {
  test('the four diffs share one name list', () => {
    assert.deepEqual(DIFF_NAMES, ['scene-participants', 'live-data', 'online-set', 'hot-scenes'])
  })

  test('reproduces the report format from the brief, key for key and in order', () => {
    const line = buildReportLine(BASE)

    assert.deepEqual(Object.keys(line), [
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
    ])
    assert.deepEqual(line, {
      diff: 'live-data',
      at: '2026-09-05T10:00:00.000Z',
      env: 'zone',
      sampleSize: 42,
      agree: 40,
      onlyLegacy: 1,
      onlyPulse: 1,
      tolerance: { maxDisagreeRatio: 0.05 },
      withinTolerance: true,
      explainedBy: ['no-comms peers visible to Pulse', '<= 2 s batching', '~5 s vs webhook latency'],
      notes: 'nightly cron'
    })
  })

  test('all four diffs produce the same key order', () => {
    const shape = Object.keys(buildReportLine(BASE))
    for (const diff of DIFF_NAMES) {
      assert.deepEqual(Object.keys(buildReportLine({ ...BASE, diff })), shape, diff)
    }
  })

  test('rejects an unknown diff name', () => {
    assert.throws(() => buildReportLine({ ...BASE, diff: 'nope' }), /unknown diff/i)
  })

  test('rejects counts that cannot come from one sample', () => {
    assert.throws(() => buildReportLine({ ...BASE, agree: 43 }), /agree/i)
    assert.throws(() => buildReportLine({ ...BASE, onlyLegacy: 2, onlyPulse: 2 }), /onlyLegacy/i)
    assert.throws(() => buildReportLine({ ...BASE, sampleSize: 1.5 }), /integer/i)
    assert.throws(() => buildReportLine({ ...BASE, sampleSize: -1 }), /integer/i)
  })

  test('rejects a nonsensical tolerance', () => {
    assert.throws(() => buildReportLine({ ...BASE, tolerance: { maxDisagreeRatio: 1.5 } }), /maxDisagreeRatio/)
    assert.throws(() => buildReportLine({ ...BASE, tolerance: { maxDisagreeRatio: -0.1 } }), /maxDisagreeRatio/)
  })
})

describe('tolerance arithmetic', () => {
  test('disagree is everything that did not agree', () => {
    assert.equal(disagreeCount({ sampleSize: 42, agree: 40 }), 2)
    assert.equal(disagreeCount({ sampleSize: 0, agree: 0 }), 0)
  })

  test('the ratio is disagree / sampleSize', () => {
    assert.equal(disagreeRatio({ sampleSize: 200, agree: 190 }), 0.05)
    assert.equal(disagreeRatio({ sampleSize: 4, agree: 3 }), 0.25)
  })

  test('an empty sample is 0, never NaN, and is within tolerance', () => {
    assert.equal(disagreeRatio({ sampleSize: 0, agree: 0 }), 0)
    const line = buildReportLine({ ...BASE, sampleSize: 0, agree: 0, onlyLegacy: 0, onlyPulse: 0 })
    assert.equal(line.withinTolerance, true)
  })

  test('withinTolerance is inclusive at the boundary', () => {
    const atBoundary = buildReportLine({ ...BASE, sampleSize: 200, agree: 190, onlyLegacy: 5, onlyPulse: 5 })
    assert.equal(disagreeRatio(atBoundary), 0.05)
    assert.equal(atBoundary.withinTolerance, true)

    const justOver = buildReportLine({ ...BASE, sampleSize: 200, agree: 189, onlyLegacy: 6, onlyPulse: 5 })
    assert.equal(justOver.withinTolerance, false)
  })

  test('floating point does not push an exact boundary over', () => {
    // 0.29 * 100 is 28.999999999999996 in float64, so `disagree <= ratio * sampleSize` read
    // literally would call an exact 29-in-100 breach of a 29% tolerance. It is not one.
    assert.ok(0.29 * 100 !== 29)
    const line = buildReportLine({
      ...BASE,
      sampleSize: 100,
      agree: 71,
      onlyLegacy: 29,
      onlyPulse: 0,
      tolerance: { maxDisagreeRatio: 0.29 }
    })
    assert.equal(disagreeRatio(line), 0.29)
    assert.equal(line.withinTolerance, true)
  })
})

describe('tolerance resolution from the environment', () => {
  test('defaults to 0.05 for every diff', () => {
    assert.equal(DEFAULT_MAX_DISAGREE_RATIO, 0.05)
    for (const diff of DIFF_NAMES) {
      assert.deepEqual(resolveTolerance(diff, {}), { maxDisagreeRatio: 0.05 })
    }
  })

  test('MAX_DISAGREE_RATIO overrides every diff', () => {
    assert.deepEqual(resolveTolerance('live-data', { MAX_DISAGREE_RATIO: '0.2' }), { maxDisagreeRatio: 0.2 })
  })

  test('the per-diff variable wins over the global one', () => {
    const env = { MAX_DISAGREE_RATIO: '0.2', MAX_DISAGREE_RATIO_LIVE_DATA: '0.01' }
    assert.deepEqual(resolveTolerance('live-data', env), { maxDisagreeRatio: 0.01 })
    assert.deepEqual(resolveTolerance('hot-scenes', env), { maxDisagreeRatio: 0.2 })
  })

  test('the per-diff variable name is the diff name upper-snake-cased', () => {
    assert.deepEqual(resolveTolerance('scene-participants', { MAX_DISAGREE_RATIO_SCENE_PARTICIPANTS: '0.5' }), {
      maxDisagreeRatio: 0.5
    })
    assert.deepEqual(resolveTolerance('online-set', { MAX_DISAGREE_RATIO_ONLINE_SET: '0' }), { maxDisagreeRatio: 0 })
  })

  test('rejects an unparseable override instead of silently defaulting', () => {
    assert.throws(() => resolveTolerance('live-data', { MAX_DISAGREE_RATIO: 'loose' }), /MAX_DISAGREE_RATIO/)
    assert.throws(() => resolveTolerance('live-data', { MAX_DISAGREE_RATIO: '2' }), /MAX_DISAGREE_RATIO/)
  })
})

describe('output', () => {
  test('appends exactly one line per run and keeps earlier runs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-diff-'))
    try {
      const file = appendReportLine(dir, buildReportLine(BASE))
      appendReportLine(dir, buildReportLine({ ...BASE, at: '2026-09-05T11:00:00.000Z' }))

      assert.equal(path.basename(file), 'live-data.jsonl')
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      assert.equal(lines.length, 2)
      assert.equal(JSON.parse(lines[0]).at, '2026-09-05T10:00:00.000Z')
      assert.equal(JSON.parse(lines[1]).at, '2026-09-05T11:00:00.000Z')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('creates the output directory when it does not exist yet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-diff-'))
    try {
      const file = appendReportLine(path.join(dir, 'a', 'b'), buildReportLine(BASE))
      assert.ok(fs.existsSync(file))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the human summary carries the verdict and the ratios', () => {
    const summary = formatHumanSummary(buildReportLine(BASE))
    assert.match(summary, /live-data/)
    assert.match(summary, /zone/)
    assert.match(summary, /sample=42/)
    assert.match(summary, /agree=40/)
    assert.match(summary, /4\.76%/)
    assert.match(summary, /5\.00%/)
    assert.match(summary, /WITHIN TOLERANCE/)
    assert.match(summary, /no-comms peers visible to Pulse/)
  })

  test('the human summary says so when a run is out of tolerance', () => {
    const summary = formatHumanSummary(buildReportLine({ ...BASE, agree: 20, onlyLegacy: 20, onlyPulse: 2 }))
    assert.match(summary, /OUT OF TOLERANCE/)
  })
})
