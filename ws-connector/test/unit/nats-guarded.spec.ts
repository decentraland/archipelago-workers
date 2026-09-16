import { NatsMsg } from '@well-known-components/nats-component/dist/types'
import { guarded } from '../../src/logic/nats'
import { createLoggerMockedComponent } from '../mocks/logger-mock'

describe('guarded NATS callback', () => {
  let logs: ReturnType<typeof createLoggerMockedComponent>
  let handle: jest.Mock

  const message = { subject: 'engine.peer.0xabc.island_changed', data: new Uint8Array([1]) } as NatsMsg

  beforeEach(() => {
    logs = createLoggerMockedComponent()
    handle = jest.fn()
  })

  describe('when a message is delivered normally', () => {
    beforeEach(() => {
      guarded('island_changed', logs.logger, handle)(null as never, message)
    })

    it('should pass it to the handler', () => {
      expect(handle).toHaveBeenCalledWith(message)
    })

    it('should log nothing', () => {
      expect(logs.logger.error).not.toHaveBeenCalled()
    })
  })

  describe('when the subscription reports a delivery error', () => {
    const deliveryError = new Error('permissions violation')

    beforeEach(() => {
      guarded('island_changed', logs.logger, handle)(deliveryError as never, message)
    })

    it('should not invoke the handler with a message it never received', () => {
      expect(handle).not.toHaveBeenCalled()
    })

    it('should log the error', () => {
      expect(logs.logger.error).toHaveBeenCalledWith(deliveryError)
    })
  })

  describe('when the handler throws', () => {
    beforeEach(() => {
      handle.mockImplementation(() => {
        throw new Error('decode failed')
      })
    })

    it('should contain the throw, since one escaping stops delivery on every subject', () => {
      expect(() => guarded('island_changed', logs.logger, handle)(null as never, message)).not.toThrow()
    })

    it('should log which message kind failed and why', () => {
      guarded('island_changed', logs.logger, handle)(null as never, message)

      expect(logs.logger.error).toHaveBeenCalledWith('cannot process island_changed message decode failed')
    })
  })

  describe('when the handler throws a non-Error value', () => {
    beforeEach(() => {
      handle.mockImplementation(() => {
        throw 'a bare string'
      })
    })

    it('should still contain it and fall back to a generic message', () => {
      guarded('heartbeat', logs.logger, handle)(null as never, message)

      expect(logs.logger.error).toHaveBeenCalledWith('cannot process heartbeat message Unknown error')
    })
  })
})
