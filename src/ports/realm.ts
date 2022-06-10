import { DAOClient, noReject, ServerMetadata } from '@dcl/catalyst-node-commons'
import { IBaseComponent } from '@well-known-components/interfaces'
import { BaseComponents } from '../types'
import { DAOContractClient } from '@dcl/catalyst-node-commons'
import { DAOContract } from '@dcl/catalyst-contracts'

const DEFAULT_ETH_NETWORK = 'ropsten' // TODO update to new network

export type IRealmComponent = IBaseComponent & {
  getRealmName(): string
  start(): Promise<void>
}

export const defaultNames = [
  'zeus',
  'poseidon',
  'athena',
  'hera',
  'hephaestus',
  'aphrodite',
  'hades',
  'hermes',
  'artemis',
  'thor',
  'loki',
  'odin',
  'freyja',
  'fenrir',
  'heimdallr',
  'baldr'
]

export async function createRealmComponent(
  components: Pick<BaseComponents, 'logs' | 'config'>
): Promise<IRealmComponent> {
  const { logs, config } = components
  const logger = logs.getLogger('Naming')

  let realmName = ''

  async function start() {
    const CURRENT_ETH_NETWORK = (await config.getString('ETH_NETWORK')) ?? DEFAULT_ETH_NETWORK

    // Keeping LIGHTHOUSE_NAMES for retrocompatibility
    const configuredNames = (await config.getString('REALM_NAMES')) || (await config.getString('LIGHTHOUSE_NAMES'))
    const daoClient = new DAOContractClient(DAOContract.withNetwork(CURRENT_ETH_NETWORK))
    realmName = await pickName(configuredNames, daoClient)
  }

  function getRealmName(): string {
    return realmName
  }

  async function pickName(configuredNames: string | undefined, daoClient: DAOClient, previousName?: string) {
    const existingNames: string[] = await getRealmNames(daoClient)

    if (typeof configuredNames === 'undefined') {
      // We use the stored name only if no name has been configured
      if (previousName && !existingNames.includes(previousName)) {
        return previousName
      } else if (previousName) {
        logger.warn('Could not reuse previous name because another server in the DAO already has it: ' + previousName)
      }
    }

    const namesList = (configuredNames?.split(',')?.map((it) => it.trim()) ?? defaultNames).filter(
      (it) => !existingNames.includes(it)
    )

    if (namesList.length === 0) throw new Error('Could not set my name! Names taken: ' + existingNames)

    const pickedName = namesList[Math.floor(Math.random() * namesList.length)]

    logger.info('Picked name: ' + pickedName)

    return pickedName
  }

  async function getRealmNames(daoClient: DAOClient) {
    const servers = await daoClient.getAllServers()
    const namePromises = await Promise.all(Array.from(servers).map(getName).map(noReject))
    const existingNames: string[] = namePromises
      .filter((result) => result[0] === 'fulfilled')
      .map((result) => result[1])
    return existingNames
  }

  async function getName(server: ServerMetadata): Promise<string> {
    //Timeout is an option that is supported server side, but not browser side, so it doesn't compile if we don't cast it to any
    try {
      const statusResponse = await fetch(`${server.baseUrl}/comms/status`, { timeout: 5000 } as any)
      const json = await statusResponse.json()

      if (json.name) {
        return json.name
      }

      throw new Error(`Response did not have the expected format. Response was: ${JSON.stringify(json)}`)
    } catch (e: any) {
      logger.warn(`Error while getting the name of ${server.baseUrl}, id: ${server.id}`, e.message)
      throw e
    }
  }

  return { getRealmName, start }
}
