import { IBaseComponent } from '@well-known-components/interfaces'
import { Transport } from '../types'

export type TransportListener = {
  onTransportHeartbeat(transport: Transport): void
  onTransportDisconnected(id: number): void
}

export type ITransportRegistryComponent = IBaseComponent &
  TransportListener & {
    setListener(listener: TransportListener): void
  }

export async function createTransportRegistryComponent(): Promise<ITransportRegistryComponent> {
  let listener: TransportListener | undefined = undefined

  function onTransportHeartbeat(transport: Transport) {
    if (!listener) {
      throw new Error('No listener defined')
    }
    listener.onTransportHeartbeat(transport)
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
    onTransportHeartbeat,
    onTransportDisconnected,
    setListener
  }
}
