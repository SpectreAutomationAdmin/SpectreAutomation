// Chart-of-Accounts XLSX template builder.
//
// Generates a 6-worksheet Excel workbook that's BOTH the import
// template AND the canonical reference for every available Type,
// Category, FS Group, and Department in the club's configuration.
//
// Sheets (in tab order):
//   1. Instructions          — purpose, workflow, column guidance
//   2. Chart of Accounts     — the sheet the user completes; has
//                              Excel data-validation dropdowns on
//                              the optional Type / Category / FS
//                              Group columns
//   3. Types                 — reference: every account type
//   4. Categories            — reference: every category
//   5. FS Groups             — reference: presentation buckets only
//                              (NO department names per founder spec)
//   6. Departments           — reference: every department
//
// Nothing in this file is hard-coded. Types / Categories / FS
// Groups / Departments are all passed in as `options` and rendered
// straight to their reference sheet. If a future taxonomy is added
// the generator picks it up automatically.

import ExcelJS from "exceljs";

import type {
  CoaMappingOptions,
  AccountTypeKey,
} from "./coa-mapping";

// ── Spectre palette (ARGB) ───────────────────────────────────────
const COLOR = {
  greenDeep: "FF1B3A1E",   // club-green-900
  green: "FF2F5832",        // club-green-700
  gold: "FFB08A3E",         // club-gold
  cream: "FFF4ECD8",        // club-cream
  sand: "FFE5DFC8",         // club-sand
  ink: "FF1F1D18",          // club-ink
  greySoft: "FFF5F4EE",     // alt row tint
};

// How many rows in the Chart of Accounts sheet to pre-populate
// with Excel Data Validation. 250 is enough for ~95% of clubs;
// power users with longer COAs can drag the validation down.
const COA_PRE_VALIDATED_ROW_COUNT = 250;

// ── Per-key field metadata (used by reference sheets) ────────────
// Keeps the "Description" / "Typical Use" / "Example Accounts"
// columns sourced from data instead of being inferred at runtime.
// This is reference-only — if a key has no entry here, the
// reference cell renders blank (sheet stays valid).
type ReferenceDetail = {
  description?: string;
  typicalUse?: string;
  examples?: string;
};

const TYPE_DETAILS: Record<AccountTypeKey, ReferenceDetail> = {
  ASSET: {
    description: "Resources the club owns or controls (cash, AR, inventory, equipment).",
    examples: "Operating Bank Account · Member AR · F&B Inventory",
  },
  LIABILITY: {
    description: "Amounts the club owes (AP, accrued liabilities, deferred revenue, debt).",
    examples: "Trade AP · Accrued Payroll · Long-term Debt",
  },
  EQUITY: {
    description: "Member equity, retained earnings, current-year earnings.",
    examples: "Member Shares · Retained Earnings · Current-Year Earnings",
  },
  REVENUE: {
    description: "Income earned from member dues, guest fees, F&B, pro shop, events.",
    examples: "Membership Dues · Greens & Guest Fees · Pro Shop Revenue",
  },
  EXPENSE: {
    description: "Operating costs: payroll, COGS, utilities, R&M, professional fees.",
    examples: "Wages and Benefits · Utilities · Insurance",
  },
};

