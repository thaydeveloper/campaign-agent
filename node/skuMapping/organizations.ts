import { failureDetail, SkuMappingError } from './errors'
import { isOrganizationId } from './input'

/**
 * An organization is a B2B contract: a CL document with isCorporate=true.
 * Its id is the customerId the portal stores as tenant_id. Same reading as
 * admin-order-guides (`contracts`).
 */
export interface Organization {
  id: string
  name: string
}

/** Fields read off the platform-managed CL entity. */
export interface ClDocument {
  id: string
  corporateName?: string | null
  tradeName?: string | null
  isCorporate?: boolean | string | null
}

export interface OrganizationSource {
  /** One page of CL documents with isCorporate=true. */
  searchCorporate(page: number, pageSize: number): Promise<ClDocument[]>
  /** One CL document, or null when there is none with this id. */
  get(id: string): Promise<ClDocument | null>
}

/** Master Data caps a search page at 100 documents. */
export const PAGE_SIZE = 100
/** Up to 5,000 organizations in the selector. */
export const MAX_PAGES = 50

const nameOf = (document: ClDocument) =>
  (document.tradeName || document.corporateName || document.id).trim()

const isCorporate = (document: ClDocument) =>
  document.isCorporate === true || document.isCorporate === 'true'

async function masterData<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof SkuMappingError) throw error
    throw new SkuMappingError('UNAVAILABLE', {
      source: 'master-data',
      ...failureDetail(error),
    })
  }
}

/**
 * Lists organizations and checks the one a request names. A confirmed
 * organization is kept for five minutes, so searching and paging do not hit
 * Master Data on every request.
 */
export function createOrganizations({
  now = Date.now,
  ttlMs = 300000,
  maxEntries = 1000,
}: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}) {
  const confirmed = new Map<string, { organization: Organization; until: number }>()

  return {
    async list(source: OrganizationSource): Promise<Organization[]> {
      const organizations: Organization[] = []

      for (let page = 1; page <= MAX_PAGES; page++) {
        const documents = await masterData(() => source.searchCorporate(page, PAGE_SIZE))

        for (const document of documents) {
          // A tenant_id is a UUID: other ids could never hold mappings.
          if (isOrganizationId(document.id)) {
            organizations.push({ id: document.id, name: nameOf(document) })
          }
        }

        if (documents.length < PAGE_SIZE) break
      }

      return organizations.sort(
        (a, b) =>
          a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
          a.id.localeCompare(b.id)
      )
    },

    /** Throws ORGANIZATION_NOT_FOUND unless `id` is a corporate CL document. */
    async verify(account: string, id: string, source: OrganizationSource): Promise<Organization> {
      const key = `${account}/${id}`
      const cached = confirmed.get(key)

      if (cached && cached.until > now()) return cached.organization
      confirmed.delete(key)

      const document = await masterData(() => source.get(id))

      if (!document || !isCorporate(document)) {
        throw new SkuMappingError('ORGANIZATION_NOT_FOUND')
      }

      if (confirmed.size >= maxEntries) {
        const oldest = confirmed.keys().next()

        if (!oldest.done) confirmed.delete(oldest.value)
      }

      const organization = { id, name: nameOf(document) }

      confirmed.set(key, { organization, until: now() + ttlMs })

      return organization
    },
  }
}
