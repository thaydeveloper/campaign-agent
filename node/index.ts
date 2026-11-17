import type { ParamsContext, RecorderState } from '@vtex/api'
import { Service } from '@vtex/api'

import { Clients } from './clients'
import { resolvers } from './resolvers'

export default new Service<Clients, RecorderState, ParamsContext>({
  clients: {
    implementation: Clients,
    options: {
      default: {
        retries: 2,
        timeout: 5000,
      },
    },
  },
  graphql: {
    resolvers,
  },
})
