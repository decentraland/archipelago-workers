'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test, describe } = require('node:test')

const hotScenes = require('../src/diffs/hot-scenes')
const liveData = require('../src/diffs/live-data')
const sceneParticipants = require('../src/diffs/scene-participants')

const fixture = (...parts) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', ...parts), 'utf8'))

const REALMS = fixture('iteration-2', 'http', 'realms.json').body
const LIVE_DATA = fixture('live-data.json').body
const STATS_HOT_SCENES = fixture('iteration-2', 'http', 'today', 'hot-scenes.json').body
const GATEKEEPER_HOT_SCENES = fixture('hot-scenes-gatekeeper.json').body
const METRICS = fs.readFileSync(path.join(__dirname, 'fixtures', 'gatekeeper-metrics.txt'), 'utf8')

const withTempDir = (body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-diff-'))
  try {
    return body(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const serve = (routes) => {
  const requested = []
  const fetchJson = async (url) => {
    requested.push(url)
    if (!(url in routes)) {
      throw new Error(`no fixture for ${url}`)
    }
    return routes[url]
  }
  return { requested, fetchJson }
}

describe('live-data run', () => {
  test('GETs both endpoints and writes one line', async () => {
    await withTempDir(async (dir) => {
      const { requested, fetchJson } = serve({
        'https://worlds.example.com/live-data': LIVE_DATA,
        'https://pulse.example.com/realms': REALMS
      })
      const printed = []

      const line = await liveData.run({
        env: {
          OUT_DIR: dir,
          SHADOW_DIFF_ENV: 'zone',
          WCS_URL: 'https://worlds.example.com',
          PULSE_URL: 'https://pulse.example.com'
        },
        fetchJson,
        now: () => new Date('2026-09-05T10:00:00.000Z'),
        out: (text) => printed.push(text)
      })

      assert.deepEqual(requested, ['https://worlds.example.com/live-data', 'https://pulse.example.com/realms'])
      assert.equal(line.diff, 'live-data')
      assert.deepEqual([line.sampleSize, line.agree, line.onlyLegacy, line.onlyPulse], [2, 1, 1, 0])
      assert.equal(line.withinTolerance, false)
      assert.ok(printed.length > 0)

      const written = fs.readFileSync(path.join(dir, 'live-data.jsonl'), 'utf8').trim()
      assert.deepEqual(JSON.parse(written), line)
    })
  })

  test('a trailing slash on either base URL does not double up the path', async () => {
    await withTempDir(async (dir) => {
      const { requested, fetchJson } = serve({
        'https://worlds.example.com/live-data': LIVE_DATA,
        'https://pulse.example.com/realms': REALMS
      })
      await liveData.run({
        env: { OUT_DIR: dir, WCS_URL: 'https://worlds.example.com/', PULSE_URL: 'https://pulse.example.com/' },
        fetchJson,
        now: () => new Date('2026-09-05T10:00:00.000Z'),
        out: () => {}
      })
      assert.deepEqual(requested, ['https://worlds.example.com/live-data', 'https://pulse.example.com/realms'])
    })
  })

  test('the environment label defaults to zone', async () => {
    await withTempDir(async (dir) => {
      const { fetchJson } = serve({
        'https://worlds.example.com/live-data': LIVE_DATA,
        'https://pulse.example.com/realms': REALMS
      })
      const line = await liveData.run({
        env: { OUT_DIR: dir, WCS_URL: 'https://worlds.example.com', PULSE_URL: 'https://pulse.example.com' },
        fetchJson,
        now: () => new Date('2026-09-05T10:00:00.000Z'),
        out: () => {}
      })
      assert.equal(line.env, 'zone')
    })
  })

  test('missing URLs stop the run before any request', async () => {
    await withTempDir(async (dir) => {
      const { requested, fetchJson } = serve({})
      await assert.rejects(() => liveData.run({ env: { OUT_DIR: dir }, fetchJson }), /WCS_URL/)
      await assert.rejects(
        () => liveData.run({ env: { OUT_DIR: dir, WCS_URL: 'https://worlds.example.com' }, fetchJson }),
        /PULSE_URL/
      )
      assert.equal(requested.length, 0)
    })
  })

  test('the per-diff tolerance override reaches the line', async () => {
    await withTempDir(async (dir) => {
      const { fetchJson } = serve({
        'https://worlds.example.com/live-data': LIVE_DATA,
        'https://pulse.example.com/realms': REALMS
      })
      const line = await liveData.run({
        env: {
          OUT_DIR: dir,
          WCS_URL: 'https://worlds.example.com',
          PULSE_URL: 'https://pulse.example.com',
          MAX_DISAGREE_RATIO_LIVE_DATA: '0.6'
        },
        fetchJson,
        now: () => new Date('2026-09-05T10:00:00.000Z'),
        out: () => {}
      })
      assert.deepEqual(line.tolerance, { maxDisagreeRatio: 0.6 })
      assert.equal(line.withinTolerance, true)
    })
  })
})

describe('hot-scenes run', () => {
  test('GETs both /hot-scenes and writes one line', async () => {
    await withTempDir(async (dir) => {
      const { requested, fetchJson } = serve({
        'https://stats.example.com/hot-scenes': STATS_HOT_SCENES,
        'https://gatekeeper.example.com/hot-scenes': GATEKEEPER_HOT_SCENES
      })

      const line = await hotScenes.run({
        env: {
          OUT_DIR: dir,
          SHADOW_DIFF_ENV: 'org',
          STATS_URL: 'https://stats.example.com',
          GATEKEEPER_URL: 'https://gatekeeper.example.com'
        },
        fetchJson,
        now: () => new Date('2026-09-05T10:00:00.000Z'),
        out: () => {}
      })

      assert.deepEqual(requested, [
        'https://stats.example.com/hot-scenes',
        'https://gatekeeper.example.com/hot-scenes'
      ])
      assert.equal(line.diff, 'hot-scenes')
      assert.equal(line.env, 'org')
      assert.deepEqual([line.sampleSize, line.agree, line.onlyLegacy, line.onlyPulse], [2, 0, 0, 1])
      assert.match(line.notes, /jaccard=0\.500/)
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'hot-scenes.jsonl'), 'utf8').trim()), line)
    })
  })

  test('missing URLs stop the run', async () => {
    await withTempDir(async (dir) => {
      const { fetchJson } = serve({})
      await assert.rejects(() => hotScenes.run({ env: { OUT_DIR: dir }, fetchJson }), /STATS_URL/)
      await assert.rejects(
        () => hotScenes.run({ env: { OUT_DIR: dir, STATS_URL: 'https://stats.example.com' }, fetchJson }),
        /GATEKEEPER_URL/
      )
    })
  })
})