// Canonical Category reference (founder rule 2026-07-19) —
// 24 entries across the 5 account types. Reference-only; blank
// keys still render a valid sheet row.
const CATEGORY_DETAILS: Record<string, ReferenceDetail> = {
  // Assets (4)
  CURRENT_ASSETS:            { description: "Resources expected to convert to cash within 12 months.", typicalUse: "Cash, AR, prepaid expenses, inventory.", examples: "Operating Bank Account · Member AR · F&B Inventory" },
  INVESTMENTS:               { description: "Marketable securities + long-term investments held for return.", typicalUse: "Investment portfolio, capital-reserve investments.", examples: "Marketable Securities · GICs" },
  CAPITAL_ASSETS:            { description: "Land, buildings, course improvements, equipment, vehicles (long-lived productive assets).", typicalUse: "Capitalized property + plant + equipment.", examples: "Land · Buildings · Equipment & Vehicles" },
  OTHER_ASSETS:              { description: "Long-term assets that don't fit another bucket — intangibles, ROU assets, deposits.", typicalUse: "Intangibles, deposits, ROU assets, financing receivables (long-term portion).", examples: "Trademarks · ROU Asset — Premises · Long-term Financing Receivable" },
  // Liabilities (2)
  CURRENT_LIABILITIES:       { description: "Amounts owed within 12 months.", typicalUse: "AP, accrued expenses, deferred revenue, sales-tax payable.", examples: "Trade AP · Accrued Payroll · Dues — Deferred" },
  LONG_TERM_LIABILITIES:     { description: "Amounts owed beyond one year.", typicalUse: "Long-term debt, lease liabilities, deferred capital contributions.", examples: "Long-term Debt · Lease Liabilities" },
  // Equity (1)
  EQUITY:                    { description: "Member equity + retained earnings + current-year earnings + reserves.", typicalUse: "Share capital, retained earnings, capital reserve.", examples: "Member Shares · Retained Earnings · Capital Reserve" },
  // Revenue (6)
  MEMBERSHIP_REVENUE:        { description: "Member dues + annual fees + entrance fees + capital assessments.", typicalUse: "Membership-driven recurring + one-time revenue.", examples: "Membership Dues · Initiation Fees · Capital Assessments" },
  GOLF_OPS_REVENUE:          { description: "Golf-course operating revenue.", typicalUse: "Green fees, cart, range, lessons, pro shop merchandise, tournaments.", examples: "Greens & Guest Fees · Cart & Range · Pro Shop Revenue · Lesson Revenue" },
  FB_REVENUE:                { description: "Food & beverage sales (dining room + bar + catering).", typicalUse: "Food sales, beverage sales, catering.", examples: "F&B — Dining · Beverage Sales · Catering Revenue" },
  EVENT_REVENUE:             { description: "Private events + banquets + member events.", typicalUse: "Private + corporate event hosting revenue.", examples: "Event Revenue · Banquet Hall Billing" },
  RENTAL_REVENUE:            { description: "Facility rental revenue (halls, lockers, parking, etc.).", typicalUse: "Hall rentals, locker rentals, parking, other facility income.", examples: "Facility Rentals · Locker Rentals" },
  OTHER_REVENUE:             { description: "Non-operating + miscellaneous income — interest, gains, recoveries.", typicalUse: "Interest income, gain/loss on asset disposal, miscellaneous recoveries.", examples: "Interest Income · Gain on Asset Disposal · Other Revenue" },
  // Expenses (11)
  PAYROLL_BENEFITS:          { description: "Salaries, wages, employee benefits across every department.", typicalUse: "Gross payroll + benefits + source deductions.", examples: "Course Salaries · Pro Shop Wages · Employee Benefits" },
  COST_OF_SALES:             { description: "Direct cost of goods sold (food, beverage, merchandise).", typicalUse: "F&B + Pro Shop COGS.", examples: "Cost of Food Sold · Cost of Beverage Sold · Cost of Merchandise Sold" },
  COURSE_GROUNDS:            { description: "Course agronomy + grounds operations (excluding payroll + R&M).", typicalUse: "Supplies, small tools, materials specific to course care.", examples: "Course Supplies & Materials · Small Tools" },
  CLUBHOUSE_OPERATIONS:      { description: "Clubhouse facility operations (excluding payroll + R&M).", typicalUse: "Janitorial supplies, cleaning services, security.", examples: "Janitorial Supplies · Cleaning Services · Security" },
  UTILITIES:                 { description: "Electricity, gas, water, fuel — across every facility.", typicalUse: "Utility bills.", examples: "Clubhouse Utilities · Course Irrigation Electricity" },
  REPAIRS_MAINTENANCE:       { description: "Repairs + maintenance of buildings, equipment, vehicles.", typicalUse: "Course equipment R&M, clubhouse R&M, vehicle + equipment.", examples: "Course Equipment R&M · Clubhouse R&M · Vehicle & Equipment" },
  ADMIN_EXPENSES:            { description: "General administrative + office overhead.", typicalUse: "Office supplies, IT, telephone, bank fees, merchant fees, licenses.", examples: "Office & Administration · IT & Software · Bank Charges · Merchant Fees" },
  PROFESSIONAL_SERVICES:     { description: "Audit, legal, agronomy, consulting fees.", typicalUse: "Outside professional firms.", examples: "Audit Fees · Legal Fees · Agronomy Consulting" },
  MARKETING_MEMBER_RELATIONS:{ description: "Advertising, member events, sponsorships, member acquisition.", typicalUse: "Marketing campaigns + member retention spend.", examples: "Marketing & Advertising · Member Events" },
  INSURANCE:                 { description: "Property + liability + officer insurance.", typicalUse: "All insurance premiums.", examples: "Property Insurance · Liability Insurance · D&O Insurance" },
  OTHER_EXPENSES:            { description: "Expenses that don't fit another bucket — depreciation, interest, taxes, bad debt, shrinkage.", typicalUse: "Depreciation, interest, income tax, property tax, bad debt.", examples: "Depreciation Expense · Interest Expense · Income Tax · Property Tax · Bad Debt" },
};

