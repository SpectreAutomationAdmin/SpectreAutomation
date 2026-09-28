// WI-2A (2026-09-27) — Work Intake review page scaffold data.
//
// Static, representative content that matches the approved review-page
// reference verbatim. Real Work Intake integration (extraction, vendor
// matching, GL suggestion, workflow transitions, Spectre AI) is
// deliberately DEFERRED — this slice is visual scaffolding only per §25.

export interface ReviewMetaChip {
  label: string;
  tone: "amber-outline" | "muted";
}

export interface ReviewWorkItem {
  slug: string;                    // route param (e.g. "row-1")
  status: "INTAKE";
  title: string;
  detectedAt: string;              // "Detected 2 hours ago"
  meta: ReviewMetaChip[];          // [amber-outline "Invoice", muted "Fairway Irrigation", muted "$48,750.00"]
}

export interface InvoiceLine {
  n: number;
  description: string;
  qty: number;
  unitPrice: string;
  amount: string;
  glCode: string;
}

export interface ClassificationRow {
  label: string;
  iconTone: "vendor" | "capex" | "irrigation" | "gl" | "project" | "cost-center" | "location";
  value: string;
  pill?: { label: string; tone: "confidence" | "matched" | "verified" };
  action?: { label: string; href: string };
}

export interface DocMetaRow {
  label: string;
  value: string;
  pill?: { label: string; tone: "verified" };
  iconTone?: "vendor";
}

export interface LineItemsSummary {
  count: number;
  total: string;
}

export interface ContextRow {
  category: string;
  title: string;
  meta: string;
  action?: { label: string; href: string };
}

export interface WorkflowStage {
  index: number;
  key: string;
  label: string;
  supporting: string;
  state: "done" | "active" | "pending";
}

export interface KeyInsight {
  body: string;
}

export interface Recommendation {
  body: string;
  iconTone: "blue" | "purple" | "gold";
}

export const REVIEW_WORK_ITEM: ReviewWorkItem = {
  slug: "row-1",
  status: "INTAKE",
  title: "Capital Invoice – Fairway irrigation controls",
  detectedAt: "Detected 2 hours ago",
  meta: [
    { label: "Invoice", tone: "amber-outline" },
    { label: "Fairway Irrigation", tone: "muted" },
    { label: "$48,750.00", tone: "muted" },
  ],
};

// The invoice preview reproduces the exact document shown on the
// left side of the Invoice Details card in the reference PNG.
export const INVOICE_PREVIEW = {
  brand: "FAIRWAY",
  brandSub: "IRRIGATION SYSTEMS LTD.",
  documentTitle: "INVOICE",
  vendor: {
    name: "Fairway Irrigation Controls Ltd.",
    address1: "5800 Golf Course Road",
    address2: "Calgary, AB T3A 2X1",
  },
  fields: [
    { label: "Invoice #",    value: "INV-88421" },
    { label: "Invoice Date", value: "May 12, 2024" },
    { label: "Due Date",     value: "Jun 11, 2024" },
    { label: "Terms",        value: "Net 30" },
  ],
  lines: [
    { description: "Central control unit",       qty: 1,  unitPrice: "$28,500.00", amount: "$28,500.00" },
    { description: "Satellite field modules",    qty: 12, unitPrice: "$1,250.00",  amount: "$15,000.00" },
    { description: "Installation & programming", qty: 1,  unitPrice: "$5,250.00",  amount: "$5,250.00"  },
  ],
  totals: [
    { label: "Subtotal",     value: "$48,750.00" },
    { label: "GST (5%)",     value: "$2,437.50"  },
    { label: "Total (CAD)",  value: "$51,187.50", strong: true },
  ],
  page: { current: 1, of: 3 },
};

// Extracted invoice information + classification rows shown on the
// right side of the Invoice Details card.
export const INVOICE_DOC_META: DocMetaRow[] = [
  { label: "Vendor",       value: "Fairway Irrigation Controls", iconTone: "vendor", pill: { label: "Verified vendor", tone: "verified" } },
  { label: "Invoice #",    value: "INV-88421" },
  { label: "Invoice Date", value: "May 12, 2024" },
  { label: "Due Date",     value: "Jun 11, 2024 (Net 30)" },
  { label: "Total Amount", value: "$48,750.00 USD" },
];

