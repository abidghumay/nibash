import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
test("all migrations including rental protection install on an empty PostgreSQL database", async (t) => {
  const db = new PGlite({ extensions: { pg_trgm } });
  t.after(() => db.close());
  const directory = resolve(__dirname, "../../../db/migrations");
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of names)
    await db.exec(
      (await readFile(resolve(directory, name), "utf8")).replace(/^\uFEFF/, ""),
    );
  await db.exec(
    "CALL generate_monthly_payments(); CALL mark_overdue_payments()",
  );
  assert.equal(
    (
      await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM rental_documents",
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT indexname FROM pg_indexes WHERE indexname='rental_one_invoice_per_root_month'",
      )
    ).rows.length,
    1,
  );
});
