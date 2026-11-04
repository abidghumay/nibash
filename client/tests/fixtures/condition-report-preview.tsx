// Local visual QA fixture only. All API data and images are synthetic; no backend connection.
import React from "react";
import {createRoot} from "react-dom/client";
import {ConditionReportPanel} from "../../src/components/ConditionReportPanel";
import "../../src/index.css";
import baseline from "../../../output/condition-vision/baseline.png";

const photo={id:1,room_id:1,original_filename:"synthetic-living-room.png",mime_type:"image/png",width:800,height:600,file_size:14000,sha256:"b".repeat(64),notes:"Clean wall, window, chair and table. Synthetic illustration for demonstration.",uploaded_at:"2026-11-04T10:12:00Z",uploaded_by:2,removed_at:null};
let report:any={id:1,contract_id:1,type:"move_in",record_kind:"current_condition",status:"submitted",version:4,recorded_at:"2026-11-04T10:00:00Z",
 submitted_at:"2026-11-04T10:15:00Z",locked_at:null,integrity_hash:"a".repeat(64),owner_id:1,tenant_id:2,
 rooms:[{id:1,name:"Living room",display_order:0}],photos:[photo],archived_photos:[],
 confirmations:[{id:3,actor_id:2,version:4,created_at:"2026-11-04T10:16:00Z",details:{hash:"a".repeat(64)}}],ai_consents:[],
 events:[{id:1,actor_id:2,action:"submitted",version:4,created_at:"2026-11-04T10:15:00Z",details:{hash:"a".repeat(64),snapshot:{rooms:[{id:1,name:"Living room"}],photos:[photo]}}}]};
window.fetch=(async(input,options)=>{
 const url=String(input);
 if(url.includes("/photos/1/url"))return Response.json({url:baseline,expires_in:120});
 if(url.endsWith("/confirm")){report={...report,status:"confirmed",locked_at:new Date().toISOString(),confirmations:[...report.confirmations,{id:4,actor_id:1,version:4,created_at:new Date().toISOString(),details:{hash:report.integrity_hash}}]};}
 else if(url.endsWith("/ai-consent")){const body=JSON.parse(String(options?.body));report={...report,ai_consents:[{actor_id:1,details:{granted:body.granted}}]};}
 else if(options?.method==="POST"||options?.method==="PATCH")return Response.json({error:"Synthetic preview: use automated HTTP tests for uploads and edits."},{status:409});
 return Response.json({report,eligible:true,ai_analysis_enabled:false});
}) as typeof fetch;
createRoot(document.getElementById("root")!).render(<main style={{maxWidth:1120,margin:"0 auto",padding:"24px 16px",fontFamily:"Arial, sans-serif"}}>
 <p style={{fontSize:14,color:"#38645b"}}>NIBASH / CONTRACT 1 · SYNTHETIC VISUAL QA</p><ConditionReportPanel contractId="1" userId={1}/></main>);
