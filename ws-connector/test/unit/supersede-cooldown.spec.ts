import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createSupersedeCooldown } from '../../src/adapters/supersede-cooldown'
import { ISupersedeCooldownComponent } from '../../src/adapters/supersede-cooldown'

const ADDRESS = '0x0000000000000000000000000000000000000001'
const OTHER_ADDRESS = '0x0000000000000000000000000000000000000002'
const COOLDOWN_MS = 5000

describe('supersede-cooldown', () => {
  let cooldown: ISupersedeCooldownComponent

  async function build(env: Record<string, string> = {}): Promise<ISupersedeCooldownComponent> {
    const logs = await createLogComponent({ config: createConfigComponent({ LOG_LEVEL: 'ERROR' }) })
    return createSupersedeCooldown({ config: createConfigComponent(env), logs })
  }

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('when an address has never been superseded', () => {
    beforeEach(async () => {
      cooldown = await build()
    })

    it('should not report it as cooling down', () => {
      expect(cooldown.isCoolingDown(ADDRESS)).toBe(false)
    })
  })

  describe('when an address was just superseded', () => {
    beforeEach(async () => {
      jest.useFakeTimers()
      cooldown = await build()
      cooldown.onSuperseded(ADDRESS)
    })

    it('should report it as cooling down', () => {
      expect(cooldown.isCoolingDown(ADDRESS)).toBe(true)
    })

    it('should leave every other address alone', () => {
      expect(cooldown.isCoolingDown(OTHER_ADDRESS)).toBe(false)
    })

    describe('and the window has not quite elapsed', () => {
      beforeEach(() => {
        jest.advanceTimersByTime(COOLDOWN_MS - 1)
      })

      it('should still report it as cooling down', () => {
        expect(cooldown.isCoolingDown(ADDRESS)).toBe(true)
      })
    })

    describe('and the window has elapsed', () => {
      beforeEach(() => {
        jest.advanceTimersByTime(COOLDOWN_MS)
      })

      it('should stop reporting it as cooling down', () => {
        expect(cooldown.isCoolingDown(ADDRESS)).toBe(false)
      })
    })

    describe('and it is superseded again before the window elapses', () => {
      beforeEach(() => {
        jest.advanceTimersByTime(COOLDOWN_MS - 1)
        cooldown.onSuperseded(ADDRESS)
        jest.advanceTimersByTime(COOLDOWN_MS - 1)
      })

      it('should measure the window from the later supersede', () => {
        expect(cooldown.isCoolingDown(ADDRESS)).toBe(true)
      })
    })
  })

  describe('when the cooldown is configured to a custom window', () => {
    beforeEach(async () => {
      jest.useFakeTimers()
      cooldown = await build({ SUPERSEDE_COOLDOWN_MS: '500' })
      cooldown.onSuperseded(ADDRESS)
      jest.advanceTimersByTime(500)
    })

    it('should honour it instead of the default', () => {
      expect(cooldown.isCoolingDown(ADDRESS)).toBe(false)
    })
  })

  describe('when more addresses are superseded than the sweep threshold', () => {
    // Above SWEEP_THRESHOLD in the component; if that grows past this, raise this with it.
    const OVER_THRESHOLD = 1100

    beforeEach(async () => {
      jest.useFakeTimers()
      cooldown = await build()
      for (let i = 0; i < OVER_THRESHOLD; i += 1) {
        cooldown.onSuperseded(`0x${i}`)
      }
      jest.advanceTimersByTime(COOLDOWN_MS)
      cooldown.onSuperseded(ADDRESS)
    })

    it('should drop the lapsed entries rather than hold every address it ever saw', () => {
      expect(cooldown.size()).toBe(1)
    })
  })

  describe('when the cooldown is configured as zero', () => {
    beforeEach(async () => {
      cooldown = await build({ SUPERSEDE_COOLDOWN_MS: '0' })
      cooldown.onSuperseded(ADDRESS)
    })

    it('should never report an address as cooling down, since zero is the kill switch', () => {
      expect(cooldown.isCoolingDown(ADDRESS)).toBe(false)
    })
  })

  describe('when the cooldown is configured as a negative window', () => {
    beforeEach(async () => {
      cooldown = await build({ SUPERSEDE_COOLDOWN_MS: '-1' })
      cooldown.onSuperseded(ADDRESS)
    })

    it('should turn the guard off too, not just an exact zero', () => {
      expect(cooldown.isCoolingDown(ADDRESS)).toBe(false)
    })
  })
})
