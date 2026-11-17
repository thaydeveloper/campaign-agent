/**
 * The Node service without VTEX IO: Admin token check, organization check,
 * settings and error codes, with the database functions running on PGlite.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAdminUsers, type TokenValidation } from "../node/skuMapping/adminUser";
import { createDatabase, type Database } from "../node/skuMapping/database";
import { databaseError, SkuMappingError } from "../node/skuMapping/errors";
import {
  createOrganizations,
  PAGE_SIZE,
  type ClDocument,
  type OrganizationSource,
} from "../node/skuMapping/organizations";
import { createSkuMappingService } from "../node/skuMapping/service";
import { parseSettings } from "../node/skuMapping/settings";
import { dataApi, migratedDatabase } from "./helpers/database";

const ACCOUNT = "demoindsupply";
const fails = (code: string) => (error: unknown) =>
  error instanceof SkuMappingError && error.code === code;

let database: Database;

before(async () => {
  database = createDatabase(dataApi(await migratedDatabase()));
});

test("only a VTEX ID Admin token of this account gets in, confirmed once a minute", async () => {
  let now = 0;
  let calls = 0;
  const users = createAdminUsers({ now: () => now });
  const answer = (overrides: Partial<TokenValidation>) => async () => {
    calls++;
    return {
      authStatus: "Success",
      account: ACCOUNT,
      audience: "admin",
      user: "Gestor@DemoIndSupply.com",
      ...overrides,
    };
  };

  await assert.rejects(users.verify(ACCOUNT, undefined, answer({})), fails("UNAUTHORIZED"));
  assert.equal(calls, 0);
  for (const wrong of [
    { account: "another-account" },
    { audience: "webstore" },
    { authStatus: "InvalidToken" },
    { user: "" },
  ])
    await assert.rejects(users.verify(ACCOUNT, `token-${calls}`, answer(wrong)), fails("UNAUTHORIZED"));
  const refused = async (): Promise<TokenValidation> => {
    throw { response: { status: 401, data: "" } };
  };
  await assert.rejects(users.verify(ACCOUNT, "expired", refused), fails("UNAUTHORIZED"));
  const down = async (): Promise<TokenValidation> => {
    throw { response: { status: 503, data: { message: "unavailable" } } };
  };
  await assert.rejects(users.verify(ACCOUNT, "any", down), fails("UNAVAILABLE"));

  calls = 0;
  const valid = answer({});
  assert.deepEqual(await users.verify(ACCOUNT, "good", valid), { email: "gestor@demoindsupply.com" });
  assert.deepEqual(await users.verify(ACCOUNT, "good", valid), { email: "gestor@demoindsupply.com" });
  assert.equal(calls, 1);
  // The same token for another account is checked on its own (and refused here).
  await assert.rejects(users.verify("other", "good", valid), fails("UNAUTHORIZED"));
  now = 61_000;
  await users.verify(ACCOUNT, "good", valid);
  assert.equal(calls, 3);
});

test("organizations: every corporate CL page, sorted by name; a check confirms each one", async () => {
  const ids = Array.from({ length: PAGE_SIZE + 2 }, () => randomUUID());
  const documents: ClDocument[] = ids.map((id, index) => ({
    id,
    corporateName: `Corp ${String(1000 - index)}`,
    tradeName: index === 0 ? "acme industrial" : null,
  }));
  documents.push({ id: "not-a-uuid", corporateName: "Legacy" });
  const pages: number[] = [];
  let gets = 0;
  const source: OrganizationSource = {
    searchCorporate: async (page, size) => {
      pages.push(page);
      return documents.slice((page - 1) * size, page * size);
    },
    get: async (id) => {
      gets++;
      if (id === ids[1]) return { id, corporateName: "Person", isCorporate: false };
      return documents.find((document) => document.id === id) ? { id, tradeName: "Acme", isCorporate: true } : null;
    },
  };
  const organizations = createOrganizations();
  const list = await organizations.list(source);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(list.length, PAGE_SIZE + 2);
  assert.deepEqual(list[0], { id: ids[0], name: "acme industrial" });
  assert.equal(list[1].name, "Corp 899");

  assert.deepEqual(await organizations.verify(ACCOUNT, ids[0], source), { id: ids[0], name: "Acme" });
  await organizations.verify(ACCOUNT, ids[0], source);
  assert.equal(gets, 1);
  await assert.rejects(organizations.verify(ACCOUNT, ids[1], source), fails("ORGANIZATION_NOT_FOUND"));
  await assert.rejects(organizations.verify(ACCOUNT, randomUUID(), source), fails("ORGANIZATION_NOT_FOUND"));
  const broken: OrganizationSource = {
    searchCorporate: async () => {
      throw { response: { status: 500, data: { Message: "boom" } } };
    },
    get: async () => null,
  };
  await assert.rejects(organizations.list(broken), fails("UNAVAILABLE"));
});

test("the service imports for the chosen organization as the Admin user", async () => {
  const organization = randomUUID();
  const verified: string[] = [];
  const service = createSkuMappingService({
    adminUser: async () => ({ email: "gestor@demoindsupply.com" }),
    listOrganizations: async () => [],
    verifyOrganization: async (id) => {
      verified.push(id);
      if (id !== organization) throw new SkuMappingError("ORGANIZATION_NOT_FOUND");
      return { id, name: "Acme" };
    },
    database: async () => database,
  });

  const { importId } = await service.startImport(organization.toUpperCase(), " acme.csv ");
  assert.deepEqual(await service.addChunk(organization, importId, [["ACM-00412", "1043"]]), {
    inserted: 1,
    updated: 0,
    unchanged: 0,
  });
  assert.deepEqual(await service.finishImport(organization, importId, 0), {
    inserted: 1,
    updated: 0,
    total: 1,
  });
  const overview = await service.overview(organization);
  assert.equal(overview.lastImport?.fileName, "acme.csv");
  assert.equal(overview.lastImport?.mine, true);
  assert.deepEqual(
    (await service.mappings(organization, { query: "acm-004" })).rows.map((row) => row.vtexSku),
    ["1043"],
  );
  // Chunks write to an import of a confirmed organization: no Master Data call.
  assert.deepEqual(verified, [organization, organization, organization, organization]);

  await assert.rejects(service.startImport(randomUUID(), "x.csv"), fails("ORGANIZATION_NOT_FOUND"));
  await assert.rejects(service.overview("../../etc"), fails("ORGANIZATION_NOT_FOUND"));
  await assert.rejects(service.startImport(organization, ""), fails("INVALID_INPUT"));
  await assert.rejects(service.addChunk(organization, importId, [["bad code", "1"]]), fails("INVALID_ROWS"));
  await assert.rejects(service.addChunk(organization, "1; drop", [["A", "1"]]), fails("INVALID_INPUT"));
  await assert.rejects(service.finishImport(organization, importId, 1.5), fails("INVALID_INPUT"));
  await assert.rejects(service.addChunk(organization, importId, [["A", "1"]]), fails("IMPORT_NOT_RUNNING"));
});

test("every call checks the Admin user first", async () => {
  let touched = false;
  const service = createSkuMappingService({
    adminUser: async () => {
      throw new SkuMappingError("UNAUTHORIZED");
    },
    listOrganizations: async () => {
      touched = true;
      return [];
    },
    verifyOrganization: async () => {
      touched = true;
      return { id: "", name: "" };
    },
    database: async () => {
      touched = true;
      return database;
    },
  });
  const organization = randomUUID();
  for (const call of [
    () => service.organizations(),
    () => service.overview(organization),
    () => service.mappings(organization, {}),
    () => service.startImport(organization, "a.csv"),
    () => service.addChunk(organization, 1, [["A", "1"]]),
    () => service.finishImport(organization, 1, 0),
    () => service.cancelImport(organization, 1),
  ])
    await assert.rejects(call(), fails("UNAUTHORIZED"));
  assert.equal(touched, false);
});

test("settings must be complete, and only expected database failures keep their code", () => {
  const settings = {
    supabaseUrl: " https://vxmotxxwjhxdjnleqidr.supabase.co/ ",
    supabasePublishableKey: "sb_publishable_x",
    writerToken: "aaa.bbb.ccc",
  };
  assert.deepEqual(parseSettings(settings), {
    url: "https://vxmotxxwjhxdjnleqidr.supabase.co",
    publishableKey: "sb_publishable_x",
    writerToken: "aaa.bbb.ccc",
  });
  for (const broken of [
    undefined,
    { ...settings, supabaseUrl: "http://vxmotxxwjhxdjnleqidr.supabase.co" },
    { ...settings, supabaseUrl: "https://evil.example.com" },
    { ...settings, supabasePublishableKey: "" },
    { ...settings, writerToken: "not a jwt" },
  ])
    assert.throws(() => parseSettings(broken), fails("NOT_CONFIGURED"));

  const postgrest = (status: number, data: unknown) => ({ response: { status, data } });
  assert.equal(databaseError(postgrest(400, { code: "P0001", message: "IMPORT_RUNNING" })).code, "IMPORT_RUNNING");
  // An exception raised by something else is not passed through as a code.
  assert.equal(databaseError(postgrest(400, { code: "P0001", message: "UNAUTHORIZED" })).code, "UNAVAILABLE");
  const expired = databaseError(
    Object.assign(new Error("Request failed with status code 401"), {
      config: { headers: { Authorization: "Bearer secret-token" } },
      response: { status: 401, data: { code: "PGRST303", message: "JWT expired" } },
    }),
  );
  assert.equal(expired.code, "UNAVAILABLE");
  assert.deepEqual(expired.detail, {
    source: "database",
    status: 401,
    code: "PGRST303",
    message: "JWT expired",
    hint: undefined,
  });
  assert.doesNotMatch(JSON.stringify(expired.detail), /secret-token/);
});
