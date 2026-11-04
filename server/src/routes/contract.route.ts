import { Router } from "express";
import authMiddleware from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import * as contractController from "../controllers/contract.controller.js";
import conditionReportRoutes from "./conditionReport.route.js";
import moveOutInspectionRoutes from "./moveOutInspection.route.js";

const router = Router();
router.use("/:id/condition-report", conditionReportRoutes);
router.use("/:id/move-out-inspection", moveOutInspectionRoutes);

router.post("/", authMiddleware, asyncHandler(contractController.create));
router.get("/active", authMiddleware, asyncHandler(contractController.getActive));
router.get("/:id", authMiddleware, asyncHandler(contractController.getById));
router.patch("/:id", authMiddleware, asyncHandler(contractController.sign));

export default router;
