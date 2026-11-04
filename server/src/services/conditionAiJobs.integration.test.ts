import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import sharp from 'sharp';
import {rentalDatabase} from './testing/rentalFixtures.js';
import {bindSandboxDatabase} from './testing/sandboxDatabase.js';
import {pool} from '../db/pool.js';
import {ConditionReports} from './conditionReports.service.js';
import {MoveOutInspections} from './moveOutInspections.service.js';
import {ConditionAiJobs} from './conditionAiJobs.service.js';
import {parseMoveOutComparison,type MoveOutPair,compareMoveOutPairs} from './moveOutVision.js';

test('actual move-out submission, private evidence worker and approval complete a tenancy safely',async t=>{
 const db=await rentalDatabase();t.after(()=>db.close());
 for(const name of ['021_condition_reports.sql','022_move_out_inspections.sql','023_condition_analysis_jobs.sql'])
  await db.exec(await readFile(resolve(__dirname,'../../../db/migrations',name),'utf8'));
 const restore=bindSandboxDatabase(db);t.after(restore);
 const oldGate=process.env.CONDITION_AI_PROCESSING_ENABLED,oldKey=process.env.GEMINI_API_KEY;
 process.env.CONDITION_AI_PROCESSING_ENABLED='true';process.env.GEMINI_API_KEY='test-double-never-sent';
 t.after(()=>{if(oldGate===undefined)delete process.env.CONDITION_AI_PROCESSING_ENABLED;else process.env.CONDITION_AI_PROCESSING_ENABLED=oldGate;if(oldKey===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=oldKey;});
 const objects=new Map<string,Buffer>();let providerCalls=0,reads=0;
 const storage={async put(path:string,bytes:Buffer){objects.set(path,bytes);},async read(path:string){reads++;return objects.get(path)!;},async remove(path:string){objects.delete(path);},async sign(){return 'test-only';}};
 const baselineService=new ConditionReports(pool,storage),service=new MoveOutInspections(pool,storage);
 const image=await sharp({create:{width:128,height:128,channels:3,background:'#ddd'}}).png().toBuffer();
 let baseline=(await baselineService.create(2,1)).report!;
 baseline=(await baselineService.addRoom(2,1,baseline.version,'Synthetic living room')).report!;
 baseline=(await baselineService.addPhoto(2,1,baseline.version,baseline.rooms[0].id,image,'before.png','image/png','')).report!;
 baseline=(await baselineService.submit(2,1,baseline.version)).report!;
 for(const user of [1,2])baseline=(await baselineService.confirm(user,1,baseline.version,baseline.integrity_hash)).report!;
 for(const user of [1,2])await baselineService.consent(user,1,baseline.version,baseline.integrity_hash,true,true);
 let inspection=(await service.create(2,1)).inspection!;
 const room=inspection.rooms[0].id;
 async function uploadAndQueue(includeUnmatched=false) {
  for(const photo of inspection.photos)inspection=(await service.removePhoto(2,1,inspection.version,photo.id)).inspection!;
  inspection=(await service.addPhoto(2,1,inspection.version,room,image,'after.png','image/png','Synthetic evidence',baseline.photos[0].id)).inspection!;
  if(includeUnmatched)inspection=(await service.addPhoto(2,1,inspection.version,room,image,'unmatched.png','image/png','Manual-only photograph')).inspection!;
  inspection=(await service.submit(2,1,inspection.version,false,true)).inspection!;
  await service.consent(1,1,inspection.version,inspection.input_hash,true);
  inspection=(await service.analyze(2,1,inspection.version)).inspection!;
 }
 const evaluate:typeof compareMoveOutPairs=async(pairs:MoveOutPair[])=>{
  providerCalls++;return {result:parseMoveOutComparison({comparisonStatus:'compared',summary:'Two synthetic observations for human review.',limitations:[],findings:[
   {roomId:room,baselinePhotoId:baseline.photos[0].id,moveOutPhotoId:pairs[0].moveOutPhotoId,category:'possible_visible_change',description:'Possible wall mark.',locationHint:'Wall',visualEvidence:'Mark in second image.'},
   {roomId:room,baselinePhotoId:baseline.photos[0].id,moveOutPhotoId:pairs[0].moveOutPhotoId,category:'clear_visible_difference',description:'Possible floor patch.',locationHint:'Floor',visualEvidence:'Patch in second image.'},
  ]},pairs),model:'TEST DOUBLE',api:'TEST DOUBLE',runtime_ms:1,usage:{promptTokenCount:10},raw_response:{testDouble:true},prompt_version:'test-only'};
 };
 const worker=new ConditionAiJobs(pool,storage,evaluate,()=>true);
 await uploadAndQueue();
 await t.test('a changed property owner prevents external transmission under historical permissions',async()=>{
  await db.query('UPDATE listings SET owner_id=3 WHERE id=5');
  await worker.processOne();assert.equal(providerCalls,0);assert.equal(reads,0);
  await db.query('UPDATE listings SET owner_id=1 WHERE id=5');
  inspection=(await service.get(2,1)).inspection!;
  assert.equal(inspection.status,'awaiting_inspection');
  await uploadAndQueue();
 });
 await t.test('a queued old input cannot consume replacement evidence',async()=>{
  inspection=(await service.addPhoto(2,1,inspection.version,room,image,'retake.png','image/png','',baseline.photos[0].id)).inspection!;
  await worker.processOne();assert.equal(providerCalls,0);assert.equal(reads,0);
  assert.equal((await db.query<any>("SELECT status FROM condition_analysis_jobs ORDER BY id DESC LIMIT 1")).rows[0].status,'superseded');
 });
 await t.test('withdrawal before transmission blocks provider and preserves manual documentation',async()=>{
  inspection=(await service.submit(2,1,inspection.version,false,true)).inspection!;
  await service.consent(1,1,inspection.version,inspection.input_hash,true);
  inspection=(await service.analyze(1,1,inspection.version)).inspection!;
  await service.consent(2,1,inspection.version,inspection.input_hash,false);
  await worker.processOne();assert.equal(providerCalls,0);
  inspection=(await service.get(2,1)).inspection!;assert.equal(inspection.status,'awaiting_inspection');
 });
 await t.test('withdrawal during provider response prevents publication of its findings',async()=>{
  await uploadAndQueue();
  const withdrawing=new ConditionAiJobs(pool,storage,async(pairs)=>{
   const result=await evaluate(pairs);await service.consent(2,1,inspection.version,inspection.input_hash,false);return result;
  },()=>true);
  await withdrawing.processOne();inspection=(await service.get(2,1)).inspection!;
  assert.equal(inspection.analysis_source,'manual');assert.equal(inspection.findings.length,0);
 });
 await t.test('stored-byte tampering is detected before Gemini receives evidence',async()=>{
  await uploadAndQueue();const path=(await db.query<any>('SELECT storage_path FROM move_out_photos ORDER BY id DESC LIMIT 1')).rows[0].storage_path;
  const original=objects.get(path)!;objects.set(path,Buffer.from('tampered'));
  const before=providerCalls;await worker.processOne();assert.equal(providerCalls,before);objects.set(path,original);
  const job=(await db.query<any>('SELECT status,failure_code FROM condition_analysis_jobs ORDER BY id DESC LIMIT 1')).rows[0];
  assert.equal(job.status,'failed');assert.equal(job.failure_code,'evidence_integrity_failed');
 });
 await t.test('multiple valid observations are persisted once and require human review',async()=>{
  await uploadAndQueue(true);await worker.processOne();assert.equal(await worker.processOne(),false);
  inspection=(await service.get(1,1)).inspection!;assert.equal(inspection.analysis_source,'live');
  assert.equal(inspection.analysis_result.comparisonStatus,'limited');
  assert.ok(inspection.analysis_result.limitations.some((text:string)=>text.includes('no matched baseline')));
  assert.equal(inspection.findings.length,2);assert.equal(inspection.status,'awaiting_inspection');
  await assert.rejects(()=>service.approve(1,1,inspection.version,true,true,'2026-01-01'),/Review every finding/);
  for(const finding of inspection.findings)await service.review(1,1,inspection.version,finding.id,'acceptable','Reviewed synthetic fixture.');
  await service.vacancy(2,1,inspection.version,'2026-01-01');
  const before=(await db.query<any>('SELECT id,status,amount FROM payments ORDER BY id')).rows;
  inspection=(await service.approve(1,1,inspection.version,true,true,'2026-01-01')).inspection!;
  assert.equal(inspection.status,'completed');
  assert.deepEqual((await db.query<any>('SELECT id,status,amount FROM payments ORDER BY id')).rows,before);
  assert.equal((await db.query<any>('SELECT status,occupancy_state FROM contracts WHERE id=1')).rows[0].occupancy_state,'closed');
  assert.equal((await service.get(2,1)).inspection!.status,'completed');
  assert.equal((await baselineService.get(2,1)).report!.integrity_hash,baseline.integrity_hash);
 });
});
