import "dotenv/config";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import sharp from "sharp";
import {compareSyntheticConditionPair,ConditionVisionError} from "../services/conditionVision.js";

// Deterministic illustrative room fixtures, drawn here; no external images, personal data or documents.
function room(opts:{light?:boolean;moved?:boolean;mark?:boolean;multiple?:boolean;obscured?:boolean}={}) {
 return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
 <rect width="800" height="600" fill="#dedbd4"/><path d="M0 0L130 90V410L0 500Z" fill="#ccc5ba"/>
 <path d="M130 90H800V410H130Z" fill="#eee9df"/><path d="M0 500L130 410H800V600H0Z" fill="#b9a28c"/>
 <path d="M130 90V410H800" fill="none" stroke="#8f887e" stroke-width="4"/>
 <rect x="180" y="140" width="150" height="155" fill="#b7d6e7" stroke="#e8e2d9" stroke-width="12"/>
 <path d="M255 140V295M180 217H330" stroke="#faf8ef" stroke-width="7"/>
 <rect x="560" y="300" width="160" height="25" rx="3" fill="#77553b"/>
 <path d="M570 325V450M710 325V450" stroke="#684a35" stroke-width="12"/>
 <g transform="translate(${opts.moved?170:0},0)"><rect x="350" y="315" width="75" height="80" rx="6" fill="#446874"/>
 <path d="M350 390H440V410H350Z" fill="#355563"/><path d="M360 410V475M430 410V475" stroke="#35464b" stroke-width="9"/></g>
 ${opts.mark?'<path d="M465 177L482 188L474 201L493 213" stroke="#5b4135" stroke-width="9" stroke-linecap="round" fill="none"/>':""}
 ${opts.multiple?'<path d="M650 180L638 208L649 230L631 260" stroke="#4f4740" stroke-width="6" fill="none"/><ellipse cx="260" cy="520" rx="45" ry="18" fill="#725d48"/>':""}
 ${opts.light?'<rect width="800" height="600" fill="#263653" opacity="0.32"/>':""}
 ${opts.obscured?'<rect x="120" y="60" width="610" height="500" fill="#57504c"/><path d="M120 60L730 560M730 60L120 560" stroke="#6c6259" stroke-width="10"/>':""}
 </svg>`);
}
async function main() {
 const args=process.argv.slice(2),out=resolve(args[args.indexOf("--out")+1]||"../output/condition-vision");
 if(!args.includes("--synthetic"))throw new Error("Pass --synthetic to acknowledge synthetic-only input. Real home analysis is disabled.");
 await mkdir(out,{recursive:true});
 if(args.includes("--pair")) {
   const index=args.indexOf("--pair");
   const baseline=await readFile(resolve(args[index+1])),moveOut=await readFile(resolve(args[index+2]));
   const roomName=args.includes("--room")?args[args.indexOf("--room")+1]:"Synthetic room";
   const baselineNotes=args.includes("--notes")?args[args.indexOf("--notes")+1]:undefined;
   const result=await compareSyntheticConditionPair({baseline,moveOut,roomName,baselineNotes,synthetic:true});
   await writeFile(resolve(out,"pair-result.json"),JSON.stringify(result,null,2));return;
 }
 const cases=[
  {id:"01-identical",options:{},expected:"Comparable; no differences. No boxes.",regions:[],abstain:false},
  {id:"02-lighting",options:{light:true},expected:"No surface change; exposure alone must not be reported as damage.",regions:[],abstain:false},
  {id:"03-object-moved",options:{moved:true},expected:"Chair moved right. No surface damage inferred.",regions:[[525,650,800,775]],abstain:false},
  {id:"04-wall-mark",options:{mark:true},expected:"New visible brown mark on back wall near center; cause unknown.",regions:[[280,570,370,630]],abstain:false},
  {id:"05-obstruction",options:{obscured:true},expected:"Abstain: most room surfaces occluded. Do not invent hidden changes.",regions:[],abstain:true},
  {id:"06-multiple",options:{mark:true,multiple:true},expected:"Three visible surface changes: brown central wall mark, upper-right wall line, brown floor patch.",regions:[[280,570,370,630],[290,780,450,830],[830,265,905,390]],abstain:false},
 ];
 const baseline=await sharp(room()).png().toBuffer();
 await writeFile(resolve(out,"baseline.png"),baseline);
 // Expectations and fixture files are persisted BEFORE the first inference.
 for(const c of cases) await writeFile(resolve(out,c.id+".png"),await sharp(room(c.options)).png().toBuffer());
 await writeFile(resolve(out,"expectations.json"),JSON.stringify({license:"Project-authored synthetic SVG fixtures; no personal data.",cases},null,2));
 const results:any[]=[];
 for(const c of cases) {
  try {
   const result=await compareSyntheticConditionPair({baseline,moveOut:await readFile(resolve(out,c.id+".png")),roomName:"Synthetic living room",baselineNotes:"Clean light wall, chair, table and window. Images are synthetic illustrations.",synthetic:true});
   results.push({id:c.id,input_pair:["baseline.png",c.id+".png"],expected:c.expected,expected_regions:c.regions,expected_abstention:c.abstain,
     ...result,review:{meaningful_differences:"pending human review",false_positives:"pending human review",misses:"pending human review",localization:"pending visual review; do not display boxes"}});
   console.log(c.id+": response received ("+result.runtime_ms+" ms)");
  } catch(error) {
   results.push({id:c.id,input_pair:["baseline.png",c.id+".png"],expected:c.expected,status:"blocked",
     blocker:error instanceof ConditionVisionError?error.code:"local_fixture_error",model:error instanceof ConditionVisionError?error.model:null,
     runtime_ms:error instanceof ConditionVisionError?error.runtime_ms:null,provider_status:error instanceof ConditionVisionError?error.provider_status:undefined,
     response:null,meaningful_differences:"not evaluated",false_positives:"not evaluated",misses:"not evaluated",usable_region:false,abstention:"not evaluated"});
   console.log(c.id+": "+results.at(-1).blocker);
  }
  await writeFile(resolve(out,"results.json"),JSON.stringify({recorded_at:new Date().toISOString(),results},null,2));
 }
}
main().catch(()=>{console.error("Synthetic vision evaluation failed; check configuration and local inputs.");process.exitCode=1;});
