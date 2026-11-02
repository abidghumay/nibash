export interface RentalRule {
  id: string;
  title: string;
  jurisdiction: string;
  source_type: "statute" | "official_guidance" | "nibash_policy";
  source_url: string | null;
  source_version: string;
  effective_date: string | null;
  assumptions: string;
  enforcement: "block" | "warn" | "informational";
  verification_status: string;
}
const act = "https://bdlaws.minlaw.gov.bd/act-print-748.html";
export const rentalRules: RentalRule[] = [
  {
    id: "NIBASH-24M-v1",
    title: "24 calendar months of continuing-tenancy rent protection",
    jurisdiction: "Nibash residential agreements",
    source_type: "nibash_policy",
    source_url: null,
    source_version: "2026-11-03",
    effective_date: null,
    assumptions:
      "New accepted agreements with established continuity. No retrospective certification. Ordinary rent increases require tenant acceptance; recurring charges cannot bypass protection.",
    enforcement: "block",
    verification_status: "Product policy; not a blanket statutory prohibition",
  },
  {
    id: "BD-PRCA-10",
    title: "Advance rent and prohibited additional payments — Section 10",
    jurisdiction: "Bangladesh; ordinary residential workflow",
    source_type: "statute",
    source_url: act,
    source_version: "1991 Act 3, Section 10",
    effective_date: null,
    assumptions:
      "Ordinary tenancies. No security deposits; advance above one month requires prior Controller approval. Exceptions unsupported in this MVP.",
    enforcement: "block",
    verification_status:
      "Official source located; applicability and statutory exceptions require case-specific review",
  },
  {
    id: "BD-PRCA-13",
    title: "Signed rent receipts — Section 13",
    jurisdiction: "Bangladesh",
    source_type: "statute",
    source_url: act,
    source_version: "1991 Act 3, Section 13",
    effective_date: null,
    assumptions:
      "MVP provides an attributed electronic payment acknowledgment. Statutory prescribed-form and signature compliance not established.",
    enforcement: "warn",
    verification_status: "Signature and prescribed form require legal review",
  },
  {
    id: "BD-PRCA-15-16",
    title: "Standard rent and Controller redetermination",
    jurisdiction: "Bangladesh",
    source_type: "statute",
    source_url: act,
    source_version: "1991 Act 3, Sections 15–16",
    effective_date: null,
    assumptions:
      "Section 16(2) concerns Controller redetermination after two years. It is not represented as a universal rent freeze.",
    enforcement: "informational",
    verification_status: "Official source located; human review required",
  },
  {
    id: "BD-PRCA-18",
    title: "Protection against eviction",
    jurisdiction: "Bangladesh",
    source_type: "statute",
    source_url: act,
    source_version: "1991 Act 3, Section 18",
    effective_date: null,
    assumptions:
      "Contract expiry does not establish vacancy or authorize eviction. No automated eviction decisions.",
    enforcement: "informational",
    verification_status:
      "Official source located; no legal eligibility determination",
  },
  {
    id: "BD-LEASE-107",
    title: "Lease registration and execution",
    jurisdiction: "Bangladesh",
    source_type: "statute",
    source_url:
      "https://bdlaws.minlaw.gov.bd/act-print-48/section-print-16322.html",
    source_version: "Transfer of Property Act 1882, Section 107",
    effective_date: null,
    assumptions:
      "Terms exceeding one year, year-to-year leases or yearly rent generally require a registered instrument. PDF/account acceptance is not registration.",
    enforcement: "warn",
    verification_status:
      "Official text verified; legal execution review required",
  },
  {
    id: "DNCC-2026",
    title: "DNCC January 2026 rental guidance",
    jurisdiction: "Dhaka North City Corporation",
    source_type: "official_guidance",
    source_url:
      "https://dncc.gov.bd/pages/policies/ভাড়াটিয়ার-অধিকার-নিশ্চিতে-বাড়ি-ভাড়া-নিয়ন্ত্রণ-আইন-১৯৯১-নিয়ন্ত্রকের-পক্ষে-ঢাকা-উত্তর-সিটি-কর্পোরেশন-প্রদত্ত-নির্দেশিকা-th5xxz-6970cf60598009fd5873d86d",
    source_version: "Published 2026-01-21",
    effective_date: null,
    assumptions:
      "Published listing located. Attached policy and subsequent clarification need full legal review; no independent nationwide enforcement or June–July-only rule.",
    enforcement: "informational",
    verification_status:
      "Publication verified; attachment and clarification not fully verified",
  },
  {
    id: "DMP-CIMS",
    title: "DMP tenant information preparation",
    jurisdiction: "Dhaka Metropolitan Police area",
    source_type: "official_guidance",
    source_url: "https://dmp.gov.bd/citizen-info-management-system/",
    source_version: "Official DMP public information; checked 2026-11-03",
    effective_date: null,
    assumptions:
      "Preparation and self-reported manual tracking only. Official form requirements not fully retrieved; no extra identity/household data collected or exported.",
    enforcement: "informational",
    verification_status:
      "Official form page located; CIMS page unavailable during retrieval; no integration established",
  },
];
