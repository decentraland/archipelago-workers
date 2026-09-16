import { IBaseComponent } from '@well-known-components/interfaces'

/**
 * Periodically re-checks every connected peer against comms-gatekeeper and disconnects the ones
 * that have been banned since they connected. Purely lifecycle-driven — it exposes no methods,
 * the work happens on its own interval between `[START_COMPONENT]` and `[STOP_COMPONENT]`.
 */
export type IBanSweepComponent = IBaseComponent
