import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import express from "express";
import { pool } from "../../db/pool.js";
import listingRouter from "../../routes/listing.route.js";
import { searchListings, type SearchListingsParams } from "./searchListings.js";

const databaseFiles = resolve(__dirname, "../../../../db");

async function setup() {
  const db = new PGlite({ extensions: { pg_trgm } });
  try {
    const migrations = resolve(databaseFiles, "migrations");
    for (const name of (await readdir(migrations)).filter(n => n.endsWith(".sql") && n < "017").sort()) {
      await db.exec((await readFile(resolve(migrations, name), "utf8")).replace(/^\uFEFF/, ""));
    }
    // The legacy seed includes icon_path, which migrations 001..016 never create.
    // Keep its real areas/amenities while omitting that unused presentation column.
    const seed = (await readFile(resolve(databaseFiles, "seed.sql"), "utf8"))
      .replace(", icon_path)", ")")
      .replace(/,\s*'\/icons\/[^']+\.svg'/g, "");
    await db.exec(seed);
    await db.exec(`INSERT INTO users (name,nid,phone,password_hash) VALUES ('Search owner','search-owner','search-owner','x');
      INSERT INTO owners VALUES (1);`);
    const areas = await db.query<{ id: number; name: string }>("SELECT id,name FROM areas WHERE name IN ('Mirpur','Banani')");
    const mirpur = areas.rows.find(a => a.name === "Mirpur")!.id;
    const banani = areas.rows.find(a => a.name === "Banani")!.id;
    type Fixture = { title?: string; status?: string; bedrooms?: number; bathrooms?: number; floor?: number;
      areaId?: number; rent?: number; pets?: boolean; amenities?: string[]; views?: number };
    async function listing(overrides: Fixture = {}) {
      const f = { title: "sunflower", status: "approved", bedrooms: 3, bathrooms: 2, floor: 4,
        areaId: mirpur, rent: 25000, pets: false, amenities: ["Elevator", "Gym"], views: 10, ...overrides };
      const result = await db.query<{ id: number }>(`INSERT INTO listings
        (title,description,status,latitude,longitude,bedroom_count,bathroom_count,on_which_floor,area_id,owner_id,view_count)
        VALUES ($1::text,$1::text,$2,23.8,90.3,$3,$4,$5,$6,1,$7) RETURNING id`,
      [f.title,f.status,f.bedrooms,f.bathrooms,f.floor,f.areaId,f.views]);
      const id = result.rows[0].id;
      const terms = await db.query<{ id: number }>("INSERT INTO terms (rent,pet_allowed) VALUES ($1,$2) RETURNING id", [f.rent,f.pets]);
      await db.query("INSERT INTO initial_terms (terms_id,listing_id) VALUES ($1,$2)", [terms.rows[0].id,id]);
      await db.query(`INSERT INTO listing_amenities (listing_id,amenity_id)
        SELECT $1,id FROM amenities WHERE name=ANY($2)`, [id,f.amenities]);
      return id;
    }
    const eligible = [await listing({ views: 20 }), await listing({ bedrooms: 4, rent: 28000 }), await listing({ rent: 20000 })];
    await listing({ rent: 19000 });
    await listing({ rent: 31000 });
    await listing({ bedrooms: 2 });
    const petsOnly = await listing({ pets: true });
    await listing({ bathrooms: 1 });
    await listing({ floor: 3 });
    await listing({ areaId: banani });
    await listing({ amenities: ["Elevator"] });
    for (const status of ["waiting", "rejected", "occupied", "unavailable"]) await listing({ status });
    const legacy = await listing({ title: "legacyvilla", bedrooms: 2, bathrooms: 1, floor: 0,
      areaId: banani, rent: 15000, pets: true, amenities: ["Garage"] });
    // All structured filters match this row, so keyword tests also catch a
    // regression that silently discards keywords and performs a broad search.
    const unrelated = await listing({ title: "orchid" });
    return { db, eligible, petsOnly, legacy, unrelated, mirpur };
  } catch (error) {
    await db.close();
    throw error;
  }
}

