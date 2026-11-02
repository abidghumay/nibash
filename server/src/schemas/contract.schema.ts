import { z } from "zod";
import { money, dateOnly } from "./rental.schema.js";
export const createContractSchema = z
  .object({
    listing_id: z.number().int().positive(),
    tenant_id: z.number().int().positive(),
    start_date: dateOnly,
    end_date: dateOnly,
    rent: money.refine((v) => Number(v) > 0, "Rent must be positive"),
    electricity_bill: money,
    water_bill: money,
    service_charge: money,
    pet_allowed: z.boolean(),
    security_deposit: money
      .default("0")
      .refine(
        (v) => Number(v) === 0,
        "New security deposits are unsupported under Section 10; use zero",
      ),
    advance_rent: money.default("0"),
    monthly_due_date: z.number().int().min(1).max(28),
    previous_contract_id: z.number().int().positive().optional(),
  })
  .strict()
  .refine((v) => v.start_date < v.end_date, {
    message: "end_date must be after start_date",
    path: ["end_date"],
  });
export type CreateContractInput = z.infer<typeof createContractSchema>;
export const updateContractSchema = z
  .object({ status: z.literal("signed") })
  .strict();
export type UpdateContractInput = z.infer<typeof updateContractSchema>;
