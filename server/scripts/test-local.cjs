// Legacy __tests__ suites write to DATABASE_URL; keep the default run isolated.
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
function collect(dir) {
  return readdirSync(dir, {withFileTypes:true}).flatMap(entry => {
    const path=join(dir,entry.name);
    if (entry.isDirectory()) return entry.name==='__tests__' ? [] : collect(path);
    return entry.name.endsWith('.test.ts') ? [path] : [];
  });
}
const result=spawnSync(process.execPath,['--import','tsx','--test',...collect('src')], {
  stdio:'inherit', env:{...process.env, DATABASE_URL:'postgres://invalid:invalid@127.0.0.1:1/nibash_test_only',
    SUPABASE_URL:'https://storage.example',SUPABASE_SERVICE_ROLE_KEY:'synthetic-test-key',GEMINI_API_KEY:'synthetic-test-key'},
});
process.exit(result.status ?? 1);
