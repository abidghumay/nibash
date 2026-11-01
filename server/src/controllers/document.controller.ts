import { Request, Response } from "express";
import * as documentService from "../services/document.service.js";
import { uploadDocumentSchema } from "../schemas/document.schema.js";

export async function upload(req: Request, res: Response) {
  const parsed = uploadDocumentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0].message }); return; }
  const { document_type } = parsed.data;
  const files = (req.files as Express.Multer.File[]) ?? [];

  const result = await documentService.uploadListingDocument(
    req.params.id as string,
    req.user!.id,
    document_type,
    files,
  );
  res.status(201).json({ message: "document uploaded", ...result });
}

export async function list(req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  const documents = await documentService.getListingDocuments(
    req.params.id as string,
    req.user!.id,
  );
  res.json({ documents });
}

export async function verify(req: Request, res: Response) {
  const document = await documentService.verifyDocument(
    req.params.documentId as string,
    req.user!.id,
    req.body,
  );
  res.json({ message: "document verified", document });
}
