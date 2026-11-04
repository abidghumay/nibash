import { PGlite } from "@electric-sql/pglite";
import { pool } from "../../db/pool.js";

// PGlite has one session. Serialize both standalone queries and complete transactions.
// This adapter is only for the isolated demo/tests; production continues to use pg.Pool.
export function bindSandboxDatabase(db: PGlite) {
  let tail = Promise.resolve();
  async function lock() {
    let unlock!: () => void;
    const prior = tail;
    tail = new Promise<void>((r) => {
      unlock = r;
    });
    await prior;
    return unlock;
  }
  const query = async (sql: string, args?: unknown[]) => {
    const r = await db.query(sql, args);
    return { ...r, rowCount: r.affectedRows ?? r.rows.length };
  };
  const originalQuery = pool.query,
    originalConnect = pool.connect;
  pool.query = (async (sql: string, args?: unknown[]) => {
    const release = await lock();
    try {
      return await query(sql, args);
    } finally {
      release();
    }
  }) as typeof pool.query;
  pool.connect = (async () => {
    const release = await lock();
    return { query, release };
  }) as unknown as typeof pool.connect;
  return () => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  };
}
