import { SkuMappingError } from './errors'

/** App settings (manifest.json → settingsSchema). Read by the Node service only. */
export interface DatabaseSettings {
  /** https://<project-ref>.supabase.co */
  url: string
  /** Supabase publishable (anon) key: identifies the project, grants nothing. */
  publishableKey: string
  /** Data API token whose role is sku_mapping_writer (npm run db:writer-token). */
  writerToken: string
}

const SUPABASE_URL = /^https:\/\/[a-z0-9-]+\.supabase\.co$/
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

/** Throws NOT_CONFIGURED until all three settings are filled in correctly. */
export function parseSettings(raw: unknown): DatabaseSettings {
  const settings = (raw ?? {}) as Record<string, unknown>
  const url = text(settings.supabaseUrl).replace(/\/+$/, '')
  const publishableKey = text(settings.supabasePublishableKey)
  const writerToken = text(settings.writerToken)

  if (!SUPABASE_URL.test(url) || !publishableKey || !JWT.test(writerToken)) {
    throw new SkuMappingError('NOT_CONFIGURED')
  }

  return { url, publishableKey, writerToken }
}