// FS Group example-accounts — reference-only narrative; doesn't
// affect import behaviour. Filled where the key is recognised;
// blank otherwise so an added FS Group still appears on the
// reference sheet without breaking the build.
const FS_GROUP_DETAILS: Record<string, ReferenceDetail> = {
  // ── Balance Sheet — Assets ──────────────────────────────────────
  BS_CASH_EQUIVALENTS:       { description: "Cash on hand and short-term liquid balances.", examples: "Operating Bank Account · Petty Cash · Money Market" },
  BS_AR:                     { description: "General trade and non-member receivables.", examples: "Trade Accounts Receivable · Other Receivables" },
  BS_MEMBER_AR:              { description: "Member statement balances (the AR control account).", examples: "Member Accounts Receivable" },
  BS_INVENTORY:              { description: "Goods held for resale (Pro Shop, F&B).", examples: "Pro Shop Inventory · F&B Inventory · Beverage Inventory" },
  BS_PREPAID_EXPENSES:       { description: "Insurance, dues, software paid in advance.", examples: "Prepaid Insurance · Prepaid Subscriptions" },
  BS_INVESTMENTS:            { description: "Marketable securities, GICs, long-term investments.", examples: "Marketable Securities · GICs · Long-term Investments" },
  BS_CAPITAL_ASSETS:         { description: "Land, buildings, course improvements, equipment, vehicles (net of accumulated depreciation).", examples: "Land · Buildings · Course Improvements · Equipment & Vehicles" },
  BS_CIP:                    { description: "Capital projects under construction; not yet depreciable.", examples: "Construction in Progress · Capital Projects WIP" },
  BS_ROU_ASSETS:             { description: "Right-of-use assets recognized under lease accounting.", examples: "ROU Asset — Equipment Lease · ROU Asset — Premises" },
  BS_INTANGIBLES:            { description: "Trademarks, software licenses, goodwill.", examples: "Trademarks · Software Licenses · Goodwill" },
  BS_LONG_TERM_RECEIVABLES:  { description: "Non-current receivables — share-financing notes, supplier rebates, long-term loans receivable.", examples: "Share Financing Receivable · Buying-Group Rebate · Long-term Loan Receivable" },
  BS_OTHER_ASSETS:           { description: "Asset balances that don't fit another bucket.", examples: "Other Assets · Deposits Held" },

  // ── Balance Sheet — Liabilities ─────────────────────────────────
  BS_AP:                     { description: "Trade payables to vendors.", examples: "Accounts Payable · Trade AP" },
  BS_ACCRUED_LIABILITIES:    { description: "Accrued operating expenses (utilities, professional fees, GRNI).", examples: "Accrued Utilities · Accrued Professional Fees · GRNI" },
  BS_PAYROLL_LIABILITIES:    { description: "Accrued wages, vacation, source deductions.", examples: "Accrued Payroll · Vacation Payable · Source Deductions Payable" },
  BS_SALES_TAX_PAYABLE:      { description: "GST/HST/PST/sales tax collected, paid (ITCs), and remittable.", examples: "GST Collected · GST Paid (ITCs) · GST Filed · HST Payable · PST Payable" },
  BS_DEFERRED_REVENUE:       { description: "Membership dues / season passes invoiced but not yet earned.", examples: "Dues — Deferred · Season Passes — Deferred" },
  BS_LONG_TERM_LIABILITIES:  { description: "Generic non-debt long-term liabilities — gift cards, credit books, incentive balances. Distinct from Long-Term Debt (actual debt instruments).", examples: "Gift Card Liability · Credit Book · Incentive Credit Book" },
  BS_SECTION_FUNDS:          { description: "Custodial funds the Club holds on behalf of internal sections — Men's / Ladies / Junior / Senior Section, Match Play, Member Guest, tournament + charity funds. No defined maturity; defaults to Long-Term Liabilities (clubs that spend within the year can reconfigure).", examples: "Men's Section · Ladies Section - Dues & General · Junior Section · Seniors Match Play · Member Guest · Tournament Fund · Charity Fund" },
  BS_DEPOSITS_PAYABLE:       { description: "All refundable deposits held by the club — share-purchase, waitlist, event, tournament, rental, banquet, damage, security, external-group, member deposits.", examples: "Share Purchase Deposit · Waitlist Deposit · Event Deposit · Damage Deposit" },
  BS_DEFERRED_CAPITAL_CONTRIBUTIONS: { description: "Member capital contributions deferred and amortized over many years (non-debt).", examples: "Deferred Capital Contributions · Capital Contributions Deferred" },
  BS_LEASE_LIABILITIES:      { description: "Lease liabilities recognized under lease accounting.", examples: "Lease Liability — Current · Lease Liability — Long-term" },
  BS_LONG_TERM_DEBT:         { description: "Mortgages, term loans, member share financing notes.", examples: "Mortgage Payable · Term Loan · Member Share Financing Notes" },
  BS_OTHER_LIABILITIES:      { description: "Liability balances that don't fit another bucket.", examples: "Other Liabilities" },

  // ── Balance Sheet — Equity ──────────────────────────────────────
  BS_SHARE_CAPITAL:          { description: "Member share capital + initiation deposits classified as equity.", examples: "Member Shares · Initiation Deposits — Equity" },
  BS_RETAINED_EARNINGS:      { description: "Accumulated retained earnings from prior years.", examples: "Retained Earnings" },
  BS_CURRENT_YEAR_EARNINGS:  { description: "Net income for the current fiscal year (closing entry account).", examples: "Current-Year Earnings" },
  BS_CAPITAL_RESERVE:        { description: "Restricted capital reserve fund.", examples: "Capital Reserve Fund" },
  BS_ACCUMULATED_OCI:        { description: "Accumulated other comprehensive income (future use)." },
  BS_OTHER_EQUITY:           { description: "Equity balances that don't fit another bucket.", examples: "Other Equity" },

  // ── Income Statement — Revenue ──────────────────────────────────
  IS_MEMBERSHIP_DUES:        { description: "Recurring membership dues.", examples: "Membership Dues · Junior Dues · Social Dues" },
  IS_ANNUAL_FEES:            { description: "Annual minimums, locker / cart storage / handicap fees.", examples: "Annual Minimum · Locker Fees · Handicap Fees" },
  IS_ENTRANCE_FEES:          { description: "One-time entrance / initiation revenue (operating recognition).", examples: "Initiation Fee Revenue · Entrance Fee Revenue" },
  IS_CAPITAL_ASSESSMENTS:    { description: "Capital assessment revenue recognized in the operating fund.", examples: "Capital Assessment Revenue" },
  IS_GREEN_FEES:             { description: "Green fees + guest fees + tee-time revenue.", examples: "Greens Fees · Guest Fees · Tee-Time Revenue" },
  IS_CART_REVENUE:           { description: "Cart rentals + cart storage + range fees.", examples: "Cart Rentals · Cart Storage · Range Fees" },
  IS_DRIVING_RANGE:          { description: "Standalone driving range / practice facility revenue.", examples: "Driving Range Revenue · Practice Facility" },
  IS_GOLF_LESSONS:           { description: "Golf lesson revenue (club's share, gross).", examples: "Lesson Revenue — Adult · Lesson Revenue — Junior" },
  IS_TOURNAMENT:             { description: "Tournament entry fees + sponsorship revenue.", examples: "Tournament Entry Fees · Tournament Sponsorship" },
  IS_PRO_SHOP_MERCH:         { description: "Pro shop merchandise sales.", examples: "Pro Shop Apparel · Pro Shop Equipment · Pro Shop Accessories" },
  IS_FOOD_SALES:             { description: "Dining-room food revenue.", examples: "Dining Room Food · Halfway House Food" },
  IS_BEVERAGE_SALES:         { description: "Bar + beverage revenue.", examples: "Bar Sales · Wine Sales · Beverage Cart Sales" },
  IS_CATERING:               { description: "Catering revenue (non-event banquet billing).", examples: "Catering Revenue" },
  IS_EVENT_REVENUE:          { description: "Member events + private events (banquet hall billing).", examples: "Member Event Revenue · Private Event Revenue · Wedding Revenue" },
  IS_FACILITY_RENTALS:       { description: "Hall rentals, locker rentals, parking, other facility income.", examples: "Hall Rental · Parking Revenue · Facility Rental" },
  IS_INTEREST_INCOME:        { description: "Interest earned on bank balances + investments.", examples: "Interest Income — Bank · Interest Income — Investments" },
  IS_ASSET_GAIN_LOSS:        { description: "Gain or loss on disposal of capital assets.", examples: "Gain on Disposal · Loss on Disposal" },
  IS_OTHER_REVENUE:          { description: "Revenue that doesn't fit another bucket.", examples: "Miscellaneous Revenue · Recoveries" },

  // ── Income Statement — Expenses ─────────────────────────────────
  IS_PAYROLL:                { description: "Salaries, wages, vacation + stat pay, overtime, EI/CPP/EHT, pension/RRSP match, group health/dental benefits, WCB/WSIB, payroll burden — the entire compensation line.", examples: "Course Salaries · F&B Wages · Admin Salaries · EI/CPP · Group Benefits · RRSP Match · WCB" },
  IS_COGS_MERCHANDISE:       { description: "Cost of pro shop merchandise sold.", examples: "COGS — Pro Shop Apparel · COGS — Equipment" },
  IS_COGS_FOOD:              { description: "Cost of food sold.", examples: "COGS — Food · Kitchen Cost of Sales" },
  IS_COGS_BEVERAGE:          { description: "Cost of beverage sold (incl. liquor).", examples: "COGS — Beverage · COGS — Liquor · COGS — Wine" },
  IS_UTILITIES:              { description: "Electricity, gas, water, fuel.", examples: "Electricity · Natural Gas · Water · Heating Fuel" },
  IS_REPAIRS_MAINTENANCE:    { description: "Building + equipment R&M (capitalized below this line).", examples: "Clubhouse R&M · Course R&M · Equipment R&M" },
  IS_PROPERTY_TAX:           { description: "Municipal property, school, business property, local improvement taxes.", examples: "Municipal Property Tax · School Tax · Local Improvement Tax" },
  IS_INCOME_TAX:             { description: "Corporate income tax (federal / provincial / current / deferred).", examples: "Federal Income Tax · Provincial Income Tax · Deferred Tax Expense" },
  IS_INSURANCE:              { description: "Property + liability + officer insurance.", examples: "Property Insurance · Liability Insurance · D&O Insurance" },
  IS_OFFICE_SUPPLIES:        { description: "Office consumables + printing + postage.", examples: "Office Supplies · Printing · Postage" },
  IS_PROFESSIONAL_FEES:      { description: "Audit, legal, agronomy, consulting.", examples: "Audit Fees · Legal Fees · Agronomy Consulting · Management Consulting" },
  IS_IT_SOFTWARE:            { description: "SaaS subscriptions, club-management software, IT services.", examples: "Club-Management Software · SaaS Subscriptions · IT Services" },
  IS_TELEPHONE_INTERNET:     { description: "Phone + data + internet connectivity.", examples: "Telephone · Mobile · Internet" },
  IS_BANK_CHARGES:           { description: "Bank service fees, wire fees, NSF fees.", examples: "Bank Service Fees · Wire Fees · NSF Charges" },
  IS_MERCHANT_FEES:          { description: "Credit card / debit interchange + processing fees.", examples: "Credit Card Processing · Debit Interchange" },
  IS_VEHICLE_EQUIPMENT:      { description: "Fuel, repairs, parts for fleet + grounds equipment.", examples: "Fleet Fuel · Equipment Parts · Vehicle Repairs" },
  IS_SMALL_TOOLS:            { description: "Hand tools, agronomy supplies, course consumables.", examples: "Hand Tools · Fertilizer · Seed · Course Supplies" },
  IS_JANITORIAL_SUPPLIES:    { description: "Cleaning chemicals + linens + paper goods.", examples: "Cleaning Chemicals · Linen · Paper Goods" },
  IS_CLEANING_SERVICES:      { description: "Outsourced cleaning / janitorial labor.", examples: "Contract Janitorial · Window Cleaning" },
  IS_SECURITY:               { description: "Security services, alarm monitoring, on-site guards.", examples: "Alarm Monitoring · Security Services · On-site Guards" },
  IS_STAFF_TRAINING:         { description: "Training, certifications, conferences.", examples: "Staff Training · Certifications · Conferences" },
  IS_MARKETING_ADVERTISING:  { description: "Advertising, sponsorships, member acquisition.", examples: "Advertising · Sponsorships · Member Acquisition" },
  IS_TRAVEL_MEALS:           { description: "Staff travel + business meals.", examples: "Staff Travel · Business Meals" },
  IS_MEMBERSHIPS_SUBS:       { description: "Professional + industry memberships and subscriptions.", examples: "Industry Memberships · Trade Subscriptions" },
  IS_LICENCES_PERMITS:       { description: "Liquor licenses, health permits, business licenses.", examples: "Liquor License · Health Permit · Business License" },
  IS_DEPRECIATION:           { description: "Depreciation + amortization of capital + intangible assets.", examples: "Depreciation Expense · Amortization Expense" },
  IS_INTEREST_EXPENSE:       { description: "Interest on long-term debt + lines of credit.", examples: "Interest Expense · Line of Credit Interest" },
  IS_OTHER_EXPENSES:         { description: "Operating expenses that don't fit another bucket.", examples: "Miscellaneous Expenses · Bad Debt Expense" },

  // ── Cash Flow ───────────────────────────────────────────────────
  CF_OPERATING:              { description: "Operating activities on the cash-flow statement." },
  CF_INVESTING:              { description: "Investing activities on the cash-flow statement." },
  CF_FINANCING:              { description: "Financing activities on the cash-flow statement." },
};

