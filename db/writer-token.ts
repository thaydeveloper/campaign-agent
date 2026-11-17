/**
 * Signs a Supabase Data API token for the writer role of migration 005
 * (sku_mapping_writer) and saves it as SKU_MAPPING_WRITER_JWT in an env file
 * (default .env.local, git-ignored). The token is never printed. It goes in
 * the settings of the VTEX Admin app demoindsupply.sku-mapping ("Writer
 * token"). Running it again issues a new one; older tokens stay valid until
 * they expire (kill switch: `revoke sku_mapping_writer from authenticator`).
 *
 *   npm run db:writer-token                   (valid for 365 days)
 *   npm run db:writer-token -- --days 90
 *
 * The role can only run the sku_mapping_admin_* functions: no table grant.
 * Needs SUPABASE_LEGACY_JWT_SECRET, like db:reader-token. With
 * SUPABASE_PUBLISHABLE_KEY set, it also checks on the Data API that the token
 * runs sku_mapping_admin_overview and cannot read sku_mappings directly.
 */
import { createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { projectRef, upsertEnvLine } from "./reader";

const KEY = "SKU_MAPPING_WRITER_JWT";
const ROLE = "sku_mapping_writer";
const DAY = 86_400;
/** Sample organization of the portal preview: reading its overview changes nothing. */
const CHECK_TENANT = "00000000-0000-4000-8000-000000000000";

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** HS256 JWT that PostgREST runs as sku_mapping_writer. */
export function writerToken(
  secret: string,
  ref: string | undefined,
  issuedAt: number,
  days: number,
): string {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: "supabase",
    ...(ref ? { ref } : {}),
    role: ROLE,
    iat: issuedAt,
    exp: issuedAt + days * DAY,
  });
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string", default: ".env.local" },
      days: { type: "string", default: "365" },
    },
  });
  const secret = process.env.SUPABASE_LEGACY_JWT_SECRET;
  if (!secret) {
    console.error(
      "Set SUPABASE_LEGACY_JWT_SECRET (Project Settings → JWT Keys → Legacy JWT Secret).",
    );
    process.exitCode = 1;
    return;
  }
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    console.error("--days must be a whole number between 1 and 3650.");
    process.exitCode = 1;
    return;
  }
  const appUrl = process.env.DATABASE_URL;
  const ref = appUrl ? projectRef(appUrl) : undefined;
  const token = writerToken(secret, ref, Math.floor(Date.now() / 1000), days);

  const file = values.out;
  const current = await readFile(file, "utf8").catch(() => "");
  await writeFile(file, upsertEnvLine(current, KEY, token), { mode: 0o600 });
  console.log(
    `Saved ${KEY} to ${file} (valid for ${days} days). Paste it in the settings of the Admin app demoindsupply.sku-mapping; never share it in a chat or the repository.`,
  );

  const apiKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const base = process.env.SUPABASE_URL || (ref && `https://${ref}.supabase.co`);
  if (!apiKey || !base) return;
  const headers = {
    apikey: apiKey,
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const allowed = await fetch(`${base}/rest/v1/rpc/sku_mapping_admin_overview`, {
    method: "POST",
    headers,
    body: JSON.stringify({ p_tenant: CHECK_TENANT, p_user_id: "db:writer-token" }),
  });
  const denied = await fetch(`${base}/rest/v1/sku_mappings?select=owner_sku&limit=1`, {
    headers,
  });
  console.log(
    `Data API check: function HTTP ${allowed.status} (expected 200), table HTTP ${denied.status} (expected 401 or 403)`,
  );
  if (!allowed.ok) console.log(await allowed.text());
  if (!allowed.ok || denied.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
