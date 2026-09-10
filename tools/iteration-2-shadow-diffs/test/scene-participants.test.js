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
  compareMetric: 'presence_shadow_compare_total',
  compareLabelFilter: {}
}

// One gatekeeper task per URL: the harness scrapes each task, not the service behind its load
// balancer, and keeps one set of counters per target.
const TASK_A = 'https://gk-task-1.example.com/metrics'
const TASK_B = 'https://gk-task-2.example.com/metrics'

const scrape = (text, url = TASK_A) => [{ url, text }]

// The state a previous scrape of the fixture page would have left behind.
const previousCounters = (overrides = {}, url = TASK_A) => ({
  targets: {
    [url]: {
      diff: 15,
      compare: 944,
      'diff.land': 12,
      'diff.world': 3,
      'compare.land': 900,
      'compare.world': 44,
      ...overrides
    }
  }
})

// A minimal /metrics page with the two counters diff 1 reads, for the runs that need to move a
// counter between scrapes.
const metricsText = ({ diff, compares }) =>
  [
    `presence_shadow_diff{kind="land"} ${diff}`,
    `presence_shadow_compare_total{kind="land"} ${compares}`,
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
    const result = compareSceneParticipants({ targets: scrape(METRICS), previous: undefined, ...DEFAULTS })

    assert.equal(result.sampleSize, 944, 'the 944 comparisons gatekeeper performed, not its 944 HTTP requests')
    assert.equal(result.agree, 929)
    assert.equal(result.onlyLegacy, 0)
    assert.equal(result.onlyPulse, 0)
    assert.match(result.notes, /first run/)
    assert.match(result.notes, /land=12/)
    assert.match(result.notes, /world=3/)
    assert.match(result.notes, /compares=944/)
    assert.match(result.notes, /land=900/)
    assert.match(result.notes, /world=44/)
  })

  test('the sample counts comparisons, so requests that never reached the shadow do not dilute it', () => {
    // A page where the two facts diverge: 940 requests were served, only 100 comparisons ran.
    // Dividing by requests would report 940 samples of a shadow that compared 100 times.
    const text = [
      'presence_shadow_diff{kind="land"} 5',
      'presence_shadow_compare_total{kind="land"} 100',
      'http_requests_total{method="GET",handler="/scene-participants",code="200"} 900',
      'http_requests_total{method="GET",handler="/scene-participants",code="500"} 40',
      ''
    ].join('\n')
    const result = compareSceneParticipants({ targets: scrape(text), previous: undefined, ...DEFAULTS })
    assert.equal(result.sampleSize, 100)
    assert.equal(result.agree, 95)
  })

  test('a later run reports only the delta since the previous run', () => {
    const previous = {
      at: '2026-09-05T09:00:00.000Z',
      ...previousCounters({ diff: 13, compare: 900, 'diff.land': 10, 'compare.land': 860, 'compare.world': 40 })
    }
    const result = compareSceneParticipants({ targets: scrape(METRICS), previous, ...DEFAULTS })

    assert.equal(result.sampleSize, 44)
    assert.equal(result.agree, 42)
    assert.match(result.notes, /land=\+2/)
    assert.match(result.notes, /world=\+0/)
    assert.match(result.notes, /compares=\+44/)
    assert.match(result.notes, /land=\+40/)
    assert.match(result.notes, /world=\+4/)
  })

  test('the new counters are handed back for the next run, one set per target', () => {
    const result = compareSceneParticipants({ targets: scrape(METRICS), previous: undefined, ...DEFAULTS })
    assert.deepEqual(result.counters, {
      [TASK_A]: {
        diff: 15,
        compare: 944,
        'diff.land': 12,
        'diff.world': 3,
        'compare.land': 900,
        'compare.world': 44
      }
    })
  })

  test('a counter that went backwards skips the run instead of reporting a lifetime counter', () => {
    const previous = { at: '...', ...previousCounters({ diff: 900, compare: 90000, 'compare.land': 89000 }) }
    const result = compareSceneParticipants({ targets: scrape(METRICS), previous, ...DEFAULTS })

    assert.equal(result.counterReset, true)
    assert.equal(result.sampleSize, undefined, 'a reset run has no sample at all')
    assert.match(result.reason, /backwards/i)
    assert.match(result.reason, /gk-task-1\.example\.com/, 'the reason names the target that moved')
  })

  test('a flat compare counter is a shadow that never ran, not two sources agreeing', () => {
    const previous = { at: '...', ...previousCounters() }
    const result = compareSceneParticipants({ targets: scrape(METRICS), previous, ...DEFAULTS })

    assert.equal(result.sampleSize, 0, 'no comparisons happened, so there is no sample')
    assert.equal(result.agree, 0)
    assert.match(result.notes, /no comparisons in window/)
  })

  test('more diffing addresses than requests clamps agree at 0 and keeps the raw delta in the notes', () => {
    const previous = {
      at: '...',
      ...previousCounters({ diff: 0, compare: 939, 'diff.land': 0, 'diff.world': 0, 'compare.land': 895 })
    }
    const result = compareSceneParticipants({ targets: scrape(METRICS), previous, ...DEFAULTS })
    assert.equal(result.sampleSize, 5)
    assert.equal(result.agree, 0)
    assert.match(result.notes, /diffAddresses=\+15/)
  })

  test('two tasks are scraped separately and their deltas are summed', () => {
    // The normal shape for a service with more than one task: the harness is pointed at each task,
    // because scraping through a load balancer lands successive scrapes on different lifetimes.
    const previous = {
      at: '...',
      targets: {
        [TASK_A]: { diff: 10, compare: 500, 'diff.land': 10, 'diff.world': 0, 'compare.land': 500, 'compare.world': 0 },
        [TASK_B]: { diff: 4, compare: 300, 'diff.land': 4, 'diff.world': 0, 'compare.land': 300, 'compare.world': 0 }
      }
    }
    const result = compareSceneParticipants({
      targets: [
        { url: TASK_A, text: metricsText({ diff: 12, compares: 520 }) },
        { url: TASK_B, text: metricsText({ diff: 6, compares: 330 }) }
      ],
      previous,
      ...DEFAULTS
    })

    assert.equal(result.sampleSize, 50, '20 comparisons on task 1 plus 30 on task 2')
    assert.equal(result.agree, 46, '4 differing addresses across the two tasks')
    assert.match(result.notes, /targets=2/)
  })

  test('a task that appeared since the last run contributes its own counter and says so', () => {
    const result = compareSceneParticipants({
      targets: [
        { url: TASK_A, text: metricsText({ diff: 12, compares: 520 }) },
        { url: TASK_B, text: metricsText({ diff: 1, compares: 9 }) }
      ],
      previous: {
        at: '...',
        targets: {
          [TASK_A]: { diff: 10, compare: 500, 'diff.land': 10, 'diff.world': 0, 'compare.land': 500, 'compare.world': 0 }
        }
      },
      ...DEFAULTS
    })

    assert.equal(result.sampleSize, 29, '20 measured on task 1, 9 lifetime on the task that scaled up')
    assert.match(result.notes, /new targets=1/)
  })

  test('one task out of two going backwards skips the whole run', () => {
    const result = compareSceneParticipants({
      targets: [
        { url: TASK_A, text: metricsText({ diff: 12, compares: 520 }) },
        { url: TASK_B, text: metricsText({ diff: 0, compares: 2 }) }
      ],
      previous: {
        at: '...',
        targets: {
          [TASK_A]: { diff: 10, compare: 500, 'diff.land': 10, 'diff.world': 0, 'compare.land': 500, 'compare.world': 0 },
          [TASK_B]: { diff: 4, compare: 300, 'diff.land': 4, 'diff.world': 0, 'compare.land': 300, 'compare.world': 0 }
        }
      },
      ...DEFAULTS
    })

    // Half a window is not a window: the surviving task's delta would be reported as the whole
    // service's traffic and the ratio would drift with every restart.
    assert.equal(result.counterReset, true)
    assert.match(result.reason, /gk-task-2\.example\.com/)
  })

  test('the diff and compare metric names are parameters', () => {
    const text = 'my_diff{kind="land"} 4\nmy_compares{route="/scene-participants"} 100\n'
    const result = compareSceneParticipants({
      targets: scrape(text),
      previous: undefined,
      diffMetric: 'my_diff',
      compareMetric: 'my_compares',
      compareLabelFilter: { route: '/scene-participants' }
    })
    assert.equal(result.sampleSize, 100)
    assert.equal(result.agree, 96)
  })

  test('a request counter stays reachable as an override for a gatekeeper without the compare counter', () => {
    const result = compareSceneParticipants({
      targets: scrape(METRICS),
      previous: undefined,
      diffMetric: 'presence_shadow_diff',
      compareMetric: 'http_requests_total',
      compareLabelFilter: { handler: '/scene-participants', code: '200' }
    })
    assert.equal(result.sampleSize, 940)
    assert.equal(result.agree, 925)
  })

  test('a metrics page without the diff counter reads as zero diffs, not as a failure', () => {
    const text = 'presence_shadow_compare_total{kind="land"} 10\n'
    const result = compareSceneParticipants({ targets: scrape(text), previous: undefined, ...DEFAULTS })
    assert.equal(result.sampleSize, 10)
    assert.equal(result.agree, 10)
  })

  test('a compare counter no series matches the label filter is a hard error, not an empty sample', () => {
    // The label value drifted (a remounted route, a middleware emitting `route=` instead of
    // `handler=`). The name is still on the page, so a name-only check passes and every run for a
    // week reports a clean empty sample.
    assert.throws(
      () =>
        compareSceneParticipants({
          targets: scrape(METRICS),
          previous: undefined,
          diffMetric: 'presence_shadow_diff',
          compareMetric: 'presence_shadow_compare_total',
          compareLabelFilter: { kind: 'genesis' }
        }),
      /presence_shadow_compare_total/
    )
  })

  test('a metrics page without the compare counter is a hard error', () => {
    assert.throws(
      () =>
        compareSceneParticipants({
          targets: scrape('presence_shadow_diff{kind="land"} 3\n'),
          previous: undefined,
          ...DEFAULTS
        }),
      /presence_shadow_compare_total/
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

      await run({ env, fetchText: async () => metricsText({ diff: 50, compares: 9000 }), now: at(0), out: () => {} })
      assert.equal(fs.readFileSync(jsonl, 'utf8').trim().split('\n').length, 1)

      // The exporter restarted (or a load balancer sent this scrape to another task).
      const skipped = await run({
        env,
        fetchText: async () => metricsText({ diff: 1, compares: 20 }),
        now: at(5),
        out: (text) => printed.push(text)
      })

      assert.equal(skipped.skipped, true)
      assert.match(printed.join('\n'), /backwards/i)
      assert.equal(fs.readFileSync(jsonl, 'utf8').trim().split('\n').length, 1, 'no line for a skipped run')

      // The skipped run still left the new counters behind, so the next window is measurable.
      const next = await run({
        env,
        fetchText: async () => metricsText({ diff: 1, compares: 25 }),
        now: at(9),
        out: () => {}
      })
      assert.equal(next.sampleSize, 5)
      assert.equal(fs.readFileSync(jsonl, 'utf8').trim().split('\n').length, 2)
    })
  })

  test('a window with no comparisons is reported as no sample and out of tolerance', async () => {
    await withTempDir(async (dir) => {
      const env = {
        OUT_DIR: dir,
        GATEKEEPER_METRICS_URL: 'https://gatekeeper.example.com/metrics'
      }
      const text = metricsText({ diff: 4, compares: 700 })

      await run({ env, fetchText: async () => text, now: () => new Date('2026-09-05T10:00:00.000Z'), out: () => {} })
      // The shadow compared nothing between the two scrapes: gatekeeper's LiveKit side is failing,
      // or the presence map is cold. Traffic kept flowing, which is exactly the trap.
      const line = await run({
        env,
        fetchText: async () => text,
        now: () => new Date('2026-09-05T10:05:00.000Z'),
        out: () => {}
      })

      assert.equal(line.sampleSize, 0)
      assert.equal(line.agree, 0)
      assert.equal(line.withinTolerance, false, 'a shadow that never ran is not a shadow that agreed')
      assert.match(line.notes, /no comparisons in window/)
    })
  })

  test('the compare metric and its label filter come from the environment', async () => {
    await withTempDir(async (dir) => {
      const line = await run({
        env: {
          OUT_DIR: dir,
          GATEKEEPER_METRICS_URL: 'https://gatekeeper.example.com/metrics',
          SHADOW_COMPARE_METRIC: 'http_requests_total',
          SHADOW_COMPARE_LABELS: 'handler=/scene-participants,code=200'
        },
        fetchText: async () => METRICS,
        now: () => new Date('2026-09-05T10:00:00.000Z'),
        out: () => {}
      })
      assert.equal(line.sampleSize, 940)
    })
  })

  test('GATEKEEPER_METRICS_URL takes one URL per task and scrapes all of them', async () => {
    await withTempDir(async (dir) => {
      const scraped = []
      const env = {
        OUT_DIR: dir,
        GATEKEEPER_METRICS_URL: `${TASK_A}, ${TASK_B}`,
        GATEKEEPER_METRICS_TOKEN: 'not-a-real-token-0000'
      }
      const texts = {
        [TASK_A]: metricsText({ diff: 2, compares: 100 }),
        [TASK_B]: metricsText({ diff: 3, compares: 200 })
      }
      const fetchText = async (url, options) => {
        scraped.push({ url, auth: options.headers.authorization })
        return texts[url]
      }

      const first = await run({ env, fetchText, now: () => new Date('2026-09-05T10:00:00.000Z'), out: () => {} })

      assert.deepEqual(
        scraped.map((call) => call.url),
        [TASK_A, TASK_B]
      )
      assert.ok(scraped.every((call) => call.auth === 'Bearer not-a-real-token-0000'))
      assert.equal(first.sampleSize, 300, 'the first run takes both lifetime counters')

      texts[TASK_A] = metricsText({ diff: 2, compares: 140 })
      texts[TASK_B] = metricsText({ diff: 4, compares: 260 })
      const second = await run({ env, fetchText, now: () => new Date('2026-09-05T10:05:00.000Z'), out: () => {} })

      assert.equal(second.sampleSize, 100, '40 comparisons on task 1 plus 60 on task 2')
      assert.equal(second.agree, 99)
    })
  })

  test('the scrape carries a bearer token when one is configured', async () => {
    await withTempDir(async (dir) => {
      const calls = []
      await run({
        env: {
          OUT_DIR: dir,
          GATEKEEPER_METRICS_URL: 'https://gatekeeper.example.com/metrics',
          GATEKEEPER_METRICS_TOKEN: 'not-a-real-token-0000'
        },
        fetchText: async (url, options) => {
          calls.push({ url, options })
          return METRICS
        },
        now: () => new Date('2026-09-05T10:00:00.000Z'),
        out: () => {}
      })

      // /metrics answers 401 without it whenever the service has a metrics token configured.
      assert.deepEqual(calls[0].options.headers, { authorization: 'Bearer not-a-real-token-0000' })
    })
  })

  test('a missing GATEKEEPER_METRICS_URL stops the run', async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(() => run({ env: { OUT_DIR: dir }, fetchText: async () => METRICS }), /GATEKEEPER_METRICS_URL/)
    })
  })
})

