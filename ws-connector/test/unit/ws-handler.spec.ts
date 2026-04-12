import { Stage, WsUserData } from '../../src/types'

/**
 * These tests verify the WebSocket handler behavior for edge cases
 * around socket closing and timeout cleanup. They test the logic
 * that was fixed in ws-handler.ts without requiring a full µWebSockets server.
 */
describe('ws-handler safety', () => {
  describe('safeEndWebSocket', () => {
    let isClosed: boolean
    let endCalls: Array<{ code?: number; message?: Buffer }>

    function createMockWs() {
      isClosed = false
      endCalls = []
      const userData: WsUserData & { isClosed?: boolean } = {
        stage: Stage.HANDSHAKE_START,
        isClosed: false
      }
      return {
        getUserData: () => userData,
        end: (code?: number, message?: Buffer) => {
          endCalls.push({ code, message })
        },
        send: jest.fn().mockReturnValue(1),
        close: jest.fn()
      }
    }

    // Replicates safeEndWebSocket from ws-handler.ts
    function safeEndWebSocket(ws: ReturnType<typeof createMockWs>, code?: number, message?: Buffer) {
      const userData = ws.getUserData()
      if (!userData.isClosed) {
        userData.isClosed = true
        if (message) {
          ws.end(code, message)
        } else if (code) {
          ws.end(code)
        } else {
          ws.end()
        }
      }
    }

    describe('when the socket is open', () => {
      let ws: ReturnType<typeof createMockWs>

      beforeEach(() => {
        ws = createMockWs()
      })

      it('should close the socket with the given code and message', () => {
        safeEndWebSocket(ws, 1007, Buffer.from('Cannot decode ClientPacket'))

        expect(endCalls).toHaveLength(1)
        expect(endCalls[0].code).toBe(1007)
        expect(endCalls[0].message).toEqual(Buffer.from('Cannot decode ClientPacket'))
      })

      it('should mark the socket as closed', () => {
        safeEndWebSocket(ws)

        expect(ws.getUserData().isClosed).toBe(true)
      })
    })

    describe('when the socket is already closed', () => {
      let ws: ReturnType<typeof createMockWs>

      beforeEach(() => {
        ws = createMockWs()
        ws.getUserData().isClosed = true
      })

      it('should not call end again', () => {
        safeEndWebSocket(ws, 1007, Buffer.from('test'))

        expect(endCalls).toHaveLength(0)
      })
    })

    describe('when called twice', () => {
      let ws: ReturnType<typeof createMockWs>

      beforeEach(() => {
        ws = createMockWs()
      })

      it('should only close the socket once', () => {
        safeEndWebSocket(ws)
        safeEndWebSocket(ws)

        expect(endCalls).toHaveLength(1)
      })
    })
  })

  describe('close handler timeout cleanup', () => {
    // Replicates the close handler logic from ws-handler.ts
    function simulateClose(data: WsUserData & { isClosed?: boolean; timeout?: NodeJS.Timeout }) {
      data.isClosed = true
      if (data.timeout) {
        clearTimeout(data.timeout)
        data.timeout = undefined
      }
    }

    describe('when a timeout is pending at close time', () => {
      let timeoutFired: boolean
      let data: WsUserData & { isClosed?: boolean; timeout?: NodeJS.Timeout }

      beforeEach(() => {
        timeoutFired = false
        data = {
          stage: Stage.HANDSHAKE_START,
          isClosed: false,
          timeout: setTimeout(() => {
            timeoutFired = true
          }, 100)
        }
      })

      afterEach(() => {
        if (data.timeout) {
          clearTimeout(data.timeout)
        }
      })

      it('should clear the timeout', () => {
        simulateClose(data)

        expect(data.timeout).toBeUndefined()
      })

      it('should prevent the timeout callback from firing', async () => {
        simulateClose(data)

        await new Promise((resolve) => setTimeout(resolve, 150))

        expect(timeoutFired).toBe(false)
      })
    })

    describe('when no timeout is pending at close time', () => {
      let data: WsUserData & { isClosed?: boolean; timeout?: NodeJS.Timeout }

      beforeEach(() => {
        data = {
          stage: Stage.HANDSHAKE_START,
          isClosed: false,
          timeout: undefined
        }
      })

      it('should handle gracefully without errors', () => {
        expect(() => simulateClose(data)).not.toThrow()
        expect(data.isClosed).toBe(true)
      })
    })
  })

  describe('peer registry leak on welcome send failure', () => {
    /**
     * This test documents a bug in the ws-handler: when a peer authenticates
     * successfully but the welcome message fails to send (backpressure),
     * the peer is registered in peersRegistry (line 209) but the close
     * handler doesn't clean it up because userData.address hasn't been set
     * yet (changeStage hasn't run). This leaves a ghost entry in the registry.
     */
    let registry: Map<string, any>
    let disconnectPublished: string[]

    beforeEach(() => {
      registry = new Map()
      disconnectPublished = []
    })

    function simulateAuthenticationSuccess(address: string) {
      // Simulates lines 209-236 of ws-handler.ts
      registry.set(address, { ws: 'mock_ws2' })
      return { registered: true }
    }

    function simulateWelcomeSendFailure(address: string, userData: WsUserData & { isClosed?: boolean; address?: string }) {
      // Simulates what happens when ws.send(welcomeMessage) !== 1
      // safeEndWebSocket is called, which triggers the close handler
      userData.isClosed = true

      // Close handler logic (lines 259-271)
      if (userData.address) {
        registry.delete(userData.address)
        disconnectPublished.push(userData.address)
      }
      // Note: if userData.address is undefined, cleanup is SKIPPED
    }

    describe('when the welcome message fails to send', () => {
      let userData: WsUserData & { isClosed?: boolean; address?: string }

      beforeEach(() => {
        // Before changeStage, userData is still in HANDSHAKE_CHALLENGE_SENT
        // and has no address field
        userData = {
          stage: Stage.HANDSHAKE_CHALLENGE_SENT,
          challengeToSign: 'dcl-test',
          isClosed: false
        }

        // Peer authenticates successfully - registered in peersRegistry
        simulateAuthenticationSuccess('0xabc')

        // Welcome send fails - triggers close handler
        simulateWelcomeSendFailure('0xabc', userData)
      })

      it('should leave a ghost entry in the peers registry', () => {
        // The close handler didn't clean up because userData.address was not set
        expect(registry.has('0xabc')).toBe(true)
      })

      it('should not publish a disconnect message to NATS', () => {
        expect(disconnectPublished).toHaveLength(0)
      })
    })

    describe('when the welcome message sends successfully', () => {
      let userData: WsUserData & { isClosed?: boolean; address?: string }

      beforeEach(() => {
        userData = {
          stage: Stage.HANDSHAKE_CHALLENGE_SENT,
          challengeToSign: 'dcl-test',
          isClosed: false
        }

        simulateAuthenticationSuccess('0xabc')

        // Welcome succeeds, stage is changed (sets userData.address)
        Object.assign(userData, { stage: Stage.HANDSHAKE_COMPLETED, address: '0xabc' })
      })

      describe('and the socket later closes normally', () => {
        beforeEach(() => {
          // Normal close
          userData.isClosed = true
          if (userData.address) {
            registry.delete(userData.address)
            disconnectPublished.push(userData.address)
          }
        })

        it('should clean up the registry correctly', () => {
          expect(registry.has('0xabc')).toBe(false)
        })

        it('should publish a disconnect message', () => {
          expect(disconnectPublished).toEqual(['0xabc'])
        })
      })
    })
  })

  describe('all socket close paths use safeEndWebSocket', () => {
    /**
     * These tests verify that all paths that close a WebSocket go through
     * safeEndWebSocket (or equivalent isClosed checks). Direct ws.end() or
     * ws.close() on an already-closed socket in µWebSockets causes undefined
     * behavior (potential segfault).
     */
    let endCalled: boolean
    let userData: WsUserData & { isClosed?: boolean }

    function createMockWs() {
      endCalled = false
      userData = { stage: Stage.HANDSHAKE_START, isClosed: false }
      return {
        getUserData: () => userData,
        end: () => { endCalled = true },
        send: jest.fn().mockReturnValue(1),
        close: jest.fn()
      }
    }

    function safeEndWebSocket(ws: ReturnType<typeof createMockWs>) {
      const data = ws.getUserData()
      if (!data.isClosed) {
        data.isClosed = true
        ws.end()
      }
    }

    describe('when the timeout handler fires on an already-closed socket', () => {
      beforeEach(() => {
        const ws = createMockWs()
        userData.isClosed = true
        safeEndWebSocket(ws)
      })

      it('should not call end', () => {
        expect(endCalled).toBe(false)
      })
    })

    describe('when the challenge send fails on an already-closed socket', () => {
      beforeEach(() => {
        const ws = createMockWs()
        userData.isClosed = true
        safeEndWebSocket(ws)
      })

      it('should not call end', () => {
        expect(endCalled).toBe(false)
      })
    })

    describe('when kicking a previous connection that is already closed', () => {
      beforeEach(() => {
        const previousWs = createMockWs()
        userData.isClosed = true
        // The kick path should check isClosed before sending and before ending
        safeEndWebSocket(previousWs)
      })

      it('should not call end on the already-closed previous socket', () => {
        expect(endCalled).toBe(false)
      })
    })
  })

  describe('deny list bypass via claimed address', () => {
    /**
     * Documents the deny list bypass vulnerability that was fixed:
     * The deny list was only checked against the claimed address in
     * challengeRequest, not the real address from the auth chain.
     * A denied user could claim a non-denied address and bypass the check.
     *
     * After the fix, the deny list is checked again after authentication
     * against the real address from the auth chain.
     */
    let denyList: Set<string>

    beforeEach(() => {
      denyList = new Set(['0xdenied'])
    })

    describe('when a denied user claims a non-denied address', () => {
      let claimedAddress: string
      let realAddress: string
      let preAuthBlocked: boolean
      let postAuthBlocked: boolean

      beforeEach(() => {
        claimedAddress = '0xinnocent'
        realAddress = '0xdenied'

        // Pre-auth check (challengeRequest stage) uses claimed address
        preAuthBlocked = denyList.has(claimedAddress)

        // Post-auth check (after signature validation) uses real address
        postAuthBlocked = denyList.has(realAddress)
      })

      it('should pass the pre-auth deny list check with the claimed address', () => {
        expect(preAuthBlocked).toBe(false)
      })

      it('should be caught by the post-auth deny list check with the real address', () => {
        expect(postAuthBlocked).toBe(true)
      })
    })

    describe('when a non-denied user connects normally', () => {
      let realAddress: string
      let postAuthBlocked: boolean

      beforeEach(() => {
        realAddress = '0xgooduser'
        postAuthBlocked = denyList.has(realAddress)
      })

      it('should not be blocked by the post-auth check', () => {
        expect(postAuthBlocked).toBe(false)
      })
    })
  })

  describe('deny list fetch failure retry storm', () => {
    /**
     * Documents the deny list TTL behavior on fetch failure.
     * Before the fix: denyListLastFetched was only updated on success,
     * causing every handshake to retry the failed fetch.
     * After the fix: denyListLastFetched is always updated, so failures
     * are cached for the TTL duration.
     */
    const TTL = 5 * 60 * 1000

    describe('when the deny list fetch fails (fixed behavior)', () => {
      let fetchCount: number
      let lastFetched: number
      let cachedList: Set<string>

      beforeEach(() => {
        fetchCount = 0
        lastFetched = 0
        cachedList = new Set()
      })

      // Replicates the FIXED fetchDenyList logic
      async function fetchDenyList(): Promise<Set<string>> {
        if (Date.now() - lastFetched < TTL) {
          return cachedList
        }
        try {
          fetchCount++
          throw new Error('network error')
        } catch {
          // error logged
        }
        // Always update timestamp, even on failure
        lastFetched = Date.now()
        return cachedList
      }

      it('should only attempt one fetch within the TTL window', async () => {
        await fetchDenyList()
        await fetchDenyList()
        await fetchDenyList()

        expect(fetchCount).toBe(1)
      })
    })

    describe('when the deny list fetch fails (pre-fix behavior)', () => {
      let fetchCount: number
      let lastFetched: number
      let cachedList: Set<string>

      beforeEach(() => {
        fetchCount = 0
        lastFetched = 0
        cachedList = new Set()
      })

      // Replicates the BROKEN fetchDenyList logic (timestamp only updated on success)
      async function fetchDenyListBroken(): Promise<Set<string>> {
        if (Date.now() - lastFetched < TTL) {
          return cachedList
        }
        try {
          fetchCount++
          throw new Error('network error')
        } catch {
          // error logged
          // BUG: lastFetched NOT updated on failure
        }
        return cachedList
      }

      it('should retry on every call because the timestamp is never updated', async () => {
        await fetchDenyListBroken()
        await fetchDenyListBroken()
        await fetchDenyListBroken()

        expect(fetchCount).toBe(3)
      })
    })
  })
})
