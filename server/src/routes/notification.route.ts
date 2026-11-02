import { Router } from "express";
import { z } from "zod";
import authMiddleware from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import * as notifications from "../services/notification.service.js";

const router = Router();
const positiveId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(2147483647));
const querySchema = z.object({
  unread: z.enum(["true","false"]).optional(),
  before: positiveId.optional(),
}).strict();

router.use(authMiddleware);
router.get("/", asyncHandler(async (req,res) => {
  const query = querySchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid inbox filter or cursor" }); return; }
  res.json(await notifications.listNotifications(req.user!.id,query.data.unread === "true",query.data.before));
}));
router.get("/unread-count", asyncHandler(async (req,res) => {
  res.json({ count: await notifications.unreadCount(req.user!.id) });
}));
router.patch("/read-all", asyncHandler(async (req,res) => {
  await notifications.markAllNotificationsRead(req.user!.id);
  res.json({ message: "All messages marked as read" });
}));
router.patch("/:id", asyncHandler(async (req,res) => {
  const id = positiveId.safeParse(req.params.id);
  const body = z.object({ read: z.boolean() }).strict().safeParse(req.body);
  if (!id.success || !body.success) { res.status(400).json({ error: "Provide a valid message ID and read boolean" }); return; }
  res.json({ notification: await notifications.setNotificationRead(req.user!.id,id.data,body.data.read) });
}));

export default router;
