'use strict'

// `explainedBy` is what the cut-over gate's third step is read against ("the symmetric difference is
// explained only by the documented semantic shifts"), so the wording is pinned here rather than
// left to drift per diff. The brief pins three entries verbatim; each diff may add the shifts that
// are about its own mechanism, after them and in that order.

const assert = require('node:assert/strict')
const { test, describe } = require('node:test')

const hotScenes = require('../src/diffs/hot-scenes')
const liveData = require('../src/diffs/live-data')
const onlineSet = require('../src/diffs/online-set')
const sceneParticipants = require('../src/diffs/scene-participants')

const BRIEF = ['no-comms peers visible to Pulse', '<= 2 s batching', '~5 s vs webhook latency']

const DIFFS = [sceneParticipants, liveData, onlineSet, hotScenes]

describe('explainedBy (WP10-same-report-format)', () => {
  test('every diff opens with the brief three, in the brief order and the brief wording', () => {
    for (const diff of DIFFS) {
      assert.deepEqual(diff.EXPLAINED_BY.slice(0, 3), BRIEF, `${diff.DIFF} drifted from the brief`)
    }
  })

  test('each diff adds only the shifts that are about its own mechanism', () => {
    assert.deepEqual(liveData.EXPLAINED_BY, BRIEF)

    assert.deepEqual(sceneParticipants.EXPLAINED_BY, [
      ...BRIEF,
      'the ban filter is applied to the presence-map answer only'
    ])

    assert.deepEqual(onlineSet.EXPLAINED_BY, [
      ...BRIEF,
      'heartbeat TTL expiry vs a feed exit entry',
      'an input-idle client still ACKing the transport'
    ])

    assert.deepEqual(hotScenes.EXPLAINED_BY, [
      ...BRIEF,
      'up to 10 s HOT_SCENES_REFRESH_MS window',
      '300 s HOT_SCENES_SCENE_TTL_MS keeps a draining scene listed'
    ])
  })

  test('no entry is repeated and none is empty', () => {
    for (const diff of DIFFS) {
      assert.deepEqual([...new Set(diff.EXPLAINED_BY)], diff.EXPLAINED_BY, `${diff.DIFF} repeats an entry`)
      assert.ok(
        diff.EXPLAINED_BY.every((entry) => typeof entry === 'string' && entry.trim() !== ''),
        `${diff.DIFF} carries an empty entry`
      )
    }
  })
})
