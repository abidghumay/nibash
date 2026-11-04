// Read-only smoke against the isolated completed live demo. Never contacts production.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
async function main(){
 const base='http://127.0.0.1:5056';
 const page=await fetch(base+'/contracts/1');assert.equal(page.status,200);
 assert.match(await page.text(),/LIVE GEMINI/);
 const checks=[];
 for(const role of ['owner','tenant']){
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:`condition-${role}@example.test`,password:'NibashCondition2026!'})});
  assert.equal(login.status,200);const {token}=await login.json();
  const headers={Authorization:'Bearer '+token};
  const response=await fetch(base+'/api/contracts/1/move-out-inspection',{headers});assert.equal(response.status,200);
  const report=await response.json();assert.equal(report.inspection.status,'completed');assert.equal(report.baseline.status,'confirmed');
  assert.equal(report.inspection.analysis_source,'live');assert.equal(report.inspection.findings.length,1);
  assert.ok(report.inspection.approved_at);assert.ok(report.inspection.tenant_vacated_at);
  checks.push({role,completed:true,confirmed_baseline_preserved:true,live_finding_preserved:true});
 }
 const evidence={recorded_at:new Date().toISOString(),scope:'Local synthetic demo resumed with final source; read-only, no new inference',checks};
 fs.writeFileSync(path.join(__dirname,'demo-resume-smoke.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