const DEPARTMENT_DETAILS: Record<string, string> = {
  PROSHOP: "Golf retail + soft goods + lesson scheduling. Carries golf-pro-shop sales + cost of merchandise.",
  "F&B": "Food, beverage, dining-room operations + member banquet revenue.",
  GROUNDS: "Course agronomy + grounds maintenance — fertilizer, irrigation, fleet.",
  CLUBHOUSE: "Clubhouse building operations + member-facing front-of-house.",
  ADMIN: "General-and-administrative — accounting, HR, professional fees, depreciation.",
  EVENTS: "Member events, private events, tournament operations.",
};

// ─────────────────────────────────────────────────────────────────
// Internal helpers — common cell styling used across every sheet.
// ─────────────────────────────────────────────────────────────────

function applyTitleBand(ws: ExcelJS.Worksheet, text: string, totalCols: number) {
  ws.mergeCells(1, 1, 1, totalCols);
  const cell = ws.getCell(1, 1);
  cell.value = text;
  cell.font = {
    name: "Newsreader",
    size: 18,
    bold: true,
    color: { argb: COLOR.cream },
  };
  cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  cell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: COLOR.greenDeep },
  };
  ws.getRow(1).height = 32;
}

function applySubtitleBand(ws: ExcelJS.Worksheet, text: string, totalCols: number) {
  ws.mergeCells(2, 1, 2, totalCols);
  const cell = ws.getCell(2, 1);
  cell.value = text;
  cell.font = {
    name: "Inter",
    size: 10,
    color: { argb: COLOR.cream },
    italic: true,
  };
  cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  cell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: COLOR.green },
  };
  ws.getRow(2).height = 22;
}

