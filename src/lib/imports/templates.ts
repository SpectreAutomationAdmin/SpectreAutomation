// Import-template metadata — server-and-client safe.
//
// Holds the per-domain UX payload the New Batch screen surfaces in
// the reusable helper card:
//
//   • the display name (e.g. "Chart of Accounts" instead of "COA")
//   • the canonical column headers
//   • a short paragraph describing what the domain imports
//   • column-by-column field docs (so an admin filling out a
//     spreadsheet doesn't have to read source code to know what
//     `fsGroupKey` means)
//   • 5–10 example rows used as the downloadable template body and
//     the inline "View Sample" preview
//
// This module is intentionally free of Prisma / DB / RBAC imports
// so it can be consumed by both the server action that creates
// batches and the client component that renders the helper card.

export type ImportDomain =
  | "MEMBERS"
  | "VENDORS"
  | "COA"
  | "OPENING_TRIAL_BALANCE"
  | "INVENTORY"
  | "EMPLOYEES"
  | "EVENTS"
  | "AR_HISTORY";

export type ImportFieldDoc = {
  /** Column name as it appears in the CSV header row. */
  name: string;
  /** Short, founder-friendly description. */
  description: string;
  /** Example value the admin will recognise. */
  example?: string;
  /** True for required columns; false / undefined for optional. */
  required?: boolean;
};

export type ImportTemplateMetadata = {
  domain: ImportDomain;
  /** Sentence-case label for headers / breadcrumbs. */
  displayName: string;
  /** One-sentence summary of what this domain imports. */
  blurb: string;
  /** Canonical CSV header row. */
  headers: ReadonlyArray<string>;
  /** Per-column documentation (founder-readable). */
  fields: ReadonlyArray<ImportFieldDoc>;
  /** Example rows (parallel to `headers`). */
  sampleRows: ReadonlyArray<ReadonlyArray<string>>;
};

// ---------------------------------------------------------------------------
// Per-domain registry.
// ---------------------------------------------------------------------------

