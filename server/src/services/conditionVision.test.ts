import test from "node:test";
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {resolve} from "node:path";
test("vision schema rejects invented/invalid coordinates and rescales y,x boxes correctly",async()=>{
 assert.ok(existsSync(resolve(__dirname,"conditionVision.ts")),"vision feasibility prototype must exist");
 const {parseConditionComparison,boxAtSize,compareSyntheticConditionPair}=await import("./conditionVision.js");
 await assert.rejects(()=>compareSyntheticConditionPair({baseline:Buffer.alloc(0),moveOut:Buffer.alloc(0),roomName:"Any",synthetic:false as any}),/real_home_analysis_disabled/);
 const result=parseConditionComparison({comparable:true,reason:"Same view",differences:[{description:"New wall mark",category:"surface_change",box_2d:[100,200,300,400]}]});
 assert.deepEqual(boxAtSize(result.differences[0].box_2d!,800,600),{left:160,top:60,width:160,height:120});
 assert.deepEqual(boxAtSize(result.differences[0].box_2d!,400,300),{left:80,top:30,width:80,height:60});
 for(const box of [[0,1,0,2],[1,1,3,1001],[3,2,1,4],[1,2,3],[1.2,2,4,5]]) {
   assert.throws(()=>parseConditionComparison({comparable:true,reason:"x",differences:[{description:"x",category:"surface_change",box_2d:box}]}));
 }
 assert.throws(()=>parseConditionComparison({comparable:false,reason:"Hidden",differences:[{description:"invented",category:"surface_change",box_2d:null}]}));
});
