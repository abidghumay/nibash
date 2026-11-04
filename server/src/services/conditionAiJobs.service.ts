import {createHash,randomUUID} from 'node:crypto';
import {pool} from '../db/pool.js';
import {conditionStorage,type ConditionStorage} from './conditionStorage.service.js';
import {compareMoveOutPairs,conditionAnalysisEnabled,MOVE_OUT_PROMPT_VERSION,type MoveOutPair} from './moveOutVision.js';

interface Queryable {query(sql:string,params?:any[]):Promise<{rows:any[]}>}
interface Database extends Queryable {connect():Promise<Queryable&{release():void}>}
interface Job {id:number;inspection_id:number;input_version:number;input_hash:string;attempt_count:number;lease_token:string}
type Evaluation=Awaited<ReturnType<typeof compareMoveOutPairs>>;
function failureCode(error:unknown) {
 const text=error instanceof Error?error.message:'';
 return /^(gemini_http_\d{3}|gemini_network_or_timeout|gemini_invalid_structured_response|condition_processing_disabled|gemini_key_missing|evidence_integrity_failed|evidence_unavailable)$/.test(text)?text:'analysis_unavailable';
}
function temporary(code:string) {return /^gemini_http_(429|5\d\d)$/.test(code)||['gemini_network_or_timeout','analysis_unavailable'].includes(code);}