export const INVOICE_LINE_ITEMS_SUMMARY: LineItemsSummary = {
  count: 3,
  total: "$48,750.00",
};

export const INVOICE_CLASSIFICATION: ClassificationRow[] = [
  { label: "Category",      iconTone: "capex",       value: "Capital Expenditure" },
  { label: "Subclass",      iconTone: "irrigation",  value: "Irrigation Controls" },
  { label: "GL Suggestion", iconTone: "gl",          value: "1630 – Course Improvements", pill: { label: "92% confidence", tone: "confidence" } },
  { label: "Project",       iconTone: "project",     value: "Fairway Irrigation Upgrade (PRJ-1042)", pill: { label: "Matched", tone: "matched" } },
  { label: "Cost Center",   iconTone: "cost-center", value: "Course Operations", pill: { label: "Matched", tone: "matched" } },
  { label: "Location",      iconTone: "location",    value: "North Course", pill: { label: "Matched", tone: "matched" } },
];

export const INVOICE_LINES_TABLE: InvoiceLine[] = [
  { n: 1, description: "Central control unit",       qty: 1,  unitPrice: "$28,500.00", amount: "$28,500.00", glCode: "1630" },
  { n: 2, description: "Satellite field modules",    qty: 12, unitPrice: "$1,250.00",  amount: "$15,000.00", glCode: "1630" },
  { n: 3, description: "Installation & programming", qty: 1,  unitPrice: "$5,250.00",  amount: "$5,250.00",  glCode: "1630" },
];

export const CONTEXT_ROWS: ContextRow[] = [
  { category: "Vendor Status",         title: "Approved vendor",            meta: "Active since 2019  ·  12 prior invoices" },
  { category: "Project Match",         title: "Fairway Irrigation Upgrade", meta: "PRJ-1042  ·  87% match", action: { label: "View project", href: "#" } },
  { category: "Policy Check",          title: "Compliant",                  meta: "Within approval limits and procurement policy" },
  { category: "Similar Past Invoices", title: "4 similar invoices",         meta: "Last invoice: Feb 20, 2024  $32,100.00", action: { label: "View history", href: "#" } },
];

export const WORKFLOW_STAGES: WorkflowStage[] = [
  { index: 1, key: "intake",   label: "Intake",   supporting: "Extracted & categorized\n2 hours ago", state: "done"    },
  { index: 2, key: "review",   label: "Review",   supporting: "You are here",                          state: "active"  },
  { index: 3, key: "route",    label: "Route",    supporting: "Send for approval",                     state: "pending" },
  { index: 4, key: "execute",  label: "Execute",  supporting: "Post to ERP",                           state: "pending" },
  { index: 5, key: "complete", label: "Complete", supporting: "Notify stakeholders",                   state: "pending" },
];

export const REVIEW_TABS = [
  { key: "overview",       label: "Overview",       badge: null },
  { key: "documents",      label: "Documents",      badge: 3    },
  { key: "extracted-data", label: "Extracted Data", badge: null },
  { key: "related-work",   label: "Related Work",   badge: null },
  { key: "audit-trail",    label: "Audit Trail",    badge: null },
] as const;

export const SPECTRE_LEAD_MESSAGE =
  "Here’s what I found on this invoice and why I categorized it as a capital expenditure.";

export const KEY_INSIGHTS: KeyInsight[] = [
  { body: "Matches active project: Fairway Irrigation Upgrade (PRJ-1042)" },
  { body: "Vendor is approved and in good standing" },
  { body: "Items are capital in nature (control units and field modules)" },
  { body: "Similar invoices in the past have been coded to 1630 – Course Improvements" },
];

export const RECOMMENDATIONS: Recommendation[] = [
  { iconTone: "blue",   body: "Approve and route to Capital Approvals group" },
  { iconTone: "purple", body: "Assign to project PRJ-1042" },
  { iconTone: "gold",   body: "Post to GL 1630 – Course Improvements" },
];

export const SPECTRE_ASK_PLACEHOLDER = "Ask anything about this invoice…";
