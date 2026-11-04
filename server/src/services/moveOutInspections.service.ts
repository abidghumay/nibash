import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { AppError } from "../errors/AppError.js";
import { conditionSnapshotHash } from "./conditionReports.service.js";
import { normalizeConditionImage } from "./conditionImages.js";
import { conditionStorage, type ConditionStorage } from "./conditionStorage.service.js";
import { conditionAnalysisEnabled } from "./moveOutVision.js";

interface Queryable {query(sql:string,params?:any[]):Promise<{rows:any[]}>}
interface Database extends Queryable {connect():Promise<Queryable & {release():void}>}
const noBaseline="No confirmed baseline exists. Manual documentation is available; no before/after comparison is claimed.";
const manualResult={comparisonStatus:"insufficient_evidence",summary:"Manual physical inspection is required. No AI comparison has been performed.",findings:[],limitations:["Human inspection and approval remain required."]};
// pg decodes DATE as midnight in the process timezone. Preserve its calendar day,
// rather than converting that midnight to UTC (which is the previous day in Dhaka).
const asDate=(v:any)=>v instanceof Date?`${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,"0")}-${String(v.getDate()).padStart(2,"0")}`:String(v);

export class MoveOutInspections {
  constructor(private db:Database=pool,private storage:ConditionStorage=conditionStorage){}
  private async context(db:Queryable,user:number,contract:number,lock=false){
    if(lock){
      // Renewal proposals lock the listing before the tenancy. Match that order
      // before any operation which could eventually complete/release the listing.
      const listing=await db.query(`SELECT l.id FROM contracts c JOIN listings l ON l.id=c.listing_id
        WHERE c.id=$1 AND (c.tenant_id=$2 OR l.owner_id=$2) FOR UPDATE OF l`,[contract,user]);
      if(!listing.rows.length)throw new AppError(403,"Not authorized for this move-out inspection");
      const locked=await db.query(`SELECT root.id FROM contracts c JOIN contracts root ON root.id=coalesce(c.root_contract_id,c.id)
        JOIN listings l ON l.id=c.listing_id WHERE c.id=$1 AND (c.tenant_id=$2 OR l.owner_id=$2) FOR UPDATE OF root`,[contract,user]);
      if(!locked.rows.length)throw new AppError(403,"Not authorized for this move-out inspection");
    }
    const c=(await db.query(`SELECT c.*,c.start_date::text AS start_date,c.move_out_date::text AS move_out_date,l.owner_id,(now() AT TIME ZONE 'Asia/Dhaka')::date::text today
      FROM contracts c JOIN listings l ON l.id=c.listing_id WHERE c.id=$1 AND (c.tenant_id=$2 OR l.owner_id=$2)`,[contract,user])).rows[0];
    if(!c)throw new AppError(403,"Not authorized for this move-out inspection");
    const r=(await db.query("SELECT owner_id,tenant_id FROM move_out_inspections WHERE contract_id=$1",[contract])).rows[0];
    if(r&&![r.owner_id,r.tenant_id].includes(user))throw new AppError(403,"Not authorized for this recorded inspection");
    const baseline=(await db.query("SELECT owner_id,tenant_id FROM condition_reports WHERE contract_id=$1",[c.root_contract_id??c.id])).rows[0];
    if(baseline&&![baseline.owner_id,baseline.tenant_id].includes(user))throw new AppError(403,"Not authorized for this recorded baseline");
    c.eligible=c.status==="signed"&&c.occupancy_state!=="closed";
    return c;
  }
  async authorize(user:number,contract:number){await this.context(this.db,user,contract);}
  private async transaction<T>(user:number,contract:number,work:(db:Queryable,c:any)=>Promise<T>){
    const db=await this.db.connect();
    try{await db.query("BEGIN");const c=await this.context(db,user,contract,true);const result=await work(db,c);await db.query("COMMIT");return result;}
    catch(error){try{await db.query("ROLLBACK");}catch{}throw error;}finally{db.release();}
  }
  private async locked(db:Queryable,c:any,version:number,editable=true){
    const r=(await db.query("SELECT * FROM move_out_inspections WHERE contract_id=$1 FOR UPDATE",[c.id])).rows[0];
    if(!r)throw new AppError(404,"Start a move-out inspection first");
    if(r.version!==version)throw new AppError(409,"Inspection changed. Reload the latest version");
    if(editable&&(r.status==="completed"||r.status==="approved"))throw new AppError(409,"Approved or completed inspection is locked");
    if(editable&&!c.eligible)throw new AppError(409,"A current signed physically open tenancy is required");
    return r;
  }
  private owner(r:any,user:number){if(user!==r.owner_id)throw new AppError(403,"Only this tenancy's landlord can record physical inspection and approval");}
  private async event(db:Queryable,r:any,user:number,action:string,details:any={}){
    await db.query("INSERT INTO move_out_events(inspection_id,actor_id,action,version,details) VALUES($1,$2,$3,$4,$5::jsonb)",[r.id,user,action,r.version,JSON.stringify(details)]);
  }
  private async notify(db:Queryable,r:any,kind:string,title:string,body:string,recipients=[r.owner_id,r.tenant_id]){
    for(const user of recipients)await db.query(`INSERT INTO notifications(user_id,contract_id,kind,title,body,event_key)
      VALUES($1,$2,'condition_report',$3,$4,$5) ON CONFLICT(user_id,event_key) DO NOTHING`,[user,r.contract_id,title,body,`move-out:${r.id}:${r.version}:${kind}`]);
  }
  private async baseline(db:Queryable,root:number){
    const r=(await db.query("SELECT * FROM condition_reports WHERE contract_id=$1 AND status='confirmed'",[root])).rows[0];
    if(!r)return null;
    const rooms=(await db.query("SELECT id,name,display_order FROM condition_rooms WHERE report_id=$1 ORDER BY display_order,id",[r.id])).rows;
    const photos=(await db.query(`SELECT id,room_id,original_filename,mime_type,width,height,file_size,sha256,notes,uploaded_at,uploaded_by,removed_at
      FROM condition_photos WHERE report_id=$1 AND removed_at IS NULL ORDER BY id`,[r.id])).rows;
    const events=(await db.query("SELECT * FROM condition_events WHERE report_id=$1 ORDER BY id",[r.id])).rows;
    const consents=new Map<number,any>();for(const e of events)if(e.action==="ai_consent"&&e.version===r.version&&e.details.hash===r.integrity_hash)consents.set(e.actor_id,e);
    return {...r,rooms,photos,events,confirmations:events.filter(e=>e.action==="confirmed"&&e.version===r.version),ai_consents:[...consents.values()]};
  }
  private async load(db:Queryable,contract:number){
    const r=(await db.query("SELECT *,move_out_date::text AS move_out_date FROM move_out_inspections WHERE contract_id=$1",[contract])).rows[0];if(!r)return null;
    const rooms=(await db.query("SELECT id,baseline_room_id,name,display_order FROM move_out_rooms WHERE inspection_id=$1 ORDER BY display_order,id",[r.id])).rows;
    const photos=(await db.query(`SELECT id,room_id,baseline_photo_id,original_filename,mime_type,width,height,file_size,sha256,notes,uploaded_at,uploaded_by,removed_at
      FROM move_out_photos WHERE inspection_id=$1 ORDER BY id`,[r.id])).rows;
    const events=(await db.query("SELECT id,actor_id,action,version,details,created_at FROM move_out_events WHERE inspection_id=$1 ORDER BY id",[r.id])).rows;
    const current=events.filter(e=>e.version===r.version),reviews=new Map<string,any>(),consents=new Map<number,any>();
    const resolutionId=current.filter(e=>e.action==="dispute_resolved").at(-1)?.id??0;
    for(const e of current){if(e.action==="finding_reviewed")reviews.set(e.details.finding_id,{...e.details,actor_id:e.actor_id,created_at:e.created_at,resolved:e.id<resolutionId});if(e.action==="ai_consent"&&e.details.hash===r.input_hash)consents.set(e.actor_id,e);}
    return {...r,rooms,photos:photos.filter(p=>!p.removed_at),archived_photos:photos.filter(p=>p.removed_at),events,
      findings:r.analysis_result?.findings??[],reviews:[...reviews.values()],observations:current.filter(e=>e.action==="observation_added").map(e=>({...e.details,actor_id:e.actor_id,created_at:e.created_at,id:e.id,resolved:e.id<resolutionId})),ai_consents:[...consents.values()]};
  }
  private blocked(r:any,baseline:any){
    if(!baseline||!r?.baseline_report_id)return noBaseline;
    if(!conditionAnalysisEnabled())return "External AI image processing is not enabled by the operator. Manual inspection remains available.";
    if(!r.input_hash)return "Submit the photographs before requesting AI analysis.";
    if(![r.owner_id,r.tenant_id].every(id=>baseline.ai_consents.some((e:any)=>e.actor_id===id&&e.details.granted===true&&e.details.no_identity_documents===true&&e.details.disclosure_version==="condition-ai-v2")))return "Both parties must grant AI processing permission and confirm no identity documents for the confirmed baseline.";
    if(![r.owner_id,r.tenant_id].every(id=>r.ai_consents.some((e:any)=>e.actor_id===id&&e.details.granted===true&&e.details.no_identity_documents===true)))return "Both parties must consent to external processing of this exact move-out photograph version and confirm it contains no identity documents.";
    if(!r.photos.some((p:any)=>p.baseline_photo_id))return "Add at least one photograph matched to a confirmed baseline photograph.";
    return null;
  }
  private async response(db:Queryable,c:any){
    const inspection=await this.load(db,c.id),baseline=await this.baseline(db,c.root_contract_id??c.id);
    return {inspection,baseline,eligible:c.eligible,ai_analysis_enabled:conditionAnalysisEnabled(),analysis_blocked_reason:this.blocked(inspection,baseline),missing_baseline_message:noBaseline};
  }
  async get(user:number,contract:number){return this.transaction(user,contract,(db,c)=>this.response(db,c));}
  async create(user:number,contract:number){return this.transaction(user,contract,async(db,c)=>{
    if(await this.load(db,c.id))return this.response(db,c);
    if(!c.eligible)throw new AppError(409,"A current signed physically open tenancy is required");
    if((await db.query("SELECT id FROM contracts WHERE previous_contract_id=$1 AND status IN ('proposed','signed')",[c.id])).rows.length)throw new AppError(409,"Resolve the continuing renewal before move-out");
    const baseline=await this.baseline(db,c.root_contract_id??c.id);
    if(baseline&&![baseline.owner_id,baseline.tenant_id].every(id=>[c.owner_id,c.tenant_id].includes(id)))throw new AppError(403,"The recorded baseline parties do not match this tenancy");
    const r=(await db.query(`INSERT INTO move_out_inspections(contract_id,root_contract_id,created_by,owner_id,tenant_id,baseline_report_id,baseline_version,baseline_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[c.id,c.root_contract_id??c.id,user,c.owner_id,c.tenant_id,baseline?.id??null,baseline?.version??null,baseline?.integrity_hash??null])).rows[0];
    for(const room of baseline?.rooms??[])await db.query("INSERT INTO move_out_rooms(inspection_id,baseline_room_id,name,display_order) VALUES($1,$2,$3,$4)",[r.id,room.id,room.name,room.display_order]);
    await this.event(db,r,user,"created");await this.notify(db,r,"created","Move-out inspection started","Review the baseline and add move-out photographs in the contract inspection page.");return this.response(db,c);
  });}
  private async revise(db:Queryable,r:any){return(await db.query(`UPDATE move_out_inspections SET version=version+1,status='awaiting_photos',input_hash=NULL,analysis_result=NULL,
    analysis_source=NULL,approved_at=NULL,approved_by=NULL,updated_at=now() WHERE id=$1 RETURNING *`,[r.id])).rows[0];}
  async addRoom(user:number,contract:number,version:number,name:string){return this.transaction(user,contract,async(db,c)=>{
    let r=await this.locked(db,c,version);const n=Number((await db.query("SELECT count(*)::int n FROM move_out_rooms WHERE inspection_id=$1",[r.id])).rows[0].n);
    if(n>=20)throw new AppError(400,"Maximum 20 rooms per inspection");r=await this.revise(db,r);
    const room=(await db.query("INSERT INTO move_out_rooms(inspection_id,name,display_order) VALUES($1,$2,$3) RETURNING id",[r.id,name,n])).rows[0];
    await this.event(db,r,user,"room_added",{room_id:room.id,name});return this.response(db,c);
  });}
  async addPhoto(user:number,contract:number,version:number,room:number,bytes:Buffer,filename:string,mime:string,notes:string,baselinePhoto?:number){
    let uploaded:string|undefined;
    try{return await this.transaction(user,contract,async(db,c)=>{
      let r=await this.locked(db,c,version);
      const roomRow=(await db.query("SELECT * FROM move_out_rooms WHERE id=$1 AND inspection_id=$2",[room,r.id])).rows[0];if(!roomRow)throw new AppError(404,"Room does not belong to this inspection");
      if(baselinePhoto&&!(await db.query("SELECT id FROM condition_photos WHERE id=$1 AND report_id=$2 AND room_id=$3 AND removed_at IS NULL",[baselinePhoto,r.baseline_report_id,roomRow.baseline_room_id])).rows.length)throw new AppError(400,"Baseline photograph must belong to this room and confirmed baseline");
      if(Number((await db.query("SELECT count(*)::int n FROM move_out_photos WHERE inspection_id=$1",[r.id])).rows[0].n)>=100)throw new AppError(400,"Maximum 100 photographs including archived evidence");
      const image=await normalizeConditionImage(bytes,mime),path=`conditions/${r.id}/${randomUUID()}.${image.extension}`;
      await this.storage.put(path,image.buffer,image.mimeType);uploaded=path;r=await this.revise(db,r);
      const p=(await db.query(`INSERT INTO move_out_photos(inspection_id,room_id,baseline_photo_id,storage_path,original_filename,mime_type,width,height,file_size,sha256,notes,uploaded_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,[r.id,room,baselinePhoto??null,path,filename.normalize("NFC").replace(/[\\/\x00-\x1f\x7f]/g,"_").slice(0,200)||"photograph",image.mimeType,image.width,image.height,image.fileSize,image.sha256,notes,user])).rows[0];
      await this.event(db,r,user,"photo_added",{photo_id:p.id,sha256:image.sha256});return this.response(db,c);
    });}catch(error){if(uploaded)try{if(!(await this.db.query("SELECT id FROM move_out_photos WHERE storage_path=$1",[uploaded])).rows.length)await this.storage.remove(uploaded);}catch{console.error("Move-out upload cleanup requires storage reconciliation");}throw error;}
  }
  async removePhoto(user:number,contract:number,version:number,photo:number){return this.transaction(user,contract,async(db,c)=>{
    let r=await this.locked(db,c,version);const p=(await db.query("SELECT * FROM move_out_photos WHERE id=$1 AND inspection_id=$2 AND removed_at IS NULL",[photo,r.id])).rows[0];
    if(!p)throw new AppError(404,"Photo does not belong to this inspection");if(p.uploaded_by!==user)throw new AppError(403,"Only the uploader can remove their own photograph; originals remain retained");
    r=await this.revise(db,r);await db.query("UPDATE move_out_photos SET removed_at=now() WHERE id=$1",[photo]);await this.event(db,r,user,"photo_removed",{photo_id:photo});return this.response(db,c);
  });}
  async photoUrl(user:number,contract:number,photo:number){return this.transaction(user,contract,async(db,c)=>{
    const p=(await db.query("SELECT p.storage_path FROM move_out_photos p JOIN move_out_inspections r ON r.id=p.inspection_id WHERE r.contract_id=$1 AND p.id=$2",[c.id,photo])).rows[0];if(!p)throw new AppError(404,"Photo does not belong to this inspection");return {url:await this.storage.sign(p.storage_path),expires_in:120};
  });}
  private async grant(db:Queryable,r:any,user:number,granted:boolean){await this.event(db,r,user,"ai_consent",{hash:r.input_hash,granted,no_identity_documents:granted,disclosure_version:"move-out-ai-v1",scope:"External Gemini processing of these exact property images. I confirm they contain no identity documents. No training or marketing reuse; no liability or cost decisions."});}
  async consent(user:number,contract:number,version:number,hash:string,granted:boolean){return this.transaction(user,contract,async(db,c)=>{
    const r=await this.locked(db,c,version);if(!r.input_hash||r.input_hash!==hash)throw new AppError(409,"Consent must reference the exact submitted photograph hash");await this.grant(db,r,user,granted);
    if(!granted&&r.status==="analysis_pending")await db.query("UPDATE move_out_inspections SET status='awaiting_inspection',updated_at=now() WHERE id=$1",[r.id]);return this.response(db,c);
  });}
  private async enqueue(db:Queryable,c:any,r:any,strict:boolean){
    const full=await this.load(db,c.id),baseline=await this.baseline(db,c.root_contract_id??c.id),reason=this.blocked(full,baseline);
    if(reason){if(strict)throw new AppError(409,reason);return;}
    const existing=(await db.query("SELECT status FROM condition_analysis_jobs WHERE inspection_id=$1 AND input_version=$2",[r.id,r.version])).rows[0];
    if(existing&&!["queued","running"].includes(existing.status))throw new AppError(409,"Analysis already finished or stopped for this version. Continue with manual inspection or edit the evidence before requesting a new analysis.");
    await db.query(`INSERT INTO condition_analysis_jobs(inspection_id,input_version,input_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[r.id,r.version,r.input_hash]);
    await db.query("UPDATE move_out_inspections SET status='analysis_pending',updated_at=now() WHERE id=$1",[r.id]);await this.event(db,r,c.actor,"analysis_requested",{hash:r.input_hash});
  }
  async submit(user:number,contract:number,version:number,analyze:boolean,consent:boolean){return this.transaction(user,contract,async(db,c)=>{
    let r=await this.locked(db,c,version);const full=await this.load(db,c.id);
    if(!full.rooms.length||full.rooms.some((room:any)=>!full.photos.some((p:any)=>p.room_id===room.id)))throw new AppError(400,"Add at least one photograph to every room before submitting");
    if(!r.input_hash){const snapshot=JSON.parse(JSON.stringify({schema:1,inspection_id:r.id,contract_id:r.contract_id,version:r.version,baseline_report_id:r.baseline_report_id,baseline_version:r.baseline_version,baseline_hash:r.baseline_hash,rooms:full.rooms,photos:full.photos}));
      const hash=conditionSnapshotHash(snapshot);r=(await db.query("UPDATE move_out_inspections SET input_hash=$2,status='awaiting_inspection',analysis_source='manual',analysis_result=$3::jsonb,updated_at=now() WHERE id=$1 RETURNING *",[r.id,hash,JSON.stringify(manualResult)])).rows[0];await this.event(db,r,user,"submitted",{hash,snapshot});
    }
    if(consent)await this.grant(db,r,user,true);
    if(analyze){c.actor=user;await this.enqueue(db,c,r,false);}else if(r.status==="analysis_pending"){
      await db.query("UPDATE move_out_inspections SET status='awaiting_inspection',analysis_source='manual',analysis_result=$2::jsonb,updated_at=now() WHERE id=$1",[r.id,JSON.stringify(manualResult)]);await this.event(db,r,user,"manual_inspection_requested");
    }
    await this.notify(db,r,"submitted","Move-out photographs submitted","Review the property evidence and complete the physical inspection. AI processing requires both parties' permission.");return this.response(db,c);
  });}
  async analyze(user:number,contract:number,version:number){return this.transaction(user,contract,async(db,c)=>{
    const r=await this.locked(db,c,version);if(!r.input_hash)throw new AppError(409,"Submit the photographs first");if(r.status==="analysis_pending")return this.response(db,c);
    c.actor=user;await this.enqueue(db,c,r,true);return this.response(db,c);
  });}
  async review(user:number,contract:number,version:number,finding:string,decision:string,notes:string){return this.transaction(user,contract,async(db,c)=>{
    const r=await this.locked(db,c,version);this.owner(r,user);if(!["no_issue","acceptable","confirmed_difference","unable_to_verify"].includes(decision))throw new AppError(400,"Invalid physical review decision");
    const full=await this.load(db,c.id);if(!full.findings.some((f:any)=>f.id===finding))throw new AppError(404,"Finding does not belong to this inspection version");
    await this.event(db,r,user,"finding_reviewed",{finding_id:finding,decision,notes});
    const latest=await this.load(db,c.id),disputed=latest.reviews.some((x:any)=>x.decision==="confirmed_difference"&&!x.resolved)||latest.observations.some((x:any)=>x.review_required&&!x.resolved);
    await db.query("UPDATE move_out_inspections SET status=$2,updated_at=now() WHERE id=$1",[r.id,disputed?"needs_review":"awaiting_inspection"]);
    if(decision==="confirmed_difference")await this.notify(db,r,"disputed","Move-out observation needs review","The landlord recorded an observation requiring further review. Both parties can view the evidence.",[r.tenant_id]);return this.response(db,c);
  });}
  async addObservation(user:number,contract:number,version:number,room:number|undefined,notes:string,requiresReview=false){return this.transaction(user,contract,async(db,c)=>{
    const r=await this.locked(db,c,version);this.owner(r,user);if(room&&!(await db.query("SELECT id FROM move_out_rooms WHERE id=$1 AND inspection_id=$2",[room,r.id])).rows.length)throw new AppError(404,"Room does not belong to this inspection");
    if(requiresReview&&(!r.input_hash||!["awaiting_inspection","needs_review"].includes(r.status)))throw new AppError(409,"Submit photographs and finish or skip analysis before flagging a physical observation");
    await this.event(db,r,user,"observation_added",{room_id:room??null,notes,review_required:requiresReview});
    if(requiresReview){
      await db.query("UPDATE move_out_inspections SET status='needs_review',updated_at=now() WHERE id=$1",[r.id]);
      await this.notify(db,r,"manual_observation_disputed","Human inspection observation needs review","The landlord recorded an observation requiring further review. Open the shared inspection to review the evidence.",[r.tenant_id]);
    }
    return this.response(db,c);
  });}
  async resolve(user:number,contract:number,version:number,notes:string){return this.transaction(user,contract,async(db,c)=>{
    const r=await this.locked(db,c,version);this.owner(r,user);if(r.status!=="needs_review")throw new AppError(409,"No disputed inspection requires resolution");
    await this.event(db,r,user,"dispute_resolved",{notes});await db.query("UPDATE move_out_inspections SET status='awaiting_inspection',updated_at=now() WHERE id=$1",[r.id]);await this.notify(db,r,"resolved","Move-out observation reviewed","A manual resolution was recorded. The original evidence and observations remain available.");return this.response(db,c);
  });}
  private date(c:any,date:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date>c.today||date<asDate(c.start_date))throw new AppError(400,"Confirm an actual move-out date within the tenancy and not in the future");}
  private async finalize(db:Queryable,c:any,r:any,user:number){
    if(!r.approved_at||!r.tenant_vacated_at)return;
    if(!c.eligible)throw new AppError(409,"Only the current signed physically open contract can complete move-out");
    if((await db.query("SELECT id FROM contracts WHERE previous_contract_id=$1 AND status IN ('proposed','signed')",[c.id])).rows.length)throw new AppError(409,"Resolve the continuing renewal before closure");
    if(c.occupancy_state==="move_out_pending"&&c.move_out_date&&asDate(c.move_out_date)!==asDate(r.move_out_date))throw new AppError(409,"Existing move-out record has a different date");
    await db.query(`UPDATE contracts SET occupancy_state='closed',status='completed',move_out_date=$2,owner_closed_at=$3,tenant_closed_at=$4,
      inspection_note=coalesce(inspection_note,$5),settlement_note=coalesce(settlement_note,$6) WHERE id=$1`,[c.id,asDate(r.move_out_date),r.approved_at,r.tenant_vacated_at,`Physical condition accepted in move-out inspection ${r.id}, version ${r.version}.`,"Physical move-out only. Outstanding financial obligations remain separately recorded; no balance is waived or paid by this confirmation."]);
    await db.query("UPDATE contracts SET occupancy_state='closed' WHERE root_contract_id=$1 AND status='renewed'",[c.root_contract_id??c.id]);
    await db.query("UPDATE move_out_inspections SET status='completed',updated_at=now() WHERE id=$1",[r.id]);await this.event(db,r,user,"completed");
    await db.query("INSERT INTO rental_audit_events(contract_id,actor_id,kind,details) VALUES($1,$2,'move_out_confirmation',$3::jsonb)",[c.id,user,JSON.stringify({inspection_id:r.id,version:r.version,scope:"Physical vacancy and accepted condition; financial obligations remain separately recorded"})]);
    await this.notify(db,r,"completed","Move-out completed","The tenant confirmed vacancy and the landlord accepted the physical condition. Agreements, payments and obligations remain available.");c.eligible=false;
  }
  async vacancy(user:number,contract:number,version:number,date:string){return this.transaction(user,contract,async(db,c)=>{
    let r=await this.locked(db,c,version,false);if(user!==r.tenant_id)throw new AppError(403,"Only this tenant can confirm actual vacancy");if(r.status==="completed")return this.response(db,c);
    if(!c.eligible)throw new AppError(409,"Only the current signed physically open tenancy can record vacancy");
    this.date(c,date);if(r.move_out_date&&asDate(r.move_out_date)!==date)throw new AppError(409,"Both parties must confirm the same move-out date");
    if(c.move_out_date&&asDate(c.move_out_date)!==date)throw new AppError(409,"The existing contract move-out record has a different date");
    if(!r.tenant_vacated_at){
      r=(await db.query("UPDATE move_out_inspections SET tenant_vacated_at=now(),move_out_date=$2,updated_at=now() WHERE id=$1 RETURNING *",[r.id,date])).rows[0];
      // Persist the tenant's declaration independently of landlord condition acceptance.
      // Do not change occupancy_state here: it also controls legacy invoice eligibility.
      await db.query("UPDATE contracts SET tenant_closed_at=coalesce(tenant_closed_at,$2),move_out_date=$3 WHERE id=$1",[c.id,r.tenant_vacated_at,date]);
      await this.event(db,r,user,"tenant_vacated",{move_out_date:date,scope:"Actual physical vacancy; financial obligations remain separately recorded"});
      await this.notify(db,r,"tenant_vacated","Tenant recorded physical vacancy","The tenant's physical vacancy declaration is recorded independently of condition review. Open the contract inspection to review the evidence.",[r.owner_id]);
    }
    await this.finalize(db,c,r,user);return this.response(db,c);
  });}
  async approve(user:number,contract:number,version:number,vacated:boolean,accepted:boolean,date:string){return this.transaction(user,contract,async(db,c)=>{
    let r=await this.locked(db,c,version,false);this.owner(r,user);if(r.status==="completed")return this.response(db,c);
    if(!c.eligible)throw new AppError(409,"Only the current signed physically open tenancy can approve move-out");
    if(!vacated||!accepted)throw new AppError(400,"Explicitly confirm physical inspection, accepted condition and actual vacancy");
    if(!["awaiting_inspection","approved"].includes(r.status))throw new AppError(409,"Resolve analysis and disputed review before approval");
    const full=await this.load(db,c.id);if(full.findings.some((f:any)=>!full.reviews.some((x:any)=>x.finding_id===f.id)))throw new AppError(409,"Review every finding or mark it unable to verify before approval");
    this.date(c,date);if(r.move_out_date&&asDate(r.move_out_date)!==date)throw new AppError(409,"Both parties must confirm the same move-out date");
    if(!r.approved_at){r=(await db.query("UPDATE move_out_inspections SET approved_at=now(),approved_by=$2,move_out_date=$3,status='approved',updated_at=now() WHERE id=$1 RETURNING *",[r.id,user,date])).rows[0];await this.event(db,r,user,"approved",{move_out_date:date,physical_inspection_confirmed:true,condition_accepted:true});await this.notify(db,r,"approved","Landlord accepted move-out condition","The landlord reviewed and accepted the physical condition. Tenant vacancy confirmation is also required.");}
    await this.finalize(db,c,r,user);return this.response(db,c);
  });}
}
export const moveOutInspections=new MoveOutInspections();
