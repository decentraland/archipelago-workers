'use strict'
/**
 * The canonical synthetic peer set every fixture in this pack is derived from.
 * Wallets are obviously fake (0x000…000N). Positions are chosen so that the parcel
 * (floor(x/16), floor(z/16)) is unambiguous and away from cell boundaries.
 *
 * Realm partition (state after parcel_changes/01-snapshot.bin):
 *   main             : W1 (-1,0)  W4 (-1,0)   W2 (147,-3)  W5 (147,-3)   -> clusters C1 {W1,W4}, C2 {W2,W5}
 *   cozyfarm.dcl.eth : W3 (0,0)                                             -> cluster  C3 {W3}
 * Cluster IDs come from Pulse's single global counter (ClusterTracker: `{IdPrefix}{++nextClusterNumber}`),
 * so they are unique across realms.
 */
const wallet = (n) => '0x' + n.toString(16).padStart(40, '0')

const T0 = 1788515567804 // 2026-09-04T09:52:47.804Z — the first snapshot batch
const PASS_TIME = T0 + 30 // the ClusterTracker pass the HTTP goldens are read from

const PEERS = [
  { key: 'W1', address: wallet(1), realm: 'main', position: [-0.31, 1.73, 4.62], lastPing: T0 },
  { key: 'W2', address: wallet(2), realm: 'main', position: [2360.5, 1.5, -40.2], lastPing: T0 + 6 },
  { key: 'W3', address: wallet(3), realm: 'cozyfarm.dcl.eth', position: [8.0, 0.0, 8.0], lastPing: T0 - 14 },
  { key: 'W4', address: wallet(4), realm: 'main', position: [-5.0, 0.5, 10.0], lastPing: T0 + 10 },
  { key: 'W5', address: wallet(5), realm: 'main', position: [2355.0, 0.0, -35.0], lastPing: T0 + 20 }
]

const CLUSTERS = [
  { id: 'C1', realm: 'main', members: ['W1', 'W4'] },
  { id: 'C2', realm: 'main', members: ['W2', 'W5'] },
  { id: 'C3', realm: 'cozyfarm.dcl.eth', members: ['W3'] }
]

const EXTRA = {
  W7: wallet(7), // second Pulse instance
  W9: wallet(9), // never online (404 / filtered cases)
  WAB_MIXED: '0x00000000000000000000000000000000000000AB', // mixed-case ingest input
  WAB: '0x00000000000000000000000000000000000000ab'
}

const toParcel = ([x, , z]) => [Math.floor(x / 16), Math.floor(z / 16)]
const byAddress = (a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)

/** Goldens carry values rounded to 6 decimals; Pulse computes in float32 — compare with tolerance (README "Numeric tolerance"). */
const round = (v) => Math.round(v * 1e6) / 1e6

/** Mean of member positions on all three axes (ClusterTracker.Centroid). */
function centroid(members) {
  const s = members.reduce((acc, p) => acc.map((v, i) => v + p.position[i]), [0, 0, 0])
  return s.map((v) => round(v / members.length))
}

/** Farthest member distance from the centroid on the XZ plane only (ClusterTracker.BuildCluster). */
function radius(members, c) {
  let r2 = 0
  for (const p of members) {
    const dx = p.position[0] - c[0]
    const dz = p.position[2] - c[2]
    r2 = Math.max(r2, dx * dx + dz * dz)
  }
  return round(Math.sqrt(r2))
}

/** The *unchanged* archipelago-stats peer shape (+ `realm` where C2 says so). */
function peerResult(p, withRealm) {
  const out = { id: p.address, address: p.address, lastPing: p.lastPing, parcel: toParcel(p.position), position: p.position }
  if (withRealm) out.realm = p.realm
  return out
}

module.exports = { T0, PASS_TIME, PEERS, CLUSTERS, EXTRA, wallet, toParcel, byAddress, centroid, radius, round, peerResult }
