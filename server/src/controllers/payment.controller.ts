import { Request, Response } from "express";
import {
  createPaymentSchema,
  updatePaymentSchema,
} from "../schemas/payment.schema.js";
import * as paymentService from "../services/payment.service.js";
import { claimSchema } from '../schemas/rental.schema.js';

export async function create(req: Request, res: Response) {
  if (!req.user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const result = createPaymentSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: result.error.issues[0].message });
    return;
  }
  await paymentService.createPayment(req.user.id, result.data);
  res.json({ message: "payment posted successfully" });
}

export async function getForContract(req: Request, res: Response) {
  if (!req.user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const payments = await paymentService.getPaymentsForContract(
    req.user.id,
    req.params.contract_id as string,
  );
  res.json({ payments });
}

export async function resolve(req: Request, res: Response) {
  if (!req.user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const result = updatePaymentSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: result.error.issues[0].message });
    return;
  }
  await paymentService.resolvePayment(
    req.user.id,
    req.params.payment_id as string,
    result.data.status,
  );
  res.json({ message: "payment updated successfully" });
}

export async function payByCash(req: Request, res: Response) {
  if (!req.user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const parsed=claimSchema.safeParse(req.body??{});
  if(!parsed.success){res.status(400).json({error:parsed.error.issues[0].message});return;}
  await paymentService.payByCash(req.user.id, req.params.payment_id as string,parsed.data.amount,parsed.data.request_key);
  res.json({ message: "marked as paid by cash, awaiting owner verification" });
}

export async function rejectCash(req: Request, res: Response) {
  if (!req.user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  await paymentService.rejectCash(req.user.id, req.params.payment_id as string);
  res.json({ message: "cash payment claim rejected, payment method reset to null" });
}
