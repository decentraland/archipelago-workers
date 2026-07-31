import { HTTPProvider } from 'eth-connect'
import type { IConfigComponent, ILoggerComponent, IMetricsComponent } from '@well-known-components/interfaces'
import type { IFetchComponent } from '@dcl/core-commons'
import { metricDeclarations } from './metrics'
import { INatsComponent } from '@well-known-components/nats-component/dist/types'
import { IPeersRegistryComponent } from './adapters/peers-registry'
import { IBanCheckerComponent } from './adapters/ban-checker'
import { IBanSweepComponent } from './adapters/ban-sweep'
import { IDenyListComponent } from './adapters/deny-list'
import { IUWsComponent, HttpRequest, HttpResponse, WebSocket } from '@dcl/uws-http-server'

// components used in every environment
export type BaseComponents = {
  config: IConfigComponent
  logs: ILoggerComponent
  server: IUWsComponent
  fetch: IFetchComponent
  metrics: IMetricsComponent<keyof typeof metricDeclarations>
  nats: INatsComponent
  peersRegistry: IPeersRegistryComponent
  banChecker: IBanCheckerComponent
  banSweep: IBanSweepComponent
  denyList: IDenyListComponent
  ethereumProvider: HTTPProvider
}

// components used in runtime
export type AppComponents = BaseComponents

// components used in tests
export type TestComponents = BaseComponents & {
  // A fetch component that only hits the test server
  localFetch: IFetchComponent
}

export type JsonBody = Record<string, any>
export type ResponseBody = JsonBody | string

export type IHandlerResult = {
  status?: number
  headers?: Record<string, string>
  body?: ResponseBody
}

export type IHandler = {
  path: string
  f: (res: HttpResponse, req: HttpRequest) => Promise<IHandlerResult>
}

export enum Stage {
  HANDSHAKE_START,
  HANDSHAKE_CHALLENGE_SENT,
  HANDSHAKE_COMPLETED
}

export type WsUserData = {
  timeout?: NodeJS.Timeout
  address?: string
  isClosed?: boolean
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

export type InternalWebSocket = WebSocket<WsUserData>