function freezeBelow(ws: ExcelJS.Worksheet, row: number) {
  ws.views = [{ state: "frozen", ySplit: row }];
}

function autoSize(ws: ExcelJS.Worksheet, mins: number[], maxes: number[]) {
  ws.columns.forEach((col, i) => {
    let max = mins[i] ?? 10;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const v = cell.value;
      const s = v == null ? "" : typeof v === "object" ? "" : String(v);
      const w = Math.min(s.length + 2, maxes[i] ?? 80);
      if (w > max) max = w;
    });
    col.width = max;
  });
}

// ─────────────────────────────────────────────────────────────────
// Sheet builders
// ─────────────────────────────────────────────────────────────────

function buildInstructionsSheet(wb: ExcelJS.Workbook, options: CoaMappingOptions) {
  const ws = wb.addWorksheet("Instructions");
  applyTitleBand(ws, "Spectre · Chart of Accounts Import Workbook", 2);
  applySubtitleBand(ws, "Self-contained reference + import sheet. Complete the Chart of Accounts tab and upload to Spectre.", 2);
  freezeBelow(ws, 2);

  const lines: Array<[string, string]> = [
    ["Purpose", "This workbook is both the import template AND the reference for every Type, Category, FS Group, and Department available in Spectre. The reference tabs are populated dynamically from your club's current configuration."],
    ["Required workflow", "1. Open the Chart of Accounts tab. 2. Fill Account Number + Account Name for every account. 3. Optionally fill Type / Category / FS Group / Departments (Excel dropdowns are available). 4. Save the workbook. 5. Upload it via Admin → Imports → New Batch → Chart of Accounts."],
    ["Required columns", "Account Number and Account Name. Everything else is optional."],
    ["Optional columns", "Type · Category · FS Group · Departments. If filled, Spectre adopts those values on import. If blank, Spectre presents the standard mapping screen so you can complete them in the browser."],
    ["Departments — multiple", `Use semicolons to list multiple departments on one row, e.g. "ADMIN;GROUNDS;F&B". Spectre splits this on import into the same multi-department relationship the web mapping screen produces.`],
    ["After upload", "Spectre walks every row through the mapping screen. Any blanks on the import surface as 'Needs mapping' so nothing is missed. Pre-filled values are pre-selected so you can review + commit in seconds."],
    ["Reference tabs", "Types, Categories, FS Groups, and Departments are READ-ONLY references. They power the Excel dropdowns on the Chart of Accounts tab and document every valid value in your club's configuration."],
    ["Adding new accounts later", "Drop additional rows below the existing data — the dropdowns extend to row 250 by default. For larger COAs, copy the validation down with Excel's standard fill handle."],
  ];

  let row = 3;
  for (const [heading, body] of lines) {
    const head = ws.getCell(row, 1);
    head.value = heading;
    head.font = { name: "Inter", bold: true, size: 11, color: { argb: COLOR.green } };
    head.alignment = { vertical: "top", wrapText: true };

    const txt = ws.getCell(row, 2);
    txt.value = body;
    txt.font = { name: "Inter", size: 10, color: { argb: COLOR.ink } };
    txt.alignment = { vertical: "top", wrapText: true };
    ws.getRow(row).height = Math.max(28, Math.ceil(body.length / 90) * 14);
    row++;
  }

  ws.getColumn(1).width = 24;
  ws.getColumn(2).width = 110;

  // Stripe the body rows for readability.
  for (let r = 3; r < row; r++) {
    if (r % 2 === 0) {
      [1, 2].forEach((c) => {
        ws.getCell(r, c).fill = {
          type: "pattern", pattern: "solid", fgColor: { argb: COLOR.greySoft },
        };
      });
    }
  }
  void options;
  return ws;
}

