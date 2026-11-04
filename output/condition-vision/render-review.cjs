const fs=require("node:fs/promises"),path=require("node:path");
const sharp=require("../../server/node_modules/sharp");
(async()=>{
 const source=JSON.parse(await fs.readFile(path.join(__dirname,"results.json"),"utf8"));
 const rows=[];
 for(let i=0;i<source.results.length;i++){
  const r=source.results[i];
  const first=await sharp(path.join(__dirname,"baseline.png")).resize(400,300).png().toBuffer();
  const second=await sharp(path.join(__dirname,r.id+".png")).resize(400,300).png().toBuffer();
  const title=Buffer.from('<svg width="800" height="40"><rect width="800" height="40" fill="#17231f"/><text x="12" y="26" fill="white" font-family="Arial" font-size="17">'+r.id+' — baseline / move-out</text></svg>');
  rows.push({input:title,left:0,top:i*340},{input:first,left:0,top:i*340+40},{input:second,left:400,top:i*340+40});
 }
 await sharp({create:{width:800,height:2040,channels:3,background:"#ffffff"}}).composite(rows).png().toFile(path.join(__dirname,"fixture-pairs.png"));
})();
