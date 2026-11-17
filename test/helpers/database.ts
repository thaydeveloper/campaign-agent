/**
 * A real Postgres (PGlite, in memory) with the portal's migrations 001–004
 * and this repository's migration 005, plus a Data API stand-in: functions
 * run as sku_mapping_writer and failures come back shaped like PostgREST's.
 */
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Rpc } from "../../node/skuMapping/database";

const PORTAL_MIGRATIONS = new URL("../portal-migrations/", import.meta.url);
const MIGRATION_005 = new URL("../../db/migrations/005_sku_mapping_admin.sql", import.meta.url);

export async function migratedDatabase(): Promise<PGlite> {
  const db = new PGlite();
  const portal = (await readdir(PORTAL_MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of portal) await db.exec(await readFile(new URL(name, PORTAL_MIGRATIONS), "utf8"));
  await db.exec(await readFile(MIGRATION_005, "utf8"));
  return db;
}

/** Runs SQL as the writer role, the way the Data API does with a writer token. */
export function asWriter<T>(db: PGlite, sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role sku_mapping_writer");
    return (await tx.query<T>(sql, params)).rows;
  });
}

/** POST /rest/v1/rpc/<name> with named arguments, as sku_mapping_writer. */
export function dataApi(db: PGlite): Rpc {
  return async <T>(name: string, args: Record<string, unknown>) => {
    if (!/^sku_mapping_admin_[a-z]+$/.test(name)) throw new Error(`unexpected function ${name}`);
    const keys = Object.keys(args);
    const values = keys.map((key) =>
      args[key] !== null && typeof args[key] === "object" ? JSON.stringify(args[key]) : args[key],
    );
    try {
      const [row] = await asWriter<{ result: T }>(
        db,
        `select ${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(", ")}) as result`,
        values,
      );
      return row.result;
    } catch (error) {
      const { code, message } = error as { code?: string; message?: string };
      // PostgREST answers a raised exception with HTTP 400 and the SQLSTATE.
      throw { response: { status: 400, data: { code, message, details: null, hint: null } } };
    }
  };
}
