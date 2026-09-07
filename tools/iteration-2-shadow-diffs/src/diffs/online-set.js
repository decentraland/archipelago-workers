'use strict'

// Diff 3 -- social-service's online set: `PEERS_CACHE_KEY` (heartbeats + stats poll) vs
// `PEERS_CACHE_KEY_PULSE` (the presence feed). Both keys hold wallet addresses, so this diff
// reduces the two sets to |A \ B|, |B \ A| and |A n B| and lets the members go out of scope
// immediately. Nothing downstream of `compareOnlineSets` can print one: the returned object has no
// field that could hold one.

const { requireEnv } = require('../http')
const { readSet: defaultReadSet } = require('../redis')
const { finishRun } = require('../finish-run')

const DIFF = 'online-set'

const EXPLAINED_BY = [
  'no-comms peers visible to Pulse',
  '<= 2 s batching',
  'heartbeat TTL expiry vs a feed exit entry',
  'an input-idle client still ACKing the transport'
]

// Addresses are lowercased at Pulse ingest; the legacy set was written by whatever case the client
// sent, so both sides are normalized before they are compared.
const normalize = (members, side) => {
  if (!Array.isArray(members)) {
    throw new Error(`the ${side} set must be an array of members, got ${typeof members}`)
  }
  const set = new Set()
  for (const member of members) {
    if (typeof member !== 'string') {
      continue
    }
    const normalized = member.trim().toLowerCase()
    if (normalized !== '') {
      set.add(normalized)
    }
  }
  return set
}

const compareOnlineSets = (legacyMembers, pulseMembers) => {
  const legacy = normalize(legacyMembers, 'legacy')
  const pulse = normalize(pulseMembers, 'pulse')

  let agree = 0
  let onlyLegacy = 0
  for (const member of legacy) {
    if (pulse.has(member)) {
      agree += 1
    } else {
      onlyLegacy += 1
    }
  }
  const onlyPulse = pulse.size - agree

  return {
    sampleSize: legacy.size + pulse.size - agree,
    agree,
    onlyLegacy,
    onlyPulse,
    notes: `legacy=${legacy.size} pulse=${pulse.size} shared=${agree}`
  }
}

const run = async ({ env = {}, readSet = defaultReadSet, now, out } = {}) => {
  // Everything is validated before the first read: a half-run writes a misleading line.
  const redisUrl = requireEnv(env, 'REDIS_URL')
  const legacyKey = requireEnv(env, 'PEERS_CACHE_KEY')
  const pulseKey = requireEnv(env, 'PEERS_CACHE_KEY_PULSE')

  const legacyMembers = await readSet(redisUrl, legacyKey)
  const pulseMembers = await readSet(redisUrl, pulseKey)

  const result = compareOnlineSets(legacyMembers, pulseMembers)
  return finishRun({ diff: DIFF, env, now, out, counts: result, explainedBy: EXPLAINED_BY, notes: result.notes })
}

module.exports = { DIFF, EXPLAINED_BY, compareOnlineSets, run }