function buildTypesSheet(wb: ExcelJS.Workbook, options: CoaMappingOptions) {
  const ws = wb.addWorksheet("Types");
  applyTitleBand(ws, "Types · Reference", 4);
  applySubtitleBand(ws, "Every valid account Type in your club's configuration.", 4);
  freezeBelow(ws, 3);

  const headers = ["Type Key", "Display Name", "Description", "Example Accounts"];
  const rows = options.types.map((t) => {
    const d = TYPE_DETAILS[t] ?? {};
    return [t, t, d.description ?? "", d.examples ?? ""];
  });

  ws.addTable({
    name: "Types_Reference",
    ref: "A3",
    headerRow: true,
    style: { theme: "TableStyleLight1", showRowStripes: true },
    columns: headers.map((h) => ({ name: h, filterButton: true })),
    rows,
  });
  styleHeaderRow(ws, 3, headers.length);
  autoSize(ws, [12, 18, 40, 30], [22, 32, 80, 80]);
  return ws;
}

function buildCategoriesSheet(wb: ExcelJS.Workbook, options: CoaMappingOptions) {
  const ws = wb.addWorksheet("Categories");
  applyTitleBand(ws, "Categories · Reference", 5);
  applySubtitleBand(ws, "Every valid Category. Categories are type-scoped — the table records the Type each one applies to.", 5);
  freezeBelow(ws, 3);

  const headers = ["Category Key", "Display Name", "Type", "Description", "Typical Use"];
  const rows = options.categories.map((c) => {
    const d = CATEGORY_DETAILS[c.key] ?? {};
    return [c.key, c.name, c.accountType, d.description ?? "", d.typicalUse ?? ""];
  });

  ws.addTable({
    name: "Categories_Reference",
    ref: "A3",
    headerRow: true,
    style: { theme: "TableStyleLight1", showRowStripes: true },
    columns: headers.map((h) => ({ name: h, filterButton: true })),
    rows,
  });
  styleHeaderRow(ws, 3, headers.length);
  autoSize(ws, [16, 22, 10, 40, 30], [24, 36, 14, 80, 80]);
  return ws;
}

