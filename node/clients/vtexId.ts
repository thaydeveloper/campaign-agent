import type { InstanceOptions, IOContext } from '@vtex/api'
import { JanusClient } from '@vtex/api'

import type { TokenValidation } from '../skuMapping/adminUser'

/**
 * VTEX ID check of an Admin token. The token goes in the body, never in a
 * URL, so it does not end up in access logs.
 */
export class VtexIdClient extends JanusClient {
  constructor(context: IOContext, options?: InstanceOptions) {
    super(context, { ...options, retries: 1, timeout: 5000 })
  }

  public validate(token: string) {
    return this.http.post<TokenValidation>(
      '/api/vtexid/credential/validate',
      { token },
      { metric: 'vtexid-credential-validate' }
    )
  }
}
