import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import express from "express";
import { pool } from "../db/pool.js";
import listingRouter from "../routes/listing.route.js";

test("public marketplace counts use current rows and exclude unapproved listings and proposals", async t => {
  const db = new PGlite();
  const original = pool.query;
  pool.query = ((sql: string, values?: unknown[]) => db.query(sql, values)) as typeof pool.query;
  const app = express(); app.use("/listings", listingRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); pool.query = original; await db.close(); });
  await db.exec("CREATE TABLE listings(id integer,status text,area_id integer); CREATE TABLE contracts(id integer,status text);");
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/listings/stats`;
  const empty = await fetch(url);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { approvedApartments: 0, signedAgreements: 0, areasWithListings: 0 });
  await db.exec(`INSERT INTO listings VALUES(1,'approved',10),(2,'approved',10),(3,'approved',20),(4,'waiting',30),(5,'rejected',40);
    INSERT INTO contracts VALUES(1,'signed'),(2,'completed'),(3,'renewed'),(4,'proposed');`);
  assert.deepEqual(await (await fetch(url)).json(), { approvedApartments: 3, signedAgreements: 3, areasWithListings: 2 });
  await db.exec("UPDATE listings SET status='rejected' WHERE id=3; INSERT INTO contracts VALUES(5,'signed')");
  assert.deepEqual(await (await fetch(url)).json(), { approvedApartments: 2, signedAgreements: 4, areasWithListings: 1 });
});
