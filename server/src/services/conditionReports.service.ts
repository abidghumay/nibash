import { createHash, randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { AppError } from "../errors/AppError.js";
import { normalizeConditionImage } from "./conditionImages.js";
import { conditionStorage, type ConditionStorage } from "./conditionStorage.service.js";

interface Queryable { query(sql:string,params?:any[]):Promise<{rows:any[]}> }
interface Database extends Queryable { connect():Promise<Queryable & {release():void}> }

function canonical(value:unknown):string {
  if(value===null || typeof value!=="object") return JSON.stringify(value);
  if(Array.isArray(value)) return "["+value.map(canonical).join(",")+"]";
  const obj=value as Record<string,unknown>;
  return "{"+Object.keys(obj).sort().map(key=>JSON.stringify(key)+":"+canonical(obj[key])).join(",")+"}";
}
export function conditionSnapshotHash(snapshot:unknown) {
  return createHash("sha256").update(canonical(snapshot)).digest("hex");
}
function cleanFilename(name:string) {
  return name.normalize("NFC").replace(/[\\/\x00-\x1f\x7f]/g,"_").slice(0,200)||"photograph";
}

export class ConditionReports {
  constructor(private db:Database=pool,private storage:ConditionStorage=conditionStorage) {}
  private async context(db:Queryable,user:number,contract:number,lock=false) {
    if(lock) {
      // Separate statements give READ COMMITTED a fresh snapshot after a closure/renewal lock wait.
      const locked=await db.query(`SELECT root.id FROM contracts asked
        JOIN contracts root ON root.id=coalesce(asked.root_contract_id,asked.id)
        JOIN listings l ON l.id=asked.listing_id
        WHERE asked.id=$1 AND (asked.tenant_id=$2 OR l.owner_id=$2) FOR UPDATE OF root`,[contract,user]);
      if(!locked.rows.length) throw new AppError(403,"Not authorized for this condition report");
    }
    const row=(await db.query(`SELECT root.*,l.owner_id,asked.status AS requested_status,
      asked.occupancy_state AS requested_occupancy,(now() AT TIME ZONE 'Asia/Dhaka')::date::text AS today,
      EXISTS(SELECT 1 FROM contracts active WHERE coalesce(active.root_contract_id,active.id)=root.id
        AND active.status='signed' AND active.occupancy_state<>'closed') AS eligible
      FROM contracts asked JOIN contracts root ON root.id=coalesce(asked.root_contract_id,asked.id)
      JOIN listings l ON l.id=asked.listing_id
      WHERE asked.id=$1 AND (asked.tenant_id=$2 OR l.owner_id=$2)`,[contract,user])).rows[0];
    if(!row) throw new AppError(403,"Not authorized for this condition report");
    const existing=(await db.query("SELECT owner_id,tenant_id FROM condition_reports WHERE contract_id=$1",[row.id])).rows[0];
    if(existing && ![existing.owner_id,existing.tenant_id].includes(user)) throw new AppError(403,"Not authorized for this recorded snapshot");
    return row;
  }
  async authorize(user:number,contract:number) { await this.context(this.db,user,contract); }
  private async transaction<T>(user:number,contract:number,work:(db:Queryable,c:any)=>Promise<T>) {
    const db=await this.db.connect();
    try {
      await db.query("BEGIN");
      const c=await this.context(db,user,contract,true);
      const result=await work(db,c);
      await db.query("COMMIT");
      return result;
    } catch(error) { try {await db.query("ROLLBACK");} catch {/* Preserve the original error on connection loss. */} throw error; }
    finally {db.release();}
  }
  private async locked(db:Queryable,c:any,version:number,editable=true) {
    const r=(await db.query("SELECT * FROM condition_reports WHERE contract_id=$1 FOR UPDATE",[c.id])).rows[0];
    if(!r) throw new AppError(404,"No baseline report exists; create a current condition record first");
    if(r.version!==version) throw new AppError(409,"Report changed. Reload and review the latest version");
    if(editable && r.status==="confirmed") throw new AppError(409,"Confirmed baseline is locked");
    if(editable && !c.eligible) throw new AppError(409,"Only an accepted, physically open tenancy can be edited");
    return r;
  }
  private async event(db:Queryable,r:any,user:number,action:string,details:unknown={}) {
    await db.query("INSERT INTO condition_events(report_id,actor_id,action,version,details) VALUES($1,$2,$3,$4,$5::jsonb)",
      [r.id,user,action,r.version,JSON.stringify(details)]);
  }
  private async revise(db:Queryable,r:any) {
    return (await db.query(`UPDATE condition_reports SET version=version+1,status='draft',
      integrity_hash=NULL,submitted_at=NULL,updated_at=now() WHERE id=$1 RETURNING *`,[r.id])).rows[0];
  }
  private async load(db:Queryable,root:number) {
    const r=(await db.query("SELECT * FROM condition_reports WHERE contract_id=$1",[root])).rows[0];
    if(!r) return null;
    const rooms=(await db.query("SELECT id,name,display_order FROM condition_rooms WHERE report_id=$1 ORDER BY display_order,id",[r.id])).rows;
    const photos=(await db.query(`SELECT id,room_id,original_filename,mime_type,width,height,file_size,sha256,notes,
      uploaded_at,uploaded_by,removed_at FROM condition_photos WHERE report_id=$1 ORDER BY id`,[r.id])).rows;
    const events=(await db.query("SELECT id,actor_id,action,version,created_at,details FROM condition_events WHERE report_id=$1 ORDER BY id",[r.id])).rows;
    const confirmations=events.filter(e=>e.action==="confirmed" && e.version===r.version && e.details.hash===r.integrity_hash);
    const consents=new Map<number,any>();
    for(const e of events) if(e.action==="ai_consent" && e.version===r.version && e.details.hash===r.integrity_hash) consents.set(e.actor_id,e);
    return {...r,rooms,photos:photos.filter(p=>!p.removed_at),archived_photos:photos.filter(p=>p.removed_at),confirmations,ai_consents:[...consents.values()],events};
  }
  // Stable JSON with no storage URLs or paths; photo hashes cover normalized stored bytes.
  private snapshot(r:any) {
    return JSON.parse(JSON.stringify({schema:1,contract_id:r.contract_id,type:r.type,record_kind:r.record_kind,
      version:r.version,recorded_at:r.recorded_at,created_by:r.created_by,owner_id:r.owner_id,tenant_id:r.tenant_id,
      rooms:r.rooms,photos:r.photos}));
  }
  async get(user:number,contract:number) {
    // Keep reads on a single transaction/root lock so version, metadata and events cannot tear across an edit.
    return this.transaction(user,contract,async(db,c)=>({report:await this.load(db,c.id),eligible:c.eligible,
      ai_analysis_enabled:false,missing_baseline_message:"No move-in evidence exists. Manual documentation is available; no before/after comparison is claimed."}));
  }
  async create(user:number,contract:number) {
    return this.transaction(user,contract,async(db,c)=>{
      if(!c.eligible) throw new AppError(409,"An accepted, physically open tenancy is required");
      const existing=await this.load(db,c.id);
      if(existing) return {report:existing};
      const start=c.start_date instanceof Date?c.start_date.toISOString().slice(0,10):String(c.start_date);
      const r=(await db.query(`INSERT INTO condition_reports(contract_id,record_kind,created_by,owner_id,tenant_id)
        VALUES($1,$2,$3,$4,$5) RETURNING *`,[c.id,start<c.today?"current_condition":"move_in",user,c.owner_id,c.tenant_id])).rows[0];
      await this.event(db,r,user,"created",{limitation:"Recording date is actual; photographs do not prove authenticity or original move-in condition."});
      return {report:await this.load(db,c.id)};
    });
  }
  async addRoom(user:number,contract:number,version:number,name:string) {
    return this.transaction(user,contract,async(db,c)=>{
      let r=await this.locked(db,c,version);
      const count=Number((await db.query("SELECT count(*)::int AS n FROM condition_rooms WHERE report_id=$1",[r.id])).rows[0].n);
      if(count>=20) throw new AppError(400,"Maximum 20 rooms per report");
      r=await this.revise(db,r);
      const room=(await db.query("INSERT INTO condition_rooms(report_id,name,display_order) VALUES($1,$2,$3) RETURNING id",[r.id,name,count])).rows[0];
      await this.event(db,r,user,"room_added",{room_id:room.id,name});
      return {report:await this.load(db,c.id)};
    });
  }
  async addPhoto(user:number,contract:number,version:number,room:number,bytes:Buffer,filename:string,mime:string,notes:string) {
    let uploaded:string|undefined;
    try {
      return await this.transaction(user,contract,async(db,c)=>{
        let r=await this.locked(db,c,version);
        if(!(await db.query("SELECT id FROM condition_rooms WHERE id=$1 AND report_id=$2",[room,r.id])).rows.length) throw new AppError(404,"Room does not belong to this report");
        if(Number((await db.query("SELECT count(*)::int AS n FROM condition_photos WHERE report_id=$1",[r.id])).rows[0].n)>=100)
          throw new AppError(400,"Maximum 100 photographs including archived evidence");
        const image=await normalizeConditionImage(bytes,mime);
        const path=`conditions/${r.id}/${randomUUID()}.${image.extension}`;
        await this.storage.put(path,image.buffer,image.mimeType); uploaded=path;
        r=await this.revise(db,r);
        const p=(await db.query(`INSERT INTO condition_photos(report_id,room_id,storage_path,original_filename,mime_type,
          width,height,file_size,sha256,notes,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [r.id,room,path,cleanFilename(filename),image.mimeType,image.width,image.height,image.fileSize,image.sha256,notes,user])).rows[0];
        await this.event(db,r,user,"photo_added",{photo_id:p.id,sha256:image.sha256});
        return {report:await this.load(db,c.id)};
      });
    } catch(error) {
      // COMMIT may succeed even when its acknowledgement is lost. Check the committed reference
      // through the pool after release; on uncertainty retain the object for reconciliation.
      if(uploaded) try {
        const reference=await this.db.query("SELECT id FROM condition_photos WHERE storage_path=$1",[uploaded]);
        if(!reference.rows.length) await this.storage.remove(uploaded);
      } catch {console.error("Condition upload cleanup requires storage reconciliation");}
      throw error;
    }
  }
  async updatePhoto(user:number,contract:number,version:number,photo:number,notes:string) {
    return this.changePhoto(user,contract,version,photo,notes);
  }
  async removePhoto(user:number,contract:number,version:number,photo:number) {
    return this.changePhoto(user,contract,version,photo);
  }
  private async changePhoto(user:number,contract:number,version:number,photo:number,notes?:string) {
    return this.transaction(user,contract,async(db,c)=>{
      let r=await this.locked(db,c,version);
      const p=(await db.query("SELECT id,notes FROM condition_photos WHERE id=$1 AND report_id=$2 AND removed_at IS NULL",[photo,r.id])).rows[0];
      if(!p) throw new AppError(404,"Photo does not belong to this active report");
      r=await this.revise(db,r);
      if(notes===undefined) await db.query("UPDATE condition_photos SET removed_at=now() WHERE id=$1",[photo]);
      else await db.query("UPDATE condition_photos SET notes=$2 WHERE id=$1",[photo,notes]);
      await this.event(db,r,user,notes===undefined?"photo_removed":"photo_updated",{photo_id:photo,previous_notes:p.notes,...(notes===undefined?{}:{notes})});
      return {report:await this.load(db,c.id)};
    });
  }
  async submit(user:number,contract:number,version:number) {
    return this.transaction(user,contract,async(db,c)=>{
      const r=await this.locked(db,c,version);
      if(r.status!=="draft") throw new AppError(409,"Report is already submitted; review this snapshot");
      const full=await this.load(db,c.id);
      if(!full.rooms.length || full.rooms.some((room:any)=>!full.photos.some((p:any)=>p.room_id===room.id)))
        throw new AppError(400,"Add at least one photograph to every room before submitting");
      const snapshot=this.snapshot(full), hash=conditionSnapshotHash(snapshot);
      await db.query("UPDATE condition_reports SET status='submitted',submitted_at=now(),integrity_hash=$2,updated_at=now() WHERE id=$1",[r.id,hash]);
      await this.event(db,r,user,"submitted",{hash,snapshot});
      for(const recipient of [r.owner_id,r.tenant_id]) await db.query(`INSERT INTO notifications(user_id,contract_id,kind,title,body,event_key)
        VALUES($1,$2,'condition_report','Condition report ready for review','Review the submitted photographs and confirm this version in your contract page.',$3)
        ON CONFLICT(user_id,event_key) DO NOTHING`,[recipient,c.id,`condition:${r.id}:${r.version}:submitted`]);
      return {report:await this.load(db,c.id)};
    });
  }
  async confirm(user:number,contract:number,version:number,hash:string) {
    return this.transaction(user,contract,async(db,c)=>{
      const r=await this.locked(db,c,version,false);
      if(r.status==="draft" || r.integrity_hash!==hash) throw new AppError(409,"Review the exact submitted snapshot and hash before confirming");
      const full=await this.load(db,c.id);
      if(conditionSnapshotHash(this.snapshot(full))!==hash) throw new AppError(409,"Snapshot integrity check failed; do not confirm");
      if(!full.confirmations.some((e:any)=>e.actor_id===user)) {
        if(r.status==="confirmed") throw new AppError(409,"Confirmed baseline is locked");
        await this.event(db,r,user,"confirmed",{hash});
        if(full.confirmations.length===1) {
          await db.query("UPDATE condition_reports SET status='confirmed',locked_at=now(),updated_at=now() WHERE id=$1",[r.id]);
          for(const recipient of [r.owner_id,r.tenant_id]) await db.query(`INSERT INTO notifications(user_id,contract_id,kind,title,body,event_key)
            VALUES($1,$2,'condition_report','Condition baseline confirmed','Both parties confirmed the same version. The baseline is now locked.',$3)
            ON CONFLICT(user_id,event_key) DO NOTHING`,[recipient,c.id,`condition:${r.id}:${r.version}:locked`]);
        }
      }
      return {report:await this.load(db,c.id)};
    });
  }
  async consent(user:number,contract:number,version:number,hash:string,granted:boolean) {
    return this.transaction(user,contract,async(db,c)=>{
      const r=await this.locked(db,c,version,false);
      if(r.status==="draft" || r.integrity_hash!==hash) throw new AppError(409,"AI consent must reference the exact submitted snapshot");
      await this.event(db,r,user,"ai_consent",{hash,granted,disclosure_version:"condition-ai-v1",
        scope:"Possible visible changes only; no liability decisions. No training or marketing reuse. Production analysis is disabled pending provider safeguards."});
      return {report:await this.load(db,c.id)};
    });
  }
  async photoUrl(user:number,contract:number,photo:number) {
    return this.transaction(user,contract,async(db,c)=>{
      const p=(await db.query(`SELECT p.storage_path FROM condition_photos p JOIN condition_reports r ON r.id=p.report_id
        WHERE r.contract_id=$1 AND p.id=$2`,[c.id,photo])).rows[0];
      if(!p) throw new AppError(404,"Photo does not belong to this contract");
      return {url:await this.storage.sign(p.storage_path),expires_in:120};
    });
  }
}
export const conditionReports=new ConditionReports();
