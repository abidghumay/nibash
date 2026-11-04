// Run against a fresh isolated fixture demo on 127.0.0.1:5056. No production service is accessed.
const assert = require('node:assert/strict');
const {writeFile} = require('node:fs/promises');
const {resolve} = require('node:path');
const base='http://127.0.0.1:5056';
const checks=[];
async function request(token,path,body,expected=200){
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json();assert.equal(response.status,expected,path+': '+JSON.stringify(data));return data;
}
async function check(name,work){await work();checks.push({name,status:'passed'});console.log(name+': passed');}
async function main(){
 const login=async role=>(await request(null,'/api/auth/login',{email:`condition-${role}@example.test`,password:'NibashCondition2026!'})).token;
 const tenant=await login('tenant'),owner=await login('owner'),other=await login('other');
 const path='/api/contracts/1/move-out-inspection';
 const baseline=(await request(tenant,'/api/contracts/1/condition-report')).report;
 const paymentsBefore=(await request(tenant,'/api/payments/contracts/1')).payments;
 await check('real login and locked baseline',async()=>{assert.equal(baseline.status,'confirmed');assert.equal(baseline.confirmations.length,2);});
 await check('unauthenticated and unrelated-party rejection',async()=>{await request(null,path,undefined,401);await request(other,path,{},403);});
 let inspection=(await request(tenant,path,{},201)).inspection;
 const fixture=await(await fetch(base+'/demo-fixtures/04-wall-mark.png')).arrayBuffer();
 await check('actual multipart upload and pair matching',async()=>{
  const form=new FormData();form.set('version',String(inspection.version));form.set('room_id',String(inspection.rooms[0].id));form.set('baseline_photo_id',String(baseline.photos[0].id));form.set('photo',new Blob([fixture],{type:'image/png'}),'04-wall-mark.png');
  const response=await fetch(base+path+'/photos',{method:'POST',headers:{Authorization:'Bearer '+tenant},body:form});assert.equal(response.status,201);inspection=(await response.json()).inspection;assert.equal(inspection.photos[0].baseline_photo_id,baseline.photos[0].id);
 });
 await check('short-lived signed private image access and tamper rejection',async()=>{
  await request(other,path+'/photos/'+inspection.photos[0].id+'/url',undefined,403);
  const link=await request(owner,path+'/photos/'+inspection.photos[0].id+'/url');
  assert.equal((await fetch(base+link.url)).status,200);assert.equal((await fetch(base+'/api/demo-evidence')).status,403);assert.equal((await fetch(base+link.url+'bad')).status,403);
 });
 for(const token of [tenant,owner])await request(token,'/api/contracts/1/condition-report/ai-consent',{version:baseline.version,hash:baseline.integrity_hash,granted:true,no_identity_documents:true});
 inspection=(await request(tenant,path+'/submit',{version:inspection.version,analyze:true,consent:true})).inspection;
 inspection=(await request(owner,path+'/ai-consent',{version:inspection.version,hash:inspection.input_hash,granted:true})).inspection;
 await request(owner,path+'/analyze',{version:inspection.version});
 await check('durable worker persists clearly labelled fixture comparison',async()=>{
  for(let count=0;count<20;count++){inspection=(await request(tenant,path)).inspection;if(inspection.status==='awaiting_inspection'&&inspection.findings.length)break;await new Promise(r=>setTimeout(r,1000));}
  assert.equal(inspection.status,'awaiting_inspection');assert.equal(inspection.findings.length,1);assert.match(inspection.analysis_result.summary,/FIXTURE FALLBACK/);
 });
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dhaka'}).format(new Date());
 await check('approval before required review and tenant approval rejected',async()=>{await request(owner,path+'/approve',{version:inspection.version,vacated:true,accepted:true,move_out_date:date},409);await request(tenant,path+'/approve',{version:inspection.version,vacated:true,accepted:true,move_out_date:date},403);});
 inspection=(await request(owner,path+'/reviews',{version:inspection.version,finding_id:inspection.findings[0].id,decision:'acceptable',notes:'Synthetic physical inspection demonstration: accepted condition.'})).inspection;
 await check('landlord approval waits for independent tenant vacancy',async()=>{inspection=(await request(owner,path+'/approve',{version:inspection.version,vacated:true,accepted:true,move_out_date:date})).inspection;assert.equal(inspection.status,'approved');});
 await check('tenant vacancy completes controlled closure once',async()=>{
  inspection=(await request(tenant,path+'/vacancy',{version:inspection.version,move_out_date:date})).inspection;assert.equal(inspection.status,'completed');
  const again=(await request(owner,path+'/approve',{version:inspection.version,vacated:true,accepted:true,move_out_date:date})).inspection;assert.equal(again.events.filter(e=>e.action==='completed').length,1);assert.equal(again.events.filter(e=>e.action==='approved').length,1);
 });
 await check('both parties see completion and baseline remains unchanged',async()=>{for(const token of [owner,tenant])assert.equal((await request(token,path)).inspection.status,'completed');const after=(await request(tenant,'/api/contracts/1/condition-report')).report;assert.equal(after.integrity_hash,baseline.integrity_hash);});
 await check('unpaid invoice remains unchanged by approval and vacancy',async()=>{assert.ok(paymentsBefore.length>0);const after=(await request(tenant,'/api/payments/contracts/1')).payments;assert.deepEqual(after,paymentsBefore);});
 await check('completion notifications visible to both parties',async()=>{for(const token of [owner,tenant]){const data=await request(token,'/api/notifications');assert.ok(data.notifications.some(n=>n.title==='Move-out completed'));}});
 await check('no baseline is labelled manual and can complete without AI',async()=>{
  const manualPath='/api/contracts/2/move-out-inspection';
  let manual=(await request(tenant,manualPath,{},201)).inspection;assert.equal(manual.baseline_report_id,null);
  manual=(await request(tenant,manualPath+'/rooms',{version:manual.version,name:'Living room'},201)).inspection;
  const form=new FormData();form.set('version',String(manual.version));form.set('room_id',String(manual.rooms[0].id));form.set('photo',new Blob([fixture],{type:'image/png'}),'manual.png');
  const upload=await fetch(base+manualPath+'/photos',{method:'POST',headers:{Authorization:'Bearer '+tenant},body:form});assert.equal(upload.status,201);manual=(await upload.json()).inspection;
  const submitted=await request(tenant,manualPath+'/submit',{version:manual.version,analyze:true,consent:true});manual=submitted.inspection;assert.equal(manual.analysis_source,'manual');assert.equal(manual.status,'awaiting_inspection');assert.match(submitted.analysis_blocked_reason,/baseline/);
  await request(tenant,manualPath+'/vacancy',{version:manual.version,move_out_date:date});manual=(await request(owner,manualPath+'/approve',{version:manual.version,vacated:true,accepted:true,move_out_date:date})).inspection;assert.equal(manual.status,'completed');
 });
 await writeFile(resolve(__dirname,'demo-http-results.json'),JSON.stringify({recorded_at:new Date().toISOString(),mode:'explicit fixture fallback; no live model inference',checks},null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
