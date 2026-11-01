import { z } from "zod";

export const documentTypeEnum = z.enum([
  "dolil_deed",
  "electricity_bill_receipt",
  "holding_tax_receipt",
  "water_bill_receipt",
  "trade_license",
  "nid",
  "passport",
  "driving_license",
]);

export const uploadDocumentSchema = z.object({
  document_type: documentTypeEnum,
});

export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;

export const reviewDocumentSchema = z.object({
  upload_version: z.number().int().positive(),
  reason: z.string().trim().min(10, "Describe what you checked (at least 10 characters)").max(2000),
  override_ai: z.boolean().default(false),
});
