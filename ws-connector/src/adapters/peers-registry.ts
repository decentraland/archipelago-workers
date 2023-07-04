import { IBaseComponent } from '@well-known-components/interfaces'
import { InternalWebSocket } from '../types'
// import { IslandChangedMessage } from '@dcl/protocol/out-js/decentraland/kernel/comms/v3/archipelago.gen'
// import { craftMessage } from '../logic/craft-message'

export type WsApp = {
  publish(topic: string, payload: Uint8Array, binary: boolean): void
}

export type IPeersRegistryComponent = IBaseComponent & {
  onPeerConnected(id: string, ws: InternalWebSocket): void
  onPeerDisconnected(id: string): void
  getPeerWs(id: string): InternalWebSocket | undefined
  getPeerCount(): number
  // onChangeToIsland(peerId: string, island: Island, change: ChangeToIslandUpdate): void
  // onPeerLeft(peerId: string, islandId: string): void
}

export async function createPeersRegistry(uws: WsApp): Promise<IPeersRegistryComponent> {
  const connectedPeers = new Map<string, InternalWebSocket>()

  function onPeerConnected(id: string, ws: InternalWebSocket): void {
    connectedPeers.set(id, ws)
  }

  function onPeerDisconnected(id: string): void {
    connectedPeers.delete(id)
  }

  // function onPeerPositionsUpdate(changes: PeerPositionChange[]): void {
  // }

  function getPeerWs(id: string): InternalWebSocket | undefined {
    return connectedPeers.get(id)
  }

  function getPeerCount(): number {
    return connectedPeers.size
  }

  // function onChangeToIsland(peerId: string, toIsland: Island, update: ChangeToIslandUpdate) {
  //   const islandChangedMessage: IslandChangedMessage = {
  //     islandId: update.islandId,
  //     connStr: update.connStr,
  //     peers: {}
  //   }

  //   toIsland.peers.forEach((peerData: PeerData) => {
  //     islandChangedMessage.peers[peerData.id] = {
  //       x: peerData.position[0],
  //       y: peerData.position[1],
  //       z: peerData.position[2]
  //     }
  //   })
  //   if (update.fromIslandId) {
  //     islandChangedMessage.fromIslandId = update.fromIslandId
  //   }

  //   uws.publish(
  //     `island.${update.islandId}`,
  //     craftMessage({
  //       message: {
  //         $case: 'joinIsland',
  //         joinIsland: {
  //           islandId: update.islandId,
  //           peerId: peerId
  //         }
  //       }
  //     }),
  //     true
  //   )

  //   const ws = getPeerWs(peerId)
  //   if (ws) {
  //     if (update.fromIslandId) {
  //       ws.unsubscribe(`island.${update.fromIslandId}`)
  //     }

  //     ws.subscribe(`island.${update.islandId}`)

  //     ws.send(
  //       craftMessage({
  //         message: {
  //           $case: 'islandChanged',
  //           islandChanged: islandChangedMessage
  //         }
  //       }),
  //       true
  //     )
  //   }
  // }

  // function onPeerLeft(peerId: string, islandId: string) {
  //   uws.publish(
  //     `island.${islandId}`,
  //     craftMessage({
  //       message: {
  //         $case: 'leftIsland',
  //         leftIsland: {
  //           islandId: islandId,
  //           peerId: peerId
  //         }
  //       }
  //     }),
  //     true
  //   )
  // }

  return {
    // onPeerLeft,
    // onChangeToIsland,
    onPeerConnected,
    onPeerDisconnected,
    // onPeerPositionsUpdate,
    getPeerWs,
    getPeerCount
  }
}