test("search SQL and listing routes use isolated PostgreSQL fixtures", async t => {
  const { db, eligible, petsOnly, legacy, unrelated, mirpur } = await setup();
  const originalQuery = pool.query;
  const originalEnabled = process.env.SEARCH_AI_ENABLED;
  delete process.env.SEARCH_AI_ENABLED;
  // This is the only database boundary replaced: every application query executes
  // against the in-memory PostgreSQL engine; no pool connection is ever opened.
  const statements: { sql: string; params?: unknown[] }[] = [];
  pool.query = ((query: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
    const sql = typeof query === "string" ? query : query.text;
    const params = typeof query === "string" ? values : query.values;
    statements.push({ sql, params });
    return db.query(sql, params);
  }) as typeof pool.query;
  const app = express();
  app.use(express.json());
  app.use("/listings", listingRouter);
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    try {
      await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      pool.query = originalQuery;
      if (originalEnabled === undefined) delete process.env.SEARCH_AI_ENABLED;
      else process.env.SEARCH_AI_ENABLED = originalEnabled;
      await db.close();
    }
  });
  await new Promise<void>(resolve => server.once("listening",resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/listings`;
  const ids = (result: { listings: { id: number }[] }) => result.listings.map(l => l.id);
  const mandatory = { strict: true, minRent: 20000, maxRent: 30000, minBedrooms: 3,
    bathrooms: 2, floor: 4, areaId: mirpur, pets: false, amenityNames: ["Elevator", "Gym"] };
  // Structural assignment allows these tests to run red before the new fields exist.
  const search = (params: SearchListingsParams & Partial<typeof mandatory> & { keywords?: string }) => searchListings(params);

  await t.test("full-text search retains every mandatory filter including pets=false", async () => {
    const result = await search({ ...mandatory, keywords: "sunflower" });
    assert.deepEqual(ids(result).sort((a,b) => a-b), eligible);
    assert.equal(result.nextCursor, null);
  });

  await t.test("trigram typo fallback retains the same mandatory filters", async () => {
    assert.equal((await db.query("SELECT 1 FROM listings WHERE search_document @@ websearch_to_tsquery('simple','sunflwer')")).rows.length, 0);
    const result = await search({ ...mandatory, keywords: "sunflwer" });
    assert.deepEqual(ids(result).sort((a,b) => a-b), eligible);
  });

  await t.test("strict search ignores parser-inferred filters and uses explicit keywords", async () => {
    const result = await search({ ...mandatory, keywords: "sunflower", q: "1 bedroom under 1k in Banani pet friendly" });
    assert.deepEqual(ids(result).sort((a,b) => a-b), eligible);
  });

  await t.test("exact bedrooms and minimum bedrooms retain their separate meanings", async () => {
    assert.deepEqual(ids(await search({ ...mandatory, bedrooms: 3 })).sort((a,b) => a-b), [eligible[0], eligible[2], unrelated]);
    assert.deepEqual(ids(await search(mandatory)).sort((a,b) => a-b), [...eligible, unrelated]);
    for (const keywords of ["sunflower", "sunflwer"]) {
      assert.deepEqual(ids(await search({ ...mandatory, bedrooms: 3, keywords })).sort((a,b) => a-b), [eligible[0], eligible[2]]);
    }
  });

  await t.test("empty matches are returned without dropping mandatory filters", async () => {
    assert.deepEqual(await search({ ...mandatory, minRent: 29000 }), { listings: [], nextCursor: null });
    assert.deepEqual(await search({ ...mandatory, minRent: 29000, keywords: "sunflwer" }), { listings: [], nextCursor: null });
  });

  await t.test("cursor pagination keeps popularity and equal-view ordering without keywords", async () => {
    const first = await search({ ...mandatory, limit: 2 });
    assert.deepEqual(ids(first), [eligible[0], unrelated]);
    assert.ok(first.nextCursor);
    const second = await search({ ...mandatory, limit: 2, cursor: first.nextCursor });
    assert.deepEqual(ids(second), [eligible[2], eligible[1]]);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...ids(first), ...ids(second)]).size, 4);
  });

  await t.test("only approved listings are visible in normal and keyword search", async () => {
    for (const params of [{}, { q: "sunflower" }, { q: "sunflwer" }]) {
      const result = await searchListings(params);
      assert.ok(result.listings.length > 0);
      assert.ok(result.listings.every(l => l.status === "approved"));
    }
  });

  await t.test("injection text stays a bound value and cannot mutate listings", async () => {
    const before = await db.query("SELECT count(*)::int AS count FROM listings");
    const injection = "'; DROP TABLE listings; --";
    statements.length = 0;
    const result = await search({ ...mandatory, keywords: injection });
    assert.deepEqual(result.listings, []);
    assert.ok(statements.some(s => s.params?.includes(injection)));
    assert.ok(statements.every(s => !s.sql.includes(injection)));
    assert.deepEqual((await db.query("SELECT count(*)::int AS count FROM listings")).rows, before.rows);
  });

  await t.test("legacy natural language and explicit route filters still work", async () => {
    const q = encodeURIComponent("2 bedroom 1 bath ground floor in Banani under 20k pet friendly legacyvilla");
    const response = await fetch(`${base}/search?q=${q}&amenities=Garage`);
    assert.equal(response.status, 200);
    assert.deepEqual(ids(await response.json()), [legacy]);
    const explicit = await fetch(`${base}/search?bedrooms=2&bathrooms=1&floor=0&maxRent=20000&amenities=Garage`);
    assert.equal(explicit.status, 200);
    assert.deepEqual(ids(await explicit.json()), [legacy]);
  });

  await t.test("strict route forwards all filters without reparsing the original query", async () => {
    const params = new URLSearchParams({ strict: "1", q: "1 bedroom under 1k in Banani pet friendly", keywords: "sunflower",
      minRent: "20000", maxRent: "30000", minBedrooms: "3", bathrooms: "2", floor: "4",
      areaId: String(mirpur), pets: "false", amenities: "Elevator,Gym" });
    const response = await fetch(`${base}/search?${params}`);
    assert.equal(response.status, 200);
    assert.deepEqual(ids(await response.json()).sort((a,b) => a-b), eligible);
    params.set("pets", "true");
    const petsResponse = await fetch(`${base}/search?${params}`);
    assert.equal(petsResponse.status, 200);
    assert.deepEqual(ids(await petsResponse.json()), [petsOnly]);
  });

  await t.test("strict route rejects malformed new filters rather than broadening the search", async () => {
    for (const malformed of ["minRent=abc", "minRent=-1", "minRent=20000oops", "minRent=", "minBedrooms=", "minBedrooms=-1", "minBedrooms=2.5", "minRent=2e4", "maxRent=2e4", "floor=1e1", "pets=yes", "keywords=sunflower&keywords=gym"]) {
      const response = await fetch(`${base}/search?strict=1&${malformed}`);
      assert.equal(response.status, 400, malformed);
    }
  });

  await t.test("conflicting strict numeric filters require clarification", async () => {
    for (const conflict of ["minRent=30000&maxRent=20000", "bedrooms=2&minBedrooms=3"]) {
      assert.equal((await fetch(`${base}/search?strict=1&${conflict}`)).status, 400, conflict);
    }
  });

  await t.test("disabled interpreter returns reviewable fallback with no automatic broad search", async () => {
    const response = await fetch(`${base}/search/interpret`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "three bedrooms in Mirpur near a school" }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "fallback");
    assert.deepEqual(result.filters, {});
    assert.deepEqual(result.unsupported, []);
    assert.deepEqual(result.preferences, []);
    assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0);
    assert.equal(typeof result.latencyMs, "number");
    assert.ok(result.latencyMs >= 0);
    assert.equal(result.listings, undefined);
  });

  await t.test("interpreter route uses the real catalog and provider response contract", async child => {
    const originalFetch = globalThis.fetch;
    const oldModel = process.env.SEARCH_AI_MODEL;
    const oldKey = process.env.SEARCH_AI_API_KEY;
    process.env.SEARCH_AI_ENABLED = "true";
    process.env.SEARCH_AI_MODEL = "isolated-search-test-model";
    process.env.SEARCH_AI_API_KEY = "synthetic-search-key";
    child.after(() => {
      globalThis.fetch = originalFetch;
      delete process.env.SEARCH_AI_ENABLED;
      if (oldModel === undefined) delete process.env.SEARCH_AI_MODEL;
      else process.env.SEARCH_AI_MODEL = oldModel;
      if (oldKey === undefined) delete process.env.SEARCH_AI_API_KEY;
      else process.env.SEARCH_AI_API_KEY = oldKey;
    });
    let providerCalls = 0;
    globalThis.fetch = (async (url, options) => {
      assert.equal(String(url), "https://generativelanguage.googleapis.com/v1beta/models/isolated-search-test-model:generateContent");
      const body = JSON.parse(String(options?.body));
      assert.ok(body.systemInstruction.parts[0].text.includes('"name":"Mirpur"'));
      assert.ok(body.systemInstruction.parts[0].text.includes('"name":"Elevator"'));
      assert.equal(body.contents[0].parts[0].text, "3 bedrooms in Mirpur with lift under 30k");
      providerCalls++;
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ constraints: [
        { field: "bedrooms", value: "3", evidence: "3 bedrooms", mandatory: true },
        { field: "area", value: "Mirpur", evidence: "Mirpur", mandatory: true },
        { field: "amenity", value: "Elevator", evidence: "lift", mandatory: true },
        { field: "maxRent", value: "30000", evidence: "30k", mandatory: true },
      ], unsupported: [] }) }] } }] });
    }) as typeof fetch;
    const response = await originalFetch(`${base}/search/interpret`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "3 bedrooms in Mirpur with lift under 30k" }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "interpreted");
    assert.equal(providerCalls, 1);
    assert.deepEqual(result.filters, { bedrooms: 3, areaId: mirpur, areaName: "Mirpur", amenityNames: ["Elevator"], maxRent: 30000 });
    assert.deepEqual(result.unsupported, []);
    assert.equal(result.listings, undefined);
  });

  await t.test("interpretation validates input", async () => {
    for (const body of [{}, { query: "" }, { query: 7 }, { query: "x".repeat(601) }]) {
      const response = await fetch(`${base}/search/interpret`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
    }
  });

  await t.test("my listings stays protected without a token", async () => {
    assert.equal((await fetch(`${base}/my`)).status, 401);
  });

  await t.test("interpretation requests are rate limited independently from ordinary search", async () => {
    let limited = false;
    for (let i = 0; i < 11; i++) {
      const response = await fetch(`${base}/search/interpret`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "3 bedrooms" }) });
      if (response.status === 429) { limited = true; break; }
      assert.equal(response.status, 200);
    }
    assert.ok(limited, "the interpretation endpoint must enforce its request budget");
    assert.equal((await fetch(`${base}/search?bedrooms=3`)).status, 200);
  });
});
