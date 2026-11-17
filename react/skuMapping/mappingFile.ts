/**
 * SKU Mapping file rules, ported from the customer portal
 * (src/domain/sku-mapping.ts): reading, validation and chunking, all in the
 * browser. The Node service and the database check each chunk again. Row
 * messages stay in English, as in the portal.
 */
import Papa from 'papaparse'

import { readFirstSheet, XlsxError } from './xlsx'
import type { SheetCell } from './xlsx'

/** Same rule as Quick Order references in the portal. */
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

export const MAX_CHUNK_ROWS = 5000
/** Target for one chunk request body. */
export const MAX_CHUNK_BYTES = 200000
export const MAX_XLSX_BYTES = 10000000
export const MAX_XLSX_ROWS = 1000000
/** About a million rows of typical codes; read whole by the browser. */
export const MAX_CSV_BYTES = 50000000
export const MAX_REPORTED_ERRORS = 50
/** Excel keeps 15 significant digits: longer numbers come back altered. */
export const EXCEL_DIGITS = 15

export type SkuMapping = { ownerSku: string; vtexSku: string }
export type RowError = { row: number; message: string }
export type MappingFileResult = {
  /** One per owner_sku: when a code repeats, the last row wins. */
  mappings: SkuMapping[]
  /** The first MAX_REPORTED_ERRORS invalid rows. */
  errors: RowError[]
  rejectedRows: number
  duplicateRows: number
  /** Codes read from Excel number cells (leading zeros may be lost). */
  numericCells: number
  /** Set when nothing in the file can be imported. */
  fatal?: string
}

type Cell = string | SheetCell
type Code = { code: string; numeric: boolean } | { error: string }

const valueOf = (cell: Cell | undefined) =>
  (typeof cell === 'string' ? cell : cell?.value ?? '').trim()

const preview = (text: string) => (text.length > 40 ? `${text.slice(0, 40)}…` : text)

const tooLong = (column: string) =>
  `${column} is a number longer than ${EXCEL_DIGITS} digits, which Excel cannot keep. Format the column as Text.`

function readCode(cell: Cell | undefined, column: string): Code {
  const text = valueOf(cell)
  const type = typeof cell === 'string' || !cell ? 's' : cell.type

  if (!text) return { error: `${column} is required.` }
  if (type === 'n') {
    const integer = /^(\d+)(?:\.0+)?$/.exec(text)?.[1]

    if (integer === undefined) {
      return {
        error: /e/i.test(text)
          ? tooLong(column)
          : `${column} is not a whole number, so it cannot be a code.`,
      }
    }

    if (integer.length > EXCEL_DIGITS) return { error: tooLong(column) }

    return { code: integer, numeric: true }
  }

  if (type === 'b') return { error: `${column} is TRUE/FALSE, not a code.` }
  if (type === 'e') return { error: `${column} has an Excel error value.` }
  if (type === 'd') return { error: `${column} is a date, not a code.` }
  if (/^\d+(?:[.,]\d+)?e\+\d+$/i.test(text)) {
    return {
      error: `${column} looks like a number Excel turned into scientific notation (${preview(
        text
      )}). Format the column as Text and export again.`,
    }
  }

  if (!SKU_PATTERN.test(text)) {
    return {
      error: `${column} "${preview(
        text
      )}" is not a valid code. Use letters, digits, dot, underscore or hyphen, up to 80 characters.`,
    }
  }

  return { code: text, numeric: false }
}

/**
 * Incremental reader, fed one row at a time. The first non-empty row must be
 * the header owner_sku,vtex_sku.
 */
