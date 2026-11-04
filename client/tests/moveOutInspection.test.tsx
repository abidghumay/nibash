import assert from "node:assert/strict";
import test from "node:test";
import {JSDOM} from "jsdom";
import {act,createElement} from "react";
import {createServer} from "vite";

const date="2026-11-04T10:00:00Z";
const photo={id:11,room_id:1,original_filename:"move-out.png",mime_type:"image/png",width:800,height:600,file_size:1000,sha256:"a".repeat(64),notes:"Wall",uploaded_at:date,uploaded_by:2,removed_at:null,baseline_photo_id:7};
const finding={id:"finding-1",roomId:1,baselinePhotoId:7,moveOutPhotoId:11,category:"possible_visible_change",description:"Possible mark on the lower wall. Inspect this area.",locationHint:"Lower wall",visualEvidence:"Mark visible in move-out image",reviewRequired:true};
const inspection=()=>({id:1,contract_id:1,root_contract_id:1,version:3,status:"awaiting_inspection",owner_id:1,tenant_id:2,baseline_report_id:8,created_at:date,input_hash:null,rooms:[{id:1,name:"Living room",baseline_room_id:1}],photos:[photo],findings:[finding],reviews:[],observations:[],events:[],ai_consents:[],analysis_result:{comparisonStatus:"compared",summary:"One possible visible change requires human inspection.",findings:[finding],limitations:[]},approved_at:null,tenant_vacated_at:null,move_out_date:null});