export const IMPORT_TEMPLATE_METADATA: Record<ImportDomain, ImportTemplateMetadata> = {
  MEMBERS: {
    domain: "MEMBERS",
    displayName: "Members",
    blurb: "Member roster — names, contacts, membership category, and join date.",
    headers: ["memberNumber", "firstName", "lastName", "email", "phone", "membershipCategory", "joinDate", "status"],
    fields: [
      { name: "memberNumber", description: "Unique member identifier used across the system.", example: "M-001", required: true },
      { name: "firstName", description: "Member's first name.", example: "Jane", required: true },
      { name: "lastName", description: "Member's last name.", example: "Doe", required: true },
      { name: "email", description: "Primary email; used for portal invitations and statements.", example: "jane.doe@example.com" },
      { name: "phone", description: "Primary phone, any common North American format.", example: "(403) 555-1234" },
      { name: "membershipCategory", description: "Category name as configured under Admin → Members → Categories.", example: "Full Golf" },
      { name: "joinDate", description: "ISO date the member joined (YYYY-MM-DD).", example: "2018-04-15" },
      { name: "status", description: "ACTIVE, PROVISIONAL, INACTIVE, or SUSPENDED.", example: "ACTIVE" },
    ],
    sampleRows: [
      ["M-001", "Jane", "Doe", "jane.doe@example.com", "(403) 555-1234", "Full Golf", "2018-04-15", "ACTIVE"],
      ["M-002", "Robert", "Chen", "robert.chen@example.com", "(403) 555-2345", "Social", "2020-08-01", "ACTIVE"],
      ["M-003", "Priya", "Singh", "priya.singh@example.com", "(403) 555-3456", "Full Golf", "2014-06-22", "ACTIVE"],
      ["M-004", "Mike", "Anderson", "mike.anderson@example.com", "(403) 555-4567", "Intermediate", "2023-03-10", "PROVISIONAL"],
      ["M-005", "Sarah", "Tremblay", "sarah.tremblay@example.com", "(403) 555-5678", "Junior", "2024-05-01", "ACTIVE"],
    ],
  },

  VENDORS: {
    domain: "VENDORS",
    displayName: "Vendors",
    blurb: "Vendor master — payment terms, contact, default GL coding for invoices.",
    headers: ["legalName", "displayName", "email", "phone", "paymentTermsDays", "paymentMethod", "defaultExpenseAccountNumber", "defaultTaxCodeKey"],
    fields: [
      { name: "legalName", description: "Vendor's legal entity name (matches the cheque payee).", example: "Greenline Turf Supplies Ltd.", required: true },
      { name: "displayName", description: "Short label used in AP screens.", example: "Greenline Turf" },
      { name: "email", description: "AP contact email for remittance advice.", example: "ap@greenlineturf.example.com" },
      { name: "phone", description: "AP contact phone.", example: "(403) 555-7777" },
      { name: "paymentTermsDays", description: "Net days the vendor expects for payment.", example: "30" },
      { name: "paymentMethod", description: "EFT, CHEQUE, CARD, or CASH.", example: "EFT" },
      { name: "defaultExpenseAccountNumber", description: "GL account number applied to vendor invoices by default.", example: "7000" },
      { name: "defaultTaxCodeKey", description: "Tax code key — e.g. GST_5, HST_13, ZERO.", example: "GST_5" },
    ],
    sampleRows: [
      ["Greenline Turf Supplies Ltd.", "Greenline Turf", "ap@greenline.example.com", "(403) 555-7777", "30", "EFT", "7000", "GST_5"],
      ["Western Power & Light", "Western P&L", "billing@wpl.example.com", "(403) 555-8888", "15", "EFT", "7100", "GST_5"],
      ["Mountain View Linen Co.", "MV Linen", "orders@mvlinen.example.com", "(403) 555-9999", "30", "CHEQUE", "5100", "GST_5"],
      ["Pacific Seafood Distributors", "Pacific Seafood", "ap@pacseafood.example.com", "(403) 555-1010", "14", "EFT", "5000", "GST_5"],
      ["Acme Office Supplies", "Acme Office", "billing@acme.example.com", "(403) 555-2020", "30", "CARD", "6500", "GST_5"],
    ],
  },

  COA: {
    domain: "COA",
    displayName: "Chart of Accounts",
    blurb:
      "Upload just the account number and account name. After upload, Spectre walks " +
      "you through a mapping table where you classify each account (type, category, " +
      "financial-statement group, departments) using dropdowns populated from your " +
      "club's configured keys — no need to memorise codes.",
    headers: ["number", "name"],
    fields: [
      { name: "number", description: "Unique account number used by Spectre's chart of accounts.", example: "1010", required: true },
      { name: "name", description: "Account description shown on reports.", example: "Operating Bank Account", required: true },
    ],
    sampleRows: [
      ["1010", "Operating Bank Account"],
      ["1100", "Accounts Receivable"],
      ["1300", "Inventory - Pro Shop"],
      ["2000", "Accounts Payable"],
      ["2300", "Bank Loan"],
      ["3000", "Retained Earnings"],
      ["4000", "Membership Dues"],
      ["5000", "Food Cost of Sales"],
      ["6100", "Payroll - Administration"],
      ["7000", "Repairs and Maintenance"],
    ],
  },

  OPENING_TRIAL_BALANCE: {
    domain: "OPENING_TRIAL_BALANCE",
    displayName: "Opening Trial Balance",
    blurb: "Opening balances posted as a single dated journal — every account, debit + credit, must reconcile to zero.",
    headers: ["accountNumber", "debit", "credit", "description"],
    fields: [
      { name: "accountNumber", description: "Account number that already exists in the chart of accounts.", example: "1010", required: true },
      { name: "debit", description: "Debit amount (decimal). Use 0 if the row carries a credit.", example: "150000.00", required: true },
      { name: "credit", description: "Credit amount (decimal). Use 0 if the row carries a debit.", example: "0.00", required: true },
      { name: "description", description: "Optional line description on the opening journal.", example: "Opening cash balance as of 2026-01-01" },
    ],
    sampleRows: [
      ["1010", "150000.00", "0.00", "Opening cash balance"],
      ["1100", "85000.00", "0.00", "Opening A/R balance"],
      ["1300", "42000.00", "0.00", "Opening Pro Shop inventory"],
      ["2000", "0.00", "31000.00", "Opening A/P balance"],
      ["2300", "0.00", "100000.00", "Bank loan opening balance"],
      ["3000", "0.00", "146000.00", "Retained earnings opening balance"],
    ],
  },

  INVENTORY: {
    domain: "INVENTORY",
    displayName: "Inventory",
    blurb: "Pro shop, F&B, and ops inventory master — SKUs, units, costs, reorder thresholds.",
    headers: ["sku", "name", "categoryName", "unit", "unitCost", "reorderLevel"],
    fields: [
      { name: "sku", description: "Unique stock-keeping unit identifier.", example: "PS-GLV-001", required: true },
      { name: "name", description: "Item name as shown in POS and ordering screens.", example: "Mens Golf Glove - Cabretta L", required: true },
      { name: "categoryName", description: "Inventory category. Created on the fly if it doesn't yet exist.", example: "Pro Shop / Apparel" },
      { name: "unit", description: "Stock-keeping unit of measure.", example: "each, case, kg, L" },
      { name: "unitCost", description: "Cost per stock unit at landed cost.", example: "12.50" },
      { name: "reorderLevel", description: "Stock level that triggers a reorder warning.", example: "10" },
    ],
    sampleRows: [
      ["PS-GLV-001", "Mens Golf Glove - Cabretta L", "Pro Shop / Apparel", "each", "12.50", "10"],
      ["PS-BALL-001", "Pro V1 Sleeve (3 ball)", "Pro Shop / Equipment", "each", "18.00", "24"],
      ["FB-WINE-RED-01", "House Cabernet Sauvignon", "F&B / Wine", "case", "180.00", "4"],
      ["FB-BEER-LAGER-01", "Local Lager 24 pack", "F&B / Beer", "case", "42.00", "8"],
      ["OPS-CART-001", "Beverage Cart Cooler Insert", "Operations / Equipment", "each", "120.00", "2"],
    ],
  },

  EMPLOYEES: {
    domain: "EMPLOYEES",
    displayName: "Employees",
    blurb: "Employee roster for departmental reporting and labour tracking.",
    headers: ["employeeNumber", "firstName", "lastName", "email", "position", "department", "hireDate"],
    fields: [
      { name: "employeeNumber", description: "Unique employee identifier from payroll.", example: "E-1001", required: true },
      { name: "firstName", description: "Employee's first name.", example: "Alex", required: true },
      { name: "lastName", description: "Employee's last name.", example: "Johnson", required: true },
      { name: "email", description: "Work email for system access.", example: "alex.johnson@club.example.com" },
      { name: "position", description: "Job title.", example: "Head Golf Professional" },
      { name: "department", description: "Department code. Should match a code on the chart of accounts.", example: "PROSHOP, F&B, GROUNDS, CLUBHOUSE, ADMIN, EVENTS" },
      { name: "hireDate", description: "ISO date the employee was hired (YYYY-MM-DD).", example: "2021-03-15" },
    ],
    sampleRows: [
      ["E-1001", "Alex", "Johnson", "alex.johnson@club.example.com", "Head Golf Professional", "PROSHOP", "2021-03-15"],
      ["E-1002", "Maria", "Lopez", "maria.lopez@club.example.com", "Executive Chef", "F&B", "2019-09-01"],
      ["E-1003", "Tom", "Wright", "tom.wright@club.example.com", "Superintendent", "GROUNDS", "2017-04-10"],
      ["E-1004", "Sophie", "Tremblay", "sophie.tremblay@club.example.com", "Pro Shop Lead", "PROSHOP", "2022-05-20"],
      ["E-1005", "David", "Park", "david.park@club.example.com", "Controller", "ADMIN", "2018-11-05"],
    ],
  },

  EVENTS: {
    domain: "EVENTS",
    displayName: "Events",
    blurb: "Member events, tournaments, and dining bookings.",
    headers: ["name", "startsAt", "endsAt", "category", "capacity"],
    fields: [
      { name: "name", description: "Event title shown on the member portal.", example: "Spring Member-Guest", required: true },
      { name: "startsAt", description: "ISO start datetime (YYYY-MM-DDTHH:mm).", example: "2026-05-15T08:00", required: true },
      { name: "endsAt", description: "ISO end datetime (YYYY-MM-DDTHH:mm).", example: "2026-05-15T17:00", required: true },
      { name: "category", description: "Tournament, Dining, Social, Junior, Mixed.", example: "Tournament" },
      { name: "capacity", description: "Maximum participants / covers.", example: "144" },
    ],
    sampleRows: [
      ["Spring Member-Guest", "2026-05-15T08:00", "2026-05-15T17:00", "Tournament", "144"],
      ["Mother's Day Brunch", "2026-05-10T10:00", "2026-05-10T14:00", "Dining", "120"],
      ["Junior Golf Camp - Week 1", "2026-07-06T09:00", "2026-07-10T15:00", "Junior", "30"],
      ["Club Championship", "2026-08-22T07:30", "2026-08-23T17:00", "Tournament", "96"],
      ["Wine Society Dinner", "2026-09-12T18:30", "2026-09-12T22:00", "Dining", "40"],
    ],
  },

  AR_HISTORY: {
    domain: "AR_HISTORY",
    displayName: "AR History",
    blurb: "Historical member ledger activity (statements, charges, payments) loaded as opening A/R balances.",
    headers: ["memberNumber", "transactionDate", "category", "description", "amount"],
    fields: [
      { name: "memberNumber", description: "Member number that already exists in the system.", example: "M-001", required: true },
      { name: "transactionDate", description: "ISO date of the historical transaction (YYYY-MM-DD).", example: "2025-12-01", required: true },
      { name: "category", description: "Category — DUES, GUEST, FOOD, BEVERAGE, PRO_SHOP, FEE, PAYMENT, CREDIT.", example: "DUES" },
      { name: "description", description: "Statement line description.", example: "December dues" },
      { name: "amount", description: "Signed amount. Positive = charge, negative = payment / credit.", example: "450.00", required: true },
    ],
    sampleRows: [
      ["M-001", "2025-12-01", "DUES", "December dues", "450.00"],
      ["M-001", "2025-12-15", "FOOD", "Dining room - 4 covers", "187.50"],
      ["M-001", "2025-12-31", "PAYMENT", "EFT payment received", "-637.50"],
      ["M-002", "2025-12-01", "DUES", "December dues", "175.00"],
      ["M-002", "2025-12-08", "PRO_SHOP", "Glove + balls", "42.50"],
    ],
  },
};

