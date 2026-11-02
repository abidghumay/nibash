import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db/pool.js";
import notificationRouter from "../routes/notification.route.js";

const migrations = resolve(__dirname, "../../../db/migrations");

async function setup() {
  const db = new PGlite({ extensions: { pg_trgm } });
  try {
    for (const name of (await readdir(migrations)).filter(n => n.endsWith(".sql") && n < "017").sort()) {
      await db.exec((await readFile(resolve(migrations, name), "utf8")).replace(/^\uFEFF/, ""));
    }
    await db.exec(`
      INSERT INTO users (name,nid,phone,password_hash) VALUES
        ('Owner','1','1','x'),('Tenant','2','2','x'),('Other','3','3','x');
      INSERT INTO owners VALUES (1);
      INSERT INTO tenants VALUES (2,50000,'3');
      INSERT INTO areas (name,city,latitude,longitude,radius) VALUES ('Test','Dhaka',1,1,1);
      INSERT INTO listings (title,description,latitude,longitude,bedroom_count,bathroom_count,on_which_floor,area_id,owner_id)
        VALUES ('Test apartment','Test',1,1,2,1,1,1,1);
      INSERT INTO terms (rent,monthly_due_date) SELECT 10000,5 FROM generate_series(1,4);
      INSERT INTO agreements SELECT id FROM terms;
      INSERT INTO contracts (tenant_id,listing_id,agreement_id,status,start_date,end_date) VALUES
        (2,1,1,'signed',CURRENT_DATE-90,CURRENT_DATE+10),
        (2,1,2,'completed',CURRENT_DATE-90,CURRENT_DATE-10),
        (2,1,3,'proposed',CURRENT_DATE-90,CURRENT_DATE+10),
        (2,1,4,'signed',CURRENT_DATE-90,CURRENT_DATE+90);
      INSERT INTO payments (contract_id,amount,status,billing_month,due_date) VALUES
        (1,10000,'pending',CURRENT_DATE,CURRENT_DATE+5),
        (1,10000,'pending',CURRENT_DATE-30,CURRENT_DATE-25),
        (2,10000,'confirmed',CURRENT_DATE-60,CURRENT_DATE-55),
        (2,10000,'pending',CURRENT_DATE-30,CURRENT_DATE-25);
    `);
    // Reproduce Supabase's default browser grants before installing the inbox.
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon,authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon,authenticated;`);
    await db.exec(await readFile(resolve(migrations, "017_automated_inbox.sql"), "utf8"));
    await db.exec("UPDATE payments SET status='overdue' WHERE id=2");
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

test("inbox backfills current unpaid payments and expiring signed contracts once", async t => {
  const db = await setup();
  t.after(() => db.close());
  // Unpaid balances remain relevant even when their contract has ended.
  assert.deepEqual((await db.query(`SELECT kind, count(*)::int AS count FROM notifications GROUP BY kind ORDER BY kind`)).rows,
    [{ kind: "contract_expiring", count: 2 }, { kind: "payment_created", count: 3 }]);
  await db.exec("SELECT generate_inbox_reminders(); SELECT generate_inbox_reminders();");
  assert.equal((await db.query("SELECT * FROM notifications")).rows.length, 5);
  assert.equal((await db.query("SELECT * FROM notifications WHERE user_id=3")).rows.length, 0);
});

test("Supabase browser roles cannot directly read, mutate or generate private inbox messages", async t => {
  const db = await setup();
  t.after(() => db.close());
  assert.deepEqual((await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid='notifications'::regclass`)).rows,[{relrowsecurity:true}]);
  for (const role of ['anon','authenticated']) {
    const result = await db.query(`SELECT
      has_table_privilege($1,'notifications','SELECT') AS can_read,
      has_table_privilege($1,'notifications','INSERT') AS can_insert,
      has_table_privilege($1,'notifications','UPDATE') AS can_update,
      has_table_privilege($1,'notifications','DELETE') AS can_delete,
      has_table_privilege($1,'notifications','TRUNCATE') AS can_truncate,
      has_sequence_privilege($1,'notifications_id_seq','USAGE') AS can_sequence,
      has_function_privilege($1,'generate_inbox_reminders(date)','EXECUTE') AS can_generate`,[role]);
    assert.deepEqual(result.rows,[{can_read:false,can_insert:false,can_update:false,can_delete:false,can_truncate:false,can_sequence:false,can_generate:false}]);
  }
});

test("calendar-month expiry clamps month ends and catches missed runs", async t => {
  const db = await setup();
  t.after(() => db.close());
  await db.exec("UPDATE contracts SET end_date='2027-03-31' WHERE id=4");
  await db.exec("SELECT generate_inbox_reminders('2027-02-27')");
  assert.equal((await db.query("SELECT * FROM notifications WHERE contract_id=4")).rows.length, 0);
  await db.exec("SELECT generate_inbox_reminders('2027-02-28'); SELECT generate_inbox_reminders('2027-03-02');");
  assert.equal((await db.query("SELECT * FROM notifications WHERE contract_id=4")).rows.length, 2);
  await db.exec("UPDATE contracts SET end_date='2028-03-31' WHERE id=4; SELECT generate_inbox_reminders('2028-02-28');");
  assert.equal((await db.query("SELECT * FROM notifications WHERE contract_id=4")).rows.length, 2);
  await db.exec("SELECT generate_inbox_reminders('2028-02-29')");
  assert.equal((await db.query("SELECT * FROM notifications WHERE contract_id=4")).rows.length, 4);
  await db.exec("UPDATE contracts SET end_date='2029-01-15' WHERE id=4; SELECT generate_inbox_reminders('2028-12-15');");
  assert.equal((await db.query("SELECT * FROM notifications WHERE contract_id=4")).rows.length, 6);
  await db.exec("UPDATE contracts SET end_date='2030-01-15' WHERE id=4; SELECT generate_inbox_reminders('2030-01-16');");
  assert.equal((await db.query("SELECT * FROM notifications WHERE contract_id=4")).rows.length, 6);
});