describe('hot-scenes against a warming gatekeeper', () => {
  const warming = () => {
    const error = new Error('GET https://gatekeeper.example.com/hot-scenes answered 503')
    error.status = 503
    return error
  }

  test('a 503 warming writes an empty-sample line instead of leaving a hole in the window', async () => {
    await withTempDir(async (dir) => {
      // gatekeeper answers 503 {"ok":false,"error":"warming"} until the presence map and the
      // ranking are both ready, i.e. during every deploy. Throwing wrote nothing, and the gate's
      // first step reads a gap in `runs` as "the cron was down".
      const line = await hotScenes.run({
        env: { OUT_DIR: dir, STATS_URL: 'https://stats.example.com', GATEKEEPER_URL: 'https://gatekeeper.example.com' },
        fetchJson: async (url) => {
          if (url.startsWith('https://gatekeeper')) {
            throw warming()
          }
          return STATS_HOT_SCENES
        },
        now: () => new Date('2026-09-05T10:00:00.000Z'),
        out: () => {}
      })

      assert.equal(line.sampleSize, 0)
      assert.equal(line.agree, 0)
      assert.equal(line.withinTolerance, false, 'no sample is not agreement')
      assert.match(line.notes, /gatekeeper warming \(503\)/)
      assert.equal(fs.readFileSync(path.join(dir, 'hot-scenes.jsonl'), 'utf8').trim().split('\n').length, 1)
    })
  })

  test('any other failure is still a failure', async () => {
    await withTempDir(async (dir) => {
      const boom = new Error('GET https://gatekeeper.example.com/hot-scenes answered 500')
      boom.status = 500
      await assert.rejects(
        () =>
          hotScenes.run({
            env: {
              OUT_DIR: dir,
              STATS_URL: 'https://stats.example.com',
              GATEKEEPER_URL: 'https://gatekeeper.example.com'
            },
            fetchJson: async (url) => {
              if (url.startsWith('https://gatekeeper')) {
                throw boom
              }
              return STATS_HOT_SCENES
            },
            now: () => new Date('2026-09-05T10:00:00.000Z'),
            out: () => {}
          }),
        /answered 500/
      )
    })
  })
})

