import { ILoggerComponent } from '@well-known-components/interfaces'
import { InternalWebSocket } from '../types'
import { getErrorMessage } from './errors'

/** Return values of µWebSockets' `WebSocket.send`. */
export const SendResult = {
  /** The frame was accepted into backpressure and drains over time. */
  QUEUED: 0,
  /** The frame was written. */
  SENT: 1,
  /** The frame was dropped because it would exceed the route's `maxBackpressure`. */
  DROPPED: 2
} as const

/** WebSocket close code 1013: the server asks the client to try again later. */
export const CLOSE_TRY_AGAIN_LATER = 1013

/** The close sent to a socket whose island assignment µWebSockets dropped. */
export const ISLAND_ASSIGNMENT_DROPPED_CLOSE = {
  code: CLOSE_TRY_AGAIN_LATER,
  message: 'Island assignment dropped; reconnect'
} as const

/**
 * Ends a socket exactly once.
 *
 * `isClosed` is set before `end()` because `end()` can invoke the close handler synchronously,
 * and a throw from `end()` is logged rather than propagated: the socket is already being
 * discarded, and every caller runs inside a µWebSockets or NATS callback where a throw would
 * take unrelated work down with it. `close` travels as a pair rather than two optionals: a code
 * without a message was an unreachable branch across all call sites, and leaving it in invited
 * someone to pass one and have it silently dropped. Closing with no reason at all stays the
 * common case.
 *
 * @param ws - The socket to end.
 * @param logger - Where a failing `end()` is reported.
 * @param close - The close code and reason, or nothing for a plain close.
 */
export function safeEndWebSocket(
  ws: InternalWebSocket,
  logger: ILoggerComponent.ILogger,
  close?: { code: number; message: string | Uint8Array }
): void {
  const userData = ws.getUserData()
  if (userData.isClosed) {
    return
  }
  try {
    userData.isClosed = true
    if (close) {
      ws.end(close.code, close.message)
    } else {
      ws.end()
    }
  } catch (error) {
    logger.error(`Error while safely ending WebSocket: ${getErrorMessage(error)}`)
  }
}
