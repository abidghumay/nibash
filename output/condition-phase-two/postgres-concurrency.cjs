// Reproducible real-session checks. Requires a fresh, dedicated loopback PostgreSQL17 cluster on 55436.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const database='nibash_condition_phase_two_'+Date.now();
process.env.DATABASE_URL='postgres://postgres@127.0.0.1:55436/'+database;
process.env.CONDITION_AI_PROCESSING_ENABLED='true';process.env.GEMINI_API_KEY='test-double-never-transmitted';
const {Pool}=require(path.join(root,'server/node_modules/pg'));
const sharp=require(path.join(root,'server/node_modules/sharp'));
const {MoveOutInspections}=require(path.join(root,'server/dist/services/moveOutInspections.service.js'));
const {ConditionAiJobs}=require(path.join(root,'server/dist/services/conditionAiJobs.service.js'));
const {ConditionReports}=require(path.join(root,'server/dist/services/conditionReports.service.js'));
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:10});
const objects=new Map();
const storage={async put(p,b){objects.set(p,b);},async remove(p){objects.delete(p);},async sign(){return 'test-double';},async read(p){return objects.get(p);}};
const baselineService=new ConditionReports(pool,storage),service=new MoveOutInspections(pool,storage);
let image;
async function fixture(n,baseline=false){
 const area=(await pool.query("INSERT INTO areas(name,city,latitude,longitude,radius) VALUES($1,'Dhaka',1,1,1) RETURNING id",['Synthetic'+n])).rows[0].id;
 const listing=(await pool.query("INSERT INTO listings(title,description,latitude,longitude,bedroom_count,bathroom_count,on_which_floor,area_id,owner_id) VALUES($1,'Synthetic',1,1,1,1,1,$2,1) RETURNING id",['Synthetic'+n,area])).rows[0].id;
 const terms=(await pool.query('INSERT INTO terms(rent,security_deposit,advance_rent,monthly_due_date) VALUES(100,0,0,5) RETURNING id')).rows[0].id;
 await pool.query('INSERT INTO agreements VALUES($1)',[terms]);
 const contract=(await pool.query("INSERT INTO contracts(tenant_id,listing_id,agreement_id,start_date,end_date,created_by_id) VALUES(2,$1,$2,current_date-30,current_date+335,1) RETURNING id",[listing,terms])).rows[0].id;
 await pool.query("UPDATE contracts SET status='signed' WHERE id=$1",[contract]);
 let b;
 if(baseline){
  b=(await baselineService.create(2,contract)).report;b=(await baselineService.addRoom(2,contract,b.version,'Living room')).report;
  b=(await baselineService.addPhoto(2,contract,b.version,b.rooms[0].id,image,'before.png','image/png','')).report;
  b=(await baselineService.submit(2,contract,b.version)).report;
  for(const user of [1,2])b=(await baselineService.confirm(user,contract,b.version,b.integrity_hash)).report;
  for(const user of [1,2])await baselineService.consent(user,contract,b.version,b.integrity_hash,true,true);
 }
 let r=(await service.create(2,contract)).inspection;
 if(!baseline)r=(await service.addRoom(2,contract,r.version,'Living room')).inspection;
 r=(await service.addPhoto(2,contract,r.version,r.rooms[0].id,image,'out.png','image/png','',b?.photos[0].id)).inspection;
 r=(await service.submit(2,contract,r.version,false,baseline)).inspection;
 if(baseline){await service.consent(1,contract,r.version,r.input_hash,true);r=(await service.analyze(2,contract,r.version)).inspection;}
 return {contract,listing,r,b};
}
async function main(){
 const admin=new Pool({host:'127.0.0.1',port:55436,user:'postgres',database:'postgres'});
 try{await admin.query('CREATE DATABASE '+database);}finally{await admin.end();}
 for(const file of fs.readdirSync(path.join(root,'db/migrations')).filter(f=>f.endsWith('.sql')).sort())
  await pool.query(fs.readFileSync(path.join(root,'db/migrations',file),'utf8').replace(/^\uFEFF/,''));
 await pool.query("INSERT INTO users(name,nid,phone,password_hash) VALUES('Synthetic owner','SYNTH1','SYNTH1','x'),('Synthetic tenant','SYNTH2','SYNTH2','x');INSERT INTO owners VALUES(1);INSERT INTO tenants VALUES(2,50000,'SYNTHETIC')");
 image=await sharp({create:{width:128,height:128,channels:3,background:'#ddd'}}).png().toBuffer();
 const results=[];
 const a=await fixture('simultaneous-approvals');
 await service.vacancy(2,a.contract,a.r.version,'2026-11-04');
 const approvals=await Promise.allSettled([service.approve(1,a.contract,a.r.version,true,true,'2026-11-04'),service.approve(1,a.contract,a.r.version,true,true,'2026-11-04')]);
 assert.equal(approvals.filter(x=>x.status==='fulfilled').length,2);
 assert.equal((await pool.query("SELECT count(*)::int n FROM move_out_events WHERE inspection_id=$1 AND action='completed'",[a.r.id])).rows[0].n,1);
 results.push({case:'Simultaneous duplicate landlord approvals complete exactly once',passed:true});
 const b=await fixture('edit-approval');
 const competing=await Promise.allSettled([service.addPhoto(2,b.contract,b.r.version,b.r.rooms[0].id,image,'retake.png','image/png',''),service.approve(1,b.contract,b.r.version,true,true,'2026-11-04')]);
 assert.equal(competing.filter(x=>x.status==='fulfilled').length,1);
 const br=(await service.get(1,b.contract)).inspection;
 assert.ok(br.status==='approved'||br.status==='awaiting_photos');
 results.push({case:'Evidence edit versus approval has exactly one winner and no stale approval',passed:true});
 const c=await fixture('queue-claim',true);
 const worker=new ConditionAiJobs(pool,storage,async()=>{throw Error('test only');},()=>true);
 const claims=await Promise.all([worker.claim(),worker.claim()]);assert.equal(claims.filter(Boolean).length,1);
 const first=claims.find(Boolean);await pool.query("UPDATE condition_analysis_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",[first.id]);
 const recovered=await worker.claim();assert.notEqual(first.lease_token,recovered.lease_token);
 const evaluated={result:{comparisonStatus:'compared',summary:'No clear change (TEST DOUBLE).',findings:[],limitations:[]},model:'TEST DOUBLE',runtime_ms:1,usage:null,raw_response:{testDouble:true},api:'test-double',prompt_version:'test'};
 assert.equal(await worker.finish(first,evaluated),false);
 assert.equal(await worker.finish(recovered,evaluated),true);
 results.push({case:'SKIP LOCKED single claim, expired lease recovery and old-worker write fence',passed:true});
 const d=await fixture('revoke-finish',true),job=await worker.claim();
 await service.consent(2,d.contract,d.r.version,d.r.input_hash,false);
 assert.equal(await worker.finish(job,evaluated),false);
 assert.equal((await service.get(1,d.contract)).inspection.analysis_source,'manual');
 results.push({case:'Withdrawn consent prevents a claimed worker publishing its result',passed:true});
 const e=await fixture('vacancy-approval');
 await Promise.all([service.vacancy(2,e.contract,e.r.version,'2026-11-04'),service.approve(1,e.contract,e.r.version,true,true,'2026-11-04')]);
 assert.equal((await service.get(2,e.contract)).inspection.status,'completed');
 results.push({case:'Concurrent tenant vacancy and landlord approval complete through root lock',passed:true});
 const f=await fixture('renewal-finalization');await service.vacancy(2,f.contract,f.r.version,'2026-11-04');
 const blocker=await pool.connect();
 try{
  await blocker.query('BEGIN');await blocker.query('SELECT id FROM listings WHERE id=$1 FOR UPDATE',[f.listing]);
  const approval=service.approve(1,f.contract,f.r.version,true,true,'2026-11-04').then(value=>({value}),error=>({error}));
  let waiting=false;
  for(let n=0;n<80;n++){
   const activity=(await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF l%'" )).rows[0];
   if(activity.n>0){waiting=true;break;}await new Promise(r=>setTimeout(r,25));
  }
  assert.ok(waiting,'actual approval/listing lock wait must be observed');
  // If approval took root before listing this NOWAIT fails (the old inversion).
  await blocker.query('SELECT id FROM contracts WHERE id=$1 FOR UPDATE NOWAIT',[f.contract]);
  const terms=(await blocker.query('INSERT INTO terms(rent,security_deposit,advance_rent,monthly_due_date) VALUES(100,0,0,5) RETURNING id')).rows[0].id;
  await blocker.query('INSERT INTO agreements VALUES($1)',[terms]);
  await blocker.query(`INSERT INTO contracts(tenant_id,listing_id,agreement_id,start_date,end_date,created_by_id,previous_contract_id)
   SELECT tenant_id,listing_id,$2,end_date+1,end_date+365,1,id FROM contracts WHERE id=$1`,[f.contract,terms]);
  await blocker.query('COMMIT');const observed=await approval;
  assert.ok(observed.error);assert.match(observed.error.message,/renewal/);
  assert.equal((await service.get(1,f.contract)).inspection.status,'awaiting_inspection');
  results.push({case:'Renewal proposal versus final approval observes real listing wait, no lock inversion and fresh continuing-renewal rejection',passed:true,actual_lock_wait_observed:true});
 }finally{await blocker.query('ROLLBACK');blocker.release();}
 const evidence={recorded_at:new Date().toISOString(),database:'Fresh synthetic PostgreSQL17, loopback:55436; no production data',provider:'Explicit test doubles only',results,passed:results.length};
 fs.writeFileSync(path.join(__dirname,'postgres-concurrency.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>pool.end());
