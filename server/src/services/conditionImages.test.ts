import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";

test("condition image validation decodes bytes and normalizes evidence", async () => {
  assert.ok(existsSync(resolve(__dirname, "conditionImages.ts")), "secure image validator must be implemented");
  const { normalizeConditionImage } = await import("./conditionImages.js");
  const png = await sharp({create:{width:320,height:240,channels:3,background:"#fff"}}).png().toBuffer();
  const result = await normalizeConditionImage(png, "image/png");
  assert.equal(result.width, 320);
  assert.equal(result.height, 240);
  await assert.rejects(() => normalizeConditionImage(Buffer.from("<script>bad</script>"), "image/png"), /JPEG or PNG/);
  await assert.rejects(() => normalizeConditionImage(png, "image/jpeg"), /match/);
  await assert.rejects(() => normalizeConditionImage(Buffer.concat([png.subarray(0,30),Buffer.from("bad")]), "image/png"), /decode/);
  await assert.rejects(() => normalizeConditionImage(Buffer.alloc(8*1024*1024+1), "image/png"), /8 MiB/);
  const large = await sharp({create:{width:5001,height:5001,channels:3,background:"#fff"}}).png().toBuffer();
  await assert.rejects(() => normalizeConditionImage(large, "image/png"), /dimensions|pixel/);
  const oriented = await sharp(png).jpeg().withMetadata({orientation:6}).toBuffer();
  const normalized = await normalizeConditionImage(oriented, "image/jpeg");
  assert.equal(normalized.width, 240);
  assert.equal(normalized.height, 320);
  assert.equal((await sharp(normalized.buffer).metadata()).orientation, undefined);
});
