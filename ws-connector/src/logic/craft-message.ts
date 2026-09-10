import { KickedReason, ServerPacket } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
import { Writer } from 'protobufjs/minimal'

// we use a shared writer to reduce allocations and leverage its allocation pool
const writer = new Writer()

export function craftMessage(packet: ServerPacket): Uint8Array {
  writer.reset()
  ServerPacket.encode(packet, writer)
  return writer.finish()
}

/**
 * The message sent to a session immediately before it is closed on it.
 *
 * `KR_NEW_SESSION` is reused for every reason a peer is dropped, including a ban, because the
 * protocol enum has no better value. Replace it here if one is ever added.
 *
 * A function rather than a cached constant on purpose: `craftMessage` finishes into a pooled
 * buffer, so held bytes would be corrupted by a later call once the pool cycles.
 *
 * @returns The encoded `kicked` packet.
 */
export function craftKickedMessage(): Uint8Array {
  return craftMessage({ message: { $case: 'kicked', kicked: { reason: KickedReason.KR_NEW_SESSION } } })
}
