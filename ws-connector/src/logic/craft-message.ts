import { ServerPacket } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { Writer } from 'protobufjs/minimal'

// we use a shared writer to reduce allocations and leverage its allocation pool
const writer = new Writer()

export function craftMessage(packet: ServerPacket): Uint8Array {
  writer.reset()
  ServerPacket.encode(packet, writer)
  return writer.finish()
}
