import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import express from "express";
import { pool } from "../db/pool.js";
import { createListing, updateListing, findAreaIdForCoordinates } from "./listing.service.js";
import { searchListings } from "./search/searchListings.js";
import areaRouter from "../routes/area.route.js";
import listingRouter from "../routes/listing.route.js";

test("area lifecycle preserves database identity and geographic consistency", async t => {
  const db = new PGlite({ extensions: { pg_trgm } });
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  t.after(async () => { pool.query = originalQuery; pool.connect = originalConnect; await db.close(); });
  const root = resolve(__dirname, "../../../db");
  for (const name of (await readdir(resolve(root, "migrations"))).filter(n => n.endsWith(".sql") && n < "017").sort()) {
    await db.exec((await readFile(resolve(root, "migrations", name), "utf8")).replace(/^\uFEFF/, ""));
  }
  const seed = (await readFile(resolve(root, "seed.sql"), "utf8"))
    .replace(", icon_path)", ")").replace(/,\s*'\/icons\/[^']+\.svg'/g, "");
  // Deliberately offset IDs: the application must never assume Gulshan is ID 4.
  await db.exec("SELECT setval(pg_get_serial_sequence('areas','id'), 40)");
  await db.exec(seed);
  await db.exec(`INSERT INTO users (name,nid,phone,password_hash) VALUES ('Area owner','area-owner','area-owner','x');
    INSERT INTO owners VALUES (1);
    INSERT INTO areas(name,city,latitude,longitude,radius) VALUES ('Shyamoli','Dhaka',23.774,90.365,500)`);
  pool.query = ((sql: string, values?: unknown[]) => db.query(sql, values)) as typeof pool.query;
  pool.connect = (async () => ({ query: (sql: string, values?: unknown[]) => db.query(sql, values), release() {} })) as unknown as typeof pool.connect;
  const areaRows = (await db.query<{ id: number; name: string; latitude: number; longitude: number; radius: number }>("SELECT * FROM areas")).rows;
  const gulshan = areaRows.find(a => a.name === "Gulshan")!.id;
  const banani = areaRows.find(a => a.name === "Banani")!.id;
  const shyamoli = areaRows.find(a => a.name === "Shyamoli")!.id;
  type ListingRow = { title: string; latitude: string; longitude: string; area_id: number };
  const payload = { title: "Apartment", description: "Quiet home", bedroom_count: 2, bathroom_count: 1,
    on_which_floor: 2, latitude: 23.7917, longitude: 90.4167, rent: 25000 };

  await t.test("distant and non-finite points are unsupported but gaps between centers remain covered", () => {
    assert.equal(findAreaIdForCoordinates(0, 0, areaRows), null);
    assert.equal(findAreaIdForCoordinates(22.3569, 91.7832, areaRows), null);
    assert.equal(findAreaIdForCoordinates(NaN, 90.4, areaRows), null);
    assert.notEqual(findAreaIdForCoordinates(23.75, 90.4, areaRows), null);
  });
  await t.test("creating outside coverage makes no listing or terms", async () => {
    await assert.rejects(createListing(1, { ...payload, latitude: 0, longitude: 0 }), { statusCode: 400 });
    assert.equal((await db.query("SELECT * FROM listings")).rows.length, 0);
    assert.equal((await db.query("SELECT * FROM terms")).rows.length, 0);
  });
  const id = await createListing(1, payload);
  await db.query("UPDATE listings SET status='approved' WHERE id=$1", [id]);
  await t.test("moving a pin persists coordinates and its derived area together", async () => {
    await updateListing(String(id), 1, { latitude: 23.795, longitude: 90.4047 });
    const row = (await db.query<ListingRow>("SELECT * FROM listings WHERE id=$1", [id])).rows[0];
    assert.equal(Number(row.latitude), 23.795);
    assert.equal(Number(row.longitude), 90.4047);
    assert.equal(row.area_id, banani);
    assert.deepEqual((await searchListings({ areaId: banani })).listings.map(l => l.id), [id]);
    assert.deepEqual((await searchListings({ areaId: gulshan })).listings, []);
  });
  await t.test("an area override cannot disagree with the saved pin", async () => {
    await assert.rejects(updateListing(String(id), 1, { area_id: gulshan }), { statusCode: 400 });
    assert.equal((await db.query<{ area_id: number }>("SELECT area_id FROM listings WHERE id=$1", [id])).rows[0].area_id, banani);
    await updateListing(String(id), 1, { area_id: banani, title: "Updated apartment" });
  });
  await t.test("an invalid move leaves coordinates, area and other fields unchanged", async () => {
    await assert.rejects(updateListing(String(id), 1, { latitude: 0, longitude: 0, title: "Bad move" }), { statusCode: 400 });
    const row = (await db.query<ListingRow>("SELECT * FROM listings WHERE id=$1", [id])).rows[0];
    assert.equal(row.title, "Updated apartment");
    assert.equal(Number(row.latitude), 23.795);
    assert.equal(row.area_id, banani);
  });
  await t.test("a partial coordinate patch uses the existing other coordinate", async () => {
    await updateListing(String(id), 1, { latitude: 23.7949 });
    const row = (await db.query<ListingRow>("SELECT * FROM listings WHERE id=$1", [id])).rows[0];
    assert.equal(Number(row.latitude), 23.7949);
    assert.equal(Number(row.longitude), 90.4047);
    assert.equal(row.area_id, banani);
  });
  await t.test("unresolved explicit areas never broaden ordinary or strict search", async () => {
    await assert.rejects(searchListings({ areaName: "unknown-place-xyz" }), { statusCode: 400 });
    await assert.rejects(searchListings({ areaName: "unknown-place-xyz", strict: true }), { statusCode: 400 });
    await assert.rejects(searchListings({ areaId: 999999 }), { statusCode: 400 });
    await assert.rejects(searchListings({ areaId: banani, areaName: "Gulshan" }), { statusCode: 400 });
  });
  await t.test("ordinary parsing recognizes newly added database areas and existing Bangla aliases", async () => {
    const newId = await createListing(1, { ...payload, latitude: 23.774, longitude: 90.365 });
    await db.query("UPDATE listings SET status='approved' WHERE id=$1", [newId]);
    assert.equal((await db.query<{ area_id: number }>("SELECT area_id FROM listings WHERE id=$1", [newId])).rows[0].area_id, shyamoli);
    assert.deepEqual((await searchListings({ q: "in Shyamoli" })).listings.map(l => l.id), [newId]);
    assert.deepEqual((await searchListings({ q: "\u09ac\u09a8\u09be\u09a8\u09c0" })).listings.map(l => l.id), [id]);
  });
  await t.test("catalog endpoint includes areas without listings and actual database IDs; stats stays compatible", async () => {
    const app = express(); app.use("/areas", areaRouter); app.use("/listings", listingRouter);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(r => server.once("listening", r));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/areas`;
      const response = await fetch(base);
      assert.equal(response.status, 200);
      const catalog = await response.json() as { areas: { id: number; name: string; city: string }[] };
      assert.equal(catalog.areas.find(a => a.name === "Gulshan")?.id, gulshan);
      assert.equal(catalog.areas.length, 13);
      assert.equal(catalog.areas.find(a => a.name === "Shyamoli")?.city, "Dhaka");
      const stats = await (await fetch(`${base}/stats`)).json() as { areas: { id: number; listing_count: number }[] };
      assert.equal(stats.areas.find(a => a.id === banani)?.listing_count, 1);
      const origin = base.replace(/\/areas$/, "");
      for (const query of [`areaId=${gulshan}junk`, "areaId=-1", "area[x]=Gulshan", "area=Gulshan&area=Banani", "area=Gulshan&areaName=Banani", `areaId=${gulshan}&area=Gulshan&areaName=Banani`, "strict=1&area=Gulshan&areaName=Banani"]) {
        assert.equal((await fetch(`${origin}/listings/search?${query}`)).status, 400, query);
      }
      assert.equal((await fetch(`${origin}/listings/search?area=Gulshan&areaName=Gulshan`)).status, 200);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });
  await t.test("unchanged legacy locations remain editable, including a full form payload", async () => {
    const legacyId = await createListing(1, payload);
    await db.query("UPDATE listings SET latitude=0, longitude=0 WHERE id=$1", [legacyId]);
    await updateListing(String(legacyId), 1, { ...payload, latitude: 0, longitude: 0, title: "Legacy edited" });
    const row = (await db.query<ListingRow>("SELECT * FROM listings WHERE id=$1", [legacyId])).rows[0];
    assert.equal(row.title, "Legacy edited");
    assert.equal(Number(row.latitude), 0);
    assert.equal(Number(row.longitude), 0);
    assert.equal(row.area_id, gulshan);
    await assert.rejects(updateListing(String(legacyId), 1, { longitude: 0.1 }), { statusCode: 400 });
    await assert.rejects(updateListing(String(legacyId), 2, { title: "Unauthorized" }), { statusCode: 403 });
  });
});