// prom-client publishes no sample line for a labelled counter until its first `inc()`, and
// @dcl/metrics does not zero-fill, while `registry.metrics()` still emits `# HELP` / `# TYPE` for
// every registered metric. So a gatekeeper task that has not yet run a shadow comparison serves a
// page that declares the counter and carries no series for it. That is a fresh task, not a wrong
// metric name, and it must cost neither the run nor the traffic its siblings did measure.
const DECLARED_NOT_SAMPLED = [
  '# HELP presence_shadow_diff Addresses differing between the LiveKit and presence-map answers',
  '# TYPE presence_shadow_diff counter',
  '# HELP presence_shadow_compare_total Total /scene-participants shadow comparisons',
  '# TYPE presence_shadow_compare_total counter',
  '# HELP dcl_gatekeeper_presence_map_size Number of wallets currently held in the presence map',
  '# TYPE dcl_gatekeeper_presence_map_size gauge',
  'dcl_gatekeeper_presence_map_size 0',
  ''
].join('\n')

describe('scene-participants: a target that has not compared yet', () => {
  test('a task that declares the counter with no series counts as zero, and its sibling is reported', () => {
    const result = compareSceneParticipants({
      targets: [
        { url: TASK_A, text: metricsText({ diff: 12, compares: 520 }) },
        { url: TASK_B, text: DECLARED_NOT_SAMPLED }
      ],
      previous: {
        at: '...',
        targets: {
          [TASK_A]: { diff: 10, compare: 500, 'diff.land': 10, 'diff.world': 0, 'compare.land': 500, 'compare.world': 0 }
        }
      },
      ...DEFAULTS
    })

    assert.equal(result.sampleSize, 20, "task 1's measured window, undamaged by the young task")
    assert.equal(result.agree, 18)
    assert.deepEqual(result.freshTargets, [TASK_B])
    assert.match(result.notes, /no comparisons yet on 1 target/)
    assert.equal(result.counters[TASK_B].compare, 0, 'a declared-but-unsampled counter is a zero')
  })

  test('every target still fresh is an empty sample, not a configuration error', () => {
    const result = compareSceneParticipants({
      targets: [
        { url: TASK_A, text: DECLARED_NOT_SAMPLED },
        { url: TASK_B, text: DECLARED_NOT_SAMPLED }
      ],
      previous: undefined,
      ...DEFAULTS
    })

    assert.equal(result.sampleSize, 0)
    assert.match(result.notes, /no comparisons in window/, 'an empty sample is never within tolerance')
    assert.match(result.notes, /no comparisons yet on 2 targets/)
  })

  test('a counter neither declared nor sampled on any target is a hard error', () => {
    // The real configuration error: the name drifted, or gatekeeper predates WP2. Nothing on any
    // page knows the metric, so reading it as "no traffic" would report a clean empty sample for
    // the whole shadow period.
    assert.throws(
      () =>
        compareSceneParticipants({
          targets: [
            { url: TASK_A, text: 'presence_shadow_diff{kind="land"} 3\n' },
            { url: TASK_B, text: 'presence_shadow_diff{kind="land"} 1\n' }
          ],
          previous: undefined,
          ...DEFAULTS
        }),
      /presence_shadow_compare_total is neither declared nor exported/
    )
  })

  test('one target declaring the counter is enough to keep the run alive', () => {
    const result = compareSceneParticipants({
      targets: [
        { url: TASK_A, text: DECLARED_NOT_SAMPLED },
        { url: TASK_B, text: 'presence_shadow_diff{kind="land"} 1\n' }
      ],
      previous: undefined,
      ...DEFAULTS
    })
    assert.equal(result.sampleSize, 0)
    assert.match(result.notes, /no comparisons yet/)
  })

  test('a label filter matching nothing while the name is sampled is still a hard error', () => {
    // The distinction that makes the fresh-task rule safe: a drifted label filter leaves the name
    // SAMPLED (just never under the configured labels), which no fresh task ever looks like.
    assert.throws(
      () =>
        compareSceneParticipants({
          targets: [
            { url: TASK_A, text: METRICS },
            { url: TASK_B, text: DECLARED_NOT_SAMPLED }
          ],
          previous: undefined,
          ...DEFAULTS,
          compareLabelFilter: { kind: 'genesis' }
        }),
      /presence_shadow_compare_total.*label filter/s
    )
  })
})