function buildFsGroupsSheet(wb: ExcelJS.Workbook, options: CoaMappingOptions) {
  const ws = wb.addWorksheet("FS Groups");
  applyTitleBand(ws, "FS Groups · Reference", 5);
  applySubtitleBand(ws, "Financial-statement presentation buckets. Reporting categories only — never department names.", 5);
  freezeBelow(ws, 3);

  const headers = ["FS Group Key", "Display Name", "Financial Statement", "Description", "Example Accounts"];
  const rows = options.fsGroups.map((g) => {
    const d = FS_GROUP_DETAILS[g.key] ?? {};
    return [g.key, g.name, g.statement, d.description ?? "", d.examples ?? ""];
  });

  ws.addTable({
    name: "FsGroups_Reference",
    ref: "A3",
    headerRow: true,
    style: { theme: "TableStyleLight1", showRowStripes: true },
    columns: headers.map((h) => ({ name: h, filterButton: true })),
    rows,
  });
  styleHeaderRow(ws, 3, headers.length);
  autoSize(ws, [20, 28, 18, 40, 30], [32, 38, 22, 80, 80]);
  return ws;
}

function buildDepartmentsSheet(wb: ExcelJS.Workbook, options: CoaMappingOptions) {
  const ws = wb.addWorksheet("Departments");
  applyTitleBand(ws, "Departments · Reference", 3);
  applySubtitleBand(ws, "Every available department. Multiple departments per account are allowed — separate with semicolons on import.", 3);
  freezeBelow(ws, 3);

  const headers = ["Department Code", "Display Name", "Description"];
  const rows = options.departments.map((d) => [
    d.code,
    d.name,
    DEPARTMENT_DETAILS[d.code] ?? "",
  ]);

  ws.addTable({
    name: "Departments_Reference",
    ref: "A3",
    headerRow: true,
    style: { theme: "TableStyleLight1", showRowStripes: true },
    columns: headers.map((h) => ({ name: h, filterButton: true })),
    rows,
  });
  styleHeaderRow(ws, 3, headers.length);
  autoSize(ws, [16, 18, 50], [22, 28, 80]);
  return ws;
}

