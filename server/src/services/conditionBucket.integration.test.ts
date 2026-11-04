import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {PGlite} from "@electric-sql/pglite";
test("condition bucket setup blocks broad browser policies and can safely be reapplied",async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE SCHEMA storage;CREATE ROLE anon;CREATE ROLE authenticated;
 CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit integer,allowed_mime_types text[]);
 CREATE TABLE storage.objects(id serial PRIMARY KEY,bucket_id text,name text);
 ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
 GRANT USAGE ON SCHEMA storage TO anon,authenticated;
 GRANT ALL ON storage.objects TO anon,authenticated;
 GRANT ALL ON SEQUENCE storage.objects_id_seq TO anon,authenticated;
 CREATE POLICY legacy_broad_access ON storage.objects FOR ALL TO anon,authenticated USING(true) WITH CHECK(true);
 INSERT INTO storage.objects(bucket_id,name) VALUES('condition-evidence','synthetic-private.png'),('listing-images','synthetic-public.png');`);
 const setup=await readFile(resolve(__dirname,"../../../db/supabase_condition_storage.sql"),"utf8");
 await db.exec(setup);
 await db.exec(setup);
 for(const role of ["anon","authenticated"]){
   await db.exec("SET ROLE "+role);
   const visible:any=await db.query("SELECT bucket_id FROM storage.objects");
   assert.deepEqual(visible.rows,[{bucket_id:"listing-images"}]);
   await assert.rejects(()=>db.query("INSERT INTO storage.objects(bucket_id,name) VALUES('condition-evidence','bypass.png')"),/row-level security/);
   assert.equal((await db.query("UPDATE storage.objects SET name='tamper' WHERE bucket_id='condition-evidence' RETURNING id")).rows.length,0);
   assert.equal((await db.query("DELETE FROM storage.objects WHERE bucket_id='condition-evidence' RETURNING id")).rows.length,0);
   await db.exec("RESET ROLE");
 }
 assert.equal((await db.query("SELECT id FROM storage.objects WHERE bucket_id='condition-evidence'")).rows.length,1);
});
