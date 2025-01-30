import { HandlerContextWithPath, PeerData } from '../../types'
import { toParcel } from '../../logic/utils'

type PeerResult = {
  id: string
  address: string
  lastPing: number
  parcel: [number, number]
  position: [number, number, number]
}

type PeersResponse = {
  body: {
    ok: boolean
    peers: PeerResult[]
  }
}

type PeerResponse = {
  status: number
  body: {
    ok: boolean
    peer: PeerResult | null
  }
}

function processPeer(peer: PeerData): PeerResult {
  const { address, time, x, y, z } = peer
  const [parcelX, parcelY] = toParcel(x, z)
  return {
    id: address,
    address: address,
    lastPing: time,
    parcel: [parcelX, parcelY],
    position: [x, y, z]
  }
}

export async function peersHandler(
  context: Pick<HandlerContextWithPath<'stats', '/peers'>, 'url' | 'components'>
): Promise<PeersResponse> {
  const {
    components: { stats }
  } = context

  const peers = stats.getPeers()
  const result: PeerResult[] = []

  for (const peer of peers.values()) {
    result.push(processPeer(peer))
  }

  return {
    body: { ok: true, peers: result }
  }
}

export async function peerHandler(
  context: Pick<HandlerContextWithPath<'stats', '/peers/:id'>, 'url' | 'params' | 'components'>
): Promise<PeerResponse> {
  const {
    components: { stats }
  } = context

  const peer = stats.getPeers().get(context.params.id)

  if (!peer) {
    return {
      status: 404,
      body: { ok: false, peer: null }
    }
  }

  const result = processPeer(peer)

  return {
    status: 200,
    body: { ok: true, peer: result }
  }
}
