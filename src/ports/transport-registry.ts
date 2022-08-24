import { IBaseComponent } from '@well-known-components/interfaces'
import { Transport } from '../types'

export type TransportListener = {
  onTransportConnected(transport: Transport): void
  onTransportDisconnected(id: number): void
}

export type ITransportRegistryComponent = IBaseComponent & {
  onTransportConnected(transport: Transport): void
  onTransportDisconnected(id: number): void
  setListener(listener: TransportListener): void
}

export async function createTransportRegistryComponent(): Promise<ITransportRegistryComponent> {
  let listener: TransportListener | undefined = undefined

  function onTransportConnected(transport: Transport) {
    if (!listener) {
      throw new Error('No listener defined')
    }
    listener.onTransportConnected(transport)
  }

  function onTransportDisconnected(id: number) {
    if (!listener) {
      throw new Error('No listener defined')
    }
    listener.onTransportDisconnected(id)
  }

  function setListener(l: TransportListener) {
    listener = l
  }

  return {
    onTransportConnected,
    onTransportDisconnected,
    setListener
  }
}
