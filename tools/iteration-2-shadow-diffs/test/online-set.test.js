'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test, describe } = require('node:test')

const { compareOnlineSets, run } = require('../src/diffs/online-set')

// Synthetic wallets, shaped like the pack's peer set. They must never reach the harness output.
const wallet = (n) => `0x${n.toString(16).padStart(40, '0')}`
const LEGACY = [wallet(1), wallet(2), wallet(3), wallet(4)]
const PULSE = [wallet(2), wallet(3), wallet(4), wallet(7)]

const withTempDir = (body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-diff-'))
  try {
    return body(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('online-set: PEERS_CACHE_KEY vs PEERS_CACHE_KEY_PULSE', () => {
  test('reports |A \\ B|, |B \\ A| and |A n B| over the union', () => {
    const result = compareOnlineSets(LEGACY, PULSE)
    assert.equal(result.onlyLegacy, 1)
    assert.equal(result.onlyPulse, 1)
    assert.equal(result.agree, 3)
    assert.equal(result.sampleSize, 5)
  })

  test('never returns or names a member', () => {
    const result = compareOnlineSets(LEGACY, PULSE)
    assert.deepEqual(Object.keys(result).sort(), ['agree', 'notes', 'onlyLegacy', 'onlyPulse', 'sampleSize'])
    assert.doesNotMatch(JSON.stringify(result), /0x[0-9a-fA-F]{4}/)
  })

  test('identical sets are a full agreement', () => {
    const result = compareOnlineSets(LEGACY, [...LEGACY].reverse())
    assert.deepEqual(
      { sampleSize: result.sampleSize, agree: result.agree, onlyLegacy: result.onlyLegacy, onlyPulse: result.onlyPulse },
      { sampleSize: 4, agree: 4, onlyLegacy: 0, onlyPulse: 0 }
    )
  })

  test('two empty sets are an empty sample', () => {
    const result = compareOnlineSets([], [])
    assert.equal(result.sampleSize, 0)
    assert.equal(result.agree, 0)
  })

  test('members are compared case-insensitively and trimmed, and de-duplicated', () => {
    const result = compareOnlineSets([' 0xAB ', '0xab'], ['0xAB'])
    assert.equal(result.sampleSize, 1)
    assert.equal(result.agree, 1)
    assert.equal(result.onlyLegacy, 0)
  })

  test('an empty-string member is dropped rather than counted as a peer', () => {
    const result = compareOnlineSets([wallet(1), '', '  '], [wallet(1)])
    assert.equal(result.sampleSize, 1)
    assert.equal(result.agree, 1)
  })

  test('the notes carry the set sizes only', () => {
    const result = compareOnlineSets(LEGACY, PULSE)
    assert.match(result.notes, /legacy=4/)
    assert.match(result.notes, /pulse=4/)
    assert.doesNotMatch(result.notes, /0x/)
  })

  test('a non-array read is a hard error, not an empty set', () => {
    assert.throws(() => compareOnlineSets(undefined, PULSE), /legacy/i)
    assert.throws(() => compareOnlineSets(LEGACY, 'nope'), /pulse/i)
  })
})

describe('online-set run, with an in-memory Redis', () => {
  const fakeRedis = (sets) => {
    const calls = []
    const readSet = async (url, key) => {
      calls.push({ url, key })
      if (!(key in sets)) {
        throw new Error(`fake redis has no key ${key}`)
      }
      return sets[key]
    }
    return { calls, readSet }
  }

  test('reads both configured keys and writes one report line', async () => {
    await withTempDir(async (dir) => {
      const { calls, readSet } = fakeRedis({ 'peers:online': LEGACY, 'peers:online:pulse': PULSE })
      const printed = []

      const line = await run({
        env: {
          OUT_DIR: dir,
          SHADOW_DIFF_ENV: 'zone',
          REDIS_URL: 'redis://redis.example.com:6379',
          PEERS_CACHE_KEY: 'peers:online',
          PEERS_CACHE_KEY_PULSE: 'peers:online:pulse'
        },
        readSet,
        now: () => new Date('2026-09-05T10:00:00.000Z'),
        out: (text) => printed.push(text)
      })

      assert.deepEqual(
        calls.map((call) => call.key),
        ['peers:online', 'peers:online:pulse']
      )
      assert.equal(calls[0].url, 'redis://redis.example.com:6379')

      assert.equal(line.diff, 'online-set')
      assert.equal(line.at, '2026-09-05T10:00:00.000Z')
      assert.equal(line.env, 'zone')
      assert.deepEqual([line.sampleSize, line.agree, line.onlyLegacy, line.onlyPulse], [5, 3, 1, 1])
      assert.equal(line.withinTolerance, false)

      const written = fs.readFileSync(path.join(dir, 'online-set.jsonl'), 'utf8').trim().split('\n')
      assert.equal(written.length, 1)
      assert.deepEqual(JSON.parse(written[0]), line)

      const output = written.join('\n') + printed.join('\n')
      assert.doesNotMatch(output, /0x[0-9a-fA-F]{4}/)
    })
  })

  test('a missing REDIS_URL or key name stops the run before any read', async () => {
    await withTempDir(async (dir) => {
      const { calls, readSet } = fakeRedis({})
      await assert.rejects(() => run({ env: { OUT_DIR: dir }, readSet }), /REDIS_URL/)
      await assert.rejects(
        () => run({ env: { OUT_DIR: dir, REDIS_URL: 'redis://redis.example.com:6379' }, readSet }),
        /PEERS_CACHE_KEY/
      )
      assert.equal(calls.length, 0)
    })
  })
})
