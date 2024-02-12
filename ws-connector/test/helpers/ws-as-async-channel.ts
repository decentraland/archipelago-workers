import { AsyncQueue } from '@well-known-components/pushable-channel'
import { WebSocket } from 'ws'

export function wsAsAsyncChannel<Packet>(socket: WebSocket, decoder: (data: Uint8Array) => Packet) {
  // Wire the socket to a pushable channel
  const channel = new AsyncQueue<Packet>((queue, action) => {
    if (action === 'close') {
      socket.off('message', processMessage)
      socket.off('close', closeChannel)
    }
  })
  function processMessage(data: ArrayBuffer) {
    try {
      channel.enqueue(decoder(new Uint8Array(data)))
    } catch (error: any) {
      socket.emit('error', error)
      try {
        socket.close()
      } catch {}
    }
  }
  function closeChannel() {
    channel.close()
  }
  socket.on('message', processMessage)
  socket.on('close', closeChannel)
  socket.on('error', closeChannel)
  return Object.assign(channel, {
    async yield(timeoutMs: number, error?: string): Promise<Packet> {
      if (timeoutMs) {
        const next: any = (await Promise.race([channel.next(), timeout(timeoutMs, error)])) as any
        if (next.done) throw new Error('Cannot consume message from closed AsyncQueue. ' + error)
        return next.value
      } else {
        const next = await channel.next()
        if (next.done) throw new Error('Cannot consume message from closed AsyncQueue.' + error)
        return next.value
      }
    }
  })
}

function timeout(ms: number, error = 'Timed out') {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(error)), ms)
  })
}
