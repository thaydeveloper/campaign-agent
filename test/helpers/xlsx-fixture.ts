/** Uncompressed ZIP archive, enough to build .xlsx fixtures without a dependency. */
export function zip(files: Record<string, string>): ArrayBuffer {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const body = encoder.encode(content);
    const local = new Uint8Array(30 + nameBytes.length + body.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(8, 0, true); // stored
    localView.setUint32(18, body.length, true);
    localView.setUint32(22, body.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(body, 30 + nameBytes.length);
    locals.push(local);

    const entry = new Uint8Array(46 + nameBytes.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(10, 0, true);
    entryView.setUint32(20, body.length, true);
    entryView.setUint32(24, body.length, true);
    entryView.setUint16(28, nameBytes.length, true);
    entryView.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    central.push(entry);
    offset += local.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, central.length, true);
  endView.setUint16(10, central.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const parts = [...locals, ...central, end];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out.buffer;
}

/** A cell: text (inline string) or a typed raw cell such as { n: "12345" }. */
export type FixtureCell = string | { n: string } | { b: string } | { e: string };

/** Workbook whose first sheet holds `rows`, keyed by their sheet row number. */
export function workbook(rows: Record<number, FixtureCell[]>): ArrayBuffer {
  const xml = Object.entries(rows)
    .map(([row, cells]) => {
      const body = cells
        .map((cell, index) => {
          const ref = `${String.fromCharCode(65 + index)}${row}`;
          if (typeof cell === "string")
            return `<c r="${ref}" t="inlineStr"><is><t>${cell}</t></is></c>`;
          const [type, value] = Object.entries(cell)[0];
          const attribute = type === "n" ? "" : ` t="${type}"`;
          return `<c r="${ref}"${attribute}><v>${value}</v></c>`;
        })
        .join("");
      return `<row r="${row}">${body}</row>`;
    })
    .join("");
  return zip({
    "xl/workbook.xml":
      '<workbook xmlns:r="http://x"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${xml}</sheetData></worksheet>`,
  });
}
