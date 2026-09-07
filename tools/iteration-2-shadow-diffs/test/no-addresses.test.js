'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test, describe } = require('node:test')

const hotScenes = require('../src/diffs/hot-scenes')
const liveData = require('../src/diffs/live-data')
const onlineSet = require('../src/diffs/online-set')
const sceneParticipants = require('../src/diffs/scene-participants')
const { DIFF_NAMES, formatHumanSummary } = require('../src/report')
const { summarizeByEnv, toMarkdownTable } = require('../src/summarize')

// Any 0x-prefixed hex run of 8 or more nibbles: long enough to skip 0x0 style literals, short
// enough to catch a truncated or hashed wallet as well as a full 40-nibble one.
const HEX_RUN = /0x[0-9a-fA-F]{8,}/

const wallet = (n) => `0x${n.toString(16).padStart(40, '0')}`

const withTempDir = (body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-diff-'))
  try {
    return body(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('no addresses in any output (WP10-no-addresses-in-output)', () => {
  test('all four diffs write and print output free of wallet addresses', async () => {
    await withTempDir(async (dir) => {
      const printed = []
      const out = (text) => printed.push(text)
      const now = () => new Date('2026-09-05T10:00:00.000Z')

      // Every source below carries wallets, in the places a real answer would.
      await sceneParticipants.run({
        env: { OUT_DIR: dir, GATEKEEPER_METRICS_URL: 'https://gatekeeper.example.com/metrics' },
        fetchText: async () =>
          [
            'presence_shadow_diff{kind="land"} 3',
            'presence_shadow_diff{kind="world"} 1',
            `http_requests_total{method="GET",handler="/scene-participants",code="200",peer="${wallet(1)}"} 200`,
            ''
          ].join('\n'),
        now,
        out
      })

      await liveData.run({
        env: { OUT_DIR: dir, WCS_URL: 'https://worlds.example.com', PULSE_URL: 'https://pulse.example.com' },
        fetchJson: async (url) =>
          url.endsWith('/live-data')
            ? { data: { perWorld: [{ worldName: 'cozyfarm.dcl.eth', users: 1, owner: wallet(3) }] } }
            : { realms: [{ name: 'cozyfarm.dcl.eth', peers: 2, peersList: [wallet(3), wallet(4)] }] },
        now,
        out
      })

      await onlineSet.run({
        env: {
          OUT_DIR: dir,
          REDIS_URL: 'redis://redis.example.com:6379',
          PEERS_CACHE_KEY: 'peers:online',
          PEERS_CACHE_KEY_PULSE: 'peers:online:pulse'
        },
        readSet: async (_url, key) => (key.endsWith(':pulse') ? [wallet(2), wallet(7)] : [wallet(1), wallet(2)]),
        now,
        out
      })

      await hotScenes.run({
        env: { OUT_DIR: dir, STATS_URL: 'https://stats.example.com', GATEKEEPER_URL: 'https://gatekeeper.example.com' },
        fetchJson: async (url) =>
          url.startsWith('https://stats')
            ? [{ id: 'scene-a', name: 'A', usersTotalCount: 4, parcels: [[0, 0]], realmsDetail: [{ users: [wallet(5)] }] }]
            : [{ id: 'scene-a', name: 'A', usersTotalCount: 3, parcels: [[0, 0]] }],
        now,
        out
      })

      for (const diff of DIFF_NAMES) {
        const file = path.join(dir, `${diff}.jsonl`)
        const written = fs.readFileSync(file, 'utf8')
        assert.doesNotMatch(written, HEX_RUN, `${diff}.jsonl leaked an address`)
      }

      assert.doesNotMatch(printed.join('\n'), HEX_RUN, 'stdout leaked an address')
    })
  })

  test('the summary and its Markdown table carry no addresses either', () => {
    withTempDir((dir) => {
      const line = {
        diff: 'online-set',
        at: '2026-09-05T10:00:00.000Z',
        env: 'zone',
        sampleSize: 3,
        agree: 1,
        onlyLegacy: 1,
        onlyPulse: 1,
        tolerance: { maxDisagreeRatio: 0.05 },
        withinTolerance: false,
        explainedBy: ['no-comms peers visible to Pulse'],
        notes: 'legacy=2 pulse=2'
      }
      fs.writeFileSync(path.join(dir, 'online-set.jsonl'), `${JSON.stringify(line)}\n`)

      const rows = summarizeByEnv([line], { diff: 'online-set', now: new Date('2026-09-05T11:00:00.000Z') })
      const table = toMarkdownTable(rows, { diff: 'online-set', now: new Date('2026-09-05T11:00:00.000Z'), windowDays: 7 })

      assert.doesNotMatch(table, HEX_RUN)
      assert.doesNotMatch(formatHumanSummary(line), HEX_RUN)
      assert.doesNotMatch(JSON.stringify(rows), HEX_RUN)
    })
  })
})
