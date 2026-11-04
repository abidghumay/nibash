import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { rentalDatabase, proposed } from "./testing/rentalFixtures.js";
import { pool } from "../db/pool.js";
import { closeRental } from "./rentalManagement.service.js";

test("move-out preserves evidence and requires exact-version human approval before controlled closure", async t => {
  assert.ok(existsSync(resolve(__dirname,"moveOutInspections.service.ts")),"move-out inspection service is implemented");
  const { MoveOutInspections } = await import("./moveOutInspections.service.js");
  const { ConditionReports } = await import("./conditionReports.service.js");
  const db=await rentalDatabase(true);t.after(()=>db.close());
  for(const migration of ["021_condition_reports.sql","022_move_out_inspections.sql","023_condition_analysis_jobs.sql"])
    if(existsSync(resolve(__dirname,"../../../db/migrations",migration))) await db.exec(await readFile(resolve(__dirname,"../../../db/migrations",migration),"utf8"));
  const query=async(sql:string,params?:any[])=>db.query<any>(sql,params);
  let gate=Promise.resolve();
  const database={query,async connect(){let release!:()=>void;const next=new Promise<void>(r=>release=r),previous=gate;gate=next;await previous;return {query,release};}};
  const objects=new Map<string,Buffer>();let signs=0;
  const storage={async put(path:string,bytes:Buffer){objects.set(path,bytes);},async remove(path:string){objects.delete(path);},async sign(path:string){assert.ok(objects.has(path));signs++;return "https://example.test/signed";}};
  const baselineService=new ConditionReports(database,storage),service=new MoveOutInspections(database,storage);
  await db.exec("INSERT INTO payments(contract_id,amount,status) VALUES(1,20000,'pending');UPDATE listings SET status='occupied' WHERE id=5");
  const image=await sharp({create:{width:128,height:128,channels:3,background:"#ddd"}}).png().toBuffer();
  let baseline:any,inspection:any;
  await t.test("only tenancy parties can initiate and snapshot a confirmed baseline",async()=>{
    await assert.rejects(()=>service.create(3,1),/authorized/);
    baseline=(await baselineService.create(2,1)).report;
    baseline=(await baselineService.addRoom(2,1,baseline.version,"Living room")).report;
    baseline=(await baselineService.addPhoto(2,1,baseline.version,baseline.rooms[0].id,image,"baseline.png","image/png","")).report;
    baseline=(await baselineService.submit(2,1,baseline.version)).report;
    baseline=(await baselineService.confirm(1,1,baseline.version,baseline.integrity_hash)).report;
    baseline=(await baselineService.confirm(2,1,baseline.version,baseline.integrity_hash)).report;
    inspection=(await service.create(2,1)).inspection;
    assert.equal(inspection.baseline_report_id,baseline.id);assert.equal(inspection.baseline_hash,baseline.integrity_hash);
    assert.equal(inspection.rooms[0].baseline_room_id,baseline.rooms[0].id);
    assert.equal((await service.create(1,1)).inspection.id,inspection.id);
    assert.equal((await db.query<any>("SELECT occupancy_state FROM contracts WHERE id=1")).rows[0].occupancy_state,"unconfirmed");
  });
  await t.test("evidence versions serialize edits and protect private cross-contract access",async()=>{
    inspection=(await service.addPhoto(2,1,inspection.version,inspection.rooms[0].id,image,"out.png","image/png","Possible wall mark",baseline.photos[0].id)).inspection;
    const photo=inspection.photos[0];assert.equal(photo.baseline_photo_id,baseline.photos[0].id);
    assert.ok(!JSON.stringify(inspection).includes("storage_path"));
    await assert.rejects(()=>service.photoUrl(3,1,photo.id),/authorized/);assert.equal(signs,0);
    assert.equal((await service.photoUrl(1,1,photo.id)).expires_in,120);
    await assert.rejects(()=>service.addRoom(1,1,inspection.version-1,"stale"),/changed/);
    const results=await Promise.allSettled([service.addObservation(1,1,inspection.version,undefined,"Check wall"),service.addRoom(2,1,inspection.version,"Kitchen")]);
    assert.ok(results.some(r=>r.status==="fulfilled"));inspection=(await service.get(1,1)).inspection;
    for(const room of inspection.rooms) if(!inspection.photos.some((p:any)=>p.room_id===room.id)) inspection=(await service.addPhoto(2,1,inspection.version,room.id,image,"room.png","image/png","")).inspection;
  });
  await t.test("manual fallback remains available without AI consent and never changes baseline",async()=>{
    inspection=(await service.submit(2,1,inspection.version,false,false)).inspection;
    assert.equal(inspection.status,"awaiting_inspection");assert.equal(inspection.analysis_source,"manual");
    assert.deepEqual(inspection.findings,[]);assert.match(inspection.input_hash,/^[a-f0-9]{64}$/);
    assert.equal((await baselineService.get(1,1)).report.integrity_hash,baseline.integrity_hash);
    await assert.rejects(()=>service.approve(2,1,inspection.version,true,true,"2026-01-01"),/landlord/);
  });
  await t.test("legacy closure cannot bypass an open condition inspection",async()=>{
    const oldQuery=pool.query,oldConnect=pool.connect;
    pool.query=query as any;pool.connect=database.connect as any;
    try {await assert.rejects(()=>closeRental(1,"1",{move_out_date:"2026-01-01",inspection_note:"bypass",settlement_note:"bypass"}),/inspection/i);}
    finally {pool.query=oldQuery;pool.connect=oldConnect;}
  });
  await t.test("AI requires both exact snapshot consents and terminal jobs never leave a stuck pending inspection",async()=>{
    const prior=process.env.CONDITION_AI_PROCESSING_ENABLED;process.env.CONDITION_AI_PROCESSING_ENABLED="true";process.env.GEMINI_API_KEY="synthetic";
    try{
      await baselineService.consent(1,1,baseline.version,baseline.integrity_hash,true,true);await baselineService.consent(2,1,baseline.version,baseline.integrity_hash,true,true);
      await service.consent(1,1,inspection.version,inspection.input_hash,true);
      await assert.rejects(()=>service.analyze(1,1,inspection.version),/Both parties/);
      inspection=(await service.consent(2,1,inspection.version,inspection.input_hash,true)).inspection;
      inspection=(await service.analyze(1,1,inspection.version)).inspection;assert.equal(inspection.status,"analysis_pending");
      assert.equal((await db.query<any>("SELECT count(*)::int n FROM condition_analysis_jobs WHERE inspection_id=$1",[inspection.id])).rows[0].n,1);
      await service.analyze(2,1,inspection.version);
      await db.query("UPDATE condition_analysis_jobs SET status='failed' WHERE inspection_id=$1",[inspection.id]);
      inspection=(await service.submit(2,1,inspection.version,false,false)).inspection;assert.equal(inspection.status,"awaiting_inspection");
      await assert.rejects(()=>service.analyze(1,1,inspection.version),/manual|edit/i);
      assert.equal((await service.get(1,1)).inspection.status,"awaiting_inspection");
    }finally{if(prior===undefined)delete process.env.CONDITION_AI_PROCESSING_ENABLED;else process.env.CONDITION_AI_PROCESSING_ENABLED=prior;}
  });
  await t.test("findings remain immutable, disputes are auditable, and approval requires review",async()=>{
    const finding={id:"f1",roomId:inspection.rooms[0].id,baselinePhotoId:baseline.photos[0].id,moveOutPhotoId:inspection.photos[0].id,category:"possible_visible_change",description:"Possible wall mark",locationHint:"Wall",visualEvidence:"A mark is visible",reviewRequired:true};
    await db.query<any>("UPDATE move_out_inspections SET analysis_result=$2::jsonb,analysis_source='live',status='awaiting_inspection' WHERE id=$1",[inspection.id,JSON.stringify({comparisonStatus:"compared",summary:"Check wall",findings:[finding],limitations:[]})]);
    await assert.rejects(()=>service.approve(1,1,inspection.version,true,true,"2026-01-01"),/review/i);
    await assert.rejects(()=>service.review(2,1,inspection.version,"f1","acceptable",""),/landlord/);
    inspection=(await service.review(1,1,inspection.version,"f1","confirmed_difference","Inspect mark")).inspection;
    assert.equal(inspection.status,"needs_review");
    inspection=(await service.vacancy(2,1,inspection.version,"2026-01-01")).inspection;
    assert.ok(inspection.tenant_vacated_at);assert.equal((await db.query<any>("SELECT status FROM contracts WHERE id=1")).rows[0].status,"signed");
    const vacancyRecord=(await db.query<any>("SELECT tenant_closed_at,move_out_date::text,occupancy_state FROM contracts WHERE id=1")).rows[0];
    assert.ok(vacancyRecord.tenant_closed_at,"Tenant vacancy must also be visible on the contract while condition review is disputed");
    assert.equal(vacancyRecord.move_out_date,"2026-01-01");
    assert.equal(vacancyRecord.occupancy_state,"unconfirmed","Vacancy reporting must not change existing invoice eligibility");
    await assert.rejects(()=>service.approve(1,1,inspection.version,true,true,"2026-01-01"),/disput|review/);
    inspection=(await service.resolve(1,1,inspection.version,"Both parties reviewed; no financial decision made")).inspection;
    assert.equal(inspection.findings[0].description,"Possible wall mark");
    assert.ok(inspection.events.some((e:any)=>e.action==="dispute_resolved"));
    inspection=(await service.addObservation(1,1,inspection.version,inspection.rooms[0].id,"A fixture requires further physical review.",true)).inspection;
    assert.equal(inspection.status,"needs_review","A human-discovered problem must be flaggable even when AI missed it");
    assert.equal(inspection.observations.at(-1).review_required,true);
    inspection=(await service.review(1,1,inspection.version,"f1","acceptable","AI suggestion checked; independent fixture issue still requires review.")).inspection;
    assert.equal(inspection.status,"needs_review","Saving another AI review cannot clear a human-discovered unresolved issue");
    await assert.rejects(()=>service.approve(1,1,inspection.version,true,true,"2026-01-01"),/disput|review/);
    inspection=(await service.resolve(1,1,inspection.version,"Inspected fixture and recorded acceptable condition.")).inspection;
  });
  await t.test("approval closes atomically once, retains historical payments, and blocks later edits",async()=>{
    const paymentCount=(await db.query<any>("SELECT count(*)::int n FROM payments")).rows[0].n;
    const originalPayments=(await db.query<any>("SELECT * FROM payments ORDER BY id")).rows;
    await assert.rejects(()=>service.approve(1,1,inspection.version-1,true,true,"2026-01-01"),/changed/);
    inspection=(await service.approve(1,1,inspection.version,true,true,"2026-01-01")).inspection;
    assert.equal(inspection.status,"completed");assert.equal(inspection.approved_by,1);
    const c=(await db.query<any>("SELECT * FROM contracts WHERE id=1")).rows[0];assert.equal(c.status,"completed");assert.equal(c.occupancy_state,"closed");
    await service.approve(1,1,inspection.version,true,true,"2026-01-01");
    assert.equal((await db.query<any>("SELECT count(*)::int n FROM move_out_events WHERE inspection_id=$1 AND action='approved'",[inspection.id])).rows[0].n,1);
    assert.equal((await db.query<any>("SELECT count(*)::int n FROM payments")).rows[0].n,paymentCount);
    assert.deepEqual((await db.query<any>("SELECT * FROM payments ORDER BY id")).rows,originalPayments);
    assert.equal((await db.query<any>("SELECT status FROM listings WHERE id=5")).rows[0].status,"approved");
    await assert.rejects(()=>service.removePhoto(2,1,inspection.version,inspection.photos[0].id),/completed|locked/);
    await assert.rejects(()=>db.query<any>("UPDATE move_out_photos SET notes='tamper' WHERE id=$1",[inspection.photos[0].id]),/immutable|locked/);
    await assert.rejects(()=>db.query<any>("DELETE FROM move_out_events WHERE inspection_id=$1",[inspection.id]),/retained/);
    await db.exec("SET ROLE authenticated");await assert.rejects(()=>db.query<any>("SELECT * FROM move_out_photos"),/permission denied/);await db.exec("RESET ROLE");
  });
  await t.test("no baseline permits honest manual documentation only",async()=>{
    const id=await proposed(db,1,"20000","2026-01-01","2027-01-01");await db.query<any>("UPDATE contracts SET status='signed' WHERE id=$1",[id]);
    let current=(await service.create(2,id)).inspection;assert.equal(current.baseline_report_id,null);
    current=(await service.addRoom(2,id,current.version,"Bedroom")).inspection;
    await assert.rejects(()=>service.addPhoto(2,id,current.version,current.rooms[0].id,image,"foreign.png","image/png","",baseline.photos[0].id),/Baseline photograph/);
    await assert.rejects(()=>service.photoUrl(2,id,inspection.photos[0].id),/Photo/);
    current=(await service.addPhoto(2,id,current.version,current.rooms[0].id,image,"manual.png","image/png","")).inspection;
    const result=await service.submit(2,id,current.version,true,true);assert.equal(result.inspection.status,"awaiting_inspection");assert.equal(result.inspection.analysis_source,"manual");assert.match(result.analysis_blocked_reason!,/baseline/);
    const approved=(await service.approve(1,id,current.version,true,true,"2026-01-01")).inspection;assert.equal(approved.status,"approved");
    assert.equal((await db.query<any>("SELECT status FROM contracts WHERE id=$1",[id])).rows[0].status,"signed");
    const done=(await service.vacancy(2,id,current.version,"2026-01-01")).inspection;assert.equal(done.status,"completed");
  });
  await t.test("replacement cancels the submitted version while retaining original evidence and snapshots",async()=>{
    const id=await proposed(db,2,"20000","2026-01-01","2027-01-01");await db.query("UPDATE contracts SET status='signed' WHERE id=$1",[id]);
    let current=(await service.create(2,id)).inspection;current=(await service.addRoom(2,id,current.version,"Room")).inspection;
    current=(await service.addPhoto(2,id,current.version,current.rooms[0].id,image,"original.png","image/png","")).inspection;
    current=(await service.submit(2,id,current.version,false,false)).inspection;
    const oldVersion=current.version,oldHash=current.input_hash,photo=current.photos[0].id;
    await db.query("UPDATE move_out_inspections SET status='analysis_pending' WHERE id=$1",[current.id]);
    current=(await service.removePhoto(2,id,current.version,photo)).inspection;
    assert.equal(current.version,oldVersion+1);assert.equal(current.input_hash,null);assert.equal(current.status,"awaiting_photos");
    assert.equal(current.archived_photos.length,1);assert.equal(current.findings.length,0);
    assert.ok(current.events.some((e:any)=>e.action==="submitted"&&e.details.hash===oldHash));
    await assert.rejects(()=>service.approve(1,id,oldVersion,true,true,"2026-01-01"),/changed/);
    assert.ok((await service.photoUrl(1,id,photo)).url);
    current=(await service.addPhoto(2,id,current.version,current.rooms[0].id,image,"replacement.png","image/png","")).inspection;
    assert.notEqual(current.photos[0].id,photo);
  });
  await t.test("ambiguous upload COMMIT preserves any committed private object",async()=>{
    const id=await proposed(db,3,"20000","2026-01-01","2027-01-01");await db.query("UPDATE contracts SET status='signed' WHERE id=$1",[id]);
    let loseAcknowledgement=false;
    const faultyDatabase={query,async connect(){const client=await database.connect();return {release:client.release,async query(sql:string,params?:any[]){const result=await client.query(sql,params);if(sql==="COMMIT"&&loseAcknowledgement){loseAcknowledgement=false;throw new Error("Lost commit acknowledgement");}return result;}};}};
    const faulty=new MoveOutInspections(faultyDatabase,storage);
    let current=(await faulty.create(2,id)).inspection;current=(await faulty.addRoom(2,id,current.version,"Room")).inspection;
    loseAcknowledgement=true;
    await assert.rejects(()=>faulty.addPhoto(2,id,current.version,current.rooms[0].id,image,"commit.png","image/png",""),/acknowledgement/);
    const saved=(await db.query<any>("SELECT storage_path FROM move_out_photos WHERE inspection_id=$1",[current.id])).rows[0];assert.ok(saved);assert.ok(objects.has(saved.storage_path));
  });
});
