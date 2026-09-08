'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test, describe } = require('node:test')

const { compareSceneParticipants, run } = require('../src/diffs/scene-participants')
const { readState, writeState } = require('../src/state')

const METRICS = fs.readFileSync(path.join(__dirname, 'fixtures', 'gatekeeper-metrics.txt'), 'utf8')

const DEFAULTS = {
  diffMetric: 'presence_shadow_diff',
  requestsMetric: 'http_requests_total',
  requestsLabelFilter: { handler: '/scene-participants' }
}

// A minimal /metrics page with the two counters diff 1 reads, for the runs that need to move a
// counter between scrapes.
const metricsText = ({ diff, requests }) =>
  [
    `presence_shadow_diff{kind="land"} ${diff}`,
    `http_requests_total{method="GET",handler="/scene-participants",code="200"} ${requests}`,
    ''
  ].join('\n')

const withTempDir = (body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-diff-'))
  try {
    return body(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('scene-participants: gatekeeper shadow counters', () => {
  test('the first run takes the counters as they stand', () => {
    const result = compareSceneParticipants({ text: METRICS, previous: undefined, ...DEFAULTS })

    assert.equal(result.sampleSize, 944)
    assert.equal(result.agree, 929)
    assert.equal(result.onlyLegacy, 0)
    assert.equal(result.onlyPulse, 0)
    assert.match(result.notes, /first run/)
    assert.match(result.notes, /land=12/)
    assert.match(result.notes, /world=3/)
  })

  test('a later run reports only the delta since the previous run', () => {
    const previous = {
      at: '2026-09-05T09:00:00.000Z',
      counters: { diff: 13, requests: 900, 'diff.land': 10, 'diff.world': 3 }
    }
    const result = compareSceneParticipants({ text: METRICS, previous, ...DEFAULTS })

    assert.equal(result.sampleSize, 44)
    assert.equal(result.agree, 42)
    assert.match(result.notes, /land=\+2/)
    assert.match(result.notes, /world=\+0/)
  })

  test('the new counters are handed back for the next run', () => {
    const result = compareSceneParticipants({ text: METRICS, previous: undefined, ...DEFAULTS })
    assert.deepEqual(result.counters, { diff: 15, requests: 944, 'diff.land': 12, 'diff.world': 3 })
  })

  test('a counter that went backwards skips the run instead of reporting a lifetime counter', () => {
    const previous = { at: '...', counters: { diff: 900, requests: 90000, 'diff.land': 800, 'diff.world': 100 } }
    const result = compareSceneParticipants({ text: METRICS, previous, ...DEFAULTS })

    assert.equal(result.counterReset, true)
    assert.equal(result.sampleSize, undefined, 'a reset run has no sample at all')
    assert.match(result.reason, /backwards/i)
  })

  test('no requests since the last run is an empty sample, not a division by zero', () => {
    const previous = { at: '...', counters: { diff: 15, requests: 944, 'diff.land': 12, 'diff.world': 3 } }
    const result = compareSceneParticipants({ text: METRICS, previous, ...DEFAULTS })
    assert.equal(result.sampleSize, 0)
    assert.equal(result.agree, 0)
  })

  test('more diffing addresses than requests clamps agree at 0 and keeps the raw delta in the notes', () => {
    const previous = { at: '...', counters: { diff: 0, requests: 939, 'diff.land': 0, 'diff.world': 0 } }
    const result = compareSceneParticipants({ text: METRICS, previous, ...DEFAULTS })
    assert.equal(result.sampleSize, 5)
    assert.equal(result.agree, 0)
    assert.match(result.notes, /diffAddresses=\+15/)
  })

  test('the diff and request metric names are parameters', () => {
    const text = 'my_diff{kind="land"} 4\nmy_requests{route="/scene-participants"} 100\n'
    const result = compareSceneParticipants({
      text,
      previous: undefined,
      diffMetric: 'my_diff',
      requestsMetric: 'my_requests',
      requestsLabelFilter: { route: '/scene-participants' }
    })
    assert.equal(result.sampleSize, 100)
    assert.equal(result.agree, 96)
  })

  test('a metrics page without the diff counter reads as zero diffs, not as a failure', () => {
    const text = 'http_requests_total{handler="/scene-participants",code="200"} 10\n'
    const result = compareSceneParticipants({ text, previous: undefined, ...DEFAULTS })
    assert.equal(result.sampleSize, 10)
    assert.equal(result.agree, 10)
  })

  test('a metrics page without the request counter is a hard error', () => {
    assert.throws(
      () => compareSceneParticipants({ text: 'presence_shadow_diff{kind="land"} 3\n', previous: undefined, ...DEFAULTS }),
      /http_requests_total/
    )
  })
})

describe('state file', () => {
  test('a missing state file reads as undefined', () => {
    withTempDir((dir) => {
      assert.equal(readState(dir, 'scene-participants', 'zone'), undefined)
    })
  })

  test('what is written is what comes back', () => {
    withTempDir((dir) => {
      const state = { at: '2026-09-05T10:00:00.000Z', counters: { diff: 15, compare: 944 } }
      const file = writeState(dir, 'scene-participants', 'zone', state)
      assert.equal(path.basename(file), 'zone-scene-participants.json')
      assert.equal(path.basename(path.dirname(file)), 'state')
      assert.deepEqual(readState(dir, 'scene-participants', 'zone'), state)
    })
  })

  test('the state file is keyed by env, so zone and org can share one OUT_DIR', () => {
    withTempDir((dir) => {
      writeState(dir, 'scene-participants', 'zone', { counters: { compare: 100 } })
      writeState(dir, 'scene-participants', 'org', { counters: { compare: 7000 } })

      assert.deepEqual(readState(dir, 'scene-participants', 'zone'), { counters: { compare: 100 } })
      assert.deepEqual(readState(dir, 'scene-participants', 'org'), { counters: { compare: 7000 } })
      assert.deepEqual(fs.readdirSync(path.join(dir, 'state')).sort(), [
        'org-scene-participants.json',
        'zone-scene-participants.json'
      ])
    })
  })

  test('an env label from the environment cannot escape OUT_DIR', () => {
    withTempDir((dir) => {
      const file = writeState(dir, 'scene-participants', '../../etc/zone', { counters: {} })
      assert.ok(file.startsWith(path.join(dir, 'state')), `${file} escaped ${dir}`)
      assert.doesNotMatch(path.basename(file), /[/\\]|\.\./)
    })
  })

  test('a corrupt state file reads as undefined rather than killing the cron', () => {
    withTempDir((dir) => {
      fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'state', 'zone-scene-participants.json'), '{ not json')
      assert.equal(readState(dir, 'scene-participants', 'zone'), undefined)
    })
  })
})

describe('scene-participants run', () => {
  test('scrapes, reports and leaves state behind for the next run', async () => {
    await withTempDir(async (dir) => {
      const scraped = []
      const printed = []
      const env = {
        OUT_DIR: dir,
        SHADOW_DIFF_ENV: 'org',
        GATEKEEPER_METRICS_URL: 'https://gatekeeper.example.com/metrics'
      }

      const first = await run({
        env,
        fetchText: async (url) => {
          scraped.push(url)
          return METRICS
        },
        now: () => new Date('2026-09-05T10:00:00.000Z'),
        out: (text) => printed.push(text)
      })

      assert.deepEqual(scraped, ['https://gatekeeper.example.com/metrics'])
      assert.equal(first.diff, 'scene-participants')
      assert.equal(first.env, 'org')
      assert.equal(first.sampleSize, 944)
      assert.equal(first.withinTolerance, true)
      assert.ok(printed.join('\n').includes('scene-participants'))

      const second = await run({
        env,
        fetchText: async () => METRICS,
        now: () => new Date('2026-09-05T11:00:00.000Z'),
        out: () => {}
      })

      assert.equal(second.sampleSize, 0, 'the second run sees no new requests')

      const lines = fs.readFileSync(path.join(dir, 'scene-participants.jsonl'), 'utf8').trim().split('\n')
      assert.equal(lines.length, 2)
    })
  })

  test('a counter that went backwards logs, writes no line and re-baselines', async () => {
    await withTempDir(async (dir) => {
      const printed = []
      const env = {
        OUT_DIR: dir,
        SHADOW_DIFF_ENV: 'zone',
        GATEKEEPER_METRICS_URL: 'https://gatekeeper.example.com/metrics'
      }
      const at = (minute) => () => new Date(`2026-09-05T10:0${minute}:00.000Z`)
      const jsonl = path.join(dir, 'scene-participants.jsonl')

      await run({ env, fetchText: async () => metricsText({ diff: 50, requests: 9000 }), now: at(0), out: () => {} })
      assert.equal(fs.readFileSync(jsonl, 'utf8').trim().split('\n').length, 1)

      // The exporter restarted (or a load balancer sent this scrape to another task).
      const skipped = await run({
        env,
        fetchText: async () => metricsText({ diff: 1, requests: 20 }),
        now: at(5),
        out: (text) => printed.push(text)
      })

      assert.equal(skipped.skipped, true)
      assert.match(printed.join('\n'), /backwards/i)
      assert.equal(fs.readFileSync(jsonl, 'utf8').trim().split('\n').length, 1, 'no line for a skipped run')

      // The skipped run still left the new counters behind, so the next window is measurable.
      const next = await run({
        env,
        fetchText: async () => metricsText({ diff: 1, requests: 25 }),
        now: at(9),
        out: () => {}
      })
      assert.equal(next.sampleSize, 5)
      assert.equal(fs.readFileSync(jsonl, 'utf8').trim().split('\n').length, 2)
    })
  })

  test('a missing GATEKEEPER_METRICS_URL stops the run', async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(() => run({ env: { OUT_DIR: dir }, fetchText: async () => METRICS }), /GATEKEEPER_METRICS_URL/)
    })
  })
})
