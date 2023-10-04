import type {
  IConfigComponent,
  ILoggerComponent,
  IHttpServerComponent,
  IBaseComponent,
  IMetricsComponent,
  IFetchComponent
} from '@well-known-components/interfaces'
import { metricDeclarations } from './metrics'
import { INatsComponent } from '@well-known-components/nats-component/dist/types'
import { IPublisherComponent } from './adapters/publisher'

export type Position3D = [number, number, number]

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
  _center?: Position3D
  _radius?: number
  _geometryDirty: boolean
}

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

export type IslandUpdates = Map<string, ChangeToIslandUpdate | LeaveIslandUpdate>

export type Transport = {
  name: string
  maxIslandSize: number
  getConnectionStrings(userIds: string[], roomId: string): Promise<Record<string, string>>
}

export type Engine = IBaseComponent & {
  onPeerDisconnected(id: string): void
  onPeerPositionsUpdate(changes: PeerPositionChange[]): void
  flush(): Promise<IslandUpdates>

  getIslands(): Island[]
  getIsland(id: string): Island | undefined
  getPeerCount(): number

  // NOTE: only for testing purposes
  getPeerData(id: string): PeerData | undefined
}

export type GlobalContext = {
  components: BaseComponents
}

// components used in every environment
export type BaseComponents = {
  config: IConfigComponent
  logs: ILoggerComponent
  server: IHttpServerComponent<GlobalContext>
  metrics: IMetricsComponent<keyof typeof metricDeclarations>
  nats: INatsComponent
  publisher: IPublisherComponent
  engine: Engine
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

export type Context<Path extends string = any> = IHttpServerComponent.PathAwareContext<GlobalContext, Path>
