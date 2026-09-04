'use strict'
/**
 * Generates http/*.json — one golden response per C2 route, all derived from tools/peerset.js (the state
 * after parcel_changes/01-snapshot.bin) — and http/redirects.json (the legacy-path table).
 *
 *   node tools/gen-http-goldens.js          # (re)write files
 *   node tools/gen-http-goldens.js --check  # exit 1 if any committed file differs
 *
 * Each golden is { request, status, body, note? }. Ordering rules are normative (README "Ordering"):
 *   realms   : peers desc, then name asc
 *   peers    : address asc
 *   parcels  : peersCount desc, then x asc, then y asc
 *   islands  : id in natural order (C1 < C2 < C10); members by address asc
 */
const fs = require('fs')
const path = require('path')
const { PASS_TIME, PEERS, CLUSTERS, EXTRA, byAddress, centroid, radius, peerResult, toParcel } = require('./peerset')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'http')
const CHECK = process.argv.includes('--check')

const VERSION = '0.0.0-fixture' // tests inject version + commit hash
const COMMIT = '0000000'
const lastUpdated = new Date(PASS_TIME).toISOString()

const P = Object.fromEntries(PEERS.map((p) => [p.key, p]))
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
const naturalId = (a, b) => parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10)
const realmsOf = () => [...new Set(PEERS.map((p) => p.realm))]
const peersIn = (realm) => PEERS.filter((p) => p.realm === realm).sort(byAddress)
const clustersIn = (realm) => CLUSTERS.filter((c) => c.realm === realm).sort(naturalId)

const realmsList = realmsOf()
  .map((name) => ({ name, peers: peersIn(name).length, clusters: clustersIn(name).length }))
  .sort((a, b) => b.peers - a.peers || byName(a, b))

function parcels(realm) {
  const counts = new Map()
  for (const p of peersIn(realm)) {
    const k = toParcel(p.position).join(',')
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([k, n]) => {
      const [x, y] = k.split(',').map(Number)
      return { peersCount: n, parcel: { x, y } }
    })
    .sort((a, b) => b.peersCount - a.peersCount || a.parcel.x - b.parcel.x || a.parcel.y - b.parcel.y)
}

function island(c) {
  const members = c.members.map((k) => P[k]).sort(byAddress)
  const center = centroid(members)
  return { id: c.id, maxPeers: 0, center, radius: radius(members, center), peers: members.map((p) => peerResult(p, false)) }
}

const upperId = (a) => '0x' + a.slice(2).toUpperCase()

