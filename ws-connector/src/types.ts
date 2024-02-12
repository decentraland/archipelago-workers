import { HTTPProvider } from 'eth-connect'
import type {
  IConfigComponent,
  ILoggerComponent,
  IMetricsComponent,
  IFetchComponent
} from '@well-known-components/interfaces'
import { metricDeclarations } from './metrics'
import { INatsComponent } from '@well-known-components/nats-component/dist/types'
import { IPeersRegistryComponent } from './adapters/peers-registry'
import { IUWsComponent } from '@well-known-components/uws-http-server'
import * as uws from 'uWebSockets.js'

export type GlobalContext = {
  components: BaseComponents
}

// components used in every environment
export type BaseComponents = {
  config: IConfigComponent
  logs: ILoggerComponent
  server: IUWsComponent
  fetch: IFetchComponent
  metrics: IMetricsComponent<keyof typeof metricDeclarations>
  nats: INatsComponent
  peersRegistry: IPeersRegistryComponent
  ethereumProvider: HTTPProvider
}

// components used in runtime
export type AppComponents = BaseComponents & {}

// components used in tests
export type TestComponents = BaseComponents & {
  // A fetch component that only hits the test server
  localFetch: IFetchComponent
}

export type Parcel = [number, number]

export type JsonBody = Record<string, any>
export type ResponseBody = JsonBody | string

export type IHandlerResult = {
  status?: number
  headers?: Record<string, string>
  body?: ResponseBody
}

export type IHandler = {
  path: string
  f: (res: uws.HttpResponse, req: uws.HttpRequest) => Promise<IHandlerResult>
}

export enum Stage {
  HANDSHAKE_START,
  HANDSHAKE_CHALLENGE_SENT,
  HANDSHAKE_COMPLETED
}

export type WsUserData = {
  timeout?: NodeJS.Timeout
  address?: string
} & (
  | {
      stage: Stage.HANDSHAKE_START
    }
  | {
      stage: Stage.HANDSHAKE_CHALLENGE_SENT
      challengeToSign: string
    }
  | {
      stage: Stage.HANDSHAKE_COMPLETED
      address: string
    }
)

export type InternalWebSocket = uws.WebSocket<WsUserData>
