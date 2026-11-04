import sharp from "sharp";
import { createHash } from "node:crypto";
import { AppError } from "../errors/AppError.js";

export const MAX_CONDITION_BYTES = 8 * 1024 * 1024;
export async function normalizeConditionImage(bytes: Buffer, claimedMime: string) {
  if (!bytes.length || bytes.length > MAX_CONDITION_BYTES) throw new AppError(400, "Image must be at most 8 MiB");
  const png = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
  if (!png && !jpeg) throw new AppError(400, "Only actual JPEG or PNG images are supported; convert HEIC before uploading");
  const mimeType = png ? "image/png" : "image/jpeg";
  if (claimedMime !== mimeType) throw new AppError(400, "Image content must match its MIME type");
  try {
    const image = sharp(bytes, {limitInputPixels:24_000_000, failOn:"warning"});
    const info = await image.metadata();
    if ((info.pages ?? 1)!==1 || !info.width || !info.height || Math.min(info.width,info.height)<64 ||
      Math.max(info.width,info.height)>8000 || info.width*info.height>24_000_000) {
      throw new AppError(400, "Image dimensions must be 64–8000 pixels and at most 24 megapixels; use a single frame");
    }
    // rotate() applies EXIF orientation; ordinary output strips EXIF/GPS metadata.
    const oriented = image.rotate();
    const result = await (png ? oriented.png() : oriented.jpeg({quality:90})).toBuffer({resolveWithObject:true});
    if (result.data.length>MAX_CONDITION_BYTES) throw new AppError(400, "Normalized image exceeds 8 MiB; use a smaller photo");
    return {buffer:result.data,mimeType,width:result.info.width,height:result.info.height,
      fileSize:result.data.length,sha256:createHash("sha256").update(result.data).digest("hex"),extension:png?"png":"jpg"};
  } catch(error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && /pixel limit/i.test(error.message)) throw new AppError(400, "Image exceeds the pixel dimensions limit");
    throw new AppError(400, "Unable to decode this JPEG or PNG image");
  }
}