const G = {}
G['realms.json'] = {
  request: 'GET /realms',
  note: 'every realm with >= 1 peer; lastUpdated = ISO-8601 UTC (ms) of the ClusterTracker pass the boards were read from',
  status: 200,
  body: { realms: realmsList, lastUpdated }
}
G['realms-main-peers.json'] = {
  request: 'GET /realms/main/peers',
  status: 200,
  body: { ok: true, realm: 'main', peers: peersIn('main').map((p) => peerResult(p, false)) }
}
G['realms-cozyfarm-peers.json'] = {
  request: 'GET /realms/CozyFarm.dcl.eth/peers',
  note: 'mixed-case path segment matches case-insensitively; the response carries the canonical lowercase realm',
  status: 200,
  body: { ok: true, realm: 'cozyfarm.dcl.eth', peers: peersIn('cozyfarm.dcl.eth').map((p) => peerResult(p, false)) }
}
G['realms-unknown-peers.json'] = {
  request: 'GET /realms/nosuchrealm/peers',
  note: 'unknown == empty: a realm exists exactly as long as it has peers, so this is 200 with an empty list, not 404',
  status: 200,
  body: { ok: true, realm: 'nosuchrealm', peers: [] }
}
G['peers-by-id.json'] = {
  request: `GET /peers?id=${P.W3.address}&id=${upperId(P.W1.address)}&id=${EXTRA.W9}`,
  note: 'ALL realms; ids matched case-insensitively; unknown ids omitted; each peer carries realm; sorted by address. /comms/peers?id= is the same handler',
  status: 200,
  body: { ok: true, peers: [P.W1, P.W3].sort(byAddress).map((p) => peerResult(p, true)) }
}
G['peers-by-id-too-many.json'] = {
  request: 'GET /peers?id=<201 distinct ids>',
  note: 'cap is 200 ids per request',
  status: 400,
  body: { ok: false, error: 'too many ids (max 200)' }
}
G['peers-all.json'] = {
  request: 'GET /peers?all=true',
  note: 'unfiltered all-realms list for trusted internal callers (social-service peers-synchronizer, gatekeeper presence-map prime); each peer carries realm',
  status: 200,
  body: { ok: true, peers: [...PEERS].sort(byAddress).map((p) => peerResult(p, true)) }
}
G['peers-single.json'] = {
  request: `GET /peers/${P.W3.address}`,
  note: 'all realms; replaces worlds-content-server /wallet/:wallet/connected-world (realm ending .dcl.eth => in a world)',
  status: 200,
  body: { ok: true, peer: peerResult(P.W3, true) }
}
G['peers-single-404.json'] = {
  request: `GET /peers/${EXTRA.W9}`,
  status: 404,
  body: { ok: false, peer: null }
}
G['realms-main-parcels.json'] = {
  request: 'GET /realms/main/parcels',
  status: 200,
  body: { realm: 'main', parcels: parcels('main') }
}
G['realms-cozyfarm-parcels.json'] = {
  request: 'GET /realms/cozyfarm.dcl.eth/parcels',
  note: 'worlds number parcels from 0,0 — realm scoping is mandatory',
  status: 200,
  body: { realm: 'cozyfarm.dcl.eth', parcels: parcels('cozyfarm.dcl.eth') }
}
G['realms-main-islands.json'] = {
  request: 'GET /realms/main/islands',
  note: 'from ClusterBoard; ids are C{n}, maxPeers 0 (uncapped); the client-wire room is island-C{n}',
  status: 200,
  body: { ok: true, realm: 'main', islands: clustersIn('main').map(island) }
}
G['realms-cozyfarm-islands.json'] = {
  request: 'GET /realms/cozyfarm.dcl.eth/islands',
  status: 200,
  body: { ok: true, realm: 'cozyfarm.dcl.eth', islands: clustersIn('cozyfarm.dcl.eth').map(island) }
}
G['realms-main-islands-C1.json'] = {
  request: 'GET /realms/main/islands/C1',
  note: 'today the island object is the body itself (no envelope) — kept unchanged',
  status: 200,
  body: island(CLUSTERS[0])
}
G['realms-main-islands-404.json'] = {
  request: 'GET /realms/main/islands/C3',
  note: 'C3 lives in cozyfarm.dcl.eth, so under main it is not found; today stats answers 404 with an empty body',
  status: 404,
  body: null
}
G['status.json'] = {
  request: 'GET /status',
  note: 'version kept (godot reads it); currentTime = unix ms; realms = per-realm peer counts (same order as /realms)',
  status: 200,
  body: { version: VERSION, currentTime: PASS_TIME, commitHash: COMMIT, realms: realmsList.map(({ name, peers }) => ({ name, peers })) }
}
G['about.json'] = {
  request: 'GET /about',
  note: 'exists today; userCount counts every realm',
  status: 200,
  body: { commitHash: COMMIT, userCount: PEERS.length }
}
G['health.json'] = { request: 'GET /health', status: 200, body: null }

const legacy = ['/peers', '/parcels', '/islands', '/islands/C1', '/comms/peers', '/comms/parcels', '/comms/islands', '/comms/islands/C1']
G['redirects.json'] = {
  rule: 'Legacy unscoped paths (and their /comms/ copies) answer 308 with Location under /realms/main/…, preserving the query string. Exception: /peers and /comms/peers with an `id` or `all` query parameter are handled directly (all realms, see peers-by-id.json / peers-all.json).',
  cases: [
    ...legacy.map((p) => ({ path: p, status: 308, location: '/realms/main' + p.replace(/^\/comms/, '') })),
    { path: '/peers?foo=bar', status: 308, location: '/realms/main/peers?foo=bar' },
    { path: `/comms/peers?id=${P.W1.address}`, status: 200, golden: 'peers-by-id.json (same handler as /peers?id=)' },
    { path: '/peers?all=true', status: 200, golden: 'peers-all.json' },
    { path: '/metrics', status: 401, note: 'unchanged: bearer-token protected; every other route above is unauthenticated like /about' }
  ]
}

let failures = 0
fs.mkdirSync(OUT, { recursive: true })
for (const [file, content] of Object.entries(G)) {
  const buf = Buffer.from(JSON.stringify(content, null, 2) + '\n')
  const full = path.join(OUT, file)
  if (CHECK) {
    const cur = fs.existsSync(full) ? fs.readFileSync(full) : null
    if (!cur || !cur.equals(buf)) {
      failures++
      console.error(`MISMATCH ${file}`)
    }
  } else fs.writeFileSync(full, buf)
}
if (CHECK) {
  if (failures) process.exit(1)
  console.log('http: all files match')
} else console.log(`wrote ${Object.keys(G).length} goldens to http/`)
