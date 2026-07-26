// Mock OCR adapter. Real provider (Dext / Veryfi / Textract) wires in Phase 7.
//
// The mock returns deterministic synthetic extraction so the capture UI can be
// exercised end-to-end. Real adapters return the same `OcrExtraction` shape.

import crypto from "node:crypto";

export type OcrExtraction = {
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null; // YYYY-MM-DD
  dueDate: string | null;
  subtotal: number | null;
  taxAmount: number | null;
  total: number | null;
  currency: string;
  confidence: number; // 0..1
};

export type CodingSuggestion = {
  expenseAccountNumber: string | null;
  departmentCode: string | null;
  taxCodeKey: string | null;
  confidence: number;
};

const MOCK_VENDORS = [
  { name: "Northside Course Maintenance", expense: "6020", dept: "COURSE", taxKey: "GST_5" },
  { name: "Premium Foods Co.",             expense: "5000", dept: "FB",     taxKey: "GST_5" },
  { name: "Tetra Insurance Brokers",       expense: "6430", dept: "ADMIN",  taxKey: "EXEMPT" },
  { name: "Highland Power Co.",            expense: "6310", dept: "CLUBHOUSE", taxKey: "GST_5" },
  { name: "Heritage Office Supplies",      expense: "6410", dept: "ADMIN",  taxKey: "GST_5" },
];

// The mock keys off filename so repeated uploads return stable values during
// development. A real adapter is free to ignore the filename.
export async function mockOcrExtract(filename: string, sizeBytes?: number): Promise<{ extraction: OcrExtraction; suggestion: CodingSuggestion }> {
  const seed = parseInt(crypto.createHash("sha256").update(filename + (sizeBytes ?? 0)).digest("hex").slice(0, 8), 16);
  const rng = mulberry32(seed);
  const vendor = MOCK_VENDORS[Math.floor(rng() * MOCK_VENDORS.length)];
  const subtotal = Math.round(50 + rng() * 2950); // $50–$3000
  const taxRate = vendor.taxKey === "GST_5" ? 0.05 : vendor.taxKey === "HST_13" ? 0.13 : 0;
  const taxAmount = Math.round(subtotal * taxRate * 100) / 100;
  const total = Math.round((subtotal + taxAmount) * 100) / 100;
  const today = new Date();
  const invoiceDate = isoDate(addDays(today, -Math.floor(rng() * 10)));
  const dueDate = isoDate(addDays(new Date(invoiceDate), 30));
  const invoiceNumber = "INV-" + Math.floor(rng() * 1_000_000).toString().padStart(6, "0");

  return {
    extraction: {
      vendorName: vendor.name,
      invoiceNumber,
      invoiceDate,
      dueDate,
      subtotal,
      taxAmount,
      total,
      currency: "CAD",
      confidence: 0.78 + rng() * 0.2,
    },
    suggestion: {
      expenseAccountNumber: vendor.expense,
      departmentCode: vendor.dept,
      taxCodeKey: vendor.taxKey,
      confidence: 0.7 + rng() * 0.25,
    },
  };
}

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
