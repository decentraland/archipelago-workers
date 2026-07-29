import { IslandStatusMessage } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { IslandData } from '../types'

/**
 * Decodes an `engine.islands` snapshot into the shape `GET /islands` serves.
 *
 * Published by Pulse since iteration 1 of the Archipelago => Pulse migration: ids read
 * `C{n}` and `maxPeers` is 0 because clusters are uncapped. Both pass through untouched —
 * stats neither parses ids nor compares maxPeers. Islands without geometry are dropped:
 * the handler contract requires a center.
 */
export function decodeIslandsReport(data: Uint8Array): IslandData[] {
  const decodedMessage = IslandStatusMessage.decode(data)
  const report: IslandData[] = []
  for (const { id, peers, maxPeers, center, radius } of decodedMessage.data) {
    if (!center) {
      continue
    }
    report.push({
      id,
      peers,
      maxPeers,
      radius,
      center: [center.x, center.y, center.z]
    })
  }
  return report
}