test("transactional events notify the correct people only on actual transitions", async t => {
  const db = await setup();
  t.after(() => db.close());
  await db.exec("DELETE FROM notifications");
  await db.exec(`
    INSERT INTO terms (rent,monthly_due_date) VALUES (10000,5);
    INSERT INTO agreements VALUES (5);
    INSERT INTO contracts (tenant_id,listing_id,agreement_id,status,start_date,end_date)
      VALUES (2,1,5,'proposed',CURRENT_DATE,CURRENT_DATE+90);
    UPDATE contracts SET status='signed' WHERE id=5;
    UPDATE contracts SET status='signed' WHERE id=5;
    INSERT INTO payments (contract_id,amount,status,billing_month,due_date)
      VALUES (5,10000,'pending',CURRENT_DATE,CURRENT_DATE+5);
    UPDATE payments SET status='confirmed' WHERE contract_id=5;
    UPDATE payments SET status='confirmed' WHERE contract_id=5;
    UPDATE payments SET status='failed' WHERE id=1;
    UPDATE payments SET payment_method='Cash' WHERE id=2;
    UPDATE payments SET payment_method=NULL WHERE id=2;
    UPDATE contracts SET status='completed' WHERE id=5;
    UPDATE contracts SET status='completed' WHERE id=5;
  `);
  assert.deepEqual((await db.query("SELECT kind,user_id FROM notifications ORDER BY kind,user_id")).rows, [
    { kind: "contract_proposed", user_id: 2 },
    { kind: "contract_signed", user_id: 1 },
    { kind: "payment_created", user_id: 2 },
    { kind: "payment_confirmed", user_id: 2 },
    { kind: "payment_rejected", user_id: 2 },
    { kind: "payment_rejected", user_id: 2 },
    { kind: "contract_completed", user_id: 2 },
    { kind: "contract_completed", user_id: 1 },
  ].sort((a,b) => a.kind.localeCompare(b.kind) || a.user_id-b.user_id));
  await db.exec("BEGIN; UPDATE payments SET status='failed' WHERE id=2; ROLLBACK;");
  assert.equal((await db.query("SELECT * FROM notifications")).rows.length, 8);
});

test("inbox API authenticates, isolates recipients, validates requests and paginates", async t => {
  const db = await setup();
  const originalQuery = pool.query;
  pool.query = ((sql: string, params?: unknown[]) => db.query(sql,params)) as typeof pool.query;
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "inbox-isolated-test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/notifications",notificationRouter);
  const server = app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve => server.once("listening",resolve));
  t.after(async () => {
    await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
    pool.query = originalQuery;
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    await db.close();
  });
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api/notifications`;
  const call = (path: string,userId: number,method="GET",body?: unknown) => fetch(base+path,{
    method, headers: { "Content-Type":"application/json", Authorization:`Bearer ${jwt.sign({id:userId},process.env.JWT_SECRET!)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal((await fetch(base)).status,401);
  const tenantPage = await (await call("",2)).json();
  assert.equal(tenantPage.notifications.length,4);
  assert.equal((await (await call("/unread-count",2)).json()).count,4);
  assert.equal((await (await call("",3)).json()).notifications.length,0);
  const id = tenantPage.notifications[0].id;
  assert.equal((await call(`/${id}`,3,"PATCH",{read:true})).status,404);
  assert.equal((await call(`/${id}`,2,"PATCH",{read:"true"})).status,400);
  assert.equal((await call("?before=-1",2)).status,400);
  assert.equal((await call("?before=2147483648",2)).status,400);
  assert.equal((await call("?unread=wrong",2)).status,400);
  assert.equal((await call("?user_id=1",2)).status,400);
  await call(`/${id}`,2,"PATCH",{read:true});
  assert.equal((await (await call("?unread=true",2)).json()).notifications.length,3);
  await call(`/${id}`,2,"PATCH",{read:false});
  assert.equal((await (await call("/unread-count",2)).json()).count,4);
  await call("/read-all",2,"PATCH");
  assert.equal((await (await call("/unread-count",2)).json()).count,0);
  assert.equal((await (await call("/unread-count",1)).json()).count,1);
  await db.exec(`INSERT INTO notifications (user_id,contract_id,kind,title,body)
    SELECT 2,1,'payment_created','Test message','Test body' FROM generate_series(1,23)`);
  const first = await (await call("",2)).json();
  assert.equal(first.notifications.length,20);
  assert.ok(first.nextCursor);
  const second = await (await call(`?before=${first.nextCursor}`,2)).json();
  assert.equal(second.notifications.length,7);
  assert.equal(second.nextCursor,null);
  const ids = [...first.notifications,...second.notifications].map(n => n.id);
  assert.equal(new Set(ids).size,27);
});
