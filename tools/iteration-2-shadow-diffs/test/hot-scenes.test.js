'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, describe } = require('node:test')

const { TOP_N, compareHotScenes } = require('../src/diffs/hot-scenes')

const fixture = (...parts) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', ...parts), 'utf8'))

// The pack's probe of today's stats answer, and the hand-modified copy standing in for gatekeeper.
const STATS = fixture('iteration-2', 'http', 'today', 'hot-scenes.json').body
const GATEKEEPER = fixture('hot-scenes-gatekeeper.json').body

const scene = (id, usersTotalCount) => ({ id, name: id, baseCoords: [0, 0], usersTotalCount, parcels: [[0, 0]] })

describe('hot-scenes: stats vs gatekeeper', () => {
  test('the harness compares the top 100', () => {
    assert.equal(TOP_N, 100)
  })

  test('compares the pack probe against the modified copy', () => {
    const result = compareHotScenes(STATS, GATEKEEPER)

    // One shared scene whose count differs by 2, plus one scene only gatekeeper serves.
    assert.equal(result.sampleSize, 2)
    assert.equal(result.agree, 0)
    assert.equal(result.onlyLegacy, 0)
    assert.equal(result.onlyPulse, 1)
    assert.equal(result.usersMismatch, 1)
    assert.equal(result.maxUsersDelta, 2)
    assert.equal(result.jaccard, 0.5)
  })

  test('jaccard is intersection over union of the scene ids', () => {
    const both = compareHotScenes([scene('a', 1), scene('b', 1)], [scene('a', 1), scene('b', 1)])
    assert.equal(both.jaccard, 1)
    assert.equal(both.sampleSize, 2)
    assert.equal(both.agree, 2)

    const disjoint = compareHotScenes([scene('a', 1)], [scene('b', 1)])
    assert.equal(disjoint.jaccard, 0)
    assert.equal(disjoint.sampleSize, 2)
    assert.equal(disjoint.onlyLegacy, 1)
    assert.equal(disjoint.onlyPulse, 1)

    const partial = compareHotScenes([scene('a', 1), scene('b', 1), scene('c', 1)], [scene('a', 1), scene('b', 1)])
    assert.equal(partial.jaccard, 2 / 3)
  })

  test('two empty answers are jaccard 1 and an empty sample, never NaN', () => {
    const result = compareHotScenes([], [])
    assert.equal(result.jaccard, 1)
    assert.equal(result.sampleSize, 0)
    assert.equal(result.agree, 0)
  })

  test('only the top 100 by usersTotalCount are sampled', () => {
    const many = Array.from({ length: 150 }, (_, i) => scene(`s${i}`, 150 - i))
    const result = compareHotScenes(many, many)
    assert.equal(result.sampleSize, 100)
    assert.equal(result.agree, 100)
  })

  test('a difference below the top 100 cut-off is out of the sample', () => {
    const stats = Array.from({ length: 150 }, (_, i) => scene(`s${i}`, 150 - i))
    const gatekeeper = stats.map((s, i) => (i >= 100 ? scene(`only-gk-${i}`, 150 - i) : s))
    const result = compareHotScenes(stats, gatekeeper)
    assert.equal(result.sampleSize, 100)
    assert.equal(result.agree, 100)
    assert.equal(result.jaccard, 1)
  })

  test('an unsorted answer is sorted before the cut-off is applied', () => {
    const stats = [scene('low', 1), scene('high', 99)]
    const result = compareHotScenes(stats, [scene('high', 99), scene('low', 1)], { topN: 1 })
    assert.equal(result.sampleSize, 1)
    assert.equal(result.agree, 1)
    assert.match(result.notes, /high/)
  })

  test('a duplicate scene id is counted once', () => {
    const result = compareHotScenes([scene('a', 5), scene('a', 5)], [scene('a', 5)])
    assert.equal(result.sampleSize, 1)
    assert.equal(result.agree, 1)
  })

  test('the notes carry the jaccard and the worst per-scene delta', () => {
    const result = compareHotScenes(STATS, GATEKEEPER)
    assert.match(result.notes, /jaccard=0\.500/)
    assert.match(result.notes, /maxUsersDelta=2/)
    assert.ok(result.notes.length < 400, `notes were ${result.notes.length} chars`)
  })

  test('a malformed entry is skipped and counted, never thrown on', () => {
    const result = compareHotScenes([{ usersTotalCount: 3 }, null, scene('a', 1)], [scene('a', 1)])
    assert.equal(result.sampleSize, 1)
    assert.equal(result.agree, 1)
    assert.equal(result.malformed, 2)
    assert.match(result.notes, /malformed=2/)
  })

  test('a body that is not an array is a hard error', () => {
    assert.throws(() => compareHotScenes({ scenes: [] }, []), /hot-scenes/i)
    assert.throws(() => compareHotScenes([], undefined), /hot-scenes/i)
  })
})