describe('bearer tokens on the fetched endpoints', () => {
  test('each URL gets its own token, and no endpoint inherits another credential', async () => {
    await withTempDir(async (dir) => {
      const calls = []
      const capture = (routes) => async (url, options) => {
        calls.push({ url, headers: options === undefined ? undefined : options.headers })
        return routes[url]
      }

      await liveData.run({
        env: {
          OUT_DIR: dir,
          WCS_URL: 'https://worlds.example.com',
          PULSE_URL: 'https://pulse.example.com',
          WCS_TOKEN: 'wcs-token-0000',
          METRICS_BEARER_TOKEN: 'shared-token-0000'
        },
        fetchJson: capture({
          'https://worlds.example.com/live-data': LIVE_DATA,
          'https://pulse.example.com/realms': REALMS
        }),
        now: () => new Date('2026-09-05T10:00:00.000Z'),
        out: () => {}
      })

      await hotScenes.run({
        env: {
          OUT_DIR: dir,
          STATS_URL: 'https://stats.example.com',
          GATEKEEPER_URL: 'https://gatekeeper.example.com',
          GATEKEEPER_TOKEN: 'gk-token-0000'
        },
        fetchJson: capture({
          'https://stats.example.com/hot-scenes': STATS_HOT_SCENES,
          'https://gatekeeper.example.com/hot-scenes': GATEKEEPER_HOT_SCENES
        }),
        now: () => new Date('2026-09-05T10:00:00.000Z'),
        out: () => {}
      })

      // METRICS_BEARER_TOKEN is gatekeeper's /metrics credential. Pulse's /realms, WCS's
      // /live-data and the stats /hot-scenes are unauthenticated public endpoints, and handing
      // them a credential they never asked for spreads it to three more services and their
      // access logs.
      assert.deepEqual(
        calls.map((call) => [call.url, call.headers.authorization]),
        [
          ['https://worlds.example.com/live-data', 'Bearer wcs-token-0000'],
          ['https://pulse.example.com/realms', undefined],
          ['https://stats.example.com/hot-scenes', undefined],
          ['https://gatekeeper.example.com/hot-scenes', 'Bearer gk-token-0000']
        ]
      )
    })
  })

  test("gatekeeper's metrics token is not sent to the WCS, Pulse or stats URLs", async () => {
    await withTempDir(async (dir) => {
      const calls = []
      const capture = (routes) => async (url, options) => {
        calls.push({ url, headers: options === undefined ? {} : (options.headers ?? {}) })
        return routes[url]
      }
      const now = () => new Date('2026-09-05T10:00:00.000Z')
      // Both spellings of the one credential an operator actually holds.
      const secrets = { GATEKEEPER_METRICS_TOKEN: 'gk-metrics-0000', METRICS_BEARER_TOKEN: 'gk-metrics-0000' }

      await sceneParticipants.run({
        env: { OUT_DIR: dir, GATEKEEPER_METRICS_URL: 'https://gatekeeper.example.com/metrics', ...secrets },
        fetchText: async (url, options) => {
          calls.push({ url, headers: options.headers ?? {} })
          return METRICS
        },
        now,
        out: () => {}
      })

      await liveData.run({
        env: { OUT_DIR: dir, WCS_URL: 'https://worlds.example.com', PULSE_URL: 'https://pulse.example.com', ...secrets },
        fetchJson: capture({
          'https://worlds.example.com/live-data': LIVE_DATA,
          'https://pulse.example.com/realms': REALMS
        }),
        now,
        out: () => {}
      })

      await hotScenes.run({
        env: {
          OUT_DIR: dir,
          STATS_URL: 'https://stats.example.com',
          GATEKEEPER_URL: 'https://gatekeeper.example.com',
          ...secrets
        },
        fetchJson: capture({
          'https://stats.example.com/hot-scenes': STATS_HOT_SCENES,
          'https://gatekeeper.example.com/hot-scenes': GATEKEEPER_HOT_SCENES
        }),
        now,
        out: () => {}
      })

      const sent = new Map(calls.map((call) => [call.url, call.headers.authorization]))
      assert.equal(sent.get('https://gatekeeper.example.com/metrics'), 'Bearer gk-metrics-0000')
      for (const url of [
        'https://worlds.example.com/live-data',
        'https://pulse.example.com/realms',
        'https://stats.example.com/hot-scenes',
        'https://gatekeeper.example.com/hot-scenes'
      ]) {
        assert.equal(sent.get(url), undefined, `${url} received a credential it never asked for`)
      }

      // ... unless the operator says so explicitly, which is the documented single-credential case.
      calls.length = 0
      await liveData.run({
        env: {
          OUT_DIR: dir,
          WCS_URL: 'https://worlds.example.com',
          PULSE_URL: 'https://pulse.example.com',
          SHADOW_SHARED_BEARER_TOKEN: '1',
          ...secrets
        },
        fetchJson: capture({
          'https://worlds.example.com/live-data': LIVE_DATA,
          'https://pulse.example.com/realms': REALMS
        }),
        now,
        out: () => {}
      })
      assert.deepEqual(
        calls.map((call) => call.headers.authorization),
        ['Bearer gk-metrics-0000', 'Bearer gk-metrics-0000']
      )
    })
  })
})

describe('the output directory', () => {
  test('defaults to ./out under the harness when OUT_DIR is unset', () => {
    const { resolveOutDir } = require('../src/report')
    assert.equal(resolveOutDir({}), path.join(path.dirname(__dirname), 'out'))
    assert.equal(resolveOutDir({ OUT_DIR: '/var/log/shadow' }), '/var/log/shadow')
  })
})
