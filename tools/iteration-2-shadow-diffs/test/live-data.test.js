'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, describe } = require('node:test')

const { EXPLAINED_BY, compareLiveData } = require('../src/diffs/live-data')
const { buildReportLine } = require('../src/report')

const fixture = (...parts) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', ...parts), 'utf8'))

// The pack's Pulse-side golden and the hand-written LiveKit-side answer for the same peer set.
const REALMS = fixture('iteration-2', 'http', 'realms.json').body
const LIVE_DATA = fixture('live-data.json').body

describe('live-data: worlds-content-server /live-data vs Pulse /realms', () => {
  test('compares the pack /realms golden against the hand-written /live-data body', () => {
    const result = compareLiveData(LIVE_DATA, REALMS)

    // Union of world names: cozyfarm.dcl.eth (both, 1 user each) and quiet.dcl.eth (LiveKit only).
    assert.equal(result.sampleSize, 2)
    assert.equal(result.agree, 1)
    assert.equal(result.onlyLegacy, 1)
    assert.equal(result.onlyPulse, 0)
  })

  test('the /realms realm list is filtered to .dcl.eth, so main is never a world', () => {
    assert.ok(REALMS.realms.some((realm) => realm.name === 'main'))
    const result = compareLiveData({ data: { perWorld: [] } }, REALMS)
    assert.equal(result.sampleSize, 1)
    assert.equal(result.onlyPulse, 1)
    assert.match(result.notes, /cozyfarm\.dcl\.eth/)
    assert.doesNotMatch(result.notes, /main/)
  })

  test('names are compared lowercased on both sides', () => {
    const result = compareLiveData(
      { data: { perWorld: [{ worldName: 'CozyFarm.DCL.eth', users: 3 }] } },
      { realms: [{ name: 'cozyfarm.dcl.eth', peers: 3 }] }
    )
    assert.deepEqual(
      { sampleSize: result.sampleSize, agree: result.agree, onlyLegacy: result.onlyLegacy, onlyPulse: result.onlyPulse },
      { sampleSize: 1, agree: 1, onlyLegacy: 0, onlyPulse: 0 }
    )
  })

  test('a world both sides list but count differently is a disagreement, not a membership diff', () => {
    const result = compareLiveData(
      { data: { perWorld: [{ worldName: 'cozyfarm.dcl.eth', users: 5 }] } },
      { realms: [{ name: 'cozyfarm.dcl.eth', peers: 3 }] }
    )
    assert.equal(result.sampleSize, 1)
    assert.equal(result.agree, 0)
    assert.equal(result.onlyLegacy, 0)
    assert.equal(result.onlyPulse, 0)
    assert.equal(result.usersMismatch, 1)
    assert.equal(result.maxUsersDelta, 2)
    assert.match(result.notes, /cozyfarm\.dcl\.eth/)
  })

  test('reports the symmetric difference of names in the notes, bounded in length', () => {
    const legacyOnly = Array.from({ length: 40 }, (_, i) => ({ worldName: `w${i}.dcl.eth`, users: 1 }))
    const result = compareLiveData({ data: { perWorld: legacyOnly } }, { realms: [] })
    assert.equal(result.onlyLegacy, 40)
    assert.ok(result.notes.length < 400, `notes were ${result.notes.length} chars`)
    assert.match(result.notes, /\+ 3[0-9] more|more/)
  })

  test('falls back to /status details when /live-data has no data.perWorld', () => {
    const result = compareLiveData(
      { data: { totalUsers: 1, details: [{ worldName: 'cozyfarm.dcl.eth', users: 1 }] } },
      { realms: [{ name: 'cozyfarm.dcl.eth', peers: 1 }] }
    )
    assert.equal(result.sampleSize, 1)
    assert.equal(result.agree, 1)
  })

  test('a malformed entry is skipped and counted, never thrown on', () => {
    const result = compareLiveData(
      { data: { perWorld: [{ users: 4 }, null, { worldName: 'cozyfarm.dcl.eth' }] } },
      { realms: [{ name: 'cozyfarm.dcl.eth', peers: 0 }] }
    )
    assert.equal(result.sampleSize, 1)
    assert.equal(result.agree, 1)
    assert.equal(result.malformed, 2)
    assert.match(result.notes, /malformed=2/)
  })

  test('both sides empty is an empty sample, not a crash', () => {
    const result = compareLiveData({ data: { perWorld: [] } }, { realms: [] })
    assert.equal(result.sampleSize, 0)
    assert.equal(result.agree, 0)
  })

  test('a missing body is a hard error, not a silent all-agree', () => {
    assert.throws(() => compareLiveData(undefined, REALMS), /live-data/i)
    assert.throws(() => compareLiveData(LIVE_DATA, undefined), /realms/i)
    assert.throws(() => compareLiveData(LIVE_DATA, { realms: 'nope' }), /realms/i)
  })

  test('the counts feed the shared report line unchanged', () => {
    const result = compareLiveData(LIVE_DATA, REALMS)
    const line = buildReportLine({
      diff: 'live-data',
      at: '2026-09-05T10:00:00.000Z',
      env: 'zone',
      sampleSize: result.sampleSize,
      agree: result.agree,
      onlyLegacy: result.onlyLegacy,
      onlyPulse: result.onlyPulse,
      tolerance: { maxDisagreeRatio: 0.05 },
      explainedBy: EXPLAINED_BY,
      notes: result.notes
    })
    assert.equal(line.withinTolerance, false)
    assert.deepEqual(line.explainedBy, [
      'no-comms peers visible to Pulse',
      '<= 2 s batching',
      '~5 s vs webhook latency'
    ])
  })
})