function buildChartOfAccountsSheet(
  wb: ExcelJS.Workbook,
  options: CoaMappingOptions,
  refRanges: {
    typeRange: string;
    categoryRange: string;
    fsGroupRange: string;
    departmentRange: string;
  },
) {
  const ws = wb.addWorksheet("Chart of Accounts");
  applyTitleBand(ws, "Chart of Accounts · Import Sheet", 6);
  applySubtitleBand(
    ws,
    "Only Account Number + Account Name are required. The optional columns accept dropdown selections — leave blank to map in the Spectre UI after upload.",
    6,
  );
  freezeBelow(ws, 3);

  const headers = [
    "Account Number",
    "Account Name",
    "Type (optional)",
    "Category (optional)",
    "FS Group (optional)",
    "Departments (optional, semicolon-delimited)",
  ];

  // Provide ~5 sample rows so the user sees the expected shape.
  // Power users can delete + replace; novice users can leave them
  // as a reference and add their own beneath.
  const sampleRows: ReadonlyArray<ReadonlyArray<string>> = [
    ["1010", "Operating Bank Account", "ASSET",   "CURRENT_ASSETS",       "BS_CASH_EQUIVALENTS", ""],
    ["1100", "Accounts Receivable",    "ASSET",   "CURRENT_ASSETS",       "BS_AR",               ""],
    ["4000", "Membership Dues",        "REVENUE", "OPERATING_REVENUE",    "IS_MEMBERSHIP_DUES",  "ADMIN"],
    ["6310", "Clubhouse Utilities",    "EXPENSE", "OPERATING_EXPENSES",   "IS_UTILITIES",        "CLUBHOUSE"],
    ["6700", "Repairs and Maintenance","EXPENSE", "OPERATING_EXPENSES",   "IS_REPAIRS_MAINTENANCE", "ADMIN;GROUNDS;F&B;PROSHOP"],
  ];

  ws.addTable({
    name: "ChartOfAccounts",
    ref: "A3",
    headerRow: true,
    style: { theme: "TableStyleMedium14", showRowStripes: true },
    columns: headers.map((h) => ({ name: h, filterButton: true })),
    rows: sampleRows.map((r) => [...r]),
  });
  styleHeaderRow(ws, 3, headers.length);
  autoSize(ws, [16, 32, 16, 22, 24, 38], [22, 50, 20, 32, 36, 60]);

  // Apply data validation to columns C/D/E (Type, Category, FS
  // Group) over a 250-row window. Departments (column F) is left
  // FREE so the user can enter semicolon-delimited multi-values.
  const firstDataRow = 4; // header row 3; data starts row 4
  const lastValidatedRow = firstDataRow + COA_PRE_VALIDATED_ROW_COUNT - 1;
  for (let r = firstDataRow; r <= lastValidatedRow; r++) {
    ws.getCell(r, 3).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [refRanges.typeRange],
      showErrorMessage: true,
      errorTitle: "Invalid Type",
      error: "Choose a Type from the dropdown (see the Types tab).",
    };
    ws.getCell(r, 4).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [refRanges.categoryRange],
      showErrorMessage: true,
      errorTitle: "Invalid Category",
      error: "Choose a Category from the dropdown (see the Categories tab).",
    };
    ws.getCell(r, 5).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [refRanges.fsGroupRange],
      showErrorMessage: true,
      errorTitle: "Invalid FS Group",
      error: "Choose an FS Group from the dropdown (see the FS Groups tab).",
    };
    // Departments column — no list validation (multi-value via
    // semicolons doesn't fit Excel's single-cell dropdown model).
    // The reference tab + the sample row 8 demonstrate the format.
    void refRanges.departmentRange;
  }

  return ws;
}

// Bold + dark-green header row so it stands out against the white
// table body that ExcelJS draws via the Light1 theme.
function styleHeaderRow(ws: ExcelJS.Worksheet, rowIndex: number, colCount: number) {
  const row = ws.getRow(rowIndex);
  row.height = 22;
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.font = {
      name: "Inter",
      bold: true,
      size: 10,
      color: { argb: COLOR.cream },
    };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: COLOR.green },
    };
    cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    cell.border = {
      bottom: { style: "thin", color: { argb: COLOR.gold } },
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────

/**
 * Generate the Chart of Accounts import + reference workbook.
 *
 * The workbook is fully self-contained: every reference tab and
 * every Excel dropdown is sourced from `options` (the live per-club
 * configuration) — no hard-coded mapping values reach the file. If
 * a future taxonomy adds a Type, Category, FS Group, or Department,
 * it shows up here automatically.
 */
export async function buildCoaXlsxWorkbook(
  options: CoaMappingOptions,
  clubName: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Spectre Automation";
  wb.lastModifiedBy = "Spectre Automation";
  wb.created = new Date(0); // deterministic timestamp for snapshot tests
  wb.modified = new Date(0);
  wb.title = `${clubName} — Chart of Accounts Import`;
  wb.company = clubName;

  // Compute the data-validation ranges BEFORE creating any
  // reference sheet — they only depend on the option counts +
  // the well-known sheet names. This lets us add the sheets in
  // natural tab order (Instructions → Chart of Accounts →
  // reference tabs) without any post-hoc reordering.
  const typeLastRow = 3 + options.types.length; // header at row 3
  const categoryLastRow = 3 + options.categories.length;
  const fsGroupLastRow = 3 + options.fsGroups.length;
  const departmentLastRow = 3 + options.departments.length;

  const refRanges = {
    typeRange: `=Types!$A$4:$A$${typeLastRow}`,
    categoryRange: `=Categories!$A$4:$A$${categoryLastRow}`,
    // Wrap sheet names containing spaces in single quotes per the
    // Excel reference grammar (`'FS Groups'`).
    fsGroupRange: `='FS Groups'!$A$4:$A$${fsGroupLastRow}`,
    departmentRange: `=Departments!$A$4:$A$${departmentLastRow}`,
  };

  buildInstructionsSheet(wb, options);
  buildChartOfAccountsSheet(wb, options, refRanges);
  buildTypesSheet(wb, options);
  buildCategoriesSheet(wb, options);
  buildFsGroupsSheet(wb, options);
  buildDepartmentsSheet(wb, options);

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** Suggested filename for the downloaded workbook. */
export function coaWorkbookFilename(clubName: string): string {
  const safe = clubName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safe || "Spectre"}-Chart-of-Accounts-Template.xlsx`;
}