test("move-out UI binds physical approval to reviewed evidence version and keeps no-baseline documentation manual",async t=>{
 const dom=new JSDOM('<div id="root"></div>',{url:"http://localhost"});
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 Object.defineProperty(globalThis,"localStorage",{configurable:true,value:dom.window.localStorage});
 const {createRoot}=await import("react-dom/client");
 const previousFetch=globalThis.fetch,calls:{url:string;body:any}[]=[];
 let current:any=inspection(),baseline:any={id:8,contract_id:1,record_kind:"move_in",status:"confirmed",version:2,locked_at:date,rooms:[{id:1,name:"Living room",display_order:0}],photos:[{...photo,id:7,original_filename:"move-in.png"}],events:[],confirmations:[],ai_consents:[],archived_photos:[]};
 let refreshed=0;
 globalThis.fetch=(async(input:any,options?:RequestInit)=>{
  const url=String(input),body=options?.body?JSON.parse(String(options.body)):undefined;calls.push({url,body});
  if(url.endsWith("/url"))return Response.json({url:"https://private.example/image.png",expires_in:120});
  if(url.endsWith("/reviews")){current={...current,reviews:[{finding_id:"finding-1",decision:body.decision,notes:body.notes}]};return Response.json({inspection:current});}
  if(url.endsWith("/approve")){current={...current,status:"completed",approved_at:date};return Response.json({inspection:current});}
  if(url.endsWith("/submit")){current={...current,status:"awaiting_inspection",analysis_source:body.analyze?"gemini":"manual",analysis_result:body.analyze?current.analysis_result:{comparisonStatus:"insufficient_evidence",summary:"Manual physical inspection is required. No AI comparison has been performed.",findings:[],limitations:[]}};return Response.json({inspection:current});}
  if(url.endsWith("/vacancy")){current={...current,status:"completed",tenant_vacated_at:date};return Response.json({inspection:current});}
  if(url.endsWith("/observations")){current={...current,status:body.requires_review?"needs_review":current.status,observations:[{id:41,notes:body.notes,review_required:body.requires_review,actor_id:1,created_at:date}]};return Response.json({inspection:current});}
  if(url.endsWith("/resolve")){current={...current,status:"awaiting_inspection"};return Response.json({inspection:current});}
  return Response.json({inspection:current,baseline,eligible:true,ai_analysis_enabled:true});
 }) as typeof fetch;
 const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:[]}});
 const {MoveOutInspectionPanel}=await vite.ssrLoadModule("/src/components/MoveOutInspectionPanel.tsx");
 const root=createRoot(document.getElementById("root")!);
 t.after(async()=>{await act(async()=>root.unmount());globalThis.fetch=previousFetch;await vite.close();dom.window.close();});
 const button=(label:string)=>Array.from(document.querySelectorAll("button")).find(el=>el.textContent?.includes(label))!;
 await act(async()=>root.render(createElement(MoveOutInspectionPanel,{contractId:"1",userId:1,onCompleted:()=>{refreshed++;}})));
 assert.match(document.body.textContent!,/Possible mark/);
 assert.ok(button("Save observation"),"landlord can record manual inspection observations");
 assert.equal(document.querySelector<HTMLInputElement>('[data-observation-review]')?.checked,false,"a human observation requires further review only by explicit selection");
 assert.equal(document.querySelector<HTMLTextAreaElement>('.move-out-finding textarea')!.maxLength,1000);
 assert.equal(document.querySelectorAll(".move-out-pair img").length,2);
 assert.equal(document.querySelector('.move-out-pair figure figcaption strong')!.textContent,"Confirmed move-in evidence");
 assert.equal(Array.from(document.querySelectorAll("button")).some(el=>el.textContent?.includes("Retake / remove")),false,"landlord cannot remove the tenant's evidence");
 assert.equal(button("Approve Move-Out").disabled,true);
 assert.equal(document.querySelector<HTMLInputElement>("[data-moveout-approval]")!.checked,false);
 const decision=document.querySelector<HTMLSelectElement>("[data-finding-decision]")!;
 await act(async()=>{decision.value="acceptable";decision.dispatchEvent(new dom.window.Event("change",{bubbles:true}));});
 await act(async()=>button("Save review").click());
 assert.deepEqual(calls.find(c=>c.url.endsWith("/reviews"))!.body,{version:3,finding_id:"finding-1",decision:"acceptable",notes:""});
 const humanNotes=document.querySelector<HTMLTextAreaElement>('form.move-out-observations textarea')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,"value")!.set!.call(humanNotes,"Loose fixture found during physical inspection.");humanNotes.dispatchEvent(new dom.window.Event("input",{bubbles:true}));humanNotes.dispatchEvent(new dom.window.Event("change",{bubbles:true}));});
 await act(async()=>document.querySelector<HTMLInputElement>('[data-observation-review]')!.click());
 await act(async()=>button("Save observation").click());
 assert.deepEqual(calls.find(c=>c.url.endsWith("/observations"))!.body,{version:3,notes:"Loose fixture found during physical inspection.",requires_review:true});
 assert.match(document.body.textContent!,/Further review requested/);
 assert.equal(document.querySelector<HTMLInputElement>('[data-observation-review]')!.checked,false,"the checkbox resets after a successful observation");
 assert.equal(document.querySelector<HTMLTextAreaElement>('form.move-out-observations textarea')!.value,"");
 assert.equal(button("Approve Move-Out").disabled,true,"an independent human observation can require resolution before approval");
 current={...current,status:"awaiting_inspection",observations:current.observations.map((item:any)=>({...item,resolved:true})),reviews:current.reviews.map((item:any)=>({...item,decision:"confirmed_difference",resolved:true}))};
 await act(async()=>button("Refresh inspection").click());
 assert.match(document.querySelector('.move-out-observations')!.textContent!,/Resolved/);
 assert.doesNotMatch(document.body.textContent!,/Further review requested|Confirmed differences require a documented resolution/);
 const dateInput=document.querySelector<HTMLInputElement>('[data-moveout-date]')!;
 // Native date controls use change events.
 await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,"value")!.set!.call(dateInput,"2026-11-04");dateInput.dispatchEvent(new dom.window.Event("input",{bubbles:true}));dateInput.dispatchEvent(new dom.window.Event("change",{bubbles:true}));});
 await act(async()=>document.querySelector<HTMLInputElement>("[data-moveout-approval]")!.click());
 assert.equal(button("Approve Move-Out").disabled,false);
 current={...current,version:4};
 await act(async()=>button("Refresh inspection").click());
 assert.equal(button("Approve Move-Out").disabled,true,"approval must be bound to the reviewed version");
 await act(async()=>document.querySelector<HTMLInputElement>("[data-moveout-approval]")!.click());
 await act(async()=>button("Approve Move-Out").click());
 assert.deepEqual(calls.find(c=>c.url.endsWith("/approve"))!.body,{version:4,vacated:true,accepted:true,move_out_date:"2026-11-04"});
 assert.match(document.body.textContent!,/Move-out completed/);assert.equal(refreshed,1);
 current={...inspection(),status:"awaiting_photos",findings:[],analysis_result:null,baseline_report_id:null};baseline=null;
 await act(async()=>button("Refresh inspection").click());
 assert.match(document.body.textContent!,/No comparable baseline available/);
 assert.equal(document.querySelector('[data-analysis-consent]'),null);
 assert.equal(button("Continue with manual inspection").disabled,false);
 const input=document.querySelector<HTMLInputElement>('input[type="file"]')!;
 assert.equal(input.accept,"image/jpeg,image/png");assert.equal(input.hasAttribute("capture"),false);
 assert.equal(document.querySelector<HTMLInputElement>('[data-observation-review]')!.disabled,true,"review escalation starts only after evidence submission");
 await act(async()=>button("Continue with manual inspection").click());
 assert.deepEqual(calls.find(c=>c.url.endsWith("/submit"))!.body,{version:3,analyze:false,consent:false});
 assert.equal(document.querySelector('.condition-notice h3')?.textContent,"Manual inspection");
 // External processing must remain opt-in even with matched photographs.
 current={...inspection(),status:"awaiting_photos"};baseline={id:8,contract_id:1,photos:[{...photo,id:7}],rooms:[{id:1,name:"Living room"}]};
 await act(async()=>button("Refresh inspection").click());
 assert.equal(document.querySelector<HTMLInputElement>('[data-analysis-consent]')!.checked,false);
 assert.equal(button("Analyze Condition").disabled,true);
 await act(async()=>document.querySelector<HTMLInputElement>('[data-analysis-consent]')!.click());
 assert.equal(button("Analyze Condition").disabled,false);
 await act(async()=>button("Analyze Condition").click());
 assert.deepEqual(calls.filter(c=>c.url.endsWith("/submit")).at(-1)!.body,{version:3,analyze:true,consent:true});
 // A confirmed retrospective baseline cannot be presented as move-in evidence.
 baseline={...baseline,record_kind:"current_condition"};current={...inspection(),status:"awaiting_photos"};
 await act(async()=>button("Refresh inspection").click());
 assert.match(document.body.textContent!,/recorded later.*does not establish.*original move-in condition/i);
 assert.equal(document.querySelector('.move-out-pair figure figcaption strong')!.textContent,"Confirmed prior condition evidence");
 assert.doesNotMatch(document.querySelector('#move-out-inspection')!.textContent!,/Confirmed move-in evidence/);
 current={...current,photos:[]};
 await act(async()=>button("Refresh inspection").click());
 assert.equal(document.querySelector('.condition-photos figure figcaption strong')!.textContent,"Confirmed prior condition evidence");
 const roomSelector=document.querySelector<HTMLSelectElement>('.condition-editors select')!;
 await act(async()=>{roomSelector.value="1";roomSelector.dispatchEvent(new dom.window.Event("change",{bubbles:true}));});
 const baselineSelector=document.querySelectorAll<HTMLSelectElement>('.condition-editors select')[1]!;
 await act(async()=>{baselineSelector.value="7";baselineSelector.dispatchEvent(new dom.window.Event("change",{bubbles:true}));});
 assert.equal(document.querySelector('.condition-editors figure figcaption strong')!.textContent,"Confirmed prior condition evidence");
 // Tenant physical vacancy is a distinct explicit action after owner acceptance.
 current={...inspection(),status:"approved",approved_at:date,move_out_date:"2026-11-04"};
 await act(async()=>root.render(createElement(MoveOutInspectionPanel,{contractId:"1",userId:2,onCompleted:()=>{refreshed++;}})));
 await act(async()=>button("Refresh inspection").click());
 assert.equal(Array.from(document.querySelectorAll("button")).some(el=>el.textContent?.includes("Approve Move-Out")),false);
 assert.equal(Array.from(document.querySelectorAll("button")).some(el=>el.textContent?.includes("Save observation")),false,"only the landlord records physical inspection observations");
 assert.equal(button("Record physical vacancy").disabled,true);
 const vacancy=document.querySelector<HTMLInputElement>('.condition-confirmation input[type="checkbox"]')!;
 await act(async()=>vacancy.click());
 assert.equal(button("Record physical vacancy").disabled,false);
 await act(async()=>button("Record physical vacancy").click());
 assert.deepEqual(calls.find(c=>c.url.endsWith("/vacancy"))!.body,{version:3,move_out_date:"2026-11-04"});
 assert.match(document.body.textContent!,/Move-out completed/);assert.equal(refreshed,2);
});
