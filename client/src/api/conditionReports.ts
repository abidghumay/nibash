import {apiClient} from "./client";
export interface ConditionPhoto {
 id:number;room_id:number;original_filename:string;mime_type:string;width:number;height:number;file_size:number;
 sha256:string;notes:string;uploaded_at:string;uploaded_by:number;removed_at:string|null;
}
export interface ConditionEvent {
 id:number;actor_id:number;action:string;version:number;created_at:string;
 details:{hash?:string;granted?:boolean;photo_id?:number;notes?:string;previous_notes?:string;snapshot?:{
  rooms:{id:number;name:string}[];photos:ConditionPhoto[];
 }};
}
export interface ConditionReport {
 id:number;contract_id:number;type:"move_in";record_kind:"move_in"|"current_condition";status:"draft"|"submitted"|"confirmed";
 version:number;recorded_at:string;submitted_at:string|null;locked_at:string|null;integrity_hash:string|null;
 owner_id:number;tenant_id:number;rooms:{id:number;name:string;display_order:number}[];
 photos:ConditionPhoto[];archived_photos:ConditionPhoto[];events:ConditionEvent[];confirmations:ConditionEvent[];ai_consents:ConditionEvent[];
}
export interface ConditionResponse {report:ConditionReport|null;eligible:boolean;ai_analysis_enabled:false}
export const conditionEndpoint=(contractId:string)=>`/contracts/${encodeURIComponent(contractId)}/condition-report`;
const photoAccess=new Map<string,{until:number;request:Promise<{url:string;expires_in:number}>}>();
export async function conditionPhotoUrl(contractId:string,photoId:number,refresh=false) {
 // Session-scoped, short-lived in-memory deduplication; never persist signed URLs.
 const key=JSON.stringify([localStorage.getItem("token"),contractId,photoId]);
 for(const [id,item] of photoAccess)if(item.until<=Date.now())photoAccess.delete(id);
 const cached=photoAccess.get(key);
 if(cached&&!refresh)return cached.request;
 const request=apiClient.get<{url:string;expires_in:number}>(conditionEndpoint(contractId)+`/photos/${photoId}/url`);
 photoAccess.set(key,{until:Date.now()+105_000,request});
 try{return await request;}catch(error){photoAccess.delete(key);throw error;}
}
