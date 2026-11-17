/**
 * The database functions of migration 005, called through the Supabase Data
 * API (POST /rest/v1/rpc/<name>). Each call is one transaction.
 */
import { databaseError } from './errors'

export type Rpc = <T>(name: string, args: Record<string, unknown>) => Promise<T>

export interface ImportSummary {
  id: number
  fileName: string
  status: 'running' | 'sweeping' | 'completed' | 'failed'
  inserted: number
  updated: number
  rejected: number
  startedAt: string
  finishedAt: string | null
  /** Opened by the user asking. */
  mine: boolean
}

export interface Overview {
  total: number
  /** Most recent finished import (completed or stopped). */
  lastImport: ImportSummary | null
  /** Import still sending chunks; stale ones are left out. */
  activeImport: ImportSummary | null
}

export interface MappingRow {
  ownerSku: string
  vtexSku: string
  updatedAt: string
}

export interface MappingPage {
  rows: MappingRow[]
  /** Cursor for the next page (`after`), when there is one. */
  next: string | null
  /** Cursor for the previous page (`before`), when there is one. */
  previous: string | null
}

export interface ChunkResult {
  inserted: number
  updated: number
  unchanged: number
}

export interface FinishResult {
  inserted: number
  updated: number
  total: number
}

export function createDatabase(rpc: Rpc) {
  const call = async <T>(name: string, args: Record<string, unknown>) => {
    try {
      return await rpc<T>(name, args)
    } catch (error) {
      throw databaseError(error)
    }
  }

  return {
    start: (tenant: string, userId: string, fileName: string) =>
      call<{ importId: number }>('sku_mapping_admin_start', {
        p_tenant: tenant,
        p_user_id: userId,
        p_file_name: fileName,
      }),

    chunk: (tenant: string, userId: string, importId: number, rows: Array<[string, string]>) =>
      call<ChunkResult>('sku_mapping_admin_chunk', {
        p_tenant: tenant,
        p_user_id: userId,
        p_import_id: importId,
        p_rows: rows,
      }),

    finish: (tenant: string, userId: string, importId: number, rejectedRows: number) =>
      call<FinishResult>('sku_mapping_admin_finish', {
        p_tenant: tenant,
        p_user_id: userId,
        p_import_id: importId,
        p_rejected_rows: rejectedRows,
      }),

    cancel: (tenant: string, userId: string, importId: number) =>
      call<{ cancelled: boolean }>('sku_mapping_admin_cancel', {
        p_tenant: tenant,
        p_user_id: userId,
        p_import_id: importId,
      }),

    overview: (tenant: string, userId: string) =>
      call<Overview>('sku_mapping_admin_overview', {
        p_tenant: tenant,
        p_user_id: userId,
      }),

    page: (
      tenant: string,
      search: { query: string | null; after: string | null; before: string | null }
    ) =>
      call<MappingPage>('sku_mapping_admin_page', {
        p_tenant: tenant,
        p_query: search.query ?? '',
        p_after: search.after,
        p_before: search.before,
      }),
  }
}

export type Database = ReturnType<typeof createDatabase>