/** Back-compat — the legacy `IMPORT_TEMPLATES` export. */
export const IMPORT_TEMPLATES: Record<ImportDomain, string[]> = Object.fromEntries(
  Object.entries(IMPORT_TEMPLATE_METADATA).map(([domain, meta]) => [domain, [...meta.headers]]),
) as Record<ImportDomain, string[]>;

// ---------------------------------------------------------------------------
// CSV helpers — used by the helper card's "Download Template" and
// "Copy Header Row" buttons, and by tests.
// ---------------------------------------------------------------------------

/** Escape a single cell per RFC 4180 (commas, quotes, newlines). */
function csvEscape(cell: string): string {
  if (/[",\r\n]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

/** Build the full template CSV: header row + sample rows. */
export function buildTemplateCsv(metadata: ImportTemplateMetadata): string {
  const header = metadata.headers.map(csvEscape).join(",");
  const body = metadata.sampleRows.map((row) => row.map(csvEscape).join(",")).join("\n");
  return body.length > 0 ? `${header}\n${body}\n` : `${header}\n`;
}

/** Build just the header row (no sample data). */
export function buildHeaderRowCsv(metadata: ImportTemplateMetadata): string {
  return metadata.headers.map(csvEscape).join(",");
}

/** Suggested filename for the downloaded template. */
export function templateFilename(metadata: ImportTemplateMetadata): string {
  const slug = metadata.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `spectre-${slug}-template.csv`;
}

// Founder rule 2026-06-30 v14.1 — domains whose upload picker AND
// server-side parser accept XLSX in addition to CSV. Kept as a
// single source of truth so the file input's `accept` attribute,
// the server-side "which parser branch" gate, and every user-
// facing copy string ("Upload CSV" vs "Upload workbook or CSV")
// stay in sync. Add a domain here to enable XLSX uploads for it
// EVERYWHERE simultaneously — no scattered flag flips.
const XLSX_ENABLED_DOMAINS = new Set<ImportDomain>(["COA", "OPENING_TRIAL_BALANCE"]);
export function supportsXlsx(domain: ImportDomain): boolean {
  return XLSX_ENABLED_DOMAINS.has(domain);
}
