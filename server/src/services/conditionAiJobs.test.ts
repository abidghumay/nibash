import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createHash} from 'node:crypto';

// Real PostgreSQL queue semantics in isolation; image/provider calls are explicit test doubles.
test('condition jobs recover leases, fence old workers, retry boundedly and respect consent',async t=>{
 const {ConditionAiJobs}=await import('./conditionAiJobs.service.js');
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE TABLE listings(id integer PRIMARY KEY,owner_id integer);INSERT INTO listings VALUES(1,1);
 CREATE TABLE contracts(id integer PRIMARY KEY,listing_id integer,tenant_id integer,status text,occupancy_state text);INSERT INTO contracts VALUES(1,1,2,'signed','occupied');
 CREATE TABLE move_out_inspections(id serial PRIMARY KEY,contract_id integer,root_contract_id integer,version integer,input_hash text,status text,
  owner_id integer,tenant_id integer,baseline_report_id integer,baseline_version integer,baseline_hash text,analysis_result jsonb,analysis_source text);
 CREATE TABLE condition_reports(id integer PRIMARY KEY,status text,version integer,integrity_hash text);
 CREATE TABLE condition_events(id serial PRIMARY KEY,report_id integer,actor_id integer,action text,version integer,details jsonb);
 CREATE TABLE move_out_events(id serial PRIMARY KEY,inspection_id integer,actor_id integer,action text,version integer,details jsonb);
 CREATE TABLE move_out_rooms(id integer PRIMARY KEY,inspection_id integer,name text);
 CREATE TABLE condition_photos(id integer PRIMARY KEY,report_id integer,room_id integer,storage_path text,mime_type text,sha256 text,removed_at timestamptz);
 CREATE TABLE move_out_photos(id integer PRIMARY KEY,inspection_id integer,room_id integer,baseline_photo_id integer,storage_path text,mime_type text,sha256 text,removed_at timestamptz);
 CREATE TABLE notifications(id serial PRIMARY KEY,user_id integer,contract_id integer,kind text,title text,body text,event_key text,UNIQUE(user_id,event_key));`);
 await db.exec(await readFile(resolve(__dirname,'../../../db/migrations/023_condition_analysis_jobs.sql'),'utf8'));
 const hash='a'.repeat(64),image=Buffer.from('synthetic private storage test bytes'),imageHash=createHash('sha256').update(image).digest('hex');
 await db.query(`INSERT INTO move_out_inspections VALUES(1,1,1,1,$1,'analysis_pending',1,2,1,1,$1,NULL,NULL);
 `,[hash]);
 await db.query("INSERT INTO condition_reports VALUES(1,'confirmed',1,$1)",[hash]);
 for(const user of [1,2]) {
  await db.query("INSERT INTO condition_events(report_id,actor_id,action,version,details) VALUES(1,$1,'ai_consent',1,$2)",[user,JSON.stringify({hash,granted:true,no_identity_documents:true})]);
  await db.query("INSERT INTO move_out_events(inspection_id,actor_id,action,version,details) VALUES(1,$1,'ai_consent',1,$2)",[user,JSON.stringify({hash,granted:true,no_identity_documents:true})]);
 }
 await db.exec("INSERT INTO move_out_rooms VALUES(1,1,'Synthetic room')");
 await db.query("INSERT INTO condition_photos VALUES(10,1,1,'before','image/png',$1,NULL)",[imageHash]);
 await db.query("INSERT INTO move_out_photos VALUES(20,1,1,10,'after','image/png',$1,NULL)",[imageHash]);
 await db.query("INSERT INTO condition_analysis_jobs(inspection_id,input_version,input_hash) VALUES(1,1,$1)",[hash]);
 const query=(sql:string,params?:any[])=>db.query(sql,params);let gate=Promise.resolve();
 const database={query,async connect(){let release!:()=>void;const next=new Promise<void>(r=>release=r);const prev=gate;gate=next;await prev;return {query,release};}};
 let calls=0;
 const storage={async read(){return image;},async put(){},async remove(){},async sign(){return 'unused';}};
 const evaluated={result:{comparisonStatus:'compared',summary:'No clear changes.',findings:[],limitations:[]},model:'test-double',runtime_ms:10,usage:{promptTokenCount:10},raw_response:{synthetic:true},api:'test-double',prompt_version:'test'};
 const worker=new ConditionAiJobs(database,storage,(async()=>{calls++;return evaluated;}) as any,()=>true);
 const first=await worker.claim();assert.ok(first);
 await db.exec("UPDATE condition_analysis_jobs SET lease_until=now()-interval '1 minute'");
 const recovered=await worker.claim();assert.ok(recovered);assert.notEqual(first.lease_token,recovered.lease_token);
 assert.equal(await worker.finish(first,evaluated as any),false,'expired worker cannot overwrite retry');
 assert.equal(await worker.finish(recovered,evaluated as any),true);
 assert.equal(await worker.finish(recovered,evaluated as any),false,'duplicate finish is idempotent');
 assert.equal((await db.query<any>('SELECT status FROM move_out_inspections')).rows[0].status,'awaiting_inspection');
 assert.equal((await db.query('SELECT * FROM notifications')).rows.length,2);
 await db.query("UPDATE move_out_inspections SET version=2,status='analysis_pending'");
 await db.query("INSERT INTO condition_analysis_jobs(inspection_id,input_version,input_hash) VALUES(1,1,$1) ON CONFLICT DO NOTHING",[hash]);
 // Add a new version with no new consent: never transmit its evidence.
 await db.query("INSERT INTO condition_analysis_jobs(inspection_id,input_version,input_hash) VALUES(1,2,$1)",[hash]);
 assert.equal(await worker.processOne(),true);assert.equal(calls,0);
 assert.equal((await db.query<any>('SELECT status FROM condition_analysis_jobs WHERE input_version=2')).rows[0].status,'cancelled');
 for(const user of [1,2])await db.query("INSERT INTO move_out_events(inspection_id,actor_id,action,version,details) VALUES(1,$1,'ai_consent',2,$2)",[user,JSON.stringify({hash,granted:true,no_identity_documents:true})]);
 await db.exec("UPDATE move_out_inspections SET version=3,status='analysis_pending'");
 for(const user of [1,2])await db.query("INSERT INTO move_out_events(inspection_id,actor_id,action,version,details) VALUES(1,$1,'ai_consent',3,$2)",[user,JSON.stringify({hash,granted:true,no_identity_documents:true})]);
 await db.query("INSERT INTO condition_analysis_jobs(inspection_id,input_version,input_hash) VALUES(1,3,$1)",[hash]);
 const unavailable=new ConditionAiJobs(database,storage,async()=>{calls++;throw new Error('gemini_http_503');},()=>true);
 for(let attempt=1;attempt<=3;attempt++) {
  await unavailable.processOne();
  await db.exec("UPDATE condition_analysis_jobs SET next_retry_at=now()-interval '1 minute' WHERE status='queued'");
 }
 assert.equal(calls,3);
 assert.equal((await db.query<any>('SELECT status FROM condition_analysis_jobs WHERE input_version=3')).rows[0].status,'failed');
 assert.equal((await db.query<any>('SELECT status FROM move_out_inspections')).rows[0].status,'awaiting_inspection');
});
