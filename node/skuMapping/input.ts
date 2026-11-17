/**
 * Checks what the screen sends before anything reaches Master Data or the
 * database. The database functions check rows and limits again.
 */
import { SkuMappingError } from './errors'

/** Same rule as the portal (src/domain/sku-mapping.ts) and migration 005. */
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
export const MAX_CHUNK_ROWS = 5000
export const MAX_REJECTED_ROWS = 100000000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const isOrganizationId = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value)

/**
 * An organization is the id of a corporate CL document, which is the
 * customerId the portal stores as tenant_id (a UUID).
 */
export function organizationId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : ''

  if (!isOrganizationId(id)) throw new SkuMappingError('ORGANIZATION_NOT_FOUND')

  return id
}

export function importId(value: unknown): number {
  const id = typeof value === 'string' ? Number(value) : value

  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
    throw new SkuMappingError('INVALID_INPUT')
  }

  return id
}

export function fileName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''

  if (name.length < 1 || name.length > 255) {
    throw new SkuMappingError('INVALID_INPUT')
  }

  return name
}

export function rejectedRows(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_REJECTED_ROWS
  ) {
    throw new SkuMappingError('INVALID_INPUT')
  }

  return value
}

/** One chunk: 1 to 5,000 [owner_sku, vtex_sku] pairs of valid codes. */
export function chunkRows(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CHUNK_ROWS) {
    throw new SkuMappingError('INVALID_ROWS')
  }

  return value.map((pair) => {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== 'string' ||
      typeof pair[1] !== 'string' ||
      !SKU_PATTERN.test(pair[0]) ||
      !SKU_PATTERN.test(pair[1])
    ) {
      throw new SkuMappingError('INVALID_ROWS')
    }

    return [pair[0], pair[1]] as [string, string]
  })
}

/** Search text and cursors: the database ignores values no code can have. */
export function searchText(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 80 ? value : null
}
