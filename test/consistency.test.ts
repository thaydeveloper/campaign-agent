/**
 * Rules and codes that live in more than one place (browser, Node, SQL,
 * messages) must stay the same.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { ERROR_CODES as NODE_CODES } from "../node/skuMapping/errors";
import { SKU_PATTERN as NODE_PATTERN } from "../node/skuMapping/input";
import { SKU_PATTERN as BROWSER_PATTERN } from "../react/skuMapping/mappingFile";
import { ERROR_CODES as BROWSER_CODES } from "../react/skuMapping/request";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

test("the code rule is the same in the browser, in Node and in SQL", async () => {
  assert.equal(BROWSER_PATTERN.source, NODE_PATTERN.source);
  const sql = await read("db/migrations/005_sku_mapping_admin.sql");
  const inSql = [...sql.matchAll(/sku_pattern constant text := '([^']+)'/g)].map((match) => match[1]);
  assert.equal(inSql.length, 2);
  for (const pattern of inSql) assert.equal(pattern, NODE_PATTERN.source);
});

test("every message exists in English, Portuguese and Spanish, and reaches the screen", async () => {
  assert.deepEqual([...BROWSER_CODES], [...NODE_CODES]);
  const [en, pt, es] = await Promise.all(
    ["en", "pt", "es"].map(async (locale) => JSON.parse(await read(`messages/${locale}.json`))),
  );
  assert.deepEqual(Object.keys(pt).sort(), Object.keys(en).sort());
  assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());

  // The VTEX react builder ships only the messages whose ids are written out
  // as id="…" or id: '…'. An id built at runtime arrives untranslated.
  let code = "";
  code += await read("react/SkuMappingAdmin.tsx");
  for (const name of await readdir(new URL("react/skuMapping/", root)))
    if (/\.tsx?$/.test(name)) code += await read(`react/skuMapping/${name}`);
  const literal = new Set(
    [...code.matchAll(/id="(sku-mapping\.[\w.-]+)"|id: '(sku-mapping\.[\w.-]+)'/g)].map(
      (match) => match[1] ?? match[2],
    ),
  );
  assert.doesNotMatch(code, /`sku-mapping\./, "message ids must not be template strings");
  assert.deepEqual([...literal].filter((id) => !(id in en)), [], "ids missing from messages");

  const navigation = new Set(
    [...(await read("admin/navigation.json")).matchAll(/"(sku-mapping\.[\w.-]+)"/g)].map((match) => match[1]),
  );
  const unreachable = Object.keys(en).filter((id) => !literal.has(id) && !navigation.has(id));
  assert.deepEqual(unreachable, [], "messages the builder would not ship to the screen");
  for (const code of [...NODE_CODES, "NETWORK"]) assert.ok(literal.has(`sku-mapping.error.${code}`));
});
