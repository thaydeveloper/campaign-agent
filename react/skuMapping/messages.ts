import { defineMessages } from 'react-intl'

import type { ErrorCode } from './request'

/*
 * Every id is written out in full on purpose: the VTEX react builder only
 * ships the messages whose ids appear literally as `id: '...'` (or id="...")
 * in the code. An id built at runtime, such as `error.${code}`, reaches the
 * screen untranslated.
 */

export const errorMessages: Record<ErrorCode, { id: string }> = defineMessages({
  UNAUTHORIZED: { id: 'sku-mapping.error.UNAUTHORIZED' },
  NOT_CONFIGURED: { id: 'sku-mapping.error.NOT_CONFIGURED' },
  ORGANIZATION_NOT_FOUND: { id: 'sku-mapping.error.ORGANIZATION_NOT_FOUND' },
  INVALID_INPUT: { id: 'sku-mapping.error.INVALID_INPUT' },
  INVALID_ROWS: { id: 'sku-mapping.error.INVALID_ROWS' },
  IMPORT_RUNNING: { id: 'sku-mapping.error.IMPORT_RUNNING' },
  IMPORT_NOT_RUNNING: { id: 'sku-mapping.error.IMPORT_NOT_RUNNING' },
  UNAVAILABLE: { id: 'sku-mapping.error.UNAVAILABLE' },
  NETWORK: { id: 'sku-mapping.error.NETWORK' },
})

export const importMessages = defineMessages({
  wrongType: { id: 'sku-mapping.import.wrong-type' },
  tooBigXlsx: { id: 'sku-mapping.import.too-big-xlsx' },
  tooBigCsv: { id: 'sku-mapping.import.too-big-csv' },
  unreadable: { id: 'sku-mapping.import.unreadable' },
  ready: { id: 'sku-mapping.import.ready' },
  rejected: { id: 'sku-mapping.import.rejected' },
  duplicates: { id: 'sku-mapping.import.duplicates' },
  numeric: { id: 'sku-mapping.import.numeric' },
  numericWarning: { id: 'sku-mapping.import.numeric-warning' },
  leadingZeros: { id: 'sku-mapping.import.leading-zeros' },
  errors: { id: 'sku-mapping.import.errors' },
  errorsPartial: { id: 'sku-mapping.import.errors-partial' },
  start: { id: 'sku-mapping.import.start' },
  progress: { id: 'sku-mapping.import.progress' },
  done: { id: 'sku-mapping.import.done' },
  stoppedPartial: { id: 'sku-mapping.import.stopped-partial' },
  activeMine: { id: 'sku-mapping.import.active-mine' },
  activeOther: { id: 'sku-mapping.import.active-other' },
})

export const overviewMessages = defineMessages({
  lastImport: { id: 'sku-mapping.overview.last-import' },
  lastImportStopped: { id: 'sku-mapping.overview.last-import-stopped' },
})
