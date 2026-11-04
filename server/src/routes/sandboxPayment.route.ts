import { Router, urlencoded } from "express";
import { z } from "zod";
import auth from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { AppError } from "../errors/AppError.js";
import { sandboxConfig } from "../services/shurjoPaySandbox.js";
import * as payments from "../services/sandboxPayments.service.js";
import { completeSimulation } from "../services/simulatedPaymentProvider.js";
const router = Router();
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});
router.get("/config", auth, (_req, res) =>
  res.json({ enabled: sandboxConfig().enabled }),
);
router.all(
  "/return",
  urlencoded({ extended: false, limit: "4kb" }),
  asyncHandler(async (req, res) => {
    const order = z
      .string()
      .min(1)
      .max(120)
      .safeParse(
        req.method === "GET" ? req.query.order_id : req.body?.order_id,
      );
    if (!order.success) throw new AppError(400, "Invalid sandbox return");
    await payments.wakeSandboxCallback(order.data);
    res
      .type("text")
      .send(
        "TEST checkout returned. Waiting for independent server verification. No real money transferred. Return to your Nibash rental tab to see status and acknowledgment.",
      );
  }),
);
router.use(auth);
router.post(
  "/attempts/:id/simulate",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    const body = z
      .object({
        outcome: z.enum(["succeeded", "failed", "cancelled"]),
        delay_seconds: z.number().int().min(2).max(120).default(2),
      })
      .strict()
      .safeParse(req.body);
    if (!id.success || !body.success)
      throw new AppError(400, "Invalid simulation request");
    await completeSimulation(
      req.user!.id,
      id.data,
      body.data.outcome,
      body.data.delay_seconds,
    );
    res
      .status(202)
      .json({
        message:
          "Simulated outcome scheduled; waiting for server verification. No real money transferred.",
      });
  }),
);
router.get(
  "/payments/:id",
  asyncHandler(async (req, res) => {
    const id = z
      .string()
      .regex(/^[1-9]\d{0,9}$/)
      .safeParse(req.params.id);
    if (!id.success) throw new AppError(400, "Invalid payment ID");
    res.json({
      attempts: await payments.listSandboxAttempts(req.user!.id, id.data),
    });
  }),
);
router.post(
  "/payments/:id",
  asyncHandler(async (req, res) => {
    const id = z
      .string()
      .regex(/^[1-9]\d{0,9}$/)
      .safeParse(req.params.id);
    if (
      !id.success ||
      !z
        .object({})
        .strict()
        .safeParse(req.body ?? {}).success
    )
      throw new AppError(
        400,
        "An existing payment ID is required; amounts come from the server",
      );
    res.status(202).json(await payments.initiateSandbox(req.user!.id, id.data));
  }),
);
router.post(
  "/attempts/:id/verify",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new AppError(400, "Invalid attempt");
    await payments.requestSandboxVerification(req.user!.id, id.data);
    res.status(202).json({ message: "Server verification queued" });
  }),
);
export default router;