export function createMappingReader() {
  const byOwner = new Map<string, string>()
  const errors: RowError[] = []
  let header: 'missing' | 'ok' | 'invalid' = 'missing'
  let rejectedRows = 0
  let duplicateRows = 0
  let numericCells = 0

  const reject = (row: number, message: string) => {
    rejectedRows++
    if (errors.length < MAX_REPORTED_ERRORS) {
      errors.push({ row, message: `Row ${row}: ${message}` })
    }
  }

  return {
    /** `row` is the 1-based row number in the file, used in error messages. */
    add(cells: readonly Cell[], row: number): void {
      if (header === 'invalid') return
      const values = cells.slice()

      while (values.length && valueOf(values[values.length - 1]) === '') values.pop()
      if (!values.length) return
      if (header === 'missing') {
        const names = values.map((cell) => valueOf(cell).replace(/^﻿/, '').toLowerCase())

        header =
          names.length === 2 && names[0] === 'owner_sku' && names[1] === 'vtex_sku'
            ? 'ok'
            : 'invalid'

        return
      }

      if (values.length > 2) {
        reject(row, 'use only two columns, owner_sku and vtex_sku.')

        return
      }

      const owner = readCode(values[0], 'owner_sku')

      if ('error' in owner) {
        reject(row, owner.error)

        return
      }

      const vtex = readCode(values[1], 'vtex_sku')

      if ('error' in vtex) {
        reject(row, vtex.error)

        return
      }

      numericCells += Number(owner.numeric) + Number(vtex.numeric)
      if (byOwner.has(owner.code)) duplicateRows++
      byOwner.set(owner.code, vtex.code)
    },

    result(): MappingFileResult {
      const base = { errors, rejectedRows, duplicateRows, numericCells }

      if (header !== 'ok') {
        return {
          ...base,
          mappings: [],
          fatal:
            header === 'missing'
              ? 'The file is empty.'
              : 'The first row must be the header owner_sku,vtex_sku.',
        }
      }

      const mappings = Array.from(byOwner, ([ownerSku, vtexSku]) => ({ ownerSku, vtexSku }))

      if (!mappings.length) {
        return {
          ...base,
          mappings,
          fatal: rejectedRows
            ? 'No valid rows to import. Fix the errors below and try again.'
            : 'Add at least one mapping below the header.',
        }
      }

      return { ...base, mappings }
    },
  }
}

const failed = (fatal: string): MappingFileResult => ({
  mappings: [],
  errors: [],
  rejectedRows: 0,
  duplicateRows: 0,
  numericCells: 0,
  fatal,
})

/** Whole-text CSV. The separator is detected, so Excel's semicolon CSV works too. */
export function parseMappingCsv(text: string): MappingFileResult {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false })

  if (parsed.errors.some((error) => error.type !== 'Delimiter')) {
    return failed('CSV formatting is invalid. Check quotes and separators.')
  }

  const reader = createMappingReader()

  parsed.data.forEach((cells, index) => reader.add(cells, index + 1))

  return reader.result()
}

export async function parseMappingXlsx(data: ArrayBuffer): Promise<MappingFileResult> {
  if (data.byteLength > MAX_XLSX_BYTES) {
    return failed('Excel files must be up to 10 MB. Save the sheet as CSV to import larger files.')
  }

  const reader = createMappingReader()

  try {
    const rows = await readFirstSheet(data, { maxRows: MAX_XLSX_ROWS + 1 })

    for (const { row, cells } of rows) reader.add(cells, row)
  } catch (error) {
    return failed(
      error instanceof XlsxError
        ? error.message
        : 'This file could not be read as an Excel workbook.'
    )
  }

  return reader.result()
}

/**
 * Request-sized chunks: at most `maxRows` rows and about `maxBytes` of JSON
 * each (SKU characters are ASCII, so length equals bytes).
 */
export function chunkMappings(
  mappings: readonly SkuMapping[],
  maxRows = MAX_CHUNK_ROWS,
  maxBytes = MAX_CHUNK_BYTES
): SkuMapping[][] {
  const chunks: SkuMapping[][] = []
  let current: SkuMapping[] = []
  let bytes = 0

  for (const mapping of mappings) {
    const size = mapping.ownerSku.length + mapping.vtexSku.length + 8 // ["",""],

    if (current.length && (current.length >= maxRows || bytes + size > maxBytes)) {
      chunks.push(current)
      current = []
      bytes = 0
    }

    current.push(mapping)
    bytes += size
  }

  if (current.length) chunks.push(current)

  return chunks
}

/** Chunk wire format: rows as [owner_sku, vtex_sku] pairs. */
export const toChunkRows = (chunk: readonly SkuMapping[]) =>
  chunk.map(({ ownerSku, vtexSku }) => [ownerSku, vtexSku])
