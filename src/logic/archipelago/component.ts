import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { defaultArchipelagoController } from './controller/ArchipelagoController'
import { ArchipelagoController } from './types/interfaces'

export type IArchipelagoComponent = ArchipelagoController

export type ArchipelagoComponents = {
  config: IConfigComponent
  logs: ILoggerComponent
}

async function getLivekitConf(config: IConfigComponent) {
  const url = await config.requireString('LIVEKIT_URL')
  const apiKey = await config.requireString('LIVEKIT_API_KEY')
  const apiSecret = await config.requireString('LIVEKIT_API_SECRET')

  if (!url || !apiKey || !apiSecret) {
    return
  }

  return { url, apiKey, apiSecret }
}

async function getWsRoomServiceConf(config: IConfigComponent) {
  const url = await config.requireString('WS_ROOM_SERVICE_URL')
  const secret = await config.requireString('WS_ROOM_SERVICE_SECRET')

  if (!url || !secret) {
    return
  }

  return { url, secret }
}

export async function createArchipelagoComponent(components: ArchipelagoComponents): Promise<ArchipelagoController> {
  const { config } = components

  const flushFrequency = await config.requireNumber('ARCHIPELAGO_FLUSH_FREQUENCY')
  const joinDistance = await config.requireNumber('ARCHIPELAGO_JOIN_DISTANCE')
  const leaveDistance = await config.requireNumber('ARCHIPELAGO_LEAVE_DISTANCE')
  const maxPeersPerIsland = await config.requireNumber('ARCHIPELAGO_MAX_PEERS_PER_ISLAND')

  const controller = defaultArchipelagoController({
    flushFrequency,
    archipelagoParameters: {
      joinDistance,
      leaveDistance,
      maxPeersPerIsland,
      livekit: await getLivekitConf(config),
      wsRoomService: await getWsRoomServiceConf(config)
    },
    components
  })

  return controller
}
