import { API_BASE_URL } from "./client";
export const bdt = (v: string | number | null | undefined) =>
  new Intl.NumberFormat("en-BD", {
    style: "currency",
    currency: "BDT",
    maximumFractionDigits: 2,
  }).format(Number(v ?? 0));
export const dhakaDate = (v: string | null | undefined) =>
  v
    ? new Date(v).toLocaleDateString("en-GB", {
        timeZone: "Asia/Dhaka",
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "Not recorded";
export const dmpLabel: Record<string, string> = {
  not_prepared: "Not prepared",
  prepared: "Prepared",
  submitted_manually_unverified: "Submitted manually — unverified",
};
export interface RentalContract {
  contract_id: number;
  tenant_id: number;
  owner_id: number;
  status: string;
  rent: string;
  effective_rent: string;
  advance_rent: string;
  security_deposit: string;
  initial_rent: string | null;
  tenancy_started_on: string | null;
  protection_until: string | null;
  protection_state: string;
  occupancy_state: string;
  start_date: string;
  end_date: string;
  move_out_date: string | null;
  tenant_name: string;
  tenant_email: string;
  tenant_phone: string;
  listing_title: string;
  listing_id?: number;
  property_address?: string;
  owner_closed_at?: string | null;
  tenant_closed_at?: string | null;
  inspection_note?: string | null;
  settlement_note?: string | null;
}
export interface RentalPayment {
  id: number;
  amount: string;
  category: string;
  status: string;
  outstanding_balance: string;
  confirmed_amount: string;
  advance_credit?: string;
  due_date: string | null;
  billing_month: string | null;
}
export interface RentalEvent {
  id: string;
  payment_id: number;
  amount: string;
  method: string;
  status: string;
  confirmed_at: string | null;
  reversal_id: string | null;
  reversal_reason: string | null;
  document_id: string | null;
}
export interface RentalDocument {
  id: string;
  kind: string;
  state: string;
  issued_at: string;
  pdf_sha256: string | null;
}
export interface RentalRevision {
  id: string;
  previous_rent: string;
  proposed_rent: string;
  effective_on: string;
  status: string;
}
export interface RentalDetails {
  payment_sandbox?: boolean;
  payment_sandbox_provider?: string;
  contract: RentalContract;
  payments: RentalPayment[];
  events: RentalEvent[];
  documents: RentalDocument[];
  revisions: RentalRevision[];
  notifications?: {
    id: number;
    title: string;
    body: string;
    created_at: string;
  }[];
  dmp: {
    status: string;
    submission_date?: string | null;
    self_reported_reference?: string | null;
  };
  dmp_guidance: { message: string; form_url: string; information_url: string };
  rules: {
    id: string;
    title: string;
    source_type: string;
    source_url: string | null;
    verification_status: string;
    assumptions: string;
  }[];
}
export async function downloadRentalDocument(id: string) {
  const token = localStorage.getItem("token");
  const response = await fetch(
    `${API_BASE_URL}/rental/documents/${id}/download`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );
  if (response.status === 202)
    throw new Error(
      "The PDF is being prepared. Retry shortly; the original snapshot is already saved.",
    );
  if (!response.ok)
    throw new Error(
      (await response.json().catch(() => ({}))).error ??
        "Document download failed",
    );
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `Nibash-${id}.pdf`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
