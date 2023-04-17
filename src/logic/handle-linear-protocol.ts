import { EthAddress } from '@dcl/schemas'
import { AppComponents, InternalWebSocket } from '../types'
import { Authenticator } from '@dcl/crypto'
import { wsAsAsyncChannel } from './ws-as-async-channel'
import { normalizeAddress } from './address'
import { craftMessage } from './craft-message'
import { ClientPacket, KickedReason } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'

export async function handleSocketLinearProtocol(
  { logs, ethereumProvider, peersRegistry }: Pick<AppComponents, 'logs' | 'peersRegistry' | 'ethereumProvider'>,
  socket: InternalWebSocket
) {
  const logger = logs.getLogger('LinearProtocol')
  // Wire the socket to a pushable channel
  const channel = wsAsAsyncChannel<ClientPacket>(socket, ClientPacket.decode)

  try {
    // process the messages
    /// 1. the remote client sends their authentication message
    let packet = await channel.yield(1000, 'Timed out waiting for challengeRequest')

    if (!packet.message || packet.message.$case !== 'challengeRequest') {
      throw new Error('Invalid protocol. challengeRequest packet missed')
    }

    if (!EthAddress.validate(packet.message.challengeRequest.address))
      throw new Error('Invalid protocol. challengeRequest has an invalid address')

    const address = normalizeAddress(packet.message.challengeRequest.address)

    const challengeToSign = 'dcl-' + Math.random().toString(36)
    const previousWs = peersRegistry.getPeerWs(address)
    const alreadyConnected = !!previousWs
    logger.debug('Generating challenge', {
      challengeToSign,
      address,
      alreadyConnected: alreadyConnected + ''
    })

    const challengeMessage = craftMessage({
      message: {
        $case: 'challengeResponse',
        challengeResponse: { alreadyConnected, challengeToSign }
      }
    })

    if (socket.send(challengeMessage, true) !== 1) {
      logger.error('Closing connection: cannot send challenge')
      socket.close()
      return
    }

    /// 3. wait for the confirmation message
    packet = await channel.yield(1000, 'Timed out waiting for signed challenge response')

    if (!packet.message || packet.message.$case !== 'signedChallenge') {
      throw new Error('Invalid protocol. signedChallengeForServer packet missed')
    }

    const result = await Authenticator.validateSignature(
      challengeToSign,
      JSON.parse(packet.message.signedChallenge.authChainJson),
      ethereumProvider
    )

    if (result.ok) {
      socket.address = normalizeAddress(address)
      logger.debug(`Authentication successful`, { address: address })

      if (previousWs) {
        const kickedMessage = craftMessage({
          message: {
            $case: 'kicked',
            kicked: { reason: KickedReason.KR_NEW_SESSION }
          }
        })
        if (previousWs.send(kickedMessage, true) !== 1) {
          logger.error('Closing connection: cannot send kicked message')
        }
        previousWs.end()
      }
    } else {
      logger.warn(`Authentication failed`, { message: result.message } as any)
      throw new Error('Authentication failed')
    }
  } finally {
    // close the channel to remove the listener
    channel.close()
  }
}
