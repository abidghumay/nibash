import { Router } from "express";
import { z } from "zod";
import auth from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { pool } from "../db/pool.js";
import { AppError } from "../errors/AppError.js";
import {
  dateOnly,
  dmpSchema,
  revisionSchema,
} from "../schemas/rental.schema.js";
import * as management from "../services/rentalManagement.service.js";
import { rentalRules } from "../services/rentalRules.js";
const router = Router();
router.use(auth);
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});
const id = z.string().regex(/^[1-9]\d{0,14}$/);
router.param("id", (req, res, next, value) => {
  if (!id.safeParse(value).success) {
    res.status(400).json({ error: "Invalid record identifier" });
    return;
  }
  next();
});
router.get("/rules", (_req, res) => {
  res.json({ rules: rentalRules });
});
router.get(
  "/tenants",
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        page: z.coerce.number().int().min(1).max(100000).default(1),
        limit: z.coerce.number().int().min(1).max(50).default(20),
        group: z.enum(["all", "current", "upcoming", "former"]).default("all"),
      })
      .safeParse(req.query);
    if (!parsed.success)
      throw new AppError(400, "Invalid tenant list pagination or group");
    res.json(
      await management.listMyTenants(
        req.user!.id,
        parsed.data.page,
        parsed.data.limit,
        parsed.data.group,
      ),
    );
  }),
);
router.get(
  "/contracts/:id",
  asyncHandler(async (req, res) => {
    res.json(
      await management.rentalDetails(req.user!.id, req.params.id as string),
    );
  }),
);
router.post(
  "/contracts/:id/revisions",
  asyncHandler(async (req, res) => {
    const input = revisionSchema.safeParse(req.body);
    if (!input.success) throw new AppError(400, input.error.issues[0].message);
    const result = await pool.query(
      "SELECT propose_rent_revision($1,$2,$3,$4) AS id",
      [req.user!.id, req.params.id, input.data.rent, input.data.effective_on],
    );
    res.status(201).json(result.rows[0]);
  }),
);
router.patch(
  "/revisions/:id",
  asyncHandler(async (req, res) => {
    const input = z
      .object({ accept: z.boolean() })
      .strict()
      .safeParse(req.body);
    if (!input.success)
      throw new AppError(400, "Choose acceptance or rejection explicitly");
    await pool.query("SELECT accept_rent_revision($1,$2,$3)", [
      req.user!.id,
      req.params.id,
      input.data.accept,
    ]);
    res.json({ message: "Review recorded" });
  }),
);
router.patch(
  "/contracts/:id/dmp",
  asyncHandler(async (req, res) => {
    const input = dmpSchema.safeParse(req.body);
    if (!input.success) throw new AppError(400, input.error.issues[0].message);
    await management.updateDmp(
      req.user!.id,
      req.params.id as string,
      input.data,
    );
    res.json({ message: "Self-reported preparation status saved" });
  }),
);
router.post(
  "/contracts/:id/correction",
  asyncHandler(async (req, res) => {
    const input = z
      .object({ message: z.string().trim().min(10).max(1000) })
      .strict()
      .safeParse(req.body);
    if (!input.success)
      throw new AppError(
        400,
        "Provide a correction request of 10–1000 characters without identity document numbers",
      );
    await management.requestCorrection(
      req.user!.id,
      req.params.id as string,
      input.data.message,
    );
    res
      .status(201)
      .json({ message: "Correction request sent to the landlord" });
  }),
);
router.post(
  "/contracts/:id/close",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        move_out_date: dateOnly,
        inspection_note: z.string().trim().min(5).max(1000),
        settlement_note: z.string().trim().min(5).max(1000),
      })
      .strict()
      .safeParse(req.body);
    if (!input.success)
      throw new AppError(
        400,
        "Provide the move-out date and explicit inspection and settlement records",
      );
    await management.closeRental(
      req.user!.id,
      req.params.id as string,
      input.data,
    );
    res.json({
      message: "Move-out confirmation recorded; closure requires both parties",
    });
  }),
);
router.post(
  "/events/:id/reversal",
  asyncHandler(async (req, res) => {
    const input = z
      .object({ reason: z.string().trim().min(5).max(500) })
      .strict()
      .safeParse(req.body);
    if (!input.success) throw new AppError(400, "Provide a reversal reason");
    await pool.query("SELECT reverse_rental_payment($1,$2,$3)", [
      req.user!.id,
      req.params.id,
      input.data.reason,
    ]);
    res
      .status(201)
      .json({
        message: "Linked reversal recorded; original acknowledgment retained",
      });
  }),
);
router.post(
  "/events/:id/confirm",
  asyncHandler(async (req, res) => {
    await pool.query("SELECT confirm_rental_payment($1,$2)", [
      req.user!.id,
      req.params.id,
    ]);
    res.json({
      message: "Authenticated receipt of this installment confirmed",
    });
  }),
);
router.get(
  "/documents/:id/download",
  asyncHandler(async (req, res) => {
    // Do not fetch the private bytes before establishing party/management authorization.
    const allowed = await pool.query(
      `SELECT d.id FROM rental_documents d JOIN contracts c ON c.id=d.contract_id JOIN listings l ON l.id=c.listing_id
    WHERE d.id=$1 AND ($2=d.owner_id OR $2=d.tenant_id OR $2=l.owner_id)`,
      [req.params.id, req.user!.id],
    );
    if (!allowed.rows.length)
      throw new AppError(
        403,
        "Not authorized to download this private document",
      );
    const doc = (
      await pool.query(
        "SELECT id,state,pdf_bytes,pdf_sha256 FROM rental_documents WHERE id=$1",
        [req.params.id],
      )
    ).rows[0];
    if (doc.state !== "ready") {
      res.setHeader("Retry-After", "5");
      res
        .status(202)
        .json({ message: "Document is being prepared; retry shortly" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="Nibash-${doc.id}.pdf"`,
    );
    res.setHeader("X-Document-SHA256", doc.pdf_sha256);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(Buffer.from(doc.pdf_bytes));
  }),
);
export default router;
