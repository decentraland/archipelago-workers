import { IRealmComponent } from '../../src/ports/realm'
import { BaseComponents } from '../../src/types'

export async function createTestRealmComponent(): Promise<IRealmComponent> {
  const getRealmName = () => {
    return 'test-realm'
  }

  const start = async () => {}

  return { getRealmName, start }
}
