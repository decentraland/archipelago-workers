'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test, describe } = require('node:test')

const hotScenes = require('../src/diffs/hot-scenes')
const liveData = require('../src/diffs/live-data')

const fixture = (...parts) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', ...parts), 'utf8'))

const REALMS = fixture('iteration-2', 'http', 'realms.json').body
const LIVE_DATA = fixture('live-data.json').body
const STATS_HOT_SCENES = fixture('iteration-2', 'http', 'today', 'hot-scenes.json').body
const GATEKEEPER_HOT_SCENES = fixture('hot-scenes-gatekeeper.json').body

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

describe('bearer tokens on the fetched endpoints', () => {
  test('each URL gets its own token, with one shared token as the fallback', async () => {
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

      assert.deepEqual(
        calls.map((call) => [call.url, call.headers.authorization]),
        [
          ['https://worlds.example.com/live-data', 'Bearer wcs-token-0000'],
          ['https://pulse.example.com/realms', 'Bearer shared-token-0000'],
          ['https://stats.example.com/hot-scenes', undefined],
          ['https://gatekeeper.example.com/hot-scenes', 'Bearer gk-token-0000']
        ]
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
