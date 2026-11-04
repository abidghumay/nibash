import {apiClient} from "./client";
import type {ConditionEvent,ConditionPhoto,ConditionReport} from "./conditionReports";

export interface MoveOutFinding {
 id:string;roomId:number;baselinePhotoId:number;moveOutPhotoId:number;
 category:"possible_visible_change"|"clear_visible_difference"|"no_meaningful_change"|"insufficient_evidence";
 description:string;locationHint:string;visualEvidence:string;reviewRequired:boolean;
}
export type ReviewDecision="no_issue"|"acceptable"|"confirmed_difference"|"unable_to_verify";
export interface MoveOutReview {finding_id:string;decision:ReviewDecision;notes:string;resolved?:boolean;actor_id?:number;created_at?:string}
export interface MoveOutInspection {
 id:number;contract_id:number;root_contract_id:number;version:number;owner_id:number;tenant_id:number;
 status:"awaiting_photos"|"analysis_pending"|"awaiting_inspection"|"needs_review"|"approved"|"completed";
 baseline_report_id:number|null;input_hash:string|null;created_at:string;submitted_at?:string|null;
 rooms:{id:number;name:string;baseline_room_id:number|null}[];
 photos:(ConditionPhoto&{baseline_photo_id:number|null})[];
 findings:MoveOutFinding[];reviews:MoveOutReview[];observations:{id?:number;room_id?:number;notes:string;review_required?:boolean;resolved?:boolean;actor_id?:number;created_at?:string}[];
 analysis_result:{comparisonStatus:"compared"|"limited"|"insufficient_evidence";summary:string;findings:MoveOutFinding[];limitations:string[]}|null;
 analysis_error?:string|null;analysis_status?:string;analysis_source?:string|null;events:ConditionEvent[];ai_consents:ConditionEvent[];
 approved_at:string|null;approved_by?:number|null;tenant_vacated_at:string|null;move_out_date:string|null;
}
export interface MoveOutResponse {
 inspection:MoveOutInspection|null;baseline:ConditionReport|null;eligible:boolean;ai_analysis_enabled:boolean;analysis_blocked_reason?:string|null;
}
export const moveOutEndpoint=(contractId:string)=>`/contracts/${encodeURIComponent(contractId)}/move-out-inspection`;
export const moveOutPhotoUrl=(contractId:string,photoId:number)=>apiClient.get<{url:string;expires_in:number}>(moveOutEndpoint(contractId)+`/photos/${photoId}/url`);
