import {useCallback,useEffect,useRef,useState} from "react";
import type {FormEvent} from "react";
import {apiClient} from "../api/client";
import {conditionPhotoUrl} from "../api/conditionReports";
import type {ConditionPhoto} from "../api/conditionReports";
import {moveOutEndpoint,moveOutPhotoUrl} from "../api/moveOutInspections";
import type {MoveOutFinding,MoveOutResponse,MoveOutReview,ReviewDecision} from "../api/moveOutInspections";
import "../styles/rental-management.css";
import "../styles/condition-report.css";
import "../styles/move-out-inspection.css";

const recorded=(value:string)=>new Date(value).toLocaleString("en-BD",{timeZone:"Asia/Dhaka",dateStyle:"medium",timeStyle:"short"});
const statusLabel={awaiting_photos:"Collecting move-out photographs",analysis_pending:"AI analysis in progress",awaiting_inspection:"Ready for physical inspection",needs_review:"Further human review required",approved:"Landlord approved · awaiting tenant vacancy confirmation",completed:"Move-out completed"};
const decisions:{value:ReviewDecision;label:string}[]=[{value:"no_issue",label:"No issue found"},{value:"acceptable",label:"Acceptable condition / ordinary wear"},{value:"confirmed_difference",label:"Difference confirmed, further review needed"},{value:"unable_to_verify",label:"Unable to verify"}];

