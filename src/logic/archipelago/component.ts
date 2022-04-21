import { IConfigComponent } from "@well-known-components/interfaces"
import { defaultArchipelagoController } from "./controller/ArchipelagoController"
import { ArchipelagoController } from "./types/interfaces"

export declare type IArchipelagoComponent = ArchipelagoController

export declare type ArchipelagoComponents = {
  config: IConfigComponent
}

export async function createArchipelagoComponent(components: ArchipelagoComponents): Promise<ArchipelagoController> {
  const { config } = components

  const flushFrequency = await config.requireNumber("ARCHIPELAGO_FLUSH_FREQUENCY")
  const joinDistance = await config.requireNumber("ARCHIPELAGO_JOIN_DISTANCE")
  const leaveDistance = await config.requireNumber("ARCHIPELAGO_LEAVE_DISTANCE")
  const maxPeersPerIsland = await config.requireNumber("ARCHIPELAGO_MAX_PEERS_PER_ISLAND")

  const controller = defaultArchipelagoController({
    flushFrequency,
    archipelagoParameters: {
      joinDistance,
      leaveDistance,
      maxPeersPerIsland,
    },
  })

  return controller
}
