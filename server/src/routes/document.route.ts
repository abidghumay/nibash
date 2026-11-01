import { Router } from "express";
import authMiddleware from "../middleware/auth.js";
import { requireVerifier } from "../middleware/verifier.js";
import { upload } from "../middleware/upload.js";
import * as documentController from "../controllers/document.controller.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();
const parseDocumentUpload = upload.array("files", 1);

router.post(
  "/listings/:id",
  authMiddleware,
  (req, res, next) => parseDocumentUpload(req, res, error => {
    if (error) {
      res.status(400).json({ error: "Upload one JPEG, PNG, WebP or complete PDF up to 5 MB" });
      return;
    }
    next();
  }),
  asyncHandler(documentController.upload),
);

// Owner-or-verifier check happens inside the service.
router.get(
  "/listings/:id",
  authMiddleware,
  asyncHandler(documentController.list),
);

router.post(
  "/:documentId/verify",
  authMiddleware,
  requireVerifier,
  asyncHandler(documentController.verify),
);

export default router;
