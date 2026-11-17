/**
 * Reads an `.xlsx` workbook with no dependency, ported from the customer
 * portal (src/domain/xlsx.ts). The portal chose this over a library: `xlsx`
 * and `exceljs` carry known vulnerabilities, and one code path serves both the
 * screen and the tests.
 *
 * An `.xlsx` is a ZIP archive of XML files. Only what is needed is read: the
 * first sheet, its rows and its strings. Business rules stay with the caller.
 */

const SIGNATURE = [0x50, 0x4b, 0x03, 0x04]

export class XlsxError extends Error {}

/**
 * A cell as stored in the sheet. `type` is the XLSX `t` attribute: "s"
 * (shared string), "inlineStr", "str" (formula text), "n" (number, the
 * default), "b" (boolean), "e" (error) or "d" (ISO date). Number cells keep
 * the raw stored text, so callers can tell 123 from 00123 typed as text.
 */
export type SheetCell = { value: string; type: string }
/** A non-empty row with its 1-based number in the sheet. */
export type SheetRow = { row: number; cells: SheetCell[] }

type Decompressor = new (format: string) => {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (all, code: string) => {
    if (code === 'amp') return '&'
    if (code === 'lt') return '<'
    if (code === 'gt') return '>'
    if (code === 'quot') return '"'
    if (code === 'apos') return "'"
    const point =
      code[1] === 'x' || code[1] === 'X'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10)

    return Number.isFinite(point) ? String.fromCodePoint(point) : all
  })
}

async function inflate(bytes: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return bytes
  if (method !== 8) throw new XlsxError('This workbook uses an unsupported compression.')
  // `deflate-raw` exists in browsers and in Node: one code path.
  const Decompression = (globalThis as unknown as { DecompressionStream?: Decompressor })
    .DecompressionStream

  const body = new Response(bytes).body

  if (!Decompression || !body) {
    throw new XlsxError('This browser cannot read Excel files. Save the sheet as CSV and import it.')
  }

  const stream = body.pipeThrough(new Decompression('deflate-raw'))

  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Entries of the archive, read from the central directory. */
async function readArchive(data: ArrayBuffer): Promise<Map<string, string>> {
  const bytes = new Uint8Array(data)

  if (bytes.length < 22 || SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new XlsxError('This file is not an Excel workbook.')
  }

  const view = new DataView(data)
  let end = -1

  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  }

  if (end < 0) throw new XlsxError('This workbook is damaged or incomplete.')

  const count = view.getUint16(end + 10, true)
  let cursor = view.getUint32(end + 16, true)
  const decoder = new TextDecoder()
  const entries = new Map<string, string>()

  for (let i = 0; i < count; i++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new XlsxError('This workbook is damaged or incomplete.')
    }

    const method = view.getUint16(cursor + 10, true)
    const compressed = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))

    // Only these parts matter: the rest is never decompressed.
    if (
      name === 'xl/workbook.xml' ||
      name === 'xl/_rels/workbook.xml.rels' ||
      name === 'xl/sharedStrings.xml' ||
      name.startsWith('xl/worksheets/')
    ) {
      const localNameLength = view.getUint16(localOffset + 26, true)
      const localExtraLength = view.getUint16(localOffset + 28, true)
      const start = localOffset + 30 + localNameLength + localExtraLength
      const chunk = bytes.subarray(start, start + compressed)

      entries.set(name, decoder.decode(await inflate(chunk, method)))
    }

    cursor += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

/** First sheet tab, resolved through the workbook and its relationships. */
function firstSheetXml(entries: Map<string, string>): string {
  const workbook = entries.get('xl/workbook.xml')
  const rels = entries.get('xl/_rels/workbook.xml.rels')

  if (workbook && rels) {
    const first = /<sheet\b[^>]*\/?>/.exec(workbook)?.[0]
    const id = first && /r:id="([^"]+)"/.exec(first)?.[1]
    const relation = id && new RegExp(`<Relationship\\b[^>]*Id="${id}"[^>]*>`).exec(rels)?.[0]
    const target = relation && /Target="([^"]+)"/.exec(relation)?.[1]

    if (target) {
      // Excel writes a relative path, openpyxl an absolute one.
      const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
      const sheet = entries.get(path)

      if (sheet) return sheet
    }
  }

  const fallback =
    entries.get('xl/worksheets/sheet1.xml') ??
    Array.from(entries.entries())
      .filter(([name]) => name.startsWith('xl/worksheets/'))
      .sort(([a], [b]) => a.localeCompare(b))[0]?.[1]

  if (!fallback) throw new XlsxError('This workbook has no readable sheet.')

  return fallback
}

function sharedStrings(entries: Map<string, string>): string[] {
  const xml = entries.get('xl/sharedStrings.xml')

  if (!xml) return []

  return Array.from(xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)).map((entry) =>
    // A string can be split into several formatted runs.
    Array.from(entry[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
      .map((part) => decodeEntities(part[1]))
      .join('')
  )
}

function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference.toUpperCase())?.[1] ?? ''
  let index = 0

  for (const letter of letters.split('')) index = index * 26 + (letter.charCodeAt(0) - 64)

  return Math.max(0, index - 1)
}

/**
 * Non-empty rows of the sheet, empty cells included, without trailing empty
 * columns. More than `maxRows` rows is refused rather than cut.
 */
function sheetRows(xml: string, strings: string[], maxRows: number): SheetRow[] {
  const rows: SheetRow[] = []

  for (const row of Array.from(xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g))) {
    if (rows.length >= maxRows) throw new XlsxError('This sheet has too many rows to import.')
    const cells: SheetCell[] = []

    for (const cell of Array.from(row[2].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g))) {
      const attributes = cell[1]
      const body = cell[2] ?? ''
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? 'n'
      let value = ''

      if (type === 'inlineStr') {
        value = Array.from(body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
          .map((part) => decodeEntities(part[1]))
          .join('')
      } else {
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''

        value = type === 's' ? strings[Number(raw)] ?? '' : decodeEntities(raw)
      }

      const reference = /\br="([^"]+)"/.exec(attributes)?.[1]
      const index = reference ? columnIndex(reference) : cells.length

      while (cells.length < index) cells.push({ value: '', type: 's' })
      cells[index] = { value: value.trim(), type }
    }

    while (cells.length && cells[cells.length - 1].value === '') cells.pop()
    const number = Number(/\br="(\d+)"/.exec(row[1])?.[1])

    if (cells.length) {
      rows.push({
        row: Number.isInteger(number) && number > 0 ? number : rows.length + 1,
        cells,
      })
    }
  }

  return rows
}

/** Reads the first sheet of a workbook. Throws `XlsxError` when unreadable. */
export async function readFirstSheet(
  data: ArrayBuffer,
  { maxRows }: { maxRows: number }
): Promise<SheetRow[]> {
  const entries = await readArchive(data)

  return sheetRows(firstSheetXml(entries), sharedStrings(entries), maxRows)
}
