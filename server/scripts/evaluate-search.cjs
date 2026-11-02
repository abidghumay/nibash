// Explicit opt-in; synthetic queries/catalog only. Never connects to DATABASE_URL.
// node --import tsx scripts/evaluate-search.cjs [--limit=12]
const { writeFileSync } = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const { interpretSearch } = require('../src/services/search/interpretSearch.ts');
const fixtures = require('./search-evaluation.json');
if (process.env.SEARCH_AI_ENABLED !== 'true' || !process.env.SEARCH_AI_MODEL) {
  console.error('Set SEARCH_AI_ENABLED=true and SEARCH_AI_MODEL explicitly before live evaluation.');
  process.exit(1);
}
const catalog = { areas: [{id:2,name:'Dhanmondi'},{id:4,name:'Gulshan'}], amenities: [{name:'Elevator'},{name:'Garage'},{name:'Gym'}] };
const limit = Number(process.argv.find(x => x.startsWith('--limit='))?.split('=')[1]) || fixtures.length;
(async () => {
  const cases=[];
  for (const fixture of fixtures.slice(0,limit)) {
    const result=await interpretSearch(fixture.query,{catalog});
    const pass=result.status==='interpreted' && isDeepStrictEqual(result.filters,fixture.filters) &&
      result.unsupported.some(x=>x.mandatory)===Boolean(fixture.unsupportedMandatory) &&
      (!fixture.hasPreference || result.preferences.length>0);
    const item={query:fixture.query,expected:fixture.filters,actual:result.filters,status:result.status,unsupported:result.unsupported,preferences:result.preferences,latencyMs:result.latencyMs,pass};
    cases.push(item); console.log(JSON.stringify(item));
  }
  const times=cases.map(x=>x.latencyMs).sort((a,b)=>a-b);
  const summary={date:new Date().toISOString(),model:process.env.SEARCH_AI_MODEL,sampleSize:cases.length,passed:cases.filter(x=>x.pass).length,medianMs:times[Math.floor(times.length/2)],p95Ms:times[Math.min(times.length-1,Math.ceil(times.length*.95)-1)],scope:'Synthetic small fixture set; not a general accuracy claim',cases};
  writeFileSync('scripts/search-evaluation-results.json',JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify({...summary,cases:undefined}));
  process.exitCode=summary.passed===cases.length?0:1;
})();
