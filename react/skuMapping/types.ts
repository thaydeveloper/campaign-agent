export interface Organization {
  id: string
  name: string
}

export interface ImportSummary {
  id: number
  fileName: string
  status: 'running' | 'sweeping' | 'completed' | 'failed'
  inserted: number
  updated: number
  rejected: number
  startedAt: string
  finishedAt: string | null
  mine: boolean
}

export interface Overview {
  total: number
  lastImport: ImportSummary | null
  activeImport: ImportSummary | null
}

export interface MappingRow {
  ownerSku: string
  vtexSku: string
  updatedAt: string
}

export interface MappingPage {
  rows: MappingRow[]
  next: string | null
  previous: string | null
}
