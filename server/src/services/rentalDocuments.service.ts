import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import PDFDocument from "pdfkit";
import { pool } from "../db/pool.js";

export interface RentalDocument {
  id: string;
  kind: string;
  issued_at: Date | string;
  snapshot: Record<string, unknown>;
  lease_token?: string;
  attempts: number;
}
const hash = (v: Buffer | string) =>
  createHash("sha256").update(v).digest("hex");
const label: Record<string, string> = {
  draft: "DRAFT — rental agreement",
  agreement: "Accepted rental agreement",
  amendment: "Accepted rent amendment",
  acknowledgment: "Electronic payment acknowledgment",
  reversal: "Payment reversal acknowledgment",
};
export function formatRentalField(name: string, value: unknown): string {
  if (value === null || value === undefined) return "Not recorded";
  if (
    [
      "Confirmed at",
      "Owner proposal audit",
      "Tenant acceptance audit",
      "Tenant accepted at",
      "Reversed at",
    ].includes(name)
  ) {
    const date = new Date(String(value));
    if (!Number.isNaN(date.getTime()))
      return (
        date.toLocaleString("en-GB", { timeZone: "Asia/Dhaka" }) +
        " (Asia/Dhaka)"
      );
  }
  return String(value);
}
export async function renderRentalPdf(row: RentalDocument): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: "A4",
    margin: 48,
    bufferPages: true,
    info: {
      Title: label[row.kind],
      Author: "Nibash",
      CreationDate: new Date(row.issued_at),
    },
  });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    pdf.on("data", (b) => chunks.push(b));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  pdf.registerFont(
    "text",
    resolve(__dirname, "../../assets/fonts/NotoSans.ttf"),
  );
  pdf.registerFont(
    "bangla",
    resolve(__dirname, "../../assets/fonts/NotoSansBengali.ttf"),
  );
  const line = (value: string, size = 10, color = "#233444") => {
    pdf
      .font(/[\u0980-\u09ff]/.test(value) ? "bangla" : "text")
      .fontSize(size)
      .fillColor(color)
      .text(value, { lineGap: 5 });
  };
  line("NIBASH", 27, "#163c37");
  line("RENTAL RECORDS  /  BANGLADESH", 9, "#536963");
  pdf.moveDown();
  line(label[row.kind] ?? row.kind, 20);
  line("Document NIBASH-" + row.id + "  •  Currency BDT", 10);
  line(
    "Issued " +
      new Date(row.issued_at).toLocaleString("en-GB", {
        timeZone: "Asia/Dhaka",
      }) +
      " (Asia/Dhaka)",
    9,
  );
  pdf.moveDown();
  const s = row.snapshot;
  if (s.test_payment) line('TEST PAYMENT — no real money transferred; no landlord payout.', 14, '#9c381b');
  const fields: Array<[string, unknown]> = [
    ["Contract reference", s.contract_id],
    ["Landlord", s.owner_name],
    ["Tenant", s.tenant_name],
    ["Property", s.property],
    ["Unit / address available in Nibash", s.address],
    ["Agreement start", s.start_date],
    ["Agreement end", s.end_date],
  ];
  if (row.kind === "acknowledgment" || row.kind === "reversal")
    fields.push(
      ["Payment ID", s.payment_id],
      ["Confirmation event", s.event_id],
      ["Category", s.category],
      ["Billing period", s.billing_month ?? "Not period-specific"],
      [s.test_payment ? "TEST amount (BDT)" : "Amount actually received (BDT)", s.amount_received],
      ["Outstanding at this event (BDT)", s.outstanding_balance],
      ["Method", s.payment_method],
      ["Confirmed at", s.confirmed_at],
      ["Authenticated issuer", s.provider === 'simulated' ? 'Nibash development simulator' : s.issuer_name],
      ["Confirmation detail", s.confirmation],
    );
  else
    fields.push(
      ["Monthly rent (BDT)", s.monthly_rent],
      ["Electricity (BDT)", s.electricity_bill],
      ["Water (BDT)", s.water_bill],
      ["Recurring service charge (BDT)", s.service_charge],
      ["Monthly due day", s.monthly_due_date],
      ["Pets allowed", s.pet_allowed],
      ["Advance rent (BDT)", s.advance_rent],
      [
        "Historical deposit record (BDT; no lawfulness asserted)",
        s.historical_deposit,
      ],
      [
        "Original protected rent (BDT)",
        s.initial_rent ?? "Awaiting acceptance / verification",
      ],
      ["Continuing tenancy begins", s.tenancy_started_on],
      ["Increase eligible from", s.protection_until],
      ["Owner proposal audit", s.owner_proposed_at],
      ["Tenant acceptance audit", s.tenant_accepted_at],
    );
  if (row.kind === "amendment")
    fields.push(
      ["Previous effective rent (BDT)", s.previous_rent],
      ["Accepted revised rent (BDT)", s.revised_rent],
      ["Revision effective on", s.effective_on],
      ["Tenant accepted at", s.accepted_at],
    );
  if (row.kind === "reversal")
    fields.push(
      ["Original document", s.original_document_id],
      ["Reversal reason", s.reversal_reason],
      ["Reversed at", s.reversed_at],
    );
  const width = (pdf.page.width - 112) / 2;
  for (let index = 0; index < fields.length; index += 2) {
    const pair = fields.slice(index, index + 2);
    const prepared = pair.map(([name, value]) => ({
      name,
      value: formatRentalField(name, value),
    }));
    const height = Math.max(
      ...prepared.map((field) => {
        pdf.font("text").fontSize(8);
        const title = pdf.heightOfString(field.name.toUpperCase(), { width });
        pdf
          .font(/[\u0980-\u09ff]/.test(field.value) ? "bangla" : "text")
          .fontSize(10);
        return title + pdf.heightOfString(field.value, { width, lineGap: 3 }) + (s.test_payment ? 12 : 17);
      }),
    );
    if (pdf.y + height > 710) {
      pdf.addPage();
      line("NIBASH  /  CONTINUED RECORD NIBASH-" + row.id, 10);
      pdf.moveDown();
    }
    const top = pdf.y;
    prepared.forEach((field, column) => {
      const x = 48 + column * (width + 16);
      pdf
        .font("text")
        .fontSize(8)
        .fillColor("#536963")
        .text(field.name.toUpperCase(), x, top, { width });
      const valueTop = pdf.y + 3;
      pdf
        .font(/[\u0980-\u09ff]/.test(field.value) ? "bangla" : "text")
        .fontSize(10)
        .fillColor("#233444")
        .text(field.value, x, valueTop, { width, lineGap: 3 });
    });
    pdf.x = 48;
    pdf.y = top + height;
  }
  pdf.moveDown();
  line(
    "Nibash 24-month protection is a contractual platform policy. This document does not certify legal validity, government verification, a registered lease or a recognized digital signature.",
    9,
  );
  if (row.kind === "draft")
    line(
      "DRAFT: This proposal has not been accepted by the tenant.",
      11,
      "#9c381b",
    );
  if (row.kind === "acknowledgment")
    line(
      s.provider === 'simulated' ? "Simulated payment — no real money transferred. This development demonstration is not an official gateway verification or a receipt for real rent."
        : s.test_payment ? "TEST acknowledgment of independent sandbox verification. This is not a receipt for real rent or a landlord settlement." : "This electronic acknowledgment records an authenticated landlord confirmation. Statutory signed receipt requirements require separate review.",
      9,
    );
  line(
    "Source: Premises Rent Control Act 1991 (Sections 10, 13, 15–16, 18); Transfer of Property Act 1882 Section 107. https://bdlaws.minlaw.gov.bd/act-print-748.html",
    8,
  );
  line("Snapshot SHA-256: " + hash(JSON.stringify(s)), 8);
  line(
    "Generated through Nibash. The original snapshot and PDF are retained privately.",
    8,
  );
  const pages = pdf.bufferedPageRange();
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    pdf.switchToPage(i);
    const bottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf
      .font("text")
      .fontSize(8)
      .fillColor("#536963")
      .text(
        `NIBASH-${row.id}  |  Page ${i + 1} of ${pages.count}`,
        48,
        pdf.page.height - 30,
        { lineBreak: false },
      );
    pdf.page.margins.bottom = bottom;
  }
  pdf.end();
  return result;
}

