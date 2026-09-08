'use strict'

// Diff 4 -- archipelago-stats `/hot-scenes` vs comms-gatekeeper `/hot-scenes`. Top-100 Jaccard over
// scene ids plus the per-scene `usersTotalCount` delta, sampled every run.

const { authHeaders, fetchJson: defaultFetchJson, joinUrl, requireEnv } = require('../http')
const { boundedList, joinNotes } = require('../notes')
const { finishRun } = require('../finish-run')

const DIFF = 'hot-scenes'

// comms-gatekeeper answers `503 {"ok":false,"error":"warming"}` until the presence map and the
// ranking are both ready, i.e. during every deploy. Throwing there wrote no line and left a hole
// the gate's first step reads as "the cron was down", so a warm-up is recorded as what it is: a run
// with no sample. An empty sample is never within tolerance, so it cannot pad the window either.
const WARMING_NOTE = 'gatekeeper warming (503)'
const WARMING_STATUS = 503

// `/hot-scenes` answers at most 100 entries, so anything below the cut-off is not in either answer
// and cannot be diffed.
const TOP_N = 100

// The three the brief pins, verbatim, then this diff's own shifts (test/explained-by.test.js).
const EXPLAINED_BY = [
  'no-comms peers visible to Pulse',
  '<= 2 s batching',
  '~5 s vs webhook latency',
  'up to 10 s HOT_SCENES_REFRESH_MS window',
  '300 s HOT_SCENES_SCENE_TTL_MS keeps a draining scene listed'
]

const toUsers = (value) => {
  const users = Number(value)
  return Number.isFinite(users) ? users : 0
}

// First occurrence of an id wins, then sort by users desc and keep the top N -- the same cut-off
// both services apply, so a difference below it is out of the sample by construction.
const collect = (body, side, topN) => {
  if (!Array.isArray(body)) {
    throw new Error(`the ${side} /hot-scenes body must be a bare array of scenes`)
  }
  const scenes = new Map()
  let malformed = 0
  for (const entry of body) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.trim() === '') {
      malformed += 1
      continue
    }
    const id = entry.id.trim()
    if (!scenes.has(id)) {
      scenes.set(id, toUsers(entry.usersTotalCount))
    }
  }
  const top = new Map([...scenes.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN))
  return { scenes: top, malformed }
}

const compareHotScenes = (statsBody, gatekeeperBody, options = {}) => {
  const topN = options.topN ?? TOP_N
  const legacy = collect(statsBody, 'stats', topN)
  const pulse = collect(gatekeeperBody, 'gatekeeper', topN)

  const onlyLegacyIds = []
  const onlyPulseIds = []
  let agree = 0
  let shared = 0
  let usersMismatch = 0
  let maxUsersDelta = 0
  let worst
  let hottest
  let hottestUsers = -Infinity

  const ids = new Set([...legacy.scenes.keys(), ...pulse.scenes.keys()])
  for (const id of ids) {
    const legacyUsers = legacy.scenes.get(id)
    const pulseUsers = pulse.scenes.get(id)
    const users = Math.max(legacyUsers ?? -Infinity, pulseUsers ?? -Infinity)
    if (users > hottestUsers) {
      hottestUsers = users
      hottest = id
    }
    if (legacyUsers === undefined) {
      onlyPulseIds.push(id)
      continue
    }
    if (pulseUsers === undefined) {
      onlyLegacyIds.push(id)
      continue
    }
    shared += 1
    if (legacyUsers === pulseUsers) {
      agree += 1
      continue
    }
    usersMismatch += 1
    const delta = Math.abs(legacyUsers - pulseUsers)
    if (delta > maxUsersDelta) {
      maxUsersDelta = delta
      worst = id
    }
  }

  // Two empty answers agree completely: there is nothing either side is missing.
  const jaccard = ids.size === 0 ? 1 : shared / ids.size
  const malformed = legacy.malformed + pulse.malformed

  const notes = joinNotes([
    `jaccard=${jaccard.toFixed(3)} sampled=top${topN} legacy=${legacy.scenes.size} pulse=${pulse.scenes.size}` +
      (malformed > 0 ? ` malformed=${malformed}` : '') +
      (hottest === undefined ? '' : ` hottest=${hottest}`) +
      (usersMismatch > 0 ? ` usersMismatch=${usersMismatch} maxUsersDelta=${maxUsersDelta}` : ''),
    worst === undefined ? undefined : `worst: ${worst}`,
    onlyLegacyIds.length > 0 ? `onlyLegacy: ${boundedList(onlyLegacyIds, 3)}` : undefined,
    onlyPulseIds.length > 0 ? `onlyPulse: ${boundedList(onlyPulseIds, 3)}` : undefined
  ])

  return {
    sampleSize: ids.size,
    agree,
    onlyLegacy: onlyLegacyIds.length,
    onlyPulse: onlyPulseIds.length,
    usersMismatch,
    maxUsersDelta,
    jaccard,
    malformed,
    notes
  }
}

const run = async ({ env = {}, fetchJson = defaultFetchJson, now, out } = {}) => {
  const statsUrl = requireEnv(env, 'STATS_URL')
  const gatekeeperUrl = requireEnv(env, 'GATEKEEPER_URL')

  const statsBody = await fetchJson(joinUrl(statsUrl, '/hot-scenes'), { headers: authHeaders(env, 'STATS_URL') })

  let gatekeeperBody
  try {
    gatekeeperBody = await fetchJson(joinUrl(gatekeeperUrl, '/hot-scenes'), {
      headers: authHeaders(env, 'GATEKEEPER_URL')
    })
  } catch (error) {
    if (error === null || error === undefined || error.status !== WARMING_STATUS) {
      throw error
    }
    return finishRun({
      diff: DIFF,
      env,
      now,
      out,
      counts: { sampleSize: 0, agree: 0, onlyLegacy: 0, onlyPulse: 0 },
      explainedBy: EXPLAINED_BY,
      notes: WARMING_NOTE
    })
  }

  const result = compareHotScenes(statsBody, gatekeeperBody)
  return finishRun({ diff: DIFF, env, now, out, counts: result, explainedBy: EXPLAINED_BY, notes: result.notes })
}

module.exports = { DIFF, EXPLAINED_BY, TOP_N, WARMING_NOTE, WARMING_STATUS, compareHotScenes, run }
