import type { IFetchComponent } from '@well-known-components/http-server'
import type {
  IConfigComponent,
  ILoggerComponent,
  IHttpServerComponent,
  IBaseComponent,
  IMetricsComponent
} from '@well-known-components/interfaces'
import { metricDeclarations } from './metrics'
import { INatsComponent } from '@well-known-components/nats-component/dist/types'
import { IdGenerator } from './misc/idGenerator'

export type Position3D = [number, number, number]
export type Transport = 'livekit' | 'ws' | 'p2p'

export type PeerData = {
  id: string
  position: Position3D
  preferedIslandId?: string
  islandId?: string
}

export type Island = {
  id: string
  peers: PeerData[]
  maxPeers: number
  center: Position3D
  radius: number
  sequenceId: number
  transport: Transport
}

export type ArchipelagoOptions = {
  maxPeersPerIsland: number
  joinDistance: number
  leaveDistance: number
  islandIdGenerator: IdGenerator
}

export type MandatoryArchipelagoOptions = Pick<ArchipelagoOptions, 'joinDistance' | 'leaveDistance'>

export type ArchipelagoParameters = MandatoryArchipelagoOptions & Partial<ArchipelagoOptions>

export type UpdatableArchipelagoParameters = Partial<Omit<ArchipelagoOptions, 'islandIdGenerator'>>

export type PeerPositionChange = { id: string; position: Position3D; preferedIslandId?: string }

export type ChangeToIslandUpdate = {
  action: 'changeTo'
  islandId: string
  connStr: string
  fromIslandId?: string
}

export type LeaveIslandUpdate = {
  action: 'leave'
  islandId: string
}

export type IslandUpdate = ChangeToIslandUpdate | LeaveIslandUpdate
export type IslandUpdates = Record<string, IslandUpdate>
export type UpdateSubscriber = (updates: IslandUpdates) => any

export type ArchipelagoMetricPerTransport = {
  transport: {
    livekit: number
    ws: number
    p2p: number
  }
}

export type ArchipelagoMetrics = {
  peers: ArchipelagoMetricPerTransport
  islands: ArchipelagoMetricPerTransport
}

export { IdGenerator } from './misc/idGenerator'

export type ArchipelagoComponent = {
  calculateMetrics(): Promise<ArchipelagoMetrics>
  clearPeers(...ids: string[]): void
  setPeersPositions(...requests: PeerPositionChange[]): void
  subscribeToUpdates(subscriber: UpdateSubscriber): void
  getIslands(): Promise<Island[]>
  getIsland(id: string): Promise<Island | undefined>
}

export type GlobalContext = {
  components: BaseComponents
}

// components used in every environment
export type BaseComponents = {
  config: IConfigComponent
  logs: ILoggerComponent
  server: IHttpServerComponent<GlobalContext>
  fetch: IFetchComponent
  metrics: IMetricsComponent<keyof typeof metricDeclarations>
  nats: INatsComponent
  archipelago: ArchipelagoComponent
}

// components used in runtime
export type AppComponents = BaseComponents & {
  statusChecks: IBaseComponent
}

// components used in tests
export type TestComponents = BaseComponents & {
  // A fetch component that only hits the test server
  localFetch: IFetchComponent
}

// this type simplifies the typings of http handlers
export type HandlerContextWithPath<
  ComponentNames extends keyof AppComponents,
  Path extends string = any
> = IHttpServerComponent.PathAwareContext<
  IHttpServerComponent.DefaultContext<{
    components: Pick<AppComponents, ComponentNames>
  }>,
  Path
>

export type Parcel = [number, number]

export type ServiceDiscoveryMessage = {
  serverName: string
  status: any
}

export type Context<Path extends string = any> = IHttpServerComponent.PathAwareContext<GlobalContext, Path>
