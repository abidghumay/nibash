import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import authMiddleware from "../middleware/auth.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { AppError } from "../errors/AppError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { moveOutInspections as service } from "../services/moveOutInspections.service.js";
import { MAX_CONDITION_BYTES } from "../services/conditionImages.js";

const router=Router({mergeParams:true});
const positive=z.coerce.number().int().positive().max(2147483647),versioned=z.object({version:positive}).strict();
const notes=z.string().trim().max(1000),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)throw new AppError(400,result.error.issues[0]?.message??"Invalid inspection input");return result.data;}
const id=(req:Request)=>parse(positive,req.params.id),actor=(req:Request)=>req.user!.id,photo=(req:Request)=>parse(positive,req.params.photoId);
router.use(authMiddleware);
router.use(async(req:Request,res:Response,next:NextFunction)=>{
  res.setHeader("Cache-Control","private, no-store");res.setHeader("Referrer-Policy","no-referrer");
  try{if(Object.keys(req.query).length)throw new AppError(400,"Query parameters and storage paths are not accepted");await service.authorize(actor(req),id(req));next();}
  catch(error){if(error instanceof AppError)res.status(error.statusCode).json({error:error.message});else res.status(500).json({error:"Move-out inspections are unavailable"});}
});
router.use(createRateLimiter({windowMs:60000,max:120}));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_CONDITION_BYTES,files:1,fields:4,parts:5,fieldSize:4096}});
const multipart=(req:Request,res:Response,next:NextFunction)=>upload.single("photo")(req,res,error=>{if(error){res.status(error instanceof multer.MulterError&&error.code==="LIMIT_FILE_SIZE"?413:400).json({error:"Upload one JPEG or PNG photograph, at most 8 MiB, with version, room_id, optional baseline_photo_id and notes"});return;}next();});
router.get("/",asyncHandler(async(req,res)=>{res.json(await service.get(actor(req),id(req)));}));
router.post("/",asyncHandler(async(req,res)=>{parse(z.object({}).strict(),req.body??{});res.status(201).json(await service.create(actor(req),id(req)));}));
router.post("/rooms",asyncHandler(async(req,res)=>{const p=parse(versioned.extend({name:z.string().trim().min(1).max(80)}),req.body);res.status(201).json(await service.addRoom(actor(req),id(req),p.version,p.name));}));
router.post("/photos",multipart,asyncHandler(async(req,res)=>{
  const p=parse(versioned.extend({room_id:positive,baseline_photo_id:positive.optional(),notes:notes.default("")}),req.body);if(!req.file)throw new AppError(400,"Choose a JPEG or PNG photograph");
  res.status(201).json(await service.addPhoto(actor(req),id(req),p.version,p.room_id,req.file.buffer,req.file.originalname,req.file.mimetype,p.notes,p.baseline_photo_id));
}));
router.post("/photos/:photoId/remove",asyncHandler(async(req,res)=>{const p=parse(versioned,req.body);res.json(await service.removePhoto(actor(req),id(req),p.version,photo(req)));}));
router.get("/photos/:photoId/url",asyncHandler(async(req,res)=>{res.json(await service.photoUrl(actor(req),id(req),photo(req)));}));
router.post("/submit",asyncHandler(async(req,res)=>{const p=parse(versioned.extend({analyze:z.boolean(),consent:z.boolean()}),req.body);res.json(await service.submit(actor(req),id(req),p.version,p.analyze,p.consent));}));
router.post("/ai-consent",asyncHandler(async(req,res)=>{const p=parse(versioned.extend({hash:z.string().regex(/^[a-f0-9]{64}$/),granted:z.boolean()}),req.body);res.json(await service.consent(actor(req),id(req),p.version,p.hash,p.granted));}));
router.post("/analyze",asyncHandler(async(req,res)=>{const p=parse(versioned,req.body);res.json(await service.analyze(actor(req),id(req),p.version));}));
router.post("/reviews",asyncHandler(async(req,res)=>{const p=parse(versioned.extend({finding_id:z.string().min(1).max(100),decision:z.enum(["no_issue","acceptable","confirmed_difference","unable_to_verify"]),notes:notes.default("")}),req.body);res.json(await service.review(actor(req),id(req),p.version,p.finding_id,p.decision,p.notes));}));
router.post("/observations",asyncHandler(async(req,res)=>{const p=parse(versioned.extend({room_id:positive.optional(),notes:notes.min(1),requires_review:z.boolean().default(false)}),req.body);res.json(await service.addObservation(actor(req),id(req),p.version,p.room_id,p.notes,p.requires_review));}));
router.post("/resolve",asyncHandler(async(req,res)=>{const p=parse(versioned.extend({notes:notes.min(1)}),req.body);res.json(await service.resolve(actor(req),id(req),p.version,p.notes));}));
router.post("/vacancy",asyncHandler(async(req,res)=>{const p=parse(versioned.extend({move_out_date:date}),req.body);res.json(await service.vacancy(actor(req),id(req),p.version,p.move_out_date));}));
router.post("/approve",asyncHandler(async(req,res)=>{const p=parse(versioned.extend({vacated:z.literal(true),accepted:z.literal(true),move_out_date:date}),req.body);res.json(await service.approve(actor(req),id(req),p.version,p.vacated,p.accepted,p.move_out_date));}));
export default router;