describe('scene-participants run: a fresh target', () => {
  test('is logged at info, and the run writes the line for the traffic that was measured', async () => {
    await withTempDir(async (dir) => {
      const printed = []
      const env = { OUT_DIR: dir, GATEKEEPER_METRICS_URL: `${TASK_A}, ${TASK_B}` }
      const texts = {
        [TASK_A]: metricsText({ diff: 2, compares: 100 }),
        [TASK_B]: DECLARED_NOT_SAMPLED
      }
      const fetchText = async (url) => texts[url]
      const at = (minute) => () => new Date(`2026-09-05T10:0${minute}:00.000Z`)

      await run({ env, fetchText, now: at(0), out: () => {} })
      texts[TASK_A] = metricsText({ diff: 3, compares: 140 })
      const line = await run({ env, fetchText, now: at(5), out: (text) => printed.push(text) })

      assert.equal(line.sampleSize, 40, 'the 40 comparisons task 1 ran, not a failed run')
      assert.equal(line.withinTolerance, true)
      assert.match(printed.join('\n'), /no comparisons yet on 1 target/)
      assert.match(printed.join('\n'), /gk-task-2\.example\.com/, 'the log names the young task')
      const written = fs.readFileSync(path.join(dir, 'scene-participants.jsonl'), 'utf8').trim().split('\n')
      assert.equal(written.length, 2, 'a fresh sibling must not delete a run from the evidence')
    })
  })
})