export class ConditionAiJobs {
 constructor(private db:Database=pool,private storage:ConditionStorage=conditionStorage,
  private evaluate:typeof compareMoveOutPairs=compareMoveOutPairs,private enabled:()=>boolean=conditionAnalysisEnabled) {}
 async claim():Promise<Job|undefined> {
  return (await this.db.query(`UPDATE condition_analysis_jobs SET status='running',attempt_count=attempt_count+1,
   lease_token=$1,lease_until=now()+interval '5 minutes' WHERE id=(SELECT id FROM condition_analysis_jobs
    WHERE (status='queued' AND next_retry_at<=now()) OR (status='running' AND lease_until<=now())
    ORDER BY next_retry_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,[randomUUID()])).rows[0];
 }
 private async permitted(db:Queryable,i:any) {
  if(!this.enabled()||!i.baseline_report_id)return false;
  const tenancy=(await db.query(`SELECT c.id FROM contracts c JOIN listings l ON l.id=c.listing_id
   WHERE c.id=$1 AND c.tenant_id=$2 AND l.owner_id=$3 AND c.status='signed' AND c.occupancy_state<>'closed'`,
   [i.contract_id,i.tenant_id,i.owner_id])).rows[0];
  if(!tenancy)return false;
  const baseline=(await db.query("SELECT * FROM condition_reports WHERE id=$1 AND status='confirmed' AND version=$2 AND integrity_hash=$3",
   [i.baseline_report_id,i.baseline_version,i.baseline_hash])).rows[0];
  if(!baseline)return false;
  for(const [table,key,id,version,hash] of [
   ['condition_events','report_id',i.baseline_report_id,i.baseline_version,i.baseline_hash],
   ['move_out_events','inspection_id',i.id,i.version,i.input_hash],
  ] as const) {
   const events=(await db.query(`SELECT DISTINCT ON(actor_id) actor_id,details FROM ${table}
    WHERE ${key}=$1 AND version=$2 AND action='ai_consent' AND details->>'hash'=$3 ORDER BY actor_id,id DESC`,[id,version,hash])).rows;
   if(![i.owner_id,i.tenant_id].every(user=>events.some(e=>e.actor_id===user&&e.details.granted===true&&e.details.no_identity_documents===true)))return false;
  }
  return true;
 }
 private async current(job:Job) {
  return (await this.db.query(`SELECT i.* FROM move_out_inspections i JOIN condition_analysis_jobs j ON j.inspection_id=i.id
   WHERE j.id=$1 AND j.lease_token=$2 AND j.status='running' AND j.lease_until>now()
    AND i.version=$3 AND i.input_hash=$4 AND i.status='analysis_pending'`,[job.id,job.lease_token,job.input_version,job.input_hash])).rows[0];
 }
 async finish(job:Job,result?:Evaluation,code?:string):Promise<boolean> {
  const db=await this.db.connect();
  try {
   await db.query('BEGIN');
   // Match renewal/approval lock order. Never hold locks during inference.
   await db.query(`SELECT l.id FROM listings l JOIN contracts c ON c.listing_id=l.id
    JOIN move_out_inspections i ON i.contract_id=c.id WHERE i.id=$1 FOR UPDATE OF l`,[job.inspection_id]);
   await db.query(`SELECT c.id FROM contracts c JOIN move_out_inspections i ON i.root_contract_id=c.id WHERE i.id=$1 FOR UPDATE OF c`,[job.inspection_id]);
   const i=(await db.query('SELECT * FROM move_out_inspections WHERE id=$1 FOR UPDATE',[job.inspection_id])).rows[0];
   const lease=(await db.query("SELECT * FROM condition_analysis_jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() FOR UPDATE",[job.id,job.lease_token])).rows[0];
   if(!lease){await db.query('COMMIT');return false;}
   const stale=!i||i.version!==job.input_version||i.input_hash!==job.input_hash||i.status!=='analysis_pending';
   const allowed=!stale&&await this.permitted(db,i);
   const retry=!stale&&allowed&&!result&&job.attempt_count<3&&temporary(code||'analysis_unavailable');
   const status=stale?'superseded':!allowed?'cancelled':result?'completed':retry?'queued':'failed';
   await db.query(`UPDATE condition_analysis_jobs SET status=$2,lease_token=NULL,lease_until=NULL,
    next_retry_at=now()+($3 * interval '30 seconds'),finished_at=CASE WHEN $2='queued' THEN NULL ELSE now() END,
    failure_code=$4,model=$5,runtime_ms=$6,usage=$7::jsonb,raw_output=$8::jsonb,prompt_version=$9 WHERE id=$1`,
    [job.id,status,2**Math.min(job.attempt_count-1,3),stale?'stale_input':!allowed?'consent_or_processing_disabled':code??null,
     result?.model??null,result?.runtime_ms??null,JSON.stringify(result?.usage??null),JSON.stringify(result?.raw_response??null),result?.prompt_version??MOVE_OUT_PROMPT_VERSION]);
   if(!stale&&!retry) {
    const report=allowed&&result?result.result:{comparisonStatus:'insufficient_evidence',summary:'AI comparison unavailable. Review the photographs manually.',findings:[],limitations:[!allowed?'External processing permission is unavailable or was withdrawn.':'The model could not produce a usable comparison.']};
    await db.query("UPDATE move_out_inspections SET status='awaiting_inspection',analysis_result=$2::jsonb,analysis_source=$3 WHERE id=$1",[i.id,JSON.stringify(report),allowed&&result?'live':'manual']);
    await db.query("INSERT INTO move_out_events(inspection_id,actor_id,action,version,details) VALUES($1,$2,$3,$4,$5::jsonb)",
     [i.id,i.owner_id,allowed&&result?'analysis_completed':'analysis_unavailable',i.version,JSON.stringify({job_id:job.id,automated:true,source:allowed&&result?'live':'manual',model:result?.model,prompt_version:MOVE_OUT_PROMPT_VERSION})]);
    for(const recipient of [i.owner_id,i.tenant_id])await db.query(`INSERT INTO notifications(user_id,contract_id,kind,title,body,event_key)
     VALUES($1,$2,'condition_report',$3,$4,$5) ON CONFLICT(user_id,event_key) DO NOTHING`,
     [recipient,i.contract_id,allowed&&result?'AI inspection ready':'Inspection ready for manual review',
      'Open the move-out inspection in your contract to compare the evidence and record human review.',`move-out:${i.id}:${i.version}:analysis-finished`]);
   }
   await db.query('COMMIT');return !stale;
  }catch(error){try{await db.query('ROLLBACK');}catch{}throw error;}finally{db.release();}
 }
 async processOne() {
  const job=await this.claim();if(!job)return false;
  try {
   const i=await this.current(job);
   if(!i||!await this.permitted(this.db,i)||job.attempt_count>3) {await this.finish(job,undefined,'condition_processing_disabled');return true;}
   const rows=(await this.db.query(`SELECT p.id AS move_out_id,p.room_id,p.storage_path AS move_out_path,p.sha256 AS move_out_hash,p.mime_type AS move_out_mime,
    b.id AS baseline_id,b.storage_path AS baseline_path,b.sha256 AS baseline_image_hash,b.mime_type AS baseline_mime,r.name AS room_name
    FROM move_out_photos p JOIN move_out_rooms r ON r.id=p.room_id AND r.inspection_id=p.inspection_id
    JOIN condition_photos b ON b.id=p.baseline_photo_id AND b.report_id=$2 AND b.removed_at IS NULL
    WHERE p.inspection_id=$1 AND p.removed_at IS NULL ORDER BY p.id`,[i.id,i.baseline_report_id])).rows;
   if(!rows.length||!this.storage.read)throw new Error('evidence_unavailable');
   const total=Number((await this.db.query('SELECT count(*)::int AS n FROM move_out_photos WHERE inspection_id=$1 AND removed_at IS NULL',[i.id])).rows[0].n);
   const unmatched=Math.max(0,total-rows.length);
   const results:Evaluation[]=[];const started=performance.now();
   for(let offset=0;offset<rows.length;offset+=4) {
    const current=await this.current(job);
    if(!current||!await this.permitted(this.db,current)) {await this.finish(job,undefined,'condition_processing_disabled');return true;}
    await this.db.query("UPDATE condition_analysis_jobs SET lease_until=now()+interval '5 minutes' WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now()",[job.id,job.lease_token]);
    const pairs:MoveOutPair[]=[];
    for(const p of rows.slice(offset,offset+4)) {
     const baseline=await this.storage.read(p.baseline_path),moveOut=await this.storage.read(p.move_out_path);
     if(createHash('sha256').update(baseline).digest('hex')!==p.baseline_image_hash||createHash('sha256').update(moveOut).digest('hex')!==p.move_out_hash)
      throw new Error('evidence_integrity_failed');
     pairs.push({roomId:p.room_id,roomName:p.room_name,baselinePhotoId:p.baseline_id,moveOutPhotoId:p.move_out_id,
      baseline,moveOut,baselineMime:p.baseline_mime,moveOutMime:p.move_out_mime});
    }
    // Consent may have been withdrawn while private images were downloading.
    const ready=await this.current(job);
    if(!ready||!await this.permitted(this.db,ready)){await this.finish(job,undefined,'condition_processing_disabled');return true;}
    results.push(await this.evaluate(pairs));
   }
   const findings=results.flatMap(r=>r.result.findings),limitations=results.flatMap(r=>r.result.limitations);
   if(unmatched)limitations.push(`${unmatched} move-out photograph(s) have no matched baseline and were not analyzed. Inspect them manually.`);
   const limited=unmatched>0||results.some(r=>r.result.comparisonStatus!=='compared');
   const allInsufficient=results.every(r=>r.result.comparisonStatus==='insufficient_evidence');
   const evaluated:Evaluation={...results[0],runtime_ms:Math.round(performance.now()-started),
    result:{comparisonStatus:allInsufficient?'insufficient_evidence':limited?'limited':'compared',
     summary:results.length===1?results[0].result.summary:allInsufficient?'The photographs could not be compared reliably. Physical inspection is required.':`${findings.length} observation(s) suggested for human inspection.${limited?' Some photographs have comparison limitations.':''}`,
     findings,limitations},raw_response:results.map(r=>r.raw_response),usage:results.map(r=>r.usage)};
   await this.finish(job,evaluated);
  } catch(error) {await this.finish(job,undefined,failureCode(error));}
  return true;
 }
 start() {
  let stopped=false;let timer:ReturnType<typeof setTimeout>|undefined;
  const tick=async()=>{try{await this.processOne();}catch{console.error('Condition worker could not reach its job store');}
   if(!stopped){timer=setTimeout(tick,3000);timer.unref();}};
  void tick();return()=>{stopped=true;if(timer)clearTimeout(timer);};
 }
}
export const conditionAiJobs=new ConditionAiJobs();
export const startConditionWorker=()=>conditionAiJobs.start();
