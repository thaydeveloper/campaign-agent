import type { ServiceContext } from '@vtex/api'
import { ForbiddenError, ResolverError, UserInputError } from '@vtex/api'

import type { Clients } from './clients'
import { createAdminUsers } from './skuMapping/adminUser'
import { createDatabase } from './skuMapping/database'
import { failureDetail, SkuMappingError } from './skuMapping/errors'
import type { ClDocument, OrganizationSource } from './skuMapping/organizations'
import { createOrganizations } from './skuMapping/organizations'
import type { SkuMappingService } from './skuMapping/service'
import { createSkuMappingService } from './skuMapping/service'
import { parseSettings } from './skuMapping/settings'

type Context = ServiceContext<Clients>

const CL = 'CL'

// Kept across requests of this worker.
const adminUsers = createAdminUsers()
const organizations = createOrganizations()

function organizationSource({ clients: { masterdata } }: Context): OrganizationSource {
  return {
    searchCorporate: (page, pageSize) =>
      masterdata.searchDocuments<ClDocument>({
        dataEntity: CL,
        fields: ['id', 'corporateName', 'tradeName'],
        where: 'isCorporate=true',
        pagination: { page, pageSize },
      }),
    get: async (id) => {
      try {
        return await masterdata.getDocument<ClDocument>({
          dataEntity: CL,
          id,
          fields: ['id', 'corporateName', 'tradeName', 'isCorporate'],
        })
      } catch (error) {
        if ((error as { response?: { status?: number } }).response?.status === 404) return null
        throw error
      }
    },
  }
}

async function readSettings(ctx: Context) {
  let raw: unknown

  try {
    raw = await ctx.clients.apps.getAppSettings(process.env.VTEX_APP_ID as string)
  } catch (error) {
    throw new SkuMappingError('UNAVAILABLE', { source: 'app-settings', ...failureDetail(error) })
  }

  return parseSettings(raw)
}

function serviceFor(ctx: Context): SkuMappingService {
  const { account, adminUserAuthToken } = ctx.vtex
  const source = organizationSource(ctx)

  return createSkuMappingService({
    adminUser: () =>
      adminUsers.verify(account, adminUserAuthToken, (token) => ctx.clients.vtexId.validate(token)),
    listOrganizations: () => organizations.list(source),
    verifyOrganization: (id) => organizations.verify(account, id, source),
    database: async () => {
      const settings = await readSettings(ctx)

      return createDatabase((name, args) => ctx.clients.dataApi.rpc(settings, name, args))
    },
  })
}

/** Admin data changes with every import: never cached, by the browser or the edge. */
function noCache(ctx: Context) {
  const { graphql } = ctx as unknown as {
    graphql?: { cacheControl?: { noCache: boolean; noStore: boolean } }
  }

  if (graphql?.cacheControl) {
    graphql.cacheControl.noCache = true
    graphql.cacheControl.noStore = true
  }
}

/** The message is the code, which the screen translates. */
function toGraphQLError(ctx: Context, error: unknown): Error {
  if (error instanceof SkuMappingError) {
    if (error.code === 'UNAUTHORIZED') return new ForbiddenError(error.code)
    if (error.code === 'UNAVAILABLE') {
      ctx.vtex.logger.error({ message: 'SKU mapping: a dependency failed', ...error.detail })

      return new ResolverError(error.code, 503)
    }

    return new UserInputError(error.code)
  }

  ctx.vtex.logger.error({
    message: 'SKU mapping: unexpected failure',
    error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
  })

  return new ResolverError('UNAVAILABLE', 500)
}

function field<Args, Result>(work: (service: SkuMappingService, args: Args) => Promise<Result>) {
  return async (_root: unknown, args: Args, ctx: Context) => {
    noCache(ctx)
    try {
      return await work(serviceFor(ctx), args)
    } catch (error) {
      throw toGraphQLError(ctx, error)
    }
  }
}

type OrganizationArgs = { organizationId: string }
type ImportArgs = OrganizationArgs & { importId: number }

export const resolvers = {
  Query: {
    skuMappingOrganizations: field((service) => service.organizations()),
    skuMappingOverview: field((service, args: OrganizationArgs) =>
      service.overview(args.organizationId)
    ),
    skuMappings: field(
      (service, args: OrganizationArgs & { query?: string; after?: string; before?: string }) =>
        service.mappings(args.organizationId, args)
    ),
  },
  Mutation: {
    startSkuMappingImport: field((service, args: OrganizationArgs & { fileName: string }) =>
      service.startImport(args.organizationId, args.fileName)
    ),
    addSkuMappingChunk: field((service, args: ImportArgs & { rows: string[][] }) =>
      service.addChunk(args.organizationId, args.importId, args.rows)
    ),
    finishSkuMappingImport: field((service, args: ImportArgs & { rejectedRows: number }) =>
      service.finishImport(args.organizationId, args.importId, args.rejectedRows)
    ),
    cancelSkuMappingImport: field(async (service, args: ImportArgs) =>
      (await service.cancelImport(args.organizationId, args.importId)).cancelled
    ),
  },
}