describe('scene-participants run: a target that no longer answers', () => {
  // Task addresses on a container scheduler are ephemeral: a deploy replaces the tasks and the
  // addresses in GATEKEEPER_METRICS_URL stop resolving. Failing the whole run there would drop
  // every run from the evidence until someone refreshes the env file -- exactly the window in
  // which the shadow's numbers are being watched.
  const refused = (url) => {
    const error = new Error(`GET ${url} failed: connect ECONNREFUSED`)
    return error
  }

  test('one unreachable target is logged, and the targets that answered are still reported', async () => {
    await withTempDir(async (dir) => {
      const printed = []
      const env = { OUT_DIR: dir, GATEKEEPER_METRICS_URL: `${TASK_A}, ${TASK_B}` }
      const texts = {
        [TASK_A]: metricsText({ diff: 2, compares: 100 }),
        [TASK_B]: metricsText({ diff: 1, compares: 50 })
      }
      const fetchText = async (url) => {
        if (texts[url] === undefined) {
          throw refused(url)
        }
        return texts[url]
      }
      const at = (minute) => () => new Date(`2026-09-05T10:0${minute}:00.000Z`)

      await run({ env, fetchText, now: at(0), out: () => {} })

      // The deploy moved task 2; task 1 kept serving.
      delete texts[TASK_B]
      texts[TASK_A] = metricsText({ diff: 4, compares: 140 })
      const line = await run({ env, fetchText, now: at(5), out: (text) => printed.push(text) })

      assert.equal(line.sampleSize, 40, "task 1's window, measured")
      assert.match(line.notes, /unreachable targets=1/)
      assert.match(printed.join('\n'), /did not answer/)
      assert.match(printed.join('\n'), /gk-task-2\.example\.com/)
      assert.equal(
        fs.readFileSync(path.join(dir, 'scene-participants.jsonl'), 'utf8').trim().split('\n').length,
        2,
        'a moved address must not delete a run from the evidence'
      )
    })
  })

  test('an unreachable target keeps its last known counters, so its return is not a lifetime jump', async () => {
    await withTempDir(async (dir) => {
      const env = { OUT_DIR: dir, GATEKEEPER_METRICS_URL: `${TASK_A}, ${TASK_B}` }
      const texts = {
        [TASK_A]: metricsText({ diff: 0, compares: 100 }),
        [TASK_B]: metricsText({ diff: 0, compares: 500 })
      }
      const fetchText = async (url) => {
        if (texts[url] === undefined) {
          throw refused(url)
        }
        return texts[url]
      }
      const at = (minute) => () => new Date(`2026-09-05T10:0${minute}:00.000Z`)

      await run({ env, fetchText, now: at(0), out: () => {} })
      delete texts[TASK_B]
      await run({ env, fetchText, now: at(5), out: () => {} })

      // Task 2 answers again from the same process: 30 comparisons since its last scrape, not 530.
      texts[TASK_B] = metricsText({ diff: 0, compares: 530 })
      const line = await run({ env, fetchText, now: at(9), out: () => {} })

      assert.equal(line.sampleSize, 30)
      assert.doesNotMatch(line.notes, /new targets/, 'a target that came back is not a new target')
    })
  })

  test('every target unreachable fails the run: that is not a moved task, it is no data', async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(
        () =>
          run({
            env: { OUT_DIR: dir, GATEKEEPER_METRICS_URL: `${TASK_A}, ${TASK_B}` },
            fetchText: async (url) => {
              throw refused(url)
            },
            now: () => new Date('2026-09-05T10:00:00.000Z'),
            out: () => {}
          }),
        /no scrape target answered/
      )
    })
  })

  test('a 401 fails the run, because a bad token is wrong for every target', async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(
        () =>
          run({
            env: { OUT_DIR: dir, GATEKEEPER_METRICS_URL: `${TASK_A}, ${TASK_B}` },
            fetchText: async (url) => {
              if (url === TASK_A) {
                const error = new Error(`GET ${url} answered 401`)
                error.status = 401
                throw error
              }
              return metricsText({ diff: 1, compares: 10 })
            },
            now: () => new Date('2026-09-05T10:00:00.000Z'),
            out: () => {}
          }),
        /answered 401/
      )
    })
  })
})
