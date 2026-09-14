'use strict'
/**
 * Generates parcel_changes/*.json (canonical protobuf-JSON, lowerCamelCase, proto3 defaults omitted)
 * and the matching *.bin wire bytes from pulse_presence.proto, plus replay.json (the ordered consumer
 * scenario with the expected state after every step).
 *
 *   node tools/gen-parcel-changes.js          # (re)write files
 *   node tools/gen-parcel-changes.js --check  # exit 1 if any committed file differs
 *
 * Canonical encoding = what Google.Protobuf (Pulse, C#) emits: fields in field-number order, proto3
 * scalar defaults omitted, message fields written when present (an all-default Parcel {0,0} is an
 * empty length-delimited field: `1a 00`). protobufjs produces the same bytes as long as default-valued
 * scalars are left out of the source object, which is why the JSON never spells `"snapshot": false`
 * or `"x": 0`.
 */
const fs = require('fs')
const path = require('path')
const protobuf = require('protobufjs')
const { T0, PEERS, EXTRA, toParcel } = require('./peerset')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'parcel_changes')
const CHECK = process.argv.includes('--check')

const root = protobuf.loadSync(path.join(ROOT, 'pulse_presence.proto'))
const Batch = root.lookupType('decentraland.pulse.ParcelChangesBatch')

const P = Object.fromEntries(PEERS.map((p) => [p.key, p]))
const parcelOf = (xy) => {
  const o = {}
  if (xy[0] !== 0) o.x = xy[0]
  if (xy[1] !== 0) o.y = xy[1]
  return o // {} == parcel (0,0): present, all-default
}
const change = (address, realm, xy) => (xy ? { address, realm, parcel: parcelOf(xy) } : { address, realm })
const batch = (serverName, seq, serverTime, changes, snapshot) => {
  const b = { serverName, seq }
  if (snapshot) b.snapshot = true
  b.serverTime = serverTime
  b.changes = changes
  return b
}

// ---- the scenario -------------------------------------------------------------------------------
const S1 = 'pulse-1'
const S2 = 'pulse-2'
const initial = PEERS.map((p) => change(p.address, p.realm, toParcel(p.position))) // already sorted by address

const FIXTURES = [
  {
    name: '01-snapshot',
    note: 'Snapshot on publisher start: the full state of pulse-1 (C1 §4). W3 stands on the world origin — parcel {} is (0,0), present.',
    batch: batch(S1, 1, T0, initial, true)
  },
  {
    name: '02-delta-move',
    note: 'W2 walks one parcel east: an ordinary move (C1 §1 was satisfied by the snapshot).',
    batch: batch(S1, 2, T0 + 2000, [change(P.W2.address, 'main', [148, -3])])
  },
  {
    name: '03-exit',
    note: 'W1 leaves by any exit path (C1 §2): exactly one parcel-absent entry, realm kept.',
    batch: batch(S1, 3, T0 + 4000, [change(P.W1.address, 'main', null)])
  },
  {
    name: '04-realm-change',
    note: 'W2 teleports from main to cozyfarm.dcl.eth: one non-null entry for the NEW realm only; the old realm is implied (C1 §2).',
    batch: batch(S1, 4, T0 + 6000, [change(P.W2.address, 'cozyfarm.dcl.eth', [1, 2])])
  },
  {
    name: '05-coalesced',
    note: 'W3 moved twice inside one batch interval ((0,0)->(2,2)->(3,4)); only the latest state is published (C1 §3). Producer input in 05-coalesced.input.json.',
    batch: batch(S1, 5, T0 + 8000, [change(P.W3.address, 'cozyfarm.dcl.eth', [3, 4])]),
    input: {
      serverName: S1,
      window: [
        { at: T0 + 6500, address: P.W3.address, realm: 'cozyfarm.dcl.eth', parcel: { x: 2, y: 2 } },
        { at: T0 + 7200, address: P.W3.address, realm: 'cozyfarm.dcl.eth', parcel: { x: 3, y: 4 } }
      ],
      expected: '05-coalesced.json'
    }
  },
  {
    name: '06-mixed-case',
    note: 'Handshake/teleport arrived with realm "CozyFarm.dcl.eth" and a mixed-case wallet; Pulse canonicalizes both to lowercase before publishing (C1 §5). Input in 06-mixed-case.input.json.',
    batch: batch(S1, 6, T0 + 10000, [change(EXTRA.WAB, 'cozyfarm.dcl.eth', [5, 6])]),
    input: { handshake: { address: EXTRA.WAB_MIXED, realm: 'CozyFarm.dcl.eth' }, parcel: { x: 5, y: 6 }, expected: '06-mixed-case.json' }
  },
  {
    name: '07-invalid-mixed-case-realm',
    note: 'INVALID: violates C1 §5 (realm not lowercase). A conforming Pulse never emits it; consumers use it to test their contract-violation guard. Not part of replay.json.',
    batch: batch(S1, 7, T0 + 12000, [{ address: P.W1.address, realm: 'Main', parcel: { x: -1 } }])
  },
  {
    name: '08-gap',
    note: 'seq jumps 6 -> 9 for pulse-1: the consumer keeps serving its current state and waits for the next snapshot (C1 consumer rule).',
    batch: batch(S1, 9, T0 + 16000, [change(P.W5.address, 'main', [150, -3])])
  },
  {
    name: '09-second-server',
    note: 'A second Pulse instance announces itself with its own snapshot; consumers key seq and replacement per server_name.',
    batch: batch(S2, 1, T0 + 17000, [change(EXTRA.W7, 'main', [0, 0])], true)
  },
  {
    name: '10-snapshot-restart',
    note: 'pulse-1 restarted: seq resets to 1 with snapshot=true; everything previously known for pulse-1 is replaced, pulse-2 entries are untouched.',
    batch: batch(S1, 1, T0 + 20000, [change(P.W2.address, 'cozyfarm.dcl.eth', [1, 2]), change(P.W4.address, 'main', [-1, 0])], true)
  }
]

