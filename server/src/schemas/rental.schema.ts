import { z } from "zod";
export const money = z
  .union([z.string(), z.number()])
  .transform(String)
  .pipe(
    z
      .string()
      .regex(
        /^\d{1,10}(\.\d{1,2})?$/,
        "Use a non-negative BDT amount with at most two decimal places",
      ),
  );
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const date = new Date(v + "T00:00:00Z");
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === v
    );
  }, "Use a valid calendar date");
export const revisionSchema = z
  .object({
    rent: money.refine((v) => Number(v) > 0, "Rent must be positive"),
    effective_on: dateOnly,
  })
  .strict();
export const claimSchema = z
  .object({
    amount: money.optional(),
    request_key: z.string().min(1).max(120).optional(),
  })
  .strict();
export const dmpSchema = z
  .object({
    status: z.enum([
      "not_prepared",
      "prepared",
      "submitted_manually_unverified",
    ]),
    submission_date: dateOnly.nullable().optional(),
    self_reported_reference: z.string().trim().max(120).nullable().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.status === "submitted_manually_unverified" ||
      (!v.submission_date && !v.self_reported_reference),
    "Submission details apply only to self-reported manual submission",
  );
