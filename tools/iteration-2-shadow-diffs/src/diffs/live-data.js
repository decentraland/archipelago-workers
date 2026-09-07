'use strict'

// Diff 2 -- worlds-content-server `/live-data` (LiveKit-fed) vs Pulse `/realms` filtered to
// `.dcl.eth`. Per-world `users` delta plus the symmetric difference of world names.

const { fetchJson: defaultFetchJson, joinUrl, requireEnv } = require('../http')
const { boundedList, joinNotes } = require('../notes')
const { finishRun } = require('../finish-run')

const DIFF = 'live-data'

// The three documented semantic shifts between a LiveKit-derived count and a Pulse-derived one.
// The cut-over gate reads: the symmetric difference is explained only by these.
const EXPLAINED_BY = ['no-comms peers visible to Pulse', '<= 2 s batching', '~5 s vs webhook latency']

const WORLD_SUFFIX = '.dcl.eth'

const toUsers = (value) => {
  const users = Number(value)
  return Number.isFinite(users) ? users : 0
}

// First occurrence wins; a repeated world name is one world, not two.
const collect = (entries, nameKey, usersKey, { worldsOnly = false } = {}) => {
  const worlds = new Map()
  let malformed = 0
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || typeof entry[nameKey] !== 'string') {
      malformed += 1
      continue
    }
    const name = entry[nameKey].trim().toLowerCase()
    if (name === '') {
      malformed += 1
      continue
    }
    if (worldsOnly && !name.endsWith(WORLD_SUFFIX)) {
      continue
    }
    if (!worlds.has(name)) {
      worlds.set(name, toUsers(entry[usersKey]))
    }
  }
  return { worlds, malformed }
}

const readLiveData = (body) => {
  const data = body === null || typeof body !== 'object' ? undefined : body.data
  const entries =
    data !== null && typeof data === 'object'
      ? (Array.isArray(data.perWorld) && data.perWorld) || (Array.isArray(data.details) && data.details) || undefined
      : undefined
  if (entries === undefined) {
    throw new Error('the /live-data body must carry data.perWorld (or data.details) as an array')
  }
  return collect(entries, 'worldName', 'users')
}

const readRealms = (body) => {
  const realms = body === null || typeof body !== 'object' ? undefined : body.realms
  if (!Array.isArray(realms)) {
    throw new Error('the /realms body must carry a realms array')
  }
  // `main` is Genesis City, not a world: /live-data only ever answers for `<name>.dcl.eth`.
  return collect(realms, 'name', 'peers', { worldsOnly: true })
}

const compareLiveData = (liveDataBody, realmsBody) => {
  const legacy = readLiveData(liveDataBody)
  const pulse = readRealms(realmsBody)

  const onlyLegacyNames = []
  const onlyPulseNames = []
  let agree = 0
  let usersMismatch = 0
  let maxUsersDelta = 0
  let worst

  const names = new Set([...legacy.worlds.keys(), ...pulse.worlds.keys()])
  for (const name of names) {
    const legacyUsers = legacy.worlds.get(name)
    const pulseUsers = pulse.worlds.get(name)
    if (legacyUsers === undefined) {
      onlyPulseNames.push(name)
      continue
    }
    if (pulseUsers === undefined) {
      onlyLegacyNames.push(name)
      continue
    }
    if (legacyUsers === pulseUsers) {
      agree += 1
      continue
    }
    usersMismatch += 1
    const delta = Math.abs(legacyUsers - pulseUsers)
    if (delta > maxUsersDelta) {
      maxUsersDelta = delta
      worst = name
    }
  }

  const malformed = legacy.malformed + pulse.malformed
  const notes = joinNotes([
    `worlds legacy=${legacy.worlds.size} pulse=${pulse.worlds.size}` +
      (malformed > 0 ? ` malformed=${malformed}` : '') +
      (usersMismatch > 0 ? ` usersMismatch=${usersMismatch} maxUsersDelta=${maxUsersDelta}` : ''),
    worst === undefined ? undefined : `worst: ${worst}`,
    onlyLegacyNames.length > 0 ? `onlyLegacy: ${boundedList(onlyLegacyNames)}` : undefined,
    onlyPulseNames.length > 0 ? `onlyPulse: ${boundedList(onlyPulseNames)}` : undefined
  ])

  return {
    // The sample is the union of world names: a world both sides list is one sample point.
    sampleSize: names.size,
    agree,
    onlyLegacy: onlyLegacyNames.length,
    onlyPulse: onlyPulseNames.length,
    usersMismatch,
    maxUsersDelta,
    malformed,
    notes
  }
}

const run = async ({ env = {}, fetchJson = defaultFetchJson, now, out } = {}) => {
  // Both URLs are checked before either request: a half-run writes a misleading line.
  const wcsUrl = requireEnv(env, 'WCS_URL')
  const pulseUrl = requireEnv(env, 'PULSE_URL')

  const liveDataBody = await fetchJson(joinUrl(wcsUrl, '/live-data'))
  const realmsBody = await fetchJson(joinUrl(pulseUrl, '/realms'))

  const result = compareLiveData(liveDataBody, realmsBody)
  return finishRun({ diff: DIFF, env, now, out, counts: result, explainedBy: EXPLAINED_BY, notes: result.notes })
}

module.exports = { DIFF, EXPLAINED_BY, WORLD_SUFFIX, compareLiveData, run }
