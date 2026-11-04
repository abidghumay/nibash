import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import authMiddleware from "../middleware/auth.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { AppError } from "../errors/AppError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { conditionReports as service } from "../services/conditionReports.service.js";
import { MAX_CONDITION_BYTES } from "../services/conditionImages.js";

const router=Router({mergeParams:true});
const positive=z.coerce.number().int().positive().max(2147483647);
const expected=z.object({version:positive}).strict();
const snapshot=z.object({version:positive,hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
function parse<T>(schema:z.ZodType<T>,value:unknown):T {
  const result=schema.safeParse(value);
  if(!result.success) throw new AppError(400,result.error.issues[0]?.message??"Invalid condition report input");
  return result.data;
}
const id=(req:Request)=>parse(positive,req.params.id);
const actor=(req:Request)=>req.user!.id;
const photo=(req:Request)=>parse(positive,req.params.photoId);
router.use(authMiddleware);
router.use(async(req:Request,res:Response,next:NextFunction)=>{
  res.setHeader("Cache-Control","private, no-store");
  res.setHeader("Referrer-Policy","no-referrer");
  try {
    id(req);
    if(Object.keys(req.query).length) throw new AppError(400,"Query parameters and storage paths are not accepted");
    await service.authorize(actor(req),id(req)); // Authorize before allocating multipart buffers or storage access.
    next();
  } catch(error) {
    if(error instanceof AppError) res.status(error.statusCode).json({error:error.message});
    else res.status(500).json({error:"Condition reports are unavailable"});
  }
});
router.use(createRateLimiter({windowMs:60000,max:120}));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_CONDITION_BYTES,files:1,fields:3,parts:4,fieldSize:4096}});
const multipart=(req:Request,res:Response,next:NextFunction)=>{
  upload.single("photo")(req,res,error=>{
    if(error) {res.status(error instanceof multer.MulterError && error.code==="LIMIT_FILE_SIZE"?413:400).json({error:"Upload one JPEG or PNG photograph, at most 8 MiB, with version, room_id and optional notes"});return;}
    next();
  });
};
router.get("/",asyncHandler(async(req,res)=>{res.json(await service.get(actor(req),id(req)));}));
router.post("/",asyncHandler(async(req,res)=>{
  parse(z.object({}).strict(),req.body??{});res.status(201).json(await service.create(actor(req),id(req)));
}));
router.post("/rooms",asyncHandler(async(req,res)=>{
  const input=parse(z.object({version:positive,name:z.string().trim().min(1).max(80)}).strict(),req.body);
  res.status(201).json(await service.addRoom(actor(req),id(req),input.version,input.name));
}));
router.post("/photos",multipart,asyncHandler(async(req,res)=>{
  const input=parse(z.object({version:positive,room_id:positive,notes:z.string().trim().max(1000).default("")}).strict(),req.body);
  if(!req.file) throw new AppError(400,"Choose a JPEG or PNG photograph");
  res.status(201).json(await service.addPhoto(actor(req),id(req),input.version,input.room_id,req.file.buffer,req.file.originalname,req.file.mimetype,input.notes));
}));
router.patch("/photos/:photoId",asyncHandler(async(req,res)=>{
  const input=parse(z.object({version:positive,notes:z.string().trim().max(1000)}).strict(),req.body);
  res.json(await service.updatePhoto(actor(req),id(req),input.version,photo(req),input.notes));
}));
router.post("/photos/:photoId/remove",asyncHandler(async(req,res)=>{
  const input=parse(expected,req.body);res.json(await service.removePhoto(actor(req),id(req),input.version,photo(req)));
}));
router.get("/photos/:photoId/url",asyncHandler(async(req,res)=>{
  res.json(await service.photoUrl(actor(req),id(req),photo(req)));
}));
router.post("/submit",asyncHandler(async(req,res)=>{
  const input=parse(expected,req.body);res.json(await service.submit(actor(req),id(req),input.version));
}));
router.post("/confirm",asyncHandler(async(req,res)=>{
  const input=parse(snapshot,req.body);res.json(await service.confirm(actor(req),id(req),input.version,input.hash));
}));
router.post("/ai-consent",asyncHandler(async(req,res)=>{
  const input=parse(snapshot.extend({granted:z.boolean()}).strict(),req.body);
  res.json(await service.consent(actor(req),id(req),input.version,input.hash,input.granted));
}));
export default router;
