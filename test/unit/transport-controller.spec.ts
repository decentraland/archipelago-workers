import { handleUpgrade } from '../../src/controllers/handlers/transport-handler'
import { TransportMessage, TransportType } from '../../src/controllers/proto/archipelago'
import { createTransportRegistryComponent } from '../../src/ports/transport-registry'
import { Transport } from '../../src/types'
import { Reader } from 'protobufjs/minimal'
import { delay } from '../helpers/archipelago'

describe('transport-controller-unit', () => {
  it('handling transport', async () => {
    const transportRegistry = await createTransportRegistryComponent()
    const transports = new Map<number, Transport>()
    transportRegistry.setListener({
      onTransportConnected: (t: Transport) => {
        transports.set(t.id, t)
      },
      onTransportDisconnected: (id: number) => {
        transports.delete(id)
      }
    })

    const listeners = new Map<string, (data?: any) => void>()

    const on: any = (event: string, cb: any) => {
      listeners.set(event, cb)
    }

    const ws = {
      on,
      send: (_: Uint8Array) => {},
      terminate: () => {},
      ping: () => {}
    }

    const { transport } = handleUpgrade(console, transportRegistry, ws, 1)

    expect(transport.id).toEqual(1)
    expect(transport.availableSeats).toEqual(0)
    expect(transport.usersCount).toEqual(0)
    expect(transport.maxIslandSize).toEqual(0)

    const messageListener = listeners.get('message')
    const closeListener = listeners.get('close')
    expect(messageListener).toBeTruthy()
    expect(closeListener).toBeTruthy()

    messageListener(
      TransportMessage.encode({
        message: {
          $case: 'init',
          init: {
            maxIslandSize: 300,
            type: TransportType.TRANSPORT_LIVEKIT
          }
        }
      }).finish()
    )

    expect(transport.maxIslandSize).toEqual(300)

    messageListener(
      TransportMessage.encode({
        message: {
          $case: 'heartbeat',
          heartbeat: {
            availableSeats: 100,
            usersCount: 200
          }
        }
      }).finish()
    )

    expect(transport.availableSeats).toEqual(100)
    expect(transport.usersCount).toEqual(200)
    expect(transports.has(transport.id)).toEqual(true)

    await expect(transport.getConnectionStrings(['peer1', 'peer2'], 'i1')).rejects.toThrowError('request timeout')

    ws.send = (data: Uint8Array) => {
      const transportMessage = TransportMessage.decode(Reader.create(data as Buffer))

      switch (transportMessage.message?.$case) {
        case 'authRequest': {
          const {
            authRequest: { requestId, userIds, roomId }
          } = transportMessage.message

          const connStrs: Record<string, string> = {}

          for (const userId of userIds) {
            connStrs[userId] = roomId
          }

          messageListener(
            TransportMessage.encode({
              message: {
                $case: 'authResponse',
                authResponse: {
                  requestId,
                  connStrs
                }
              }
            }).finish()
          )
          break
        }
      }
    }
    const sendSpy = jest.spyOn(ws, 'send')

    const connStrs = await transport.getConnectionStrings(['peer1', 'peer2'], 'i1')
    expect(connStrs).toEqual(
      expect.objectContaining({
        peer1: 'i1',
        peer2: 'i1'
      })
    )

    expect(sendSpy).toHaveBeenCalled()

    closeListener()
    expect(transports.has(transport.id)).toEqual(false)
  })
})