// ---- expected consumer state after each valid step -----------------------------------------------
const st = (realm, x, y) => ({ realm, parcel: [x, y] })
const REPLAY = {
  description:
    'Feed the batches in this order to a consumer. "map" is the seq-aware presence map (comms-gatekeeper); "statusEvents" is what the per-entry ONLINE/OFFLINE consumer (social-service) emits. 07-invalid-mixed-case-realm is deliberately excluded.',
  mapRules: [
    'key state by wallet; remember lastSeq[serverName] and which serverName owns each wallet entry',
    'delta with seq == lastSeq+1: apply; parcel present => upsert (realm, parcel); parcel absent => remove wallet',
    'delta with a seq gap (or the first batch seen for a serverName not being a snapshot): apply nothing, mark serverName frozen, keep serving the current state',
    'snapshot: remove every entry owned by serverName, insert the batch, lastSeq = seq, clear frozen',
    'lookups compare realm case-insensitively; a mixed-case realm/address on the wire is a contract violation to log, never a crash'
  ],
  statusRules: [
    'for every change: parcel present => ONLINE(address); parcel absent => OFFLINE(address)',
    'seq and snapshot are ignored (the 5 s /peers?all=true poll reconciles); a peer missing from a snapshot is NOT flipped OFFLINE'
  ],
  steps: []
}
let map = {}
const push = (fixture, statusEvents, frozen) => REPLAY.steps.push({ apply: fixture, map: { ...map }, frozen: frozen || [], statusEvents })
map = {
  [P.W1.address]: st('main', -1, 0),
  [P.W2.address]: st('main', 147, -3),
  [P.W3.address]: st('cozyfarm.dcl.eth', 0, 0),
  [P.W4.address]: st('main', -1, 0),
  [P.W5.address]: st('main', 147, -3)
}
push('01-snapshot.bin', PEERS.map((p) => ({ address: p.address, status: 'ONLINE' })))
map[P.W2.address] = st('main', 148, -3)
push('02-delta-move.bin', [{ address: P.W2.address, status: 'ONLINE' }])
delete map[P.W1.address]
push('03-exit.bin', [{ address: P.W1.address, status: 'OFFLINE' }])
map[P.W2.address] = st('cozyfarm.dcl.eth', 1, 2)
push('04-realm-change.bin', [{ address: P.W2.address, status: 'ONLINE' }])
map[P.W3.address] = st('cozyfarm.dcl.eth', 3, 4)
push('05-coalesced.bin', [{ address: P.W3.address, status: 'ONLINE' }])
map[EXTRA.WAB] = st('cozyfarm.dcl.eth', 5, 6)
push('06-mixed-case.bin', [{ address: EXTRA.WAB, status: 'ONLINE' }])
push('08-gap.bin', [{ address: P.W5.address, status: 'ONLINE' }], [S1]) // map unchanged, pulse-1 frozen
map[EXTRA.W7] = st('main', 0, 0)
push('09-second-server.bin', [{ address: EXTRA.W7, status: 'ONLINE' }], [S1])
map = { [EXTRA.W7]: st('main', 0, 0), [P.W2.address]: st('cozyfarm.dcl.eth', 1, 2), [P.W4.address]: st('main', -1, 0) }
push('10-snapshot-restart.bin', [
  { address: P.W2.address, status: 'ONLINE' },
  { address: P.W4.address, status: 'ONLINE' }
])

// ---- write / check ------------------------------------------------------------------------------
let failures = 0
function emit(file, content) {
  const full = path.join(OUT, file)
  if (CHECK) {
    const cur = fs.existsSync(full) ? fs.readFileSync(full) : null
    if (!cur || !cur.equals(content)) {
      failures++
      console.error(`MISMATCH ${file}`)
    }
  } else fs.writeFileSync(full, content)
}
const json = (o) => Buffer.from(JSON.stringify(o, null, 2) + '\n')
const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v

fs.mkdirSync(OUT, { recursive: true })
for (const f of FIXTURES) {
  const err = Batch.verify(f.batch)
  if (err) throw new Error(`${f.name}: ${err}`)
  const bytes = Buffer.from(Batch.encode(Batch.fromObject(f.batch)).finish())
  const decoded = Batch.toObject(Batch.decode(bytes), { longs: Number, defaults: false })
  if (JSON.stringify(sortKeys(decoded)) !== JSON.stringify(sortKeys(f.batch)))
    throw new Error(`${f.name}: not canonical\n${JSON.stringify(decoded)}\n${JSON.stringify(f.batch)}`)
  emit(`${f.name}.json`, json(f.batch))
  emit(`${f.name}.bin`, bytes)
  if (f.input) emit(`${f.name}.input.json`, json(f.input))
  if (!CHECK) console.log(`${f.name}.bin  ${bytes.length} bytes  ${bytes.toString('hex')}`)
}
emit('replay.json', json(REPLAY))
emit('NOTES.json', json(Object.fromEntries(FIXTURES.map((f) => [f.name, f.note]))))
if (CHECK) {
  if (failures) process.exit(1)
  console.log('parcel_changes: all files match')
}