function PrivatePhoto({contractId,photo,baseline=false,baselineLabel="Confirmed move-in evidence"}:{contractId:string;photo:ConditionPhoto;baseline?:boolean;baselineLabel?:string}) {
 const [url,setUrl]=useState(""),[error,setError]=useState(""),[retry,setRetry]=useState(0);
 useEffect(()=>{let active=true;setUrl("");setError("");
  const request=baseline?conditionPhotoUrl(contractId,photo.id,retry>0):moveOutPhotoUrl(contractId,photo.id);
  request.then(result=>{if(active)setUrl(result.url);}).catch(()=>{if(active)setError("Private photograph unavailable. Refresh access to try again.");});
  return()=>{active=false;};
 },[contractId,photo.id,baseline,retry]);
 return <figure className="condition-preview"><figcaption><strong>{baseline?baselineLabel:"Move-out evidence"}</strong><br/>{photo.original_filename}</figcaption>
  {url&&!error?<a href={url} target="_blank" rel="noreferrer"><img src={url} width={photo.width} height={photo.height} alt={photo.notes||photo.original_filename} loading="lazy" referrerPolicy="no-referrer" onError={()=>setError("Photograph access expired. Refresh access to try again.")}/><span>Open original photograph</span></a>:<p role="status">{error||"Loading private photograph…"}</p>}
  {error&&<button className="rental-button" type="button" onClick={()=>setRetry(value=>value+1)}>Refresh photo access</button>}
  <p className="condition-help">Uploaded {recorded(photo.uploaded_at)} (Bangladesh time)</p>{photo.notes&&<p>{photo.notes}</p>}
  <details><summary>Evidence integrity details</summary><p>{photo.width} × {photo.height} · {Math.ceil(photo.file_size/1024)} KiB</p><code>{photo.sha256}</code></details>
 </figure>;
}
function FindingReview({finding,review,owner,busy,onSave}:{finding:MoveOutFinding;review?:MoveOutReview;owner:boolean;busy:boolean;onSave:(decision:ReviewDecision,notes:string)=>void}) {
 const [decision,setDecision]=useState<ReviewDecision|"">(review?.decision||""),[notes,setNotes]=useState(review?.notes||"");
 useEffect(()=>{setDecision(review?.decision||"");setNotes(review?.notes||"");},[review?.decision,review?.notes]);
 return <article className="move-out-finding"><p className="condition-eyebrow">AI observation · {finding.category.replaceAll("_"," ")}</p>
  <h4>{finding.description}</h4>{finding.locationHint&&<p>Check: {finding.locationHint}</p>}{finding.visualEvidence&&<p className="condition-help">Visible evidence: {finding.visualEvidence}</p>}
  <p>Human review: {review?decisions.find(item=>item.value===review.decision)?.label:"Not yet reviewed"}</p>
  {owner?<><label>Physical inspection decision<select data-finding-decision value={decision} disabled={busy} onChange={event=>setDecision(event.target.value as ReviewDecision)}><option value="">Choose a decision</option>{decisions.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
   <label>Landlord inspection notes<textarea value={notes} maxLength={1000} disabled={busy} onChange={event=>setNotes(event.target.value)}/></label>
   <button type="button" className="rental-button" disabled={busy||!decision} onClick={()=>decision&&onSave(decision,notes)}>Save review</button></>:review?.notes&&<p>Landlord notes: {review.notes}</p>}
 </article>;
}

export function MoveOutInspectionPanel({contractId,userId,propertyName,onCompleted}:{contractId:string;userId:number;propertyName?:string;onCompleted?:()=>void}) {
 const endpoint=moveOutEndpoint(contractId);
 const [data,setData]=useState<MoveOutResponse|null>(null),[error,setError]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
 const [roomName,setRoomName]=useState(""),[roomId,setRoomId]=useState(""),[baselineId,setBaselineId]=useState(""),[file,setFile]=useState<File|null>(null),[notes,setNotes]=useState("");
 const [consent,setConsent]=useState(false),[accepted,setAccepted]=useState(false),[vacancyConfirmed,setVacancyConfirmed]=useState(false),[moveOutDate,setMoveOutDate]=useState("");
 const [observation,setObservation]=useState(""),[observationReview,setObservationReview]=useState(false),[resolution,setResolution]=useState("");
 const fileInput=useRef<HTMLInputElement>(null);
 const reload=useCallback(async()=>{try{const value=await apiClient.get<MoveOutResponse>(endpoint);setData(value);setError("");}catch(err){setError(err instanceof Error?err.message:"Unable to load inspection");}},[endpoint]);
 useEffect(()=>{let active=true;setData(null);setError("");setRoomId("");setFile(null);
  apiClient.get<MoveOutResponse>(endpoint).then(value=>{if(active)setData(value);}).catch(err=>{if(active)setError(err.message);});
  return()=>{active=false;};
 },[endpoint]);
 const inspection=data?.inspection,baseline=data?.baseline;
 const priorConditionBaseline=baseline?.record_kind==="current_condition";
 const baselineLabel=priorConditionBaseline?"Confirmed prior condition evidence":"Confirmed move-in evidence";
 useEffect(()=>{setAccepted(false);setConsent(false);setVacancyConfirmed(false);setObservationReview(false);},[inspection?.version,inspection?.input_hash,inspection?.status,contractId]);
 useEffect(()=>{if(inspection?.move_out_date)setMoveOutDate(inspection.move_out_date.slice(0,10));},[inspection?.move_out_date]);
 useEffect(()=>{if(inspection?.status!=="analysis_pending")return;const timer=setInterval(()=>void reload(),5000);return()=>clearInterval(timer);},[inspection?.status,reload]);
 async function action(path:string,body:unknown,success:string) {
  setBusy(true);setError("");setMessage("");
  try{const result=await apiClient.post<MoveOutResponse>(endpoint+path,body);setData(current=>({...current!,...result}));setMessage(success);if(result.inspection?.status==="completed"&&inspection?.status!=="completed")onCompleted?.();return true;}
  catch(err){setError(err instanceof Error?err.message:"Unable to save inspection");return false;}finally{setBusy(false);}
 }
 function cancelSelection(){setFile(null);setNotes("");if(fileInput.current)fileInput.current.value="";}
 async function upload(event:FormEvent){event.preventDefault();if(!inspection||!file||!roomId)return;
  if(!["image/jpeg","image/png"].includes(file.type)){setError("Choose a JPEG or PNG photograph. Convert HEIC first.");return;}
  if(file.size>8*1024*1024){setError("Choose a photograph at most 8 MiB.");return;}
  const form=new FormData();form.set("version",String(inspection.version));form.set("room_id",roomId);form.set("notes",notes);form.set("photo",file);if(baselineId)form.set("baseline_photo_id",baselineId);
  setBusy(true);setError("");setMessage("");try{const result=await apiClient.postForm<MoveOutResponse>(endpoint+"/photos",form);setData(result);cancelSelection();setMessage("Private move-out photograph saved. Review the matching baseline before submission.");}catch(err){setError(err instanceof Error?err.message:"Photograph upload failed");}finally{setBusy(false);}
 }
 if(!data)return <section className="rental-management rental-card condition-report" aria-label="Move-out inspection"><h2>Move-out inspection</h2>{error?<><p role="alert">{error}</p><button className="rental-button" type="button" onClick={reload}>Refresh inspection</button></>:<p role="status">Loading private move-out inspection…</p>}</section>;
 const owner=inspection?.owner_id===userId,tenant=inspection?.tenant_id===userId,completed=inspection?.status==="completed",approved=inspection?.status==="approved";
 const editable=!!inspection&&data.eligible&&!completed&&!approved;
 const reviewable=!!inspection&&["awaiting_inspection","needs_review"].includes(inspection.status);
 const canCompare=!!baseline?.photos.length&&!!inspection?.photos.some(photo=>photo.baseline_photo_id);
 const outstanding=inspection?.findings.filter(finding=>!inspection.reviews.some(review=>review.finding_id===finding.id)).length||0;
 const flagged=inspection?.reviews.some(review=>review.decision==="confirmed_difference"&&!review.resolved);
 const myConsent=inspection?.ai_consents?.find(event=>event.actor_id===userId)?.details.granted===true;
 const matchingBaseline=baseline?.photos.filter(photo=>photo.room_id===inspection?.rooms.find(room=>String(room.id)===roomId)?.baseline_room_id)||[];
 const dateValid=/^\d{4}-\d{2}-\d{2}$/.test(moveOutDate);
 return <section id="move-out-inspection" className="rental-management rental-card condition-report move-out-inspection" aria-label="Move-out inspection" aria-busy={busy}>
  <div className="condition-heading"><div><p className="condition-eyebrow">Shared evidence · human decision</p><h2>Move-out inspection</h2>{propertyName&&<p>{propertyName}</p>}</div><button className="rental-button" type="button" disabled={busy} onClick={reload}>Refresh inspection</button></div>
  <p>Compare the recorded evidence, inspect the property, and record the landlord's decision. AI observations may be wrong and do not determine responsibility, repair costs or deposit deductions.</p>
  {error&&<p className="condition-alert" role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
  {!baseline?.photos.length&&<div className="condition-notice"><strong>No comparable baseline available</strong><p>Document the current condition for manual inspection. These photographs cannot establish the original move-in condition.</p></div>}
  {priorConditionBaseline&&<p className="condition-notice">This confirmed prior condition record was recorded later and does not establish the property's original move-in condition. Comparison refers only to the condition recorded on that later date.</p>}
  {!inspection?<><p>Starting an inspection preserves the confirmed baseline and keeps the tenancy open until physical vacancy and landlord approval are recorded.</p><button type="button" className="rental-button primary" disabled={busy||!data.eligible} onClick={()=>action("",{},"Move-out inspection started. Both parties can view the evidence.")}>Start move-out inspection</button>{!data.eligible&&<p>An accepted, physically open tenancy is required.</p>}</>:<>
   <div className="condition-state"><strong>{statusLabel[inspection.status]}</strong><span>Version {inspection.version}</span><span>Started {recorded(inspection.created_at)}</span></div>
   <p className="condition-help">Landlord #{inspection.owner_id} · Tenant #{inspection.tenant_id} · All recording times shown in Bangladesh time.</p>
   {inspection.analysis_result&&<div className="condition-notice"><h3>{inspection.analysis_source==="manual"?"Manual inspection":`AI comparison · ${inspection.analysis_result.comparisonStatus.replaceAll("_"," ")}`}</h3><p>{inspection.analysis_result.summary}</p>{inspection.analysis_result.limitations.map((limitation,index)=><p key={index}>Limitation: {limitation}</p>)}<p>These observations require human inspection. Location guidance is textual; image regions are not verified.</p></div>}
   {(inspection.analysis_error||data.analysis_blocked_reason)&&<p className="condition-notice">{inspection.analysis_error||data.analysis_blocked_reason} You can continue with documented manual inspection.</p>}
   {inspection.status==="analysis_pending"&&<p role="status">Photographs are queued for private AI processing. This view checks for results every five seconds. Manual inspection remains available.</p>}
   <div className="condition-rooms">{inspection.rooms.map(room=><section className="condition-room" key={room.id}><h3>{room.name}</h3>
    {inspection.photos.filter(photo=>photo.room_id===room.id).map(photo=>{const before=baseline?.photos.find(item=>item.id===photo.baseline_photo_id);return <article className="move-out-evidence" key={photo.id}><div className="move-out-pair">{before?<PrivatePhoto contractId={String(baseline!.contract_id)} photo={before} baseline baselineLabel={baselineLabel}/>:<div className="condition-preview"><p>No matching baseline selected. This photograph is manual evidence.</p></div>}<PrivatePhoto contractId={contractId} photo={photo}/></div>
     {editable&&photo.uploaded_by===userId&&<button type="button" className="rental-button" disabled={busy} onClick={()=>action(`/photos/${photo.id}/remove`,{version:inspection.version},"Photograph removed from the current version; original evidence retained. Upload a replacement to retake.")}>Retake / remove from current version</button>}
     {inspection.findings.filter(finding=>finding.moveOutPhotoId===photo.id).map(finding=><FindingReview key={finding.id+":"+inspection.version} finding={finding} review={inspection.reviews.find(review=>review.finding_id===finding.id)} owner={owner&&reviewable} busy={busy} onSave={(decision,reviewNotes)=>action("/reviews",{version:inspection.version,finding_id:finding.id,decision,notes:reviewNotes},"Human review saved separately from the AI observation.")}/>)}</article>;})}
    {!inspection.photos.some(photo=>photo.room_id===room.id)&&<><p>No move-out photograph yet. Use the original viewpoint where possible.</p><div className="condition-photos">{baseline?.photos.filter(photo=>photo.room_id===room.baseline_room_id).map(photo=><PrivatePhoto key={photo.id} contractId={String(baseline!.contract_id)} photo={photo} baseline baselineLabel={baselineLabel}/>)}</div></>}
   </section>)}</div>
   {editable&&<div className="condition-editors"><form onSubmit={async event=>{event.preventDefault();if(await action("/rooms",{version:inspection.version,name:roomName},"Inspection area added."))setRoomName("");}}><h3>Add an inspection area</h3><label>Room name<input required maxLength={80} value={roomName} disabled={busy} onChange={event=>setRoomName(event.target.value)}/></label><button className="rental-button" disabled={busy||!roomName.trim()}>Add room</button></form>
    <form onSubmit={upload}><h3>Add a private move-out photograph</h3><label>Room<select required value={roomId} disabled={busy} onChange={event=>{setRoomId(event.target.value);setBaselineId("");}}><option value="">Choose a room</option>{inspection.rooms.map(room=><option value={room.id} key={room.id}>{room.name}</option>)}</select></label>
     <label>{priorConditionBaseline?"Corresponding prior condition photograph":"Corresponding move-in photograph"}<select value={baselineId} disabled={busy||!roomId} onChange={event=>setBaselineId(event.target.value)}><option value="">No comparable photograph (manual evidence)</option>{matchingBaseline.map(photo=><option value={photo.id} key={photo.id}>{photo.original_filename} · {photo.notes||"No notes"}</option>)}</select></label>
     {baselineId&&matchingBaseline.find(photo=>String(photo.id)===baselineId)&&<PrivatePhoto contractId={String(baseline!.contract_id)} photo={matchingBaseline.find(photo=>String(photo.id)===baselineId)!} baseline baselineLabel={baselineLabel}/>}
     <label>JPEG or PNG photograph<input ref={fileInput} type="file" accept="image/jpeg,image/png" disabled={busy} onChange={event=>{setFile(event.target.files?.[0]||null);setError("");}}/></label>
     <p className="condition-help">Choose a file or camera if your mobile browser offers it. One photograph at a time, up to 8 MiB and 24 megapixels. Convert HEIC first. Avoid people, identity documents and unrelated personal details.</p>{file&&<p role="status">Selected: {file.name}. Not uploaded yet.</p>}
     <label>Photograph notes<textarea maxLength={1000} value={notes} disabled={busy} onChange={event=>setNotes(event.target.value)}/></label><div className="condition-actions"><button className="rental-button primary" disabled={busy||!file||!roomId}>Upload photograph</button><button type="button" className="rental-button" disabled={busy} onClick={cancelSelection}>Cancel selection</button></div></form></div>}
   {editable&&<div className="move-out-analysis"><h3>Submit evidence for inspection</h3><p>Submitting fixes an evidence version. Changing photos creates a new version and clears its analysis and reviews.</p>
    {canCompare&&<><p>Optional AI analysis sends the selected private baseline and move-out photos, room labels and notes to Google Gemini. Both parties must permit processing of the frozen baseline and this evidence version. This permission does not authorize training, marketing or future data reuse.</p><label className="condition-check"><input type="checkbox" data-analysis-consent checked={consent} disabled={busy||inspection.status==="analysis_pending"} onChange={event=>setConsent(event.target.checked)}/>I permit external image analysis of this version for visible-change suggestions and confirm that these photographs and notes contain no identity documents or unrelated sensitive personal details.</label>
     <button type="button" className="rental-button primary" disabled={busy||!consent||!data.ai_analysis_enabled||inspection.status==="analysis_pending"} onClick={()=>action("/submit",{version:inspection.version,analyze:true,consent:true},"Evidence submitted. AI runs only after both parties' permissions are recorded.")}>Analyze Condition</button>{!data.ai_analysis_enabled&&<p>AI processing is currently disabled by the operator. Manual review remains available.</p>}
     {inspection.input_hash&&<><p>Your permission for submitted version {inspection.version}: {myConsent?"granted":"not granted"}.</p><div className="condition-actions"><button type="button" className="rental-button" disabled={busy||!consent||myConsent} onClick={()=>action("/ai-consent",{version:inspection.version,hash:inspection.input_hash,granted:true},"Your permission for this evidence version was recorded.")}>Permit submitted evidence analysis</button>{myConsent&&<button type="button" className="rental-button" disabled={busy} onClick={()=>action("/ai-consent",{version:inspection.version,hash:inspection.input_hash,granted:false},"Permission withdrawn for future processing of this version.")}>Withdraw analysis permission</button>}<button type="button" className="rental-button" disabled={busy||!data.ai_analysis_enabled||inspection.status==="analysis_pending"||!myConsent} onClick={()=>action("/analyze",{version:inspection.version},"Analysis requested for the submitted evidence.")}>Analyze submitted evidence</button></div></>}
    </>}
    <button type="button" className="rental-button" disabled={busy||!inspection.photos.length} onClick={()=>action("/submit",{version:inspection.version,analyze:false,consent:false},"Evidence submitted for documented manual inspection.")}>Continue with manual inspection</button>
   </div>}
   {inspection.observations.length>0&&<div className="move-out-observations"><h3>Human observations</h3>{inspection.observations.map((item,index)=><p key={item.id||index}>{item.review_required&&<strong>{item.resolved?"Resolved":"Further review requested"} · </strong>}{item.notes}{item.created_at&&<span className="condition-help"> · {recorded(item.created_at)}</span>}</p>)}</div>}
   {owner&&!completed&&!approved&&<form className="move-out-observations" onSubmit={async event=>{event.preventDefault();if(await action("/observations",{version:inspection.version,notes:observation,requires_review:reviewable&&observationReview},"Human observation recorded in the shared inspection history.")){setObservation("");setObservationReview(false);}}}><h3>Add a human observation</h3><label>Your inspection notes<textarea maxLength={1000} required value={observation} disabled={busy} onChange={event=>setObservation(event.target.value)}/></label><label className="condition-check"><input type="checkbox" data-observation-review checked={observationReview} disabled={busy||!reviewable} onChange={event=>setObservationReview(event.target.checked)}/>This observation requires further review</label><button className="rental-button" disabled={busy||!observation.trim()}>Save observation</button></form>}
   {owner&&inspection.status==="needs_review"&&<form className="condition-notice" onSubmit={async event=>{event.preventDefault();if(await action("/resolve",{version:inspection.version,notes:resolution},"Manual resolution recorded. Review the condition before approval."))setResolution("");}}><h3>Record manual resolution</h3><p>Preserve the disputed observation and record how the condition was resolved. This does not assign monetary liability.</p><label>Resolution notes<textarea required maxLength={1000} value={resolution} disabled={busy} onChange={event=>setResolution(event.target.value)}/></label><button className="rental-button" disabled={busy||!resolution.trim()}>Record resolution</button></form>}
   {!completed&&<div className="condition-confirmation"><h3>Physical vacancy and landlord approval</h3><p>{inspection.tenant_vacated_at?`Tenant recorded physical vacancy on ${inspection.move_out_date?.slice(0,10)}.`:"Tenant physical vacancy has not yet been recorded."}</p><p>Condition acceptance and actual vacancy are recorded separately. Payment history and financial obligations remain separate.</p>
    <label>Actual move-out date<input data-moveout-date type="date" value={moveOutDate} disabled={busy||!!inspection.tenant_vacated_at} onInput={event=>setMoveOutDate(event.currentTarget.value)} onChange={event=>setMoveOutDate(event.target.value)}/></label>
    {tenant&&!inspection.tenant_vacated_at&&<><label className="condition-check"><input type="checkbox" checked={vacancyConfirmed} disabled={busy} onChange={event=>setVacancyConfirmed(event.target.checked)}/>I confirm that I have physically vacated the property on the stated date.</label><button type="button" className="rental-button" disabled={busy||!vacancyConfirmed||!dateValid} onClick={()=>action("/vacancy",{version:inspection.version,move_out_date:moveOutDate},"Your physical vacancy was recorded. Condition approval is a separate landlord decision.")}>Record physical vacancy</button></>}
    {owner&&reviewable&&<><p>{outstanding} outstanding AI {outstanding===1?"finding":"findings"} requiring human review.</p>{flagged&&<p>Confirmed differences require a documented resolution before condition acceptance.</p>}<label className="condition-check"><input type="checkbox" data-moveout-approval checked={accepted} disabled={busy} onChange={event=>setAccepted(event.target.checked)}/>I have reviewed the move-out condition report, inspected the property as necessary, and confirm that the property has been vacated and its condition is accepted for move-out completion.</label>
     <button type="button" className="rental-button primary" disabled={busy||!accepted||!dateValid||outstanding>0||inspection.status==="needs_review"} onClick={()=>action("/approve",{version:inspection.version,vacated:true,accepted:true,move_out_date:moveOutDate},"Landlord approval recorded. Completion requires the tenant's physical vacancy confirmation.")}>Approve Move-Out</button><p className="condition-help">Approval does not automatically settle every legal or financial obligation.</p></>}
    {approved&&<p>Condition accepted {inspection.approved_at&&recorded(inspection.approved_at)}. The tenant can record physical vacancy above to complete the move-out.</p>}
   </div>}
   {completed&&<div className="condition-confirmation"><h3>Move-out completed</h3><p>Landlord condition approval and tenant physical vacancy were recorded. Approved {inspection.approved_at?recorded(inspection.approved_at):"—"} · Move-out date {inspection.move_out_date?.slice(0,10)||"—"}.</p><p>Financial settlement remains separate from this condition report.</p></div>}
   <details className="condition-history"><summary>Inspection and review history ({inspection.events.length} events)</summary><ol>{inspection.events.map(event=><li key={event.id}><strong>{event.action.replaceAll("_"," ")}</strong> · Version {event.version} · {event.actor_id===inspection.owner_id?"Landlord":event.actor_id===inspection.tenant_id?"Tenant":"System"} · {recorded(event.created_at)}{event.details?.notes&&<p>{event.details.notes}</p>}</li>)}</ol></details>
  </>}
  <details className="condition-privacy"><summary>Privacy, evidence and retention</summary><p>Original photos remain in private storage. Only authorized contract parties can request short-lived download links; do not share them. AI observations and human decisions are recorded separately. Hashes help identify platform evidence changes but do not prove the scene is authentic or independently notarized.</p><p>Retention policy: review records for deletion 12 months after confirmed physical closure, subject to a documented dispute hold; abandoned drafts after 90 days. Retention-job and backup-expiry deployment setup is required. Contact the platform operator for deletion or access requests.</p></details>
  {busy&&<p role="status">Saving private inspection record…</p>}
 </section>;
}
