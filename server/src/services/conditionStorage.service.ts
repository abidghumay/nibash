import { AppError } from "../errors/AppError.js";
const bucket="condition-evidence";
export interface ConditionStorage {
  put(path:string,bytes:Buffer,mime:string):Promise<void>;
  remove(path:string):Promise<void>;
  sign(path:string):Promise<string>;
  read?(path:string):Promise<Buffer>;
}
function config() {
  const url=process.env.SUPABASE_URL?.replace(/\/$/,""), key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!url || !key) throw new AppError(503,"Private condition storage is not configured");
  return {url,headers:{apikey:key,Authorization:`Bearer ${key}`}};
}
function safePath(path:string) {
  if(!/^conditions\/[1-9]\d*\/[a-f0-9-]{36}\.(jpg|png)$/.test(path)) throw new AppError(500,"Invalid condition storage path");
  return path.split("/").map(encodeURIComponent).join("/");
}
async function request(path:string,init:RequestInit={}) {
  const c=config();
  const res=await fetch(`${c.url}/storage/v1/${path}`,{...init,headers:{...c.headers,...init.headers},signal:AbortSignal.timeout(15000)});
  if(!res.ok) throw new AppError(503,"Private condition storage is unavailable");
  return res;
}
async function privateBucket() {
  const data=await(await request(`bucket/${bucket}`)).json() as {public?:boolean};
  if(data.public!==false) throw new AppError(503,"Condition evidence bucket must be private");
}
export const conditionStorage:ConditionStorage={
  async read(path) {
    const safe=safePath(path); await privateBucket();
    const response=await request(`object/authenticated/${bucket}/${safe}`);
    const reader=response.body?.getReader();
    if(!reader) throw new AppError(503,"Private condition evidence could not be read");
    const chunks:Uint8Array[]=[];let length=0;
    try {
      while(true) {
        const {done,value}=await reader.read();if(done)break;
        length+=value.byteLength;
        if(length>8*1024*1024) {await reader.cancel();throw new AppError(503,"Stored condition image exceeds its limit");}
        chunks.push(value);
      }
    } finally {reader.releaseLock();}
    return Buffer.concat(chunks,length);
  },
  async put(path,bytes,mime) {
    const safe=safePath(path); await privateBucket();
    await request(`object/${bucket}/${safe}`,{method:"POST",headers:{"Content-Type":mime,"x-upsert":"false"},body:bytes as unknown as BodyInit});
  },
  async remove(path) {
    safePath(path); await privateBucket();
    await request(`object/${bucket}`,{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({prefixes:[path]})});
  },
  async sign(path) {
    const safe=safePath(path); await privateBucket();
    const data=await(await request(`object/sign/${bucket}/${safe}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expiresIn:120})})).json() as {signedURL?:string};
    if(!data.signedURL?.startsWith(`/object/sign/${bucket}/${safe}?`)) throw new AppError(503,"Invalid condition download response");
    return `${config().url}/storage/v1${data.signedURL}`;
  }
};
