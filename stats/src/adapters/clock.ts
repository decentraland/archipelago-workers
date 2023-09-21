export type IClockComponent = {
  now(): number
}

export function createClockComponent() {
  return {
    now: () => Date.now()
  }
}
