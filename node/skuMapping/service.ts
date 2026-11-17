/**
 * What each GraphQL field does, independent of VTEX IO so it can be tested.
 * Every call first confirms the Admin user. Every call that names an
 * organization confirms it in Master Data, except chunks: they write to an
 * import that was opened for a confirmed organization, and the database only
 * accepts them from the same organization and user.
 */
import type { AdminUser } from './adminUser'
import type { Database } from './database'
import * as input from './input'
import type { Organization } from './organizations'

export interface ServiceDependencies {
  adminUser: () => Promise<AdminUser>
  listOrganizations: () => Promise<Organization[]>
  verifyOrganization: (id: string) => Promise<Organization>
  database: () => Promise<Database>
}

export function createSkuMappingService(deps: ServiceDependencies) {
  const tenantOf = async (organizationId: unknown) =>
    (await deps.verifyOrganization(input.organizationId(organizationId))).id

  return {
    async organizations() {
      await deps.adminUser()

      return deps.listOrganizations()
    },

    async overview(organizationId: unknown) {
      const { email } = await deps.adminUser()
      const tenant = await tenantOf(organizationId)

      return (await deps.database()).overview(tenant, email)
    },

    async mappings(
      organizationId: unknown,
      search: { query?: unknown; after?: unknown; before?: unknown }
    ) {
      await deps.adminUser()
      const tenant = await tenantOf(organizationId)

      return (await deps.database()).page(tenant, {
        query: input.searchText(search.query),
        after: input.searchText(search.after),
        before: input.searchText(search.before),
      })
    },

    async startImport(organizationId: unknown, fileName: unknown) {
      const { email } = await deps.adminUser()
      const tenant = await tenantOf(organizationId)

      return (await deps.database()).start(tenant, email, input.fileName(fileName))
    },

    async addChunk(organizationId: unknown, importId: unknown, rows: unknown) {
      const { email } = await deps.adminUser()
      const tenant = input.organizationId(organizationId)

      return (await deps.database()).chunk(
        tenant,
        email,
        input.importId(importId),
        input.chunkRows(rows)
      )
    },

    async finishImport(organizationId: unknown, importId: unknown, rejectedRows: unknown) {
      const { email } = await deps.adminUser()
      const tenant = await tenantOf(organizationId)

      return (await deps.database()).finish(
        tenant,
        email,
        input.importId(importId),
        input.rejectedRows(rejectedRows)
      )
    },

    async cancelImport(organizationId: unknown, importId: unknown) {
      const { email } = await deps.adminUser()
      const tenant = await tenantOf(organizationId)

      return (await deps.database()).cancel(tenant, email, input.importId(importId))
    },
  }
}

export type SkuMappingService = ReturnType<typeof createSkuMappingService>
