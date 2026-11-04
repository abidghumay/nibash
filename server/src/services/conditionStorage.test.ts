import test from 'node:test';
import assert from 'node:assert/strict';
import {conditionStorage} from './conditionStorage.service.js';

test('server-only evidence download checks bucket privacy, path and streaming byte limit',async t=>{
 const original=globalThis.fetch,oldUrl=process.env.SUPABASE_URL,oldKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
 process.env.SUPABASE_URL='https://storage.example';process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic-service-only';
 t.after(()=>{globalThis.fetch=original;if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;if(oldKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=oldKey;});
 const path='conditions/1/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png';let calls=0,publicBucket=false,oversized=false;
 globalThis.fetch=(async(input:any,init?:RequestInit)=>{
  calls++;const url=String(input);
  assert.equal((init?.headers as any).Authorization,'Bearer synthetic-service-only');
  if(url.endsWith('/bucket/condition-evidence'))return Response.json({public:publicBucket});
  assert.equal(url,'https://storage.example/storage/v1/object/authenticated/condition-evidence/'+path);
  if(oversized)return new Response(new Uint8Array(8*1024*1024+1));
  return new Response(new Uint8Array([1,2,3]));
 }) as typeof fetch;
 await assert.rejects(()=>conditionStorage.read!('../identity-documents/private.pdf'),/Invalid condition storage path/);assert.equal(calls,0);
 assert.deepEqual(await conditionStorage.read!(path),Buffer.from([1,2,3]));
 publicBucket=true;const before=calls;
 await assert.rejects(()=>conditionStorage.read!(path),/must be private/);assert.equal(calls,before+1,'a public bucket must fail before downloading evidence');
 publicBucket=false;oversized=true;
 await assert.rejects(()=>conditionStorage.read!(path),/exceeds its limit/);
});
