import { peerHandler, peersHandler } from '../../src/controllers/handlers/peers-handler'
import { createStatsComponent, IStatsComponent } from '../../src/adapters/stats'

describe('peers-controller-unit', () => {
  const now = Date.now()
  let stats: IStatsComponent

  beforeEach(() => {
    stats = createStatsComponent()

    stats.onPeerUpdated('0x0001', { time: now, address: '0x0001', x: 0, y: 0, z: 0 })
    stats.onPeerUpdated('0x0002', { time: now, address: '0x0002', x: 1600, y: 1, z: 1600 })
  })

  describe('/peers', () => {
    it('ok', async () => {
      const url = new URL('https://localhost/peers')

      const {
        body: { ok, peers }
      } = await peersHandler({ url, components: { stats } })

      expect(ok).toEqual(true)
      expect(peers).toHaveLength(2)
      expect(peers).toEqual(
        expect.arrayContaining([
          {
            id: '0x0001',
            address: '0x0001',
            lastPing: now,
            parcel: [0, 0],
            position: [0, 0, 0]
          },
          {
            id: '0x0002',
            address: '0x0002',
            lastPing: now,
            parcel: [100, 100],
            position: [1600, 1, 1600]
          }
        ])
      )
    })
  })

  describe('/peers/:id', () => {
    it('ok', async () => {
      const url = new URL('https://localhost/peers/0x0001')

      const {
        body: { ok, peer }
      } = await peerHandler({
        url,
        components: { stats },
        params: { id: '0x0001' }
      })

      expect(ok).toEqual(true)
      expect(peer).toEqual(
        expect.objectContaining({
          id: '0x0001',
          address: '0x0001',
          lastPing: now,
          parcel: [0, 0],
          position: [0, 0, 0]
        })
      )
    })

    it('not found', async () => {
      const url = new URL('https://localhost/peers/0x0003')

      const {
        body: { ok, peer }
      } = await peerHandler({ url, components: { stats }, params: { id: '0x0003' } })

      expect(ok).toEqual(false)
      expect(peer).toEqual(null)
    })
  })
})
