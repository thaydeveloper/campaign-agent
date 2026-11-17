/** File rules ported from the portal (tests/sku-mapping.test.ts), same expectations. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkMappings,
  MAX_CHUNK_ROWS,
  MAX_REPORTED_ERRORS,
  MAX_XLSX_BYTES,
  parseMappingCsv,
  parseMappingXlsx,
  toChunkRows,
  type SkuMapping,
} from "../react/skuMapping/mappingFile";
import { templateBytes } from "../react/skuMapping/template";
import { workbook } from "./helpers/xlsx-fixture";

test("CSV: header, rows and the detected separator", () => {
  for (const text of [
    "owner_sku,vtex_sku\n12345,54321\nAB-7,VX_9\n",
    "﻿OWNER_SKU ; Vtex_Sku\r\n12345;54321\r\nAB-7;VX_9",
  ]) {
    const result = parseMappingCsv(text);
    assert.equal(result.fatal, undefined);
    assert.deepEqual(result.mappings, [
      { ownerSku: "12345", vtexSku: "54321" },
      { ownerSku: "AB-7", vtexSku: "VX_9" },
    ]);
    assert.equal(result.rejectedRows, 0);
  }
});

test("CSV: empty lines are skipped and errors name the file row", () => {
  const result = parseMappingCsv(
    "owner_sku,vtex_sku\n\n12345,54321\n ,999\nA B,1\n1.23E+11,5\n1,2,3\n",
  );
  assert.deepEqual(result.mappings, [{ ownerSku: "12345", vtexSku: "54321" }]);
  assert.equal(result.rejectedRows, 4);
  assert.deepEqual(
    result.errors.map((error) => error.row),
    [4, 5, 6, 7],
  );
  assert.match(result.errors[0].message, /^Row 4: owner_sku is required/);
  assert.match(result.errors[1].message, /"A B" is not a valid code/);
  assert.match(result.errors[2].message, /scientific notation/);
  assert.match(result.errors[3].message, /only two columns/);
});

test("CSV: a repeated owner_sku keeps the last row and is counted", () => {
  const result = parseMappingCsv("owner_sku,vtex_sku\nA1,V1\nB1,V2\nA1,V3\n");
  assert.deepEqual(result.mappings, [
    { ownerSku: "A1", vtexSku: "V3" },
    { ownerSku: "B1", vtexSku: "V2" },
  ]);
  assert.equal(result.duplicateRows, 1);
});

test("CSV: files that cannot be imported say why", () => {
  assert.equal(parseMappingCsv("").fatal, "The file is empty.");
  assert.match(parseMappingCsv("sku,quantity\nA,1").fatal ?? "", /header/);
  assert.match(parseMappingCsv("owner_sku,vtex_sku\n").fatal ?? "", /at least one/);
  assert.match(parseMappingCsv("owner_sku,vtex_sku\nA B,1").fatal ?? "", /No valid rows/);
  assert.match(parseMappingCsv('owner_sku,vtex_sku\n"A1,V1\n').fatal ?? "", /CSV formatting/);
});

test("CSV: only the first errors are listed, all are counted", () => {
  const bad = Array.from({ length: 120 }, () => "A B,1").join("\n");
  const result = parseMappingCsv(`owner_sku,vtex_sku\nA1,V1\n${bad}`);
  assert.equal(result.errors.length, MAX_REPORTED_ERRORS);
  assert.equal(result.rejectedRows, 120);
  assert.equal(result.mappings.length, 1);
});

test("XLSX: whole numbers are accepted and counted, text keeps leading zeros", async () => {
  const result = await parseMappingXlsx(
    workbook({
      1: ["owner_sku", "vtex_sku"],
      2: [{ n: "12345" }, { n: "54321" }],
      3: ["00123", "V-1"],
      // Row 4 is empty in the sheet: numbering follows the sheet, not the count.
      5: [{ n: "777.0" }, "V-2"],
    }),
  );
  assert.equal(result.fatal, undefined);
  assert.deepEqual(result.mappings, [
    { ownerSku: "12345", vtexSku: "54321" },
    { ownerSku: "00123", vtexSku: "V-1" },
    { ownerSku: "777", vtexSku: "V-2" },
  ]);
  assert.equal(result.numericCells, 3);
});

test("XLSX: numbers that cannot be codes are refused with the sheet row", async () => {
  const result = await parseMappingXlsx(
    workbook({
      1: ["owner_sku", "vtex_sku"],
      2: [{ n: "123.5" }, "V1"],
      3: [{ n: "1234567890123456" }, "V1"],
      4: [{ n: "1.2345678901234568E+19" }, "V1"],
      5: [{ b: "1" }, "V1"],
      6: ["A1", { e: "#N/A" }],
      9: ["A9", "V9"],
    }),
  );
  assert.deepEqual(result.mappings, [{ ownerSku: "A9", vtexSku: "V9" }]);
  assert.deepEqual(
    result.errors.map(({ message }) => message),
    [
      "Row 2: owner_sku is not a whole number, so it cannot be a code.",
      "Row 3: owner_sku is a number longer than 15 digits, which Excel cannot keep. Format the column as Text.",
      "Row 4: owner_sku is a number longer than 15 digits, which Excel cannot keep. Format the column as Text.",
      "Row 5: owner_sku is TRUE/FALSE, not a code.",
      "Row 6: vtex_sku has an Excel error value.",
    ],
  );
});

test("XLSX: size cap and unreadable files", async () => {
  assert.match(
    (await parseMappingXlsx(new ArrayBuffer(MAX_XLSX_BYTES + 1))).fatal ?? "",
    /up to 10 MB/,
  );
  assert.equal(
    (await parseMappingXlsx(new TextEncoder().encode("owner_sku,vtex_sku").buffer)).fatal,
    "This file is not an Excel workbook.",
  );
});

test("the embedded template is a workbook with only the header", async () => {
  const bytes = templateBytes();
  const result = await parseMappingXlsx(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  assert.equal(result.fatal, "Add at least one mapping below the header.");
  assert.equal(result.rejectedRows, 0);
});

test("chunks stay under the row and byte limits, as [owner_sku, vtex_sku] pairs", () => {
  const many: SkuMapping[] = Array.from({ length: 12_001 }, (_, i) => ({
    ownerSku: `O${i}`,
    vtexSku: `V${i}`,
  }));
  assert.deepEqual(
    chunkMappings(many).map((chunk) => chunk.length),
    [MAX_CHUNK_ROWS, MAX_CHUNK_ROWS, 2_001],
  );
  const long: SkuMapping[] = Array.from({ length: 10 }, () => ({
    ownerSku: "A".repeat(80),
    vtexSku: "B".repeat(80),
  }));
  // 168 bytes per row: 5 rows fit in 1,000 bytes.
  assert.deepEqual(
    chunkMappings(long, MAX_CHUNK_ROWS, 1_000).map((chunk) => chunk.length),
    [5, 5],
  );
  assert.deepEqual(toChunkRows([{ ownerSku: "A1", vtexSku: "V1" }]), [["A1", "V1"]]);
});
