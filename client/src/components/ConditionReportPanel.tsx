import {useCallback,useEffect,useRef,useState} from "react";
import type {FormEvent} from "react";
import {apiClient} from "../api/client";
import {conditionEndpoint,conditionPhotoUrl} from "../api/conditionReports";
import type {ConditionPhoto,ConditionReport,ConditionResponse,ConditionEvent} from "../api/conditionReports";
import "../styles/rental-management.css";
import "../styles/condition-report.css";

const recorded=(date:string)=>new Date(date).toLocaleString("en-BD",{timeZone:"Asia/Dhaka",dateStyle:"medium",timeStyle:"short"});
function PhotoPreview({contractId,photo}:{contractId:string;photo:ConditionPhoto}) {
 const [url,setUrl]=useState(""),[error,setError]=useState(""),[retry,setRetry]=useState(0);
 useEffect(()=>{
  let active=true;setError("");setUrl("");
  conditionPhotoUrl(contractId,photo.id,retry>0).then(value=>{if(active)setUrl(value.url);})
   .catch(()=>{if(active)setError("Private preview unavailable. Try refreshing access.");});
  return()=>{active=false;};
 },[contractId,photo.id,retry]);
 return <div className="condition-preview">
  {url&&!error?<a href={url} target="_blank" rel="noreferrer"><img src={url} alt={photo.notes||photo.original_filename} width={photo.width} height={photo.height}
   loading="lazy" referrerPolicy="no-referrer" onError={()=>setError("Preview access expired or the image is unavailable.")}/><span>Open full photograph</span></a>
   :<p role="status">{error||"Loading private photograph…"}</p>}
  {error&&<button type="button" className="rental-button" onClick={()=>setRetry(x=>x+1)}>Refresh photo access</button>}
 </div>;
}
function SubmittedSnapshot({event,contractId}:{event:ConditionEvent;contractId:string}) {
 const [open,setOpen]=useState(false);
 return <details onToggle={e=>setOpen(e.currentTarget.open)}><summary>Submitted snapshot, version {event.version}</summary>
  {open&&event.details.snapshot&&<><code>{event.details.hash}</code>{event.details.snapshot.rooms.map(room=><div key={room.id}><h4>{room.name}</h4>
   {event.details.snapshot!.photos.filter(p=>p.room_id===room.id).map(photo=><div key={photo.id}><PhotoPreview contractId={contractId} photo={photo}/><p>{photo.notes||"No notes"}</p><code>{photo.sha256}</code></div>)}</div>)}</>}
 </details>;
}
function PhotoNotes({photo,busy,editable,onSave,onRemove}:{photo:ConditionPhoto;busy:boolean;editable:boolean;onSave:(notes:string)=>void;onRemove:()=>void}) {
 const [notes,setNotes]=useState(photo.notes);
 useEffect(()=>setNotes(photo.notes),[photo.notes]);
 return <div className="condition-photo-meta">
  <p className="condition-filename">{photo.original_filename}</p>
  {editable?<><label>Photograph notes<textarea maxLength={1000} value={notes} onChange={event=>setNotes(event.target.value)} disabled={busy}/></label>
   <div className="condition-actions"><button type="button" className="rental-button" disabled={busy||notes===photo.notes} onClick={()=>onSave(notes)}>Save notes</button>
    <button type="button" className="rental-button" disabled={busy} onClick={onRemove}>Remove from this version</button></div></>
   :<p>{photo.notes||"No human notes added."}</p>}
  <details><summary>Image integrity details</summary><p>{photo.width} × {photo.height} · {Math.ceil(photo.file_size/1024)} KiB · Uploaded {recorded(photo.uploaded_at)}</p><code>{photo.sha256}</code></details>
 </div>;
}
export function ConditionReportPanel({contractId,userId}:{contractId:string;userId:number}) {
 const endpoint=conditionEndpoint(contractId);
 const [data,setData]=useState<ConditionResponse|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const [roomName,setRoomName]=useState(""),[roomId,setRoomId]=useState(""),[file,setFile]=useState<File|null>(null),[notes,setNotes]=useState("");
 const [reviewed,setReviewed]=useState(false),[identityFree,setIdentityFree]=useState(false);
 const fileInput=useRef<HTMLInputElement>(null);
 const reload=useCallback(async()=>{
  try{const value=await apiClient.get<ConditionResponse>(endpoint);setData(value);setError("");}
  catch(err){setError(err instanceof Error?err.message:"Unable to load condition records");}
 },[endpoint]);
 useEffect(()=>{let active=true;
  setData(null);setReviewed(false);setFile(null);setRoomId("");
  apiClient.get<ConditionResponse>(endpoint).then(value=>{if(active)setData(value);}).catch(err=>{if(active)setError(err.message);});
  return()=>{active=false;};
 },[endpoint]);
 const report=data?.report;
 useEffect(()=>{setReviewed(false);setIdentityFree(false);},[report?.version,report?.integrity_hash,contractId]);
 async function action(work:()=>Promise<{report:ConditionReport|null}>,success:string) {
  setBusy(true);setError("");setMessage("");
  try {const value=await work();setData(current=>({...current!,report:value.report}));setMessage(success);return true;}
  catch(err){setError(err instanceof Error?err.message:"Request failed");return false;}
  finally{setBusy(false);}
 }
 function cancelSelection(){setFile(null);setNotes("");if(fileInput.current)fileInput.current.value="";}
 async function addRoom(event:FormEvent) {
  event.preventDefault();if(!report)return;
  if(await action(()=>apiClient.post(endpoint+"/rooms",{version:report.version,name:roomName}),"Room added. Review and resubmit after completing changes."))setRoomName("");
 }
 async function upload(event:FormEvent) {
  event.preventDefault();if(!file||!roomId||!report)return;
  if(file.size>8*1024*1024){setError("Choose a photograph at most 8 MiB.");return;}
  const form=new FormData();form.set("version",String(report.version));form.set("room_id",roomId);form.set("notes",notes);form.set("photo",file);
  if(await action(()=>apiClient.postForm(endpoint+"/photos",form),"Private photograph added."))cancelSelection();
 }
 if(!data)return <section className="rental-management rental-card condition-report" aria-label="Property condition record">
  <h2>Property condition record</h2>{error?<><p role="alert">{error}</p><button type="button" className="rental-button" onClick={reload}>Reload latest report</button></>:<p role="status">Loading private condition record…</p>}</section>;
 const editable=!!report&&report.status!=="confirmed"&&data.eligible;
 const myConfirmation=report?.confirmations.some(e=>e.actor_id===userId);
 const consentRecord=report?.ai_consents.find(e=>e.actor_id===userId);
 const myConsent=consentRecord?.details.granted===true&&consentRecord.details.no_identity_documents===true;
 return <section className="rental-management rental-card condition-report" aria-label="Property condition record">
  <div className="condition-heading"><div><p className="condition-eyebrow">Shared property evidence</p><h2>{report?.record_kind==="move_in"?"Move-in condition report":"Current condition record"}</h2></div>
   <button type="button" className="rental-button" disabled={busy} onClick={reload}>Reload latest report</button></div>
  <p>Document visible conditions together. Human inspection determines the outcome; photographs and hashes do not establish authenticity, financial liability or legal certification.</p>
  {error&&<p className="condition-alert" role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
  {!report?<><div className="condition-notice"><strong>No move-in evidence exists.</strong><p>A current condition record shows the actual recording date. It does not prove the original move-in condition. Without a baseline, later move-out documentation must be reviewed manually.</p></div>
   {data.eligible?<button type="button" className="rental-button primary" disabled={busy} onClick={()=>action(()=>apiClient.post(endpoint,{}),"Draft condition record created.")}>Create condition record</button>
    :<p>An accepted, physically open tenancy is required to create a record.</p>}</>
   :<>
    <div className="condition-state"><strong>{report.status==="confirmed"?"Confirmed and locked":report.status==="submitted"?"Submitted for confirmation":"Draft"}</strong>
     <span>Version {report.version}</span><span>Recorded {recorded(report.recorded_at)} (Bangladesh time)</span></div>
    {report.record_kind==="current_condition"&&<p className="condition-notice">This retrospective record does not prove the property's original move-in condition. The recording date above is the actual date this record was started.</p>}
    {editable&&report.status==="submitted"&&<p className="condition-notice">Any photograph, room or note change creates a new draft version and invalidates prior confirmation. Both parties must review and confirm the new submission.</p>}
    <div className="condition-rooms">{report.rooms.map(room=><section className="condition-room" key={room.id}><h3>{room.name}</h3>
     <div className="condition-photos">{report.photos.filter(p=>p.room_id===room.id).map(photo=><article key={photo.id} className="condition-photo">
      <PhotoPreview contractId={contractId} photo={photo}/><PhotoNotes photo={photo} busy={busy} editable={editable}
       onSave={value=>action(()=>apiClient.patch(endpoint+"/photos/"+photo.id,{version:report.version,notes:value}),"Notes saved; previous confirmation invalidated.")}
       onRemove={()=>action(()=>apiClient.post(endpoint+"/photos/"+photo.id+"/remove",{version:report.version}),"Photograph removed from this version; previous evidence retained.")}/></article>)}</div>
     {!report.photos.some(p=>p.room_id===room.id)&&<p>Add a photograph of this room before submitting.</p>}
    </section>)}</div>
    {editable&&<div className="condition-editors">
     <form onSubmit={addRoom}><h3>Add an inspection area</h3><label>Room name<input required maxLength={80} value={roomName} onChange={event=>setRoomName(event.target.value)} placeholder="e.g. Bedroom or kitchen" disabled={busy}/></label>
      <button className="rental-button" disabled={busy||!roomName.trim()}>Add room</button></form>
     <form onSubmit={upload}><h3>Add a private photograph</h3><label>Room<select required value={roomId} disabled={busy||!report.rooms.length} onChange={event=>setRoomId(event.target.value)}>
      <option value="">Choose a room</option>{report.rooms.map(room=><option value={room.id} key={room.id}>{room.name}</option>)}</select></label>
      <label>JPEG or PNG photograph<input ref={fileInput} type="file" accept="image/jpeg,image/png" disabled={busy||!report.rooms.length}
       onChange={event=>{setFile(event.target.files?.[0]??null);setError("");}}/></label>
      <p className="condition-help">One photo at a time, up to 8 MiB and 24 megapixels. On mobile, choose a file or camera if offered. Convert HEIC to JPEG first. Avoid people, identity documents and unrelated personal details.</p>
      {file&&<p role="status">Selected: {file.name} · {Math.ceil(file.size/1024)} KiB. Not uploaded yet.</p>}
      <label>Optional human notes<textarea maxLength={1000} value={notes} onChange={event=>setNotes(event.target.value)} disabled={busy}/></label>
      <div className="condition-actions"><button className="rental-button primary" disabled={busy||!file||!roomId}>Upload photograph</button>
       <button type="button" className="rental-button" disabled={busy} onClick={cancelSelection}>Cancel selection</button></div>
     </form>
    </div>}
    {report.status==="draft"&&editable&&<button type="button" className="rental-button primary" disabled={busy||!report.photos.length}
     onClick={()=>action(()=>apiClient.post(endpoint+"/submit",{version:report.version}),"Snapshot submitted. Both parties must review and confirm this version.")}>Submit for confirmation</button>}
    {report.integrity_hash&&<div className="condition-confirmation"><h3>Review the submitted snapshot</h3><p>Version {report.version} · Submitted {report.submitted_at?recorded(report.submitted_at):"—"}</p>
     <code>{report.integrity_hash}</code>
     <p>{report.confirmations.some(e=>e.actor_id===report.owner_id)?"Landlord confirmed":"Awaiting landlord confirmation"} · {report.confirmations.some(e=>e.actor_id===report.tenant_id)?"Tenant confirmed":"Awaiting tenant confirmation"}</p>
     {report.confirmations.map(e=><p key={e.actor_id}>{e.actor_id===report.owner_id?"Landlord":"Tenant"} confirmation: {recorded(e.created_at)}</p>)}
     {report.status==="submitted"&&!myConfirmation&&<><label className="condition-check"><input type="checkbox" data-review-snapshot checked={reviewed} onChange={event=>setReviewed(event.target.checked)} disabled={busy}/>
      I reviewed every room, photograph and note in version {report.version}, hash {report.integrity_hash.slice(0,12)}.</label>
      <button type="button" className="rental-button primary" disabled={busy||!reviewed} onClick={()=>action(()=>apiClient.post(endpoint+"/confirm",{version:report.version,hash:report.integrity_hash}),"Your confirmation was recorded for this snapshot.")}>Confirm version {report.version}</button></>}
     {report.status==="confirmed"&&<p>Both parties confirmed the same snapshot. Evidence is locked. Recording a disagreement does not establish liability.</p>}
    </div>}
    <details className="condition-history"><summary>Evidence and review history ({report.events.length} events)</summary>
     {report.archived_photos.length>0&&<p>{report.archived_photos.length} earlier photographs retained with their original hashes.</p>}
     <ol>{report.events.map(event=><li key={event.id}><strong>{event.action.replaceAll("_"," ")}</strong> · Version {event.version} · {event.actor_id===report.owner_id?"Landlord":"Tenant"} · {recorded(event.created_at)}
      {event.details.previous_notes!==undefined&&<p>Previous note: {event.details.previous_notes||"(empty)"}</p>}
      {event.details.notes!==undefined&&<p>Updated note: {event.details.notes||"(empty)"}</p>}
      {event.details.snapshot&&<SubmittedSnapshot event={event} contractId={contractId}/>}
     </li>)}</ol>
    </details>
    <details className="condition-privacy"><summary>Privacy and optional AI comparison permission</summary>
     <p>Photos are stored privately for both contract parties. Download links expire after two minutes. Do not share these links. Storage does not authorize model training or marketing.</p>
     <p>Optional move-out comparison sends permitted photos and room notes from this frozen baseline to Google Gemini to suggest visible changes. AI may make mistakes; a person must inspect. Both parties must separately permit baseline and move-out evidence processing. The operator must enable the reviewed provider configuration before analysis can run. This permission does not authorize training, marketing or future data reuse.</p>
     {report.integrity_hash&&<><label className="condition-check"><input type="checkbox" data-ai-evidence-safe checked={identityFree||myConsent} disabled={busy||myConsent} onChange={event=>setIdentityFree(event.target.checked)}/>
      I checked this baseline: its photographs and notes contain no identity documents or unrelated sensitive personal details.</label><label className="condition-check"><input type="checkbox" data-ai-consent checked={myConsent} disabled={busy||(!myConsent&&!identityFree)}
      onChange={event=>{const granted=event.target.checked;void action(()=>apiClient.post(endpoint+"/ai-consent",{version:report.version,hash:report.integrity_hash,granted,...(granted?{no_identity_documents:true}:{})}),granted?"Optional comparison permission recorded for this exact baseline. Move-out permissions and the operator gate are still required.":"Baseline AI permission withdrawn for future processing.");}}/>
      I permit external visible-change analysis of this submitted baseline for move-out comparison. Optional; I can withdraw this permission.</label></>}
     <p>Retention policy: review records for deletion 12 months after confirmed physical closure, subject to a documented dispute hold; abandoned drafts after 90 days. The retention job and backup expiry require deployment setup. Contact the platform operator for a deletion or access request.</p>
    </details>
   </>}
  {busy&&<p role="status">Saving private condition record…</p>}
 </section>;
}
