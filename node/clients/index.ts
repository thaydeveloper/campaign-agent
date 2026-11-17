import { IOClients } from '@vtex/api'

import { SupabaseDataApi } from './dataApi'
import { VtexIdClient } from './vtexId'

/** Master Data and app settings come from the native `masterdata` and `apps` clients. */
export class Clients extends IOClients {
  public get vtexId() {
    return this.getOrSet('vtexId', VtexIdClient)
  }

  public get dataApi() {
    return this.getOrSet('dataApi', SupabaseDataApi)
  }
}
