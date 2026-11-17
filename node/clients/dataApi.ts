import type { InstanceOptions, IOContext } from '@vtex/api'
import { ExternalClient } from '@vtex/api'

import type { DatabaseSettings } from '../skuMapping/settings'

/**
 * Supabase Data API (PostgREST), used only to call the functions of
 * migration 005 as sku_mapping_writer. The host must match the
 * outbound-access policy in manifest.json.
 */
export class SupabaseDataApi extends ExternalClient {
  constructor(context: IOContext, options?: InstanceOptions) {
    // Calls are not retried here: the screen retries chunks itself, and
    // opening or closing an import twice is not harmless.
    super('', context, { ...options, retries: 0, timeout: 20000 })
  }

  public rpc<T>(settings: DatabaseSettings, name: string, args: Record<string, unknown>) {
    return this.http.post<T>(`${settings.url}/rest/v1/rpc/${name}`, args, {
      headers: {
        apikey: settings.publishableKey,
        Authorization: `Bearer ${settings.writerToken}`,
        'Content-Type': 'application/json',
      },
      metric: `supabase-rpc-${name}`,
    })
  }
}
