/**
 * Migration 005 on a real Postgres (PGlite): the functions keep the portal's
 * rules (src/server/sku-mapping.ts) and the writer role can do nothing else.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { createDatabase, type Database } from "../node/skuMapping/database";
import { SkuMappingError } from "../node/skuMapping/errors";
import { asWriter, dataApi, migratedDatabase } from "./helpers/database";

let pg: PGlite;
let db: Database;

before(async () => {
  pg = await migratedDatabase();
  db = createDatabase(dataApi(pg));
});

const USER = "gestor@demoindsupply.com";
const fails = (code: string) => (error: unknown) =>
  error instanceof SkuMappingError && error.code === code;
const codes = async (tenant: string, search: { query?: string; after?: string; before?: string }) =>
  (
    await db.page(tenant, {
      query: search.query ?? null,
      after: search.after ?? null,
      before: search.before ?? null,
    })
  ).rows.map((row) => row.ownerSku);

test("the writer role runs the functions and cannot touch any table", async () => {
  const denied = (error: unknown) => (error as { code?: string }).code === "42501";
  for (const table of ["sku_mappings", "sku_mapping_imports", "sku_mapping_stats"])
    await assert.rejects(asWriter(pg, `select 1 from ${table}`), denied);
  await assert.rejects(
    asWriter(pg, `insert into sku_mapping_stats (tenant_id, total) values ($1, 1)`, [randomUUID()]),
    denied,
  );
  assert.deepEqual(await db.overview(randomUUID(), USER), {
    total: 0,
    lastImport: null,
    activeImport: null,
  });
  // New functions are executable by PUBLIC by default: 005 revokes that.
  await pg.exec("create role someone_else nologin");
  const [{ allowed }] = (
    await pg.query<{ allowed: boolean }>(
      "select has_function_privilege('someone_else', 'sku_mapping_admin_chunk(uuid, text, bigint, jsonb)', 'execute') as allowed",
    )
  ).rows;
  assert.equal(allowed, false);
});

test("an import adds, a resent chunk changes nothing and a new target updates", async () => {
  const tenant = randomUUID();
  const { importId } = await db.start(tenant, USER, "acme-skus.xlsx");
  const rows: Array<[string, string]> = [
    ["A-1", "100"],
    ["A-2", "200"],
    ["A-1", "101"], // repeated in the chunk: the last one wins
  ];
  assert.deepEqual(await db.chunk(tenant, USER, importId, rows), {
    inserted: 2,
    updated: 0,
    unchanged: 0,
  });
  // A retry after a lost response.
  assert.deepEqual(await db.chunk(tenant, USER, importId, rows), {
    inserted: 0,
    updated: 0,
    unchanged: 2,
  });
  assert.deepEqual(await db.chunk(tenant, USER, importId, [["A-2", "201"]]), {
    inserted: 0,
    updated: 1,
    unchanged: 0,
  });
  assert.deepEqual(await db.finish(tenant, USER, importId, 3), { inserted: 2, updated: 1, total: 2 });

  const page = await db.page(tenant, { query: null, after: null, before: null });
  assert.deepEqual(
    page.rows.map((row) => [row.ownerSku, row.vtexSku]),
    [
      ["A-1", "101"],
      ["A-2", "201"],
    ],
  );
  assert.ok(!Number.isNaN(Date.parse(page.rows[0].updatedAt)));
  const overview = await db.overview(tenant, USER);
  assert.equal(overview.total, 2);
  assert.equal(overview.activeImport, null);
  assert.equal(overview.lastImport?.status, "completed");
  assert.equal(overview.lastImport?.fileName, "acme-skus.xlsx");
  assert.equal(overview.lastImport?.rejected, 3);
  assert.equal(overview.lastImport?.mine, true);
  assert.equal((await db.overview(tenant, "someone@else.com")).lastImport?.mine, false);
  await assert.rejects(db.chunk(tenant, USER, importId, rows), fails("IMPORT_NOT_RUNNING"));
});

test("organizations and users never write to each other's imports", async () => {
  const mine = randomUUID();
  const other = randomUUID();
  const { importId } = await db.start(mine, USER, "map.csv");
  await db.chunk(mine, USER, importId, [["MINE-1", "1"]]);
  await assert.rejects(db.chunk(other, USER, importId, [["THEIRS-1", "2"]]), fails("IMPORT_NOT_RUNNING"));
  await assert.rejects(db.finish(other, USER, importId, 0), fails("IMPORT_NOT_RUNNING"));
  // Same organization, another user: the import belongs to whoever opened it.
  await assert.rejects(
    db.chunk(mine, "other@demoindsupply.com", importId, [["X-1", "3"]]),
    fails("IMPORT_NOT_RUNNING"),
  );
  assert.deepEqual(await codes(other, {}), []);
  assert.equal((await db.overview(other, USER)).total, 0);
  assert.deepEqual(await codes(mine, {}), ["MINE-1"]);
});

test("one import at a time per organization, shared with the portal; stale or cancelled ones are released", async () => {
  const tenant = randomUUID();
  const first = (await db.start(tenant, USER, "a.csv")).importId;
  await assert.rejects(db.start(tenant, USER, "b.csv"), fails("IMPORT_RUNNING"));
  await db.start(randomUUID(), USER, "c.csv"); // another organization is not blocked
  assert.equal((await db.overview(tenant, USER)).activeImport?.id, first);

  await pg.query(
    "update sku_mapping_imports set last_seen_at = now() - interval '16 minutes' where id = $1",
    [first],
  );
  assert.equal((await db.overview(tenant, USER)).activeImport, null);
  const second = (await db.start(tenant, USER, "b.csv")).importId;
  const { rows } = await pg.query<{ status: string }>(
    "select status from sku_mapping_imports where id = $1",
    [first],
  );
  assert.equal(rows[0].status, "failed");

  assert.deepEqual(await db.cancel(tenant, "other@demoindsupply.com", second), { cancelled: false });
  assert.deepEqual(await db.cancel(tenant, USER, second), { cancelled: true });

  // A buyer importing in the portal (its own code path, same table) blocks the Admin.
  await pg.query(
    "insert into sku_mapping_imports (tenant_id, user_id, file_name, mode, status) values ($1, 'buyer-1', 'portal.csv', 'merge', 'running')",
    [tenant],
  );
  await assert.rejects(db.start(tenant, USER, "d.csv"), fails("IMPORT_RUNNING"));
  const active = (await db.overview(tenant, USER)).activeImport;
  assert.equal(active?.fileName, "portal.csv");
  assert.equal(active?.mine, false);
});

test("pages move forward and back with cursors, and search keeps to a prefix", async () => {
  const tenant = randomUUID();
  const { importId } = await db.start(tenant, USER, "many.csv");
  const owners = Array.from({ length: 120 }, (_, index) => `P-${String(index).padStart(3, "0")}`);
  await db.chunk(tenant, USER, importId, owners.map((owner) => [owner, "9"]));
  await db.chunk(tenant, USER, importId, [
    ["Q_1", "9"],
    ["QA1", "9"],
  ]);

  const first = await db.page(tenant, { query: null, after: null, before: null });
  assert.equal(first.rows.length, 50);
  assert.equal(first.previous, null);
  assert.equal(first.next, "P-049");
  const second = await db.page(tenant, { query: null, after: first.next, before: null });
  assert.equal(second.rows[0].ownerSku, "P-050");
  assert.equal(second.previous, "P-050");
  const back = await db.page(tenant, { query: null, after: null, before: second.previous });
  assert.deepEqual(back, first);
  const third = await db.page(tenant, { query: null, after: second.next, before: null });
  // Ordered by the code in lower case: "q_1" < "qa1" because "_" < "a".
  assert.deepEqual(
    third.rows.map((row) => row.ownerSku),
    [...owners.slice(100), "Q_1", "QA1"],
  );
  assert.equal(third.next, null);

  assert.deepEqual(await codes(tenant, { query: "P-11" }), owners.slice(110, 120));
  // `_` is a plain character, not a LIKE wildcard.
  assert.deepEqual(await codes(tenant, { query: "Q_" }), ["Q_1"]);
  assert.deepEqual(await codes(tenant, { query: "bad%" }), []);
  assert.equal((await codes(tenant, { after: "'; drop table x" })).length, 50);
});

test("search ignores case, while codes differing only in case stay two mappings", async () => {
  const tenant = randomUUID();
  const { importId } = await db.start(tenant, USER, "case.csv");
  const result = await db.chunk(tenant, USER, importId, [
    ["abc-2", "2"],
    ["ABC-1", "1"],
    ["abc-1", "3"],
    ["AbD-1", "4"],
    ["xyz", "5"],
  ]);
  assert.equal(result.inserted, 5);
  const expected = ["ABC-1", "abc-1", "abc-2"];
  assert.deepEqual(await codes(tenant, { query: "abc" }), expected);
  assert.deepEqual(await codes(tenant, { query: "ABC" }), expected);
  assert.deepEqual(await codes(tenant, { query: "aBc-1" }), ["ABC-1", "abc-1"]);
  assert.deepEqual(await codes(tenant, { query: "ab" }), [...expected, "AbD-1"]);
  const all = await codes(tenant, {});
  assert.deepEqual(all, [...expected, "AbD-1", "xyz"]);
  assert.deepEqual(await codes(tenant, { after: "ABC-1" }), all.slice(1));
  assert.deepEqual(await codes(tenant, { before: "abc-1" }), ["ABC-1"]);
});

test("invalid chunks and inputs are refused whole, with a code", async () => {
  const tenant = randomUUID();
  const { importId } = await db.start(tenant, USER, "bad.csv");
  const send = (rows: unknown) => db.chunk(tenant, USER, importId, rows as Array<[string, string]>);
  for (const rows of [
    [],
    [["OK-1", "1"], ["A 1", "V1"]],
    [["OK-1", "1", "extra"]],
    [["OK-1", 1]],
    ["OK-1"],
    Array.from({ length: 5_001 }, (_, index) => [`R-${index}`, "1"]),
  ])
    await assert.rejects(send(rows), fails("INVALID_ROWS"));
  // Nothing of a refused chunk was written, and the import still runs.
  assert.deepEqual(await codes(tenant, {}), []);
  assert.equal((await send([["OK-1", "1"]])).inserted, 1);

  await assert.rejects(db.start(randomUUID(), USER, "  "), fails("INVALID_INPUT"));
  await assert.rejects(db.start(randomUUID(), "", "file.csv"), fails("INVALID_INPUT"));
  await assert.rejects(db.finish(tenant, USER, importId, -1), fails("INVALID_INPUT"));
});
