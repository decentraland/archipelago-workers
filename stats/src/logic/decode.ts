import { IslandStatusMessage } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { IslandData } from '../types'

/**
 * Decodes an `engine.islands` snapshot into the shape `GET /islands` serves. Pulse publishes
 * `maxPeers: 0` and `C{n}` ids: nothing here parses or compares either.
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
