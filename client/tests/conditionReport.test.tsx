import assert from "node:assert/strict";
import test from "node:test";
import {existsSync} from "node:fs";
import {resolve} from "node:path";
import {JSDOM} from "jsdom";
import {act,createElement} from "react";
import {createRoot} from "react-dom/client";
import {createServer} from "vite";

test("condition UI labels missing evidence, cancels selection, and binds confirmation to the reviewed hash",async t=>{
 assert.ok(existsSync(resolve("src/components/ConditionReportPanel.tsx")),"condition report panel must exist");
 const dom=new JSDOM('<div id="root"></div>',{url:"http://localhost"});
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 Object.defineProperty(globalThis,"localStorage",{configurable:true,value:dom.window.localStorage});
 const oldFetch=globalThis.fetch;
 const calls:{url:string;body:any}[]=[];
 const base:any={id:1,contract_id:1,record_kind:"current_condition",recorded_at:"2026-11-04T10:00:00Z",status:"submitted",version:4,
  integrity_hash:"a".repeat(64),owner_id:1,tenant_id:2,rooms:[{id:1,name:"Bedroom",display_order:0}],photos:[],archived_photos:[],events:[],confirmations:[],ai_consents:[]};
 let report:any=null;
 globalThis.fetch=(async(input:any,options?:RequestInit)=>{
   const url=String(input),body=options?.body?JSON.parse(String(options.body)):undefined;
   calls.push({url,body});
   if(url.endsWith("/ai-consent")){report={...report,ai_consents:[{id:99,actor_id:1,action:"ai_consent",version:4,created_at:base.recorded_at,details:{granted:body.granted,no_identity_documents:body.no_identity_documents,hash:body.hash}}]};return Response.json({report});}
   if(url.endsWith("/confirm")){report={...base,confirmations:[{actor_id:1}]};return Response.json({report});}
   if(options?.method==="POST"){report={...base,status:"draft",integrity_hash:null};return Response.json({report});}
   return Response.json({report,eligible:true,ai_analysis_enabled:false});
 }) as typeof fetch;
 const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:[]}});
 const {ConditionReportPanel}=await vite.ssrLoadModule("/src/components/ConditionReportPanel.tsx");
 const root=createRoot(dom.window.document.getElementById("root")!);
 t.after(async()=>{await act(async()=>root.unmount());globalThis.fetch=oldFetch;await vite.close();dom.window.close();});
 const button=(label:string)=>Array.from(dom.window.document.querySelectorAll("button")).find(el=>el.textContent?.includes(label))!;
 await act(async()=>root.render(createElement(ConditionReportPanel,{contractId:"1",userId:1})));
 assert.match(dom.window.document.body.textContent!,/No move-in evidence/);
 await act(async()=>button("Create condition record").click());
 assert.match(dom.window.document.body.textContent!,/Current condition record/);
 assert.match(dom.window.document.body.textContent!,/does not prove.*move-in/i);
 const file=dom.window.document.querySelector<HTMLInputElement>('input[type="file"]')!;
 assert.equal(file.accept,"image/jpeg,image/png");
 assert.equal(file.hasAttribute("capture"),false,"mobile upload should permit gallery selection as well as camera");
 assert.equal(file.multiple,false);
 assert.equal(button("Upload photograph").disabled,true);
 const selected=new dom.window.File(["synthetic"],"selected-bedroom.png",{type:"image/png"});
 Object.defineProperty(file,"files",{configurable:true,value:[selected]});
 await act(async()=>file.dispatchEvent(new dom.window.Event("change",{bubbles:true})));
 assert.match(dom.window.document.body.textContent!,/Selected: selected-bedroom.png/);
 await act(async()=>button("Cancel selection").click());
 assert.doesNotMatch(dom.window.document.body.textContent!,/Selected: selected-bedroom.png/);
 assert.equal(calls.filter(x=>x.url.endsWith("/photos")).length,0);
 report=base;
 await act(async()=>button("Reload latest report").click());
 const confirm=button("Confirm version");
 assert.equal(confirm.disabled,true);
 const review=dom.window.document.querySelector<HTMLInputElement>('[data-review-snapshot]')!;
 await act(async()=>review.click());
 assert.equal(confirm.disabled,false);
 await act(async()=>confirm.click());
 const sent=calls.find(x=>x.url.endsWith("/confirm"))!;
 assert.deepEqual(sent.body,{version:4,hash:"a".repeat(64)});
 assert.match(dom.window.document.body.textContent!,/Landlord confirmed/);
 assert.equal(dom.window.document.querySelectorAll('[data-ai-consent]:checked').length,0,"AI consent must not be preselected");
 assert.match(dom.window.document.body.textContent!,/Google Gemini/);
 const baselineConsent=dom.window.document.querySelector<HTMLInputElement>('[data-ai-consent]')!;
 assert.equal(baselineConsent.disabled,true,"external processing permission requires a no-identity-document attestation");
 assert.equal(dom.window.document.querySelector<HTMLInputElement>('[data-ai-evidence-safe]')!.checked,false);
 await act(async()=>dom.window.document.querySelector<HTMLInputElement>('[data-ai-evidence-safe]')!.click());
 assert.equal(baselineConsent.disabled,false);
 await act(async()=>baselineConsent.click());
 assert.deepEqual(calls.find(x=>x.url.endsWith("/ai-consent"))!.body,{version:4,hash:"a".repeat(64),granted:true,no_identity_documents:true});
 assert.equal(dom.window.document.querySelector<HTMLInputElement>('[data-ai-consent]')!.checked,true);
 assert.equal(dom.window.document.querySelector<HTMLInputElement>('[data-ai-consent]')!.disabled,false,"a granted permission remains withdrawable");
 // A newly fetched version must clear the local acknowledgment.
 report={...base,version:5,integrity_hash:"b".repeat(64)};
 await act(async()=>button("Reload latest report").click());
 assert.equal(button("Confirm version").disabled,true);
 const evidence={id:8,room_id:1,original_filename:"synthetic.png",notes:"Clean wall",width:800,height:600,file_size:1000,sha256:"c".repeat(64),uploaded_at:base.recorded_at};
 report={...base,photos:[evidence],events:[{id:10,actor_id:1,action:"submitted",version:4,created_at:base.recorded_at,details:{snapshot:{rooms:base.rooms,photos:[evidence]},hash:base.integrity_hash}}]};
 // The mock URL endpoint deliberately returns no valid URL; only request counts matter here.
 const before=calls.filter(x=>x.url.includes("/photos/8/url")).length;
 await act(async()=>button("Reload latest report").click());
 assert.equal(calls.filter(x=>x.url.includes("/photos/8/url")).length-before,1,"collapsed history must not request duplicate private links");
 assert.equal(dom.window.document.querySelectorAll(".condition-history .condition-preview").length,0,"historical previews must not mount while collapsed");
});
