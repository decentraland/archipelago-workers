import { IConfigComponent } from "@well-known-components/interfaces"
import { defaultArchipelagoController } from "./controller/ArchipelagoController"
import { ArchipelagoController } from "./types/interfaces"

export type IArchipelagoComponent = ArchipelagoController

export type ArchipelagoComponents = {
  config: IConfigComponent
}

export async function createArchipelagoComponent(components: ArchipelagoComponents): Promise<ArchipelagoController> {
  const { config } = components

  const flushFrequency = await config.requireNumber("ARCHIPELAGO_FLUSH_FREQUENCY")
  const joinDistance = await config.requireNumber("ARCHIPELAGO_JOIN_DISTANCE")
  const leaveDistance = await config.requireNumber("ARCHIPELAGO_LEAVE_DISTANCE")
  const maxPeersPerIsland = await config.requireNumber("ARCHIPELAGO_MAX_PEERS_PER_ISLAND")
  const livekit = {
    url: await config.requireString("LIVEKIT_URL"),
    apiKey: await config.requireString("LIVEKIT_API_KEY"),
    apiSecret: await config.requireString("LIVEKIT_API_SECRET"),
  }
  const wsRoomService = {
    url: await config.requireString("WS_ROOM_SERVICE_URL"),
    secret: await config.requireString("WS_ROOM_SERVICE_SECRET")
  }

  const controller = defaultArchipelagoController({
    flushFrequency,
    archipelagoParameters: {
      joinDistance,
      leaveDistance,
      maxPeersPerIsland,
      livekit,
      wsRoomService
    },
  })

  return controller
}