export async function processOneRentalDocument(
  renderer = renderRentalPdf,
): Promise<boolean> {
  const token = randomUUID();
  const claimed = await pool.query(
    `UPDATE rental_documents SET state='running',attempts=attempts+1,lease_token=$1,lease_until=now()+interval '2 minutes'
    WHERE id=(SELECT id FROM rental_documents WHERE (state='queued' AND retry_at<=now()) OR (state='running' AND lease_until<=now())
      ORDER BY retry_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,kind,issued_at,snapshot,attempts`,
    [token],
  );
  if (!claimed.rows.length) return false;
  const doc = claimed.rows[0] as RentalDocument;
  try {
    const bytes = await renderer(doc);
    await pool.query(
      `UPDATE rental_documents SET state='ready',pdf_bytes=$1,pdf_sha256=$2,snapshot_sha256=$3,generated_at=now(),lease_token=NULL,lease_until=NULL
      WHERE id=$4 AND lease_token=$5 AND state='running'`,
      [bytes, hash(bytes), hash(JSON.stringify(doc.snapshot)), doc.id, token],
    );
  } catch {
    await pool.query(
      `UPDATE rental_documents SET state='queued',lease_token=NULL,lease_until=NULL,retry_at=now()+interval '30 seconds' * $1
      WHERE id=$2 AND lease_token=$3 AND state='running'`,
      [Math.min(120, 2 ** Math.min(doc.attempts, 6)), doc.id, token],
    );
    console.error(
      "Rental PDF generation failed; retry scheduled",
      String(doc.id),
    );
  }
  return true;
}
export function startRentalDocumentWorker() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (let n = 0; n < 10 && (await processOneRentalDocument()); n++) {}
    } catch {
      console.error("Rental document worker unavailable");
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 5000);
  timer.unref();
  return () => clearInterval(timer);
}
