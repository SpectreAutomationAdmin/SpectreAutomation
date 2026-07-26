// Spectre intelligent COA auto-mapping engine (founder rule
// 2026-06-29). When a club uploads a Chart of Accounts, Spectre
// predicts Type / Category / FS Group for every row BEFORE the
// mapping screen renders. The operator then acts as auditor of
// Spectre's decisions, not data-entry clerk.
//
// Three prediction signals, in priority order:
//
//   1. EXISTING-ACCOUNT MATCH (confidence: high)
//      The club already has an Account at this number — copy
//      its current Type + Category + FS Group + default
//      Department. This is the no-new-schema "learning" path:
//      a club's second import inherits the operator's first-
//      import decisions because the canonical replacement flow
//      keeps Account rows stable by number.
//
//   2. NAME KEYWORD MATCH (confidence: high)
//      Substring keyword match against a curated dictionary of
//      ~80 patterns covering the most common private-club
//      account names. Picks a specific FS Group; the Category
//      is derived from the FS Group's canonical Category.
//
//   3. NUMBER RANGE MATCH (confidence: medium)
//      Standard private-club COA conventions (1xxx assets, 2xxx
//      liabilities, etc.). Picks Type + a default Category +
//      "Other ..." FS Group as a placeholder.
//
//   4. NOTHING MATCHED (confidence: low)
//      Returns a sensible default and flags low confidence so
//      the UI highlights the row for review.
//
// All output is keyed by the canonical taxonomy from
// `coa-template.ts` (2026-07-19 lock-in). The engine never
// hard-codes legacy keys — every prediction returns a key that
// exists in DEFAULT_FS_GROUPS / DEFAULT_CATEGORIES so the
// downstream `saveCoaRowMappings` call resolves cleanly.

import type { AccountType } from "../accounting/types";
import { defaultFundApplicabilityStringForAccount } from "../accounting/fund-applicability";

// Founder rule 2026-07-02 v15.0 — every predicted CoA row carries
// a Fund Applicability tag derived from its predicted FS Group.
// P&L predictions inherit `OPERATING` or `CAPITAL` per the
// canonical FS Group → Fund default; BS predictions carry null.
// This means the import pipeline writes fundApplicability onto
// every newly-created account without a second inference pass.
function fundForPrediction(
  type: AccountType,
  fsGroupKey: string | null | undefined,
): string | null {
  return defaultFundApplicabilityStringForAccount(type, fsGroupKey ?? null);
}

/** Confidence tier surfaced to the UI. */
export type PredictionConfidence = "high" | "medium" | "low";

/** Where the prediction came from — useful for diagnostics + tests. */
export type PredictionSource =
  | "existing-account"
  | "name-keyword"
  // Founder rule 2026-07-01 v14.18 — when the name-keyword match
  // only fires AFTER an abbreviation was expanded (e.g. "Sctn" →
  // "Section", "Accum Deprec" → "Accumulated Depreciation",
  // "Carts Rental" → "Carts Rental"), the source surfaces as
  // "abbreviation-normalized" so the UI can show a clearer
  // reason for the operator ("mapped via expanded abbreviation").
  | "abbreviation-normalized"
  | "number-range"
  // Founder rule 2026-07-01 v14.18 — sub-range within the primary
  // bracket (e.g. 1400-1499 long-term receivables). Uses the
  // number as a supporting signal alongside a keyword match.
  | "nearby-account-range"
  // Founder rule 2026-07-01 v14.22 — Trial Balance sign was the
  // deciding signal (credit → revenue/liability/equity, debit →
  // asset/expense). Used ONLY as a tie-breaker for otherwise
  // ambiguous rows (typically the 9xxx catch-all where the
  // conventional bracket is "expense OR other revenue"); never
  // overrides a keyword or existing-account match.
  | "balance-sign-supported"
  // Sprint 3 · Checkpoint 15K — chart-level reassessment. Fires
  // when the batch-level second-pass detects an implausible
  // omission (e.g. 20+ revenue accounts with shareholder/member
  // class terminology, but zero mapped to membership dues) and
  // promotes those rows from the generic "Other Revenue" bucket
  // to the domain-plausible one. Surfaced separately so the UI /
  // audit trail can distinguish a per-row keyword hit from a
  // chart-level reassessment.
  | "chart-reassessment"
  | "default";

export type CoaPrediction = {
  type: AccountType;
  /** Canonical Category key (e.g. CURRENT_ASSETS). */
  categoryKey: string;
  /** Canonical FS Group key (e.g. BS_CASH_EQUIVALENTS). */
  fsGroupKey: string;
  /** Recommended default Department code, or null if not departmental. */
  defaultDepartmentCode: string | null;
  /**
   * Founder rule 2026-07-02 v15.0 — Fund Applicability CSV string
   * derived from the predicted FS Group. `null` for BS accounts;
   * `"OPERATING"` (or `"CAPITAL"`, `"OPERATING,CAPITAL"`, ...) for
   * P&L accounts. Import + TB-map surfaces write this value onto
   * the created Account so the reporting engine has fund
   * classification available immediately after import.
   */
  fundApplicability: string | null;
  confidence: PredictionConfidence;
  source: PredictionSource;
};

export type CoaPredictorInputRow = {
  /** Trimmed account number. */
  number: string;
  /** Trimmed account name. */
  name: string;
  // Founder rule 2026-07-01 v14.22 — optional trial-balance
  // sign hints. When present, they act ONLY as a tie-breaker
  // for ambiguous rows (typically the 9xxx catch-all where the
  // conventional bracket is "expense OR other revenue"). They
  // never override a keyword or existing-account match. Callers
  // that don't have sign context (e.g. a COA-only upload with no
  // opening balances) simply omit these fields — the predictor
  // then behaves exactly like the pre-v14.22 version.
  /** Debit balance if any; used as a supporting classification signal. */
  debit?: number;
  /** Credit balance if any; used as a supporting classification signal. */
  credit?: number;
};

export type ExistingAccountSnapshot = {
  accountNumber: string;
  type: string;
  categoryKey: string | null;
  fsGroupKey: string | null;
  defaultDepartmentCode: string | null;
};

// ---------------------------------------------------------------------------
// Normalization layer (founder rule 2026-06-29 v4).
//
// Expands common accounting abbreviations to their long forms
// BEFORE keyword matching. The original account name is left
// untouched for display + import; only the prediction pass sees
// the expanded text. Word boundaries (\b) prevent false
// positives — "AR" inside "PEARL" or "DRAW" never expands.
//
// Substitutions apply in order; the most-specific patterns come
// first so "Accts Payable" expands to "Accounts Payable" before
// the bare "AP" rule could fire on "AP" later in the string.
// ---------------------------------------------------------------------------
const ABBREVIATION_SUBSTITUTIONS: Array<[RegExp, string]> = [
  // Slashed pairs — always safe (slash is non-word).
  [/\bA\s*\/\s*R\b/gi, "Accounts Receivable"],
  [/\bA\s*\/\s*P\b/gi, "Accounts Payable"],
  [/\bP\s*\/\s*R\b/gi, "Payroll"],
  [/\bF\s*\/\s*A\b/gi, "Fixed Asset"],

  // Multi-word receivable / payable shorthand.
  [/\bAccts?\s*Receivables?\b/gi, "Accounts Receivable"],
  [/\bAccts?\s*Rec\b/gi, "Accounts Receivable"],
  [/\bAcct\s*Rec\b/gi, "Accounts Receivable"],
  [/\bAccts?\s*Payable\b/gi, "Accounts Payable"],
  [/\bAccts?\s*Payables?\b/gi, "Accounts Payable"],
  [/\bAccts?\s*Pay\b/gi, "Accounts Payable"],
  [/\bAcct\s*Pay\b/gi, "Accounts Payable"],

  // Cost-of-sales family.
  [/\bCOGS\b/gi, "Cost of Goods Sold"],
  [/\bCOS\b/gi, "Cost of Sales"],
  [/\bCost\s+Sales\b/gi, "Cost of Sales"],

  // Food & Beverage.
  [/\bF\s*&\s*B\b/gi, "Food and Beverage"],
  [/\bF\s+and\s+B\b/gi, "Food and Beverage"],
  // FB / fb only as exact-case token to avoid "FB" matching
  // inside "FBI" / "FBO" / random tokens. Case-sensitive.
  [/\bFB\b/g, "Food and Beverage"],

  // Repairs & Maintenance.
  [/\bR\s*&\s*M\b/gi, "Repairs and Maintenance"],
  [/\bMaint\b/gi, "Maintenance"],

  // Capital assets.
  [/\bPP\s*&\s*E\b/gi, "Property Plant and Equipment"],
  [/\bPPE\b/g, "Property Plant and Equipment"],
  [/\bCapex\b/gi, "Capital Expenditure"],
  // Sprint 3 · Checkpoint 15J — "Furn" / "Furn." / "Furnit" is
  // the Jonas shorthand for "Furniture" that appears in tight
  // COA column widths (e.g. "Furn & Fixtures - Clubhouse").
  // Expanding to "Furniture" here lets the capital-asset rule
  // match without adding a parallel `furn` branch to the regex.
  // Scoped with word boundaries so "burn" / "spurn" / "return"
  // never expand.
  [/\bfurn(?:it)?\b/gi, "Furniture"],
  // "Equip" is the widely-used Jonas / Sage abbreviation for
  // "Equipment" (e.g. "Ground Equip", "Accum Deprec - Equip
  // under financin"). Word-bounded so "equipped" / "equipping"
  // never expand.
  [/\bequip\b/gi, "Equipment"],
  // "Eqp" — even shorter shorthand ("Grounds Eqp & Fix",
  // "Clubhouse Eqp & Fix") — expands the same way.
  [/\beqp\b/gi, "Equipment"],
  // "Fix" as shorthand for "Fixtures" only when paired with
  // Equipment / Furniture context. Matching `\bfix\b` broadly
  // would false-positive on "Fix Cost" / "Fix Assets", so we
  // scope it to the compound form. Two variants: with & without
  // ampersand.
  [/\b(equipment|furniture)\s*&\s*fix\b/gi, "$1 & Fixtures"],
  [/\b(equipment|furniture)\s+and\s+fix\b/gi, "$1 and Fixtures"],

  // Depreciation / Amortization.
  // Founder rule 2026-07-01 v14.18 — "Accum Deprec" / "Accum Depr"
  // / "Accum Depreciation" is the Jonas shorthand for a contra-
  // asset "Accumulated Depreciation" line. The most-specific
  // compound patterns fire before the bare `Accum` and `Deprec`
  // fallbacks so "Accum Deprec - Irrigation" collapses cleanly to
  // "Accumulated Depreciation - Irrigation" (which then hits the
  // BS_CAPITAL_ASSETS keyword rule below).
  [/\bAccum\s+Deprec(iation)?\b/gi, "Accumulated Depreciation"],
  [/\bAccum\s+Depr\b/gi, "Accumulated Depreciation"],
  [/\bAccum\b/gi, "Accumulated"],
  [/\bDeprec\b/gi, "Depreciation"],
  [/\bDepn\b/gi, "Depreciation"],
  [/\bDepr\b/gi, "Depreciation"],
  [/\bAmort\b/gi, "Amortization"],

  // Utilities.
  [/\bNat\s+Gas\b/gi, "Natural Gas"],
  [/\bElec\b/gi, "Electricity"],
  [/\bUtil\b/gi, "Utilities"],

  // Professional services / accounting.
  [/\bProf\s+Fees\b/gi, "Professional Fees"],
  [/\bProf\s+Services\b/gi, "Professional Services"],
  [/\bAcctg\b/gi, "Accounting"],

  // Insurance.
  [/\bInsur\b/gi, "Insurance"],
  [/\bIns\b/gi, "Insurance"],

  // Interest.
  [/\bInt\s+Exp\b/gi, "Interest Expense"],
  [/\bInt\s+Inc\b/gi, "Interest Income"],

  // Tax.
  [/\bCorp\s+Tax\b/gi, "Corporate Tax"],
  // ITC / ITCs — input tax credit. Plural-safe.
  [/\bITCs?\b/g, "Input Tax Credit"],

  // Membership / Pro Shop.
  [/\bMbrs?\b/gi, "Member"],
  [/\bGolf\s+Shop\b/gi, "Pro Shop"],
  [/\bProshop\b/gi, "Pro Shop"],

  // Founder rule 2026-07-01 v14.18 — "Sctn" is Jonas shorthand
  // for "Section" (Ladies Sctn, Mens Sctn, Junior Sctn). Expanding
  // it here lets the section-funds keyword rule match without
  // adding a parallel "Sctn" pattern to every downstream regex.
  [/\bSctn\b/gi, "Section"],

  // Payroll / Salaries.
  [/\bSal\b/gi, "Salaries"],
  // PR / FA / AR / AP — short 2-letter tokens at the END so any
  // multi-word match above has already consumed them. Case-
  // sensitive uppercase only so "pr" inside "approval" never
  // fires. (Founder convention: COA abbreviations are uppercase.)
  [/\bPR\b/g, "Payroll"],
  [/\bFA\b/g, "Fixed Asset"],
  [/\bAR\b/g, "Accounts Receivable"],
  [/\bAP\b/g, "Accounts Payable"],
];

/**
 * Expand abbreviations in a Chart of Accounts name so the
 * downstream keyword rules can match shorthand variants. The
 * original name is NEVER mutated by the caller — this returns a
 * new string used only by the prediction engine. UI + import +
 * audit always see the operator's exact wording.
 *
 * Idempotent: running twice yields the same result.
 */
export function normalizeAccountNameForPrediction(name: string): string {
  return normalizeAccountNameForPredictionWithFlag(name).normalized;
}

/**
 * Founder rule 2026-07-01 v14.18 — the "with flag" variant lets
 * the predictor tell the UI whether an abbreviation was
 * expanded. Used to set the `abbreviation-normalized`
 * PredictionSource so the operator sees WHY the row was mapped
 * ("interpreted 'Sctn' as 'Section'", "interpreted 'Accum
 * Deprec' as 'Accumulated Depreciation'"). The predicate is
 * whether any substitution actually changed the string, not
 * just whether the input had whitespace to normalize.
 */
export function normalizeAccountNameForPredictionWithFlag(
  name: string,
): { normalized: string; abbreviationsExpanded: boolean } {
  const trimmed = name.trim().replace(/\s+/g, " ");
  let s = trimmed;
  for (const [pattern, replacement] of ABBREVIATION_SUBSTITUTIONS) {
    s = s.replace(pattern, replacement);
  }
  const collapsed = s.replace(/\s+/g, " ").trim();
  return { normalized: collapsed, abbreviationsExpanded: collapsed !== trimmed };
}

// ---------------------------------------------------------------------------
// Keyword dictionary — name → canonical FS Group key.
//
// Order matters: more-specific patterns come BEFORE catch-alls.
// Expense-side patterns sit BEFORE asset-side patterns that
// could match the same word (e.g. "Vehicle Fuel" hits the
// VEHICLE_EQUIPMENT expense rule before the CAPITAL_ASSETS
// fallback). Capital-asset / inventory rules require unambiguous
// asset context ("inventory", "& vehicles", explicit asset
// names) so they don't capture expense lines.
//
// Rules match against the NORMALIZED name (abbreviations
// already expanded). See `normalizeAccountNameForPrediction`.
// ---------------------------------------------------------------------------
type KeywordRule = {
  test: RegExp;
  fsGroupKey: string;
  type: AccountType;
  // Founder rule 2026-06-29 v7 — keyword-level high-precedence
  // flag. When set, a successful match wins even against a
  // SPECIFIC existing-account mapping (used for unambiguous
  // keywords like credit-card brand names, sales tax tokens,
  // deposit / gift card / deferred-capital language).
  highPrecedence?: boolean;
};
const NAME_KEYWORD_RULES: Array<KeywordRule> = [
  // SPECIFIC ASSET PATTERNS first — these have explicit asset
  // words (prepaid, inventory, cash, receivable) so they can't
  // collide with expense names like "Prepaid Insurance".
  { test: /prepaid|input\s*tax\s*credit|prepayment/i, fsGroupKey: "BS_PREPAID_EXPENSES", type: "ASSET" },
  { test: /\binventor|stock\s*on\s*hand/i, fsGroupKey: "BS_INVENTORY", type: "ASSET" },
  // Cash — explicit cash-account words (petty, bank, chequing,
  // checking, savings, money market, cash on hand, "Bank - General",
  // "General Bank"). The negative lookahead on `bank` blocks
  // "Bank Charge / Bank Fee / Bank Loan" (those are expense /
  // liability concepts, not cash).
  { test: /petty\s*cash|operating\s*bank|reserve\s*bank|general\s*bank|bank\s*[-—]\s*general|chequing|checking|savings|money\s*market|cash\s*equiv|cash\s*on\s*hand|\bcash\b|bank(?!\s*charge|\s*fee|\s*loan)/i, fsGroupKey: "BS_CASH_EQUIVALENTS", type: "ASSET" },
  // Member Receivables — fires when AR-style words sit alongside
  // member-revenue language ("member", "dues", "membership",
  // "monthly dues", "annual dues", "assessment", "initiation",
  // "entrance fee"). The AR-side pattern recognises both the
  // full form ("Accounts Receivable") AND every abbreviation
  // (Accts Receivable, Acct Receivable, Acct Rec, Accts Rec,
  // Rec, A/R, AR, Receivables).
  { test: /(receivables?|\baccts?\s*rec\b|\bacct\s*rec\b|\brec\b|accts?\b|accounts?\b|\ba\s*\/\s*r\b|\bar\b).{0,40}(member|monthly\s*dues|annual\s*dues|membership|assess|initiation|entrance|monthly|annual)|(member|monthly\s*dues|annual\s*dues|membership|assess|initiation|entrance).{0,40}(receivables?|\baccts?\s*rec\b|\bacct\s*rec\b|\brec\b|accts?\b|accounts?\b|\ba\s*\/\s*r\b|\bar\b|statement|account\b)/i, fsGroupKey: "BS_MEMBER_AR", type: "ASSET" },
  // General Accounts Receivable — full + abbreviated forms.
  // Founder rule 2026-06-29 v3: "Acct Rec" / "Accts Rec" are
  // common shorthand and must hit this rule. The engine's
  // 1400-bracket post-process below remaps BS_AR /
  // BS_MEMBER_AR → BS_LONG_TERM_RECEIVABLES for non-current
  // ranges, so this rule just identifies the receivable nature.
  { test: /\baccts?\s*receivables?|\baccounts?\s*receivables?|\baccts?\s*rec\b|\bacct\s*rec\b|trade\s*(receivables?|ar)|other\s*receivables?|\breceivables?\b|\ba\s*\/\s*r\b|^\s*ar\s*[-—]|\bar\s*[-—]\s*(account|receivable|control)/i, fsGroupKey: "BS_AR", type: "ASSET" },

  // EXPENSES (most-specific operational language; fire first) --------------
  // Note: \bei\b / \bcpp\b / \bwsib\b / \beht\b need word
  // boundaries so they don't match "RecEIvable" / "deductCPP".
  { test: /accrued\s*payroll|accrued\s*wage|accrued\s*vacation|accrued\s*source\s*deduct|source\s*deduction|payroll\s*liab|\bcpp\b|\bei\b|\bwsib\b|\beht\b/i, fsGroupKey: "BS_PAYROLL_LIABILITIES", type: "LIABILITY" },
  { test: /accrued\s*liab|grni|goods\s*received\s*not\s*invoiced/i, fsGroupKey: "BS_ACCRUED_LIABILITIES", type: "LIABILITY" },
  // Founder rule 2026-06-29 v11 — consolidated Salaries and
  // Benefits. Single FS Group for salary, wages, vacation pay,
  // statutory holiday, overtime, EI/CPP, pension/RRSP, group
  // health/dental, WCB/WSIB, payroll burden, employer taxes.
  // The `payroll(?!\s*liab)` negative lookahead keeps "Payroll
  // Liabilities" on the balance-sheet bucket. Bare `\beht\b`,
  // `\bei\b`, `\bcpp\b`, `\bwcb\b`, `\bwsib\b` are word-bounded
  // so they don't false-positive on substrings.
  // Founder rule 2026-07-01 v14.22 — "Special Projects" is the
  // grounds-crew special-projects labour account. It's populated
  // when hourly wages are allocated to one-off course
  // improvements (a bunker rebuild, an irrigation upgrade,
  // etc), so it belongs in Payroll & Benefits alongside the
  // rest of grounds wages. Sits BEFORE the generic payroll
  // regex so the `special\s*project` token wins even against
  // more-generic wage keywords.
  { test: /special\s*project/i, fsGroupKey: "IS_PAYROLL", type: "EXPENSE" },
  { test: /payroll(?!\s*liab)|salar|wage|labour|labor|contract\s*labo|vacation\s*pay|statutory\s*holiday|stat\s*holiday|\bovertime\b|\bei\b|\bcpp\b|\beht\b|pension|rrsp|group\s*(insurance|benefit|health|dental)|health\s*benefit|dental\s*benefit|workers?\s*comp|\bwcb\b|\bwsib\b|payroll\s*burden|employer\s*tax|employee\s*benefit|\bbenefit/i, fsGroupKey: "IS_PAYROLL", type: "EXPENSE" },
  // Cost-of-sales: SPECIFIC patterns first.
  //   • Food COS — "Cost of Food", "Food COS", "Food Cost of Sales",
  //     "Cost of Sales — F&B" (Jonas-style em-dash). Must beat the
  //     generic merchandise rule because "Food Cost of Sales"
  //     contains "Cost of Sales".
  //   • Beverage COS — "Cost of Beverages Sold", "Liquor/Beer/Wine
  //     COS / cost of sales / cost". Same precedence concern.
  //   • Merchandise COS — only fires after Food + Beverage
  //     specifics; catches "Pro Shop Cost of Goods Sold",
  //     "Merchandise COS", generic "COGS".
  // Food COS — includes normalized compound forms:
  //   "Cost of Sales - Food"      (from "COS - Food")
  //   "Cost of Goods Sold - Food" (from "COGS - Food")
  //   "Cost of Sales - Food and Beverage" (from "COS - F&B")
  { test: /cost\s*of\s*food|food\s*cost|food\s*c\.?o\.?s\.?\b|food\s*cogs?\b|food\s*cost\s*of\s*sales|cost\s*of\s*(goods\s*sold|sales)[\s\W]+food|cost\s*of\s*(goods\s*sold|sales)[\s\W]+f(\s*&\s*|\s+and\s+)b\b|cost\s*of\s*(goods\s*sold|sales)[\s\W]+food\s+and\s+beverage/i, fsGroupKey: "IS_COGS_FOOD", type: "EXPENSE" },
  // Beverage COS — same compound forms for bever/liquor/beer/wine.
  { test: /cost\s*of\s*bever|cost\s*of\s*liquor|cost\s*of\s*beer|cost\s*of\s*wine|bever(age)?s?\s*c\.?o\.?s\.?\b|bever(age)?s?\s*cogs?\b|bever(age)?s?\s*cost\s*of\s*sales|liquor\s*c\.?o\.?s\.?\b|liquor\s*cogs?\b|liquor\s*cost\s*of\s*sales|beer\s*c\.?o\.?s\.?\b|beer\s*cogs?\b|wine\s*c\.?o\.?s\.?\b|wine\s*cogs?\b|beverage\s*cost|liquor\s*cost|wine\s*cost|beer\s*cost|cost\s*of\s*(goods\s*sold|sales)[\s\W]+(bever|liquor|beer|wine)/i, fsGroupKey: "IS_COGS_BEVERAGE", type: "EXPENSE" },
  // Merchandise COS — sits AFTER Food + Beverage so they win
  // when the name pairs "Cost of Goods Sold" with food/bev.
  { test: /cost\s*of\s*(goods|sales|merchandise|merch)|cogs\b|pro\s*shop\s*cost|merchandise\s*cost|merchandise\s*c\.?o\.?s\.?\b|merchandise\s*cogs?\b|merch\s*c\.?o\.?s\.?\b/i, fsGroupKey: "IS_COGS_MERCHANDISE", type: "EXPENSE" },
  { test: /utilit|electric|hydro|natural\s*gas|propane|fuel\s*oil|sewer|gas\s*(util|expense|bill)|water\s*(util|bill)/i, fsGroupKey: "IS_UTILITIES", type: "EXPENSE" },
  { test: /repair|maintenance|r\s*&\s*m\b|building\s*repair|equipment\s*(repair|maintenance)|grounds\s*repair|clubhouse\s*repair/i, fsGroupKey: "IS_REPAIRS_MAINTENANCE", type: "EXPENSE" },
  { test: /property\s*tax|municipal\s*tax|school\s*tax|local\s*improvement/i, fsGroupKey: "IS_PROPERTY_TAX", type: "EXPENSE" },
  { test: /income\s*tax|corporate\s*tax|federal\s*tax|provincial\s*tax|deferred\s*tax/i, fsGroupKey: "IS_INCOME_TAX", type: "EXPENSE" },
  { test: /insurance(?!\s*receivable)/i, fsGroupKey: "IS_INSURANCE", type: "EXPENSE" },
  { test: /office\s*suppl|office\s*expense|stationery|printing|postage/i, fsGroupKey: "IS_OFFICE_SUPPLIES", type: "EXPENSE" },
  { test: /professional\s*fee|legal\s*fee|audit\s*fee|accounting\s*fee|consulting|consultant|agronomy/i, fsGroupKey: "IS_PROFESSIONAL_FEES", type: "EXPENSE" },
  { test: /it\s*(expense|cost)|software|saas|computer|technology|hosting|cloud/i, fsGroupKey: "IS_IT_SOFTWARE", type: "EXPENSE" },
  { test: /telephone|internet|phone\s*&\s*internet|cell\s*phone|mobile|data\s*plan/i, fsGroupKey: "IS_TELEPHONE_INTERNET", type: "EXPENSE" },
  { test: /bank\s*charge|bank\s*fee|wire\s*fee|nsf\s*fee|monthly\s*service\s*charge/i, fsGroupKey: "IS_BANK_CHARGES", type: "EXPENSE" },
  { test: /merchant\s*(processing\s*)?fee|credit\s*card\s*fee|interchange|payment\s*processing/i, fsGroupKey: "IS_MERCHANT_FEES", type: "EXPENSE" },
  { test: /vehicle\s*(fuel|expense|repair|maintenance)|fuel(?!\s*oil)|fleet\s*expense|equipment\s*(rental|lease)/i, fsGroupKey: "IS_VEHICLE_EQUIPMENT", type: "EXPENSE" },
  { test: /small\s*tool|hand\s*tool|course\s*suppl|agronomy\s*suppl|grounds\s*suppl|course\s*material/i, fsGroupKey: "IS_SMALL_TOOLS", type: "EXPENSE" },
  { test: /janitor(ial)?\s*suppl|cleaning\s*suppl|linen|paper\s*good/i, fsGroupKey: "IS_JANITORIAL_SUPPLIES", type: "EXPENSE" },
  { test: /cleaning\s*service|janitor(ial)?\s*service|outsourced\s*cleaning/i, fsGroupKey: "IS_CLEANING_SERVICES", type: "EXPENSE" },
  { test: /security\s*service|alarm\s*monitor|on.?site\s*guard/i, fsGroupKey: "IS_SECURITY", type: "EXPENSE" },
  { test: /staff\s*training|certification|conference|workshop/i, fsGroupKey: "IS_STAFF_TRAINING", type: "EXPENSE" },
  { test: /marketing|advertising|advert|sponsorship|promo|member\s*acquisition|member\s*event/i, fsGroupKey: "IS_MARKETING_ADVERTISING", type: "EXPENSE" },
  { test: /travel(?!\s*revenue)|meal\s*expense|business\s*meal|entertainment(?!\s*revenue)/i, fsGroupKey: "IS_TRAVEL_MEALS", type: "EXPENSE" },
  { test: /licen[sc]e|permit|liquor\s*licen[sc]e|business\s*licen[sc]e|health\s*permit/i, fsGroupKey: "IS_LICENCES_PERMITS", type: "EXPENSE" },
  { test: /membership(?!\s*dues|\s*revenue)|subscription|dues\s*&\s*subscription/i, fsGroupKey: "IS_MEMBERSHIPS_SUBS", type: "EXPENSE" },
  { test: /depreciation|amortization|amortisation/i, fsGroupKey: "IS_DEPRECIATION", type: "EXPENSE" },
  { test: /interest\s*expense|interest\s*on\s*(debt|loan|mortgage)|financing\s*cost/i, fsGroupKey: "IS_INTEREST_EXPENSE", type: "EXPENSE" },
  { test: /bad\s*debt|allowance\s*for\s*doubtful|shrinkage/i, fsGroupKey: "IS_OTHER_EXPENSES", type: "EXPENSE" },

  // REVENUE ---------------------------------------------------------------
  // Sprint 3 · Checkpoint 15K — private-club membership-dues recognition.
  //
  // Private clubs (especially member-owned "shareholder" corporations)
  // structure their dues revenue as a taxonomy of member classes: golf
  // shareholder, ladies shareholder, corporate shareholder, senior
  // shareholder, designate golfer, junior tier, intermediate tier,
  // social class, spousal add-on, etc. Coulee Ridge's chart has 30+
  // such accounts in the 4xxx block. The pre-15K rule only matched
  // literal "membership/monthly/annual dues" phrases, so the whole
  // block fell to Other Revenue — implausible for a private-club COA.
  //
  // The rules below are ordered from most-specific to most-general
  // and are all REVENUE-typed. Bracket typing keeps them from
  // hijacking asset/liability/equity lines with similar words
  // (Shareholder Equity, Member Accounts Receivable, Membership
  // Deposits) — those match their own bracket-specific rules first.
  //
  // False-positive guards preserved by the rule ORDER upstream:
  //   • "Capital Assessment" hits IS_CAPITAL_ASSESSMENTS BEFORE
  //     these membership rules (line order matters).
  //   • "Initiation Fee" / "Entrance Fee" hit IS_ENTRANCE_FEES
  //     via the rule below.
  //   • "Share Transfer Fee" hits IS_OTHER_REVENUE via its own
  //     dedicated rule further down (line 451).
  //   • "Member Refunds" and "Membership Deposits" belong in
  //     LIABILITY/contra territory, not REVENUE — this rule is
  //     REVENUE-typed and won't fire on them.
  { test: /membership\s*dues|monthly\s*dues|annual\s*dues|member\s*dues/i, fsGroupKey: "IS_MEMBERSHIP_DUES", type: "REVENUE" },
  // Shareholder class dues — the canonical private-club pattern.
  // Matches any "[Adjective ]Shareholder[ - Modifier]" form; the
  // bare "shareholder" token in a REVENUE-typed bracket carries
  // enough signal on its own (EQUITY bracket handles "Shareholder
  // Equity" via BS_SHARE_CAPITAL).
  { test: /\bshareholder(?!\s+equity)\b/i, fsGroupKey: "IS_MEMBERSHIP_DUES", type: "REVENUE" },
  // "Designate Golfer" / "Designated Golfer" — a member class
  // where a shareholder designates a family member as the active
  // golfer. Private-club-specific vocabulary.
  { test: /\bdesignate[ds]?\s+golfer\b/i, fsGroupKey: "IS_MEMBERSHIP_DUES", type: "REVENUE" },
  // Spousal / partner dues attached to a primary membership.
  // Requires "spouse" in a REVENUE-typed bracket AND either
  // "golf" or a class qualifier (male, senior, lady) — bare
  // "spouse" alone could appear in payroll/benefits contexts
  // that this rule must not touch.
  { test: /(?:golf|male|senior|lady)\s+(?:golf\s+)?spouse\b|\bspouse\s+(?:membership|dues)\b/i, fsGroupKey: "IS_MEMBERSHIP_DUES", type: "REVENUE" },
  // Intermediate class — a member tier between junior and full.
  // Fires on bare "Intermediate", plus "Sponsored Intermediate"
  // and "Junior Intermediate" variants. REVENUE-typed so it
  // won't touch an "Intermediate loan" liability line.
  { test: /(?:sponsored\s+|junior\s+)?intermediate\b/i, fsGroupKey: "IS_MEMBERSHIP_DUES", type: "REVENUE" },
  // Age-graduated Junior tiers ("Junior I (16-18)", "Junior II
  // (12-15)", "Junior III (9-11)", "Junior IV (5-8)"). Also
  // catches "Junior Member" and "Junior Dues". Explicit Roman
  // numeral or age-parenthesis suffix disambiguates from Junior
  // as an expense-side program label.
  { test: /\bjunior\s+(?:i{1,4}|iv|v|\d+|member|dues|shareholder|class)\b/i, fsGroupKey: "IS_MEMBERSHIP_DUES", type: "REVENUE" },
  // Social class dues — "Social - Silver Club", "Social - Public",
  // "Social Member", "Social Dues". Anchored to a "social + X"
  // compound so "social event" (which is a marketing expense)
  // stays out.
  { test: /\bsocial\s*[-—]\s*|social\s+(?:member|dues|shareholder|silver|public|club)/i, fsGroupKey: "IS_MEMBERSHIP_DUES", type: "REVENUE" },
  // Wait-list dues (a percentage-rate wait-list class charged
  // reduced dues until a full share opens). Coulee Ridge names
  // this "Wait List full golf 5-10%".
  { test: /wait\s*list.{0,30}(?:golf|shareholder|member|dues|%)/i, fsGroupKey: "IS_MEMBERSHIP_DUES", type: "REVENUE" },
  // Regional / affiliation golf dues — e.g. "Alberta Golf Dues"
  // are provincial-body dues passed through to the province.
  // These are membership-related revenue collected from members
  // and paid on to the association.
  { test: /(?:alberta|bc|ontario|quebec|manitoba|saskatchewan|nova\s+scotia|new\s+brunswick|pei|northern|yukon|provincial|regional|national)\s+golf\s*(?:dues|fee)?\b/i, fsGroupKey: "IS_MEMBERSHIP_DUES", type: "REVENUE" },
  // "Premium Dues" / "Monthly Premium Dues" / "Premium Membership".
  // The word "premium" combined with any dues/membership token is
  // unambiguously a membership-revenue signal.
  { test: /premium\s+(?:dues|membership|shareholder|member)|(?:monthly|annual)\s+premium/i, fsGroupKey: "IS_MEMBERSHIP_DUES", type: "REVENUE" },
  // Inactive / honorary / life member classes — clubs often keep
  // reduced-rate or nominal dues for these categories.
  { test: /\b(?:inactive|honorary|life|associate|founding)\s+(?:member|shareholder|dues)/i, fsGroupKey: "IS_MEMBERSHIP_DUES", type: "REVENUE" },
  // Family / spousal / dependent-membership dues — these are add-on
  // memberships attached to a primary member's account and are
  // still membership revenue. Placed AFTER the shareholder /
  // designate / spouse rules above so more-specific patterns win,
  // and BEFORE the entrance-fee rule so "family membership" isn't
  // mistaken for an initiation event.
  { test: /family\s+membership|family\s+dues|spousal\s+membership|dependent\s+membership|spousal\s+dues/i, fsGroupKey: "IS_MEMBERSHIP_DUES", type: "REVENUE" },
  { test: /initiation\s*fee|entrance\s*fee/i, fsGroupKey: "IS_ENTRANCE_FEES", type: "REVENUE" },
  // Assessments — capital, special, and project-tagged capital
  // assessments ("Irrigation Assessment", "Clubhouse Assessment",
  // "Course Assessment"). These are one-off levies raised for
  // specific capital projects and belong in the capital-assessment
  // revenue bucket, not membership dues.
  { test: /capital\s*assess|special\s*assess|capital\s*lev|(?:irrigation|clubhouse|course|building|facility|project)\s+assessment/i, fsGroupKey: "IS_CAPITAL_ASSESSMENTS", type: "REVENUE" },
  // Annual / service fees — locker, cart storage, club storage,
  // bag storage, trail fees, handicap. Sprint 3 · 15K: the
  // "locker" pattern now allows a word between "locker" and
  // "fee" (e.g. "Locker Rental Fees"), and adds "club storage",
  // "bag storage", and "trail fee" as the canonical private-
  // club service-fee vocabulary.
  { test: /annual\s*fee|locker\s+(?:\w+\s+)?(?:fee|rental|revenue)|locker\s*revenue|locker\s*fee|cart\s*storage|club\s*storage|bag\s*storage|trail\s*fee|handicap\s*fee/i, fsGroupKey: "IS_ANNUAL_FEES", type: "REVENUE" },
  { test: /green\s*fee|guest\s*fee|tee.?time/i, fsGroupKey: "IS_GREEN_FEES", type: "REVENUE" },
  // Founder rule 2026-07-01 v14.18 — cart revenue accepts:
  //   • singular / plural ("Cart Rental", "Carts Rental",
  //     "Cart Rentals", "Carts Rentals")
  //   • both word orders ("Cart Rental", "Rental Cart")
  //   • revenue / fee / storage variants
  //   • combined "Cart & Range" / "Carts & Range" line
  // Prior regex only handled "Cart Rental" (singular, one word
  // order) and skipped every plural/reversed variant, dumping
  // them into IS_OTHER_REVENUE.
  { test: /carts?\s*(revenue|revenues|fee|fees|rental|rentals|&\s*range|and\s*range)|rentals?\s*carts?\b/i, fsGroupKey: "IS_CART_REVENUE", type: "REVENUE" },
  { test: /driving\s*range|range\s*fee|range\s*ball/i, fsGroupKey: "IS_DRIVING_RANGE", type: "REVENUE" },
  { test: /lesson\s*revenue|lesson\s*income|golf\s*lesson|junior\s*program/i, fsGroupKey: "IS_GOLF_LESSONS", type: "REVENUE" },
  { test: /tournament\s*revenue|tournament\s*entry|tournament\s*sponsor/i, fsGroupKey: "IS_TOURNAMENT", type: "REVENUE" },
  { test: /pro\s*shop\s*(rev|sales|merch)|golf\s*shop\s*sale|merchandise\s*sale|retail\s*revenue|retail\s*sales/i, fsGroupKey: "IS_PRO_SHOP_MERCH", type: "REVENUE" },
  // Founder rule 2026-06-29 v9 — hospitality revenue priority.
  // The engine MUST determine the primary business activity before
  // selecting an FS Group. Priority order:
  //   1. Facility Rentals (Room / Hall / Ballroom / Facility Rental)
  //   2. Events Revenue (Banquet / Wedding / Conference / Function / Reception / Meeting Room / Private Event)
  //   3. Catering Sales (any cater* term — overrides what's catered)
  //   4. Beverage Sales (Liquor / Beer / Wine / Pop / Soft Drink / Draft Beer / Beverage)
  //   5. Food Sales (only genuine food revenue: bare "food", Restaurant Food, Kitchen Sales, Sales - Food)
  // All five are highPrecedence so the keyword fires even against
  // stale specific existing-account mappings (the bug: F&B revenue
  // accounts inheriting the wrong bucket).
  // F&B aggregate sales (a single combined "F&B Sales" / "Food
  // and Beverage Revenue" account) → Food Sales per legacy
  // convention. Must fire before Beverage so the bare `bever`
  // token doesn't claim the combined account.
  { test: /\bf\s*&?\s*b[\s\W]+(sale|revenue|income|dining)|food\s+and\s+beverage[\s\W]+(sale|revenue|income)/i, fsGroupKey: "IS_FOOD_SALES", type: "REVENUE", highPrecedence: true },
  { test: /room\s*rental|hall\s*rental|facility\s*rent(al)?|ballroom|parking\s*revenue/i, fsGroupKey: "IS_FACILITY_RENTALS", type: "REVENUE", highPrecedence: true },
  { test: /banquet|wedding|conference|meeting\s*room|reception|private\s*event|\bfunction\b|event\s*revenue|\bevents?\b/i, fsGroupKey: "IS_EVENT_REVENUE", type: "REVENUE", highPrecedence: true },
  { test: /\bcater(ing|ed)?\b/i, fsGroupKey: "IS_CATERING", type: "REVENUE", highPrecedence: true },
  { test: /\bliquor\b|\bbeer\b|\bwine\b|\bpop\b|soft\s*drink|draft\s*beer|\bbever(age)?\b|bar\s*sale/i, fsGroupKey: "IS_BEVERAGE_SALES", type: "REVENUE", highPrecedence: true },
  { test: /food\s*sale|food\s*revenue|sales?[\s\W]+food|restaurant\s*food|kitchen\s*sale|f\s*&?\s*b\s*dining|dining\s*revenue|food\s+and\s+beverage[\s\W]+(sale|revenue|income)|\bfood\b/i, fsGroupKey: "IS_FOOD_SALES", type: "REVENUE", highPrecedence: true },
  { test: /interest\s*(income|earn|received)/i, fsGroupKey: "IS_INTEREST_INCOME", type: "REVENUE" },
  { test: /gain.*(disposal|sale)|loss.*(disposal|sale)|asset\s*disposal/i, fsGroupKey: "IS_ASSET_GAIN_LOSS", type: "REVENUE" },
  // Founder rule 2026-07-01 v14.22 — "Share Transfer Fee" is
  // the fee earned when equity shares transfer between
  // shareholders (typically parent → child at a member club).
  // Prior regex left it unmatched, so a 9xxx account fell to
  // the number-range default (IS_OTHER_EXPENSES). Explicit
  // pattern routes it to IS_OTHER_REVENUE + the credit-balance
  // sign check below reinforces the classification.
  // Scoped to `share transfer fee` (not the bare `transfer fee`)
  // so it can't accidentally catch expense-side "Wire Transfer
  // Fee" / "Bank Transfer Fee".
  { test: /share\s*transfer\s*fee/i, fsGroupKey: "IS_OTHER_REVENUE", type: "REVENUE" },

  // LIABILITIES — founder rule 2026-06-29 v7. All high-precedence
  // keyword rules sit at the top so the bracket+keyword path beats
  // stale BS_LONG_TERM_DEBT inheritance:
  //   • Credit cards → AP (founder explicitly: no separate FS group)
  //   • Sales tax → Sales Tax Payable
  //   • Deferred capital contributions → its own bucket
  //   • Gift cards + credit books → Long-Term Liabilities
  //   • Every deposit kind → Deposits Payable
  { test: /\bvisa\b|mastercard|\bmaster\s*card\b|\bmc\s+(card|payable)\b|\bmc\b\s*\d|\bamex\b|american\s*express|\bcredit\s*card\b|corporate\s*card|purchasing\s*card|\bp[-\s]?card\b/i, fsGroupKey: "BS_AP", type: "LIABILITY", highPrecedence: true },
  // Sales tax — word-bounded on GST/HST/PST/QST + recognises
  // ITC ("Input Tax Credit" after normalization), Tax Filed,
  // Tax Collected, Tax Payable.
  { test: /\bgst\b|\bhst\b|\bpst\b|\bqst\b|sales\s*tax|tax\s*collect|tax\s*payable|tax\s*filed|input\s*tax\s*credit/i, fsGroupKey: "BS_SALES_TAX_PAYABLE", type: "LIABILITY", highPrecedence: true },
  // Deferred capital contributions — non-debt, recognised over years.
  { test: /deferred\s*capital\s*contributions?|capital\s*contributions?\s*deferred|deferred\s*contributions?/i, fsGroupKey: "BS_DEFERRED_CAPITAL_CONTRIBUTIONS", type: "LIABILITY", highPrecedence: true },
  // Founder rule 2026-06-29 v8 — custodial section funds.
  // Men's / Ladies / Women's / Junior / Senior + Section, plus
  // Match Play, Member Guest, Tournament Fund, Charity Fund,
  // Section Fund, Section Account, Club Section. The bracket-
  // first design already filters out revenue-side "Member Guest"
  // accounts (this rule is LIABILITY-typed), and "Seniors" is
  // paired with section/match-play/fund context so it doesn't
  // false-positive on "Senior Manager Wages".
  // Founder rule 2026-07-01 v14.22 — "Senior Mens" (and
  // "Senior Men's" / "Senior Men") is another member section,
  // just like "Mens Section" and "Ladies Section". Extending
  // the section-funds pattern with `senior[\s-]*men'?s?\b`
  // captures Jonas TB rows like "Senior Mens Interclub" and
  // "Senior Mens Day" without accidentally matching payroll
  // rows like "Senior Mens Wages" — the rule is LIABILITY-typed,
  // and expense-side rows would fire against the payroll regex
  // in the EXPENSE-typed rule below, not this one.
  { test: /(?:men'?s|mens|ladies|women'?s|womens|junior|seniors?)\s*section|senior[\s-]*men'?s?\b|(?:men'?s|mens|ladies|women'?s|womens)?[\s-]*member[\s-]*guest|seniors?\s*(?:match\s*play|tournament|fund|account)|\bmatch\s*play\b|tournament\s*fund|charity\s*fund|section\s*(?:fund|account)|club\s*section/i, fsGroupKey: "BS_SECTION_FUNDS", type: "LIABILITY", highPrecedence: true },
  // Gift cards + credit books → generic Long-Term Liabilities
  // (no dedicated FS group; founder v7 correction).
  { test: /gift\s*card|gift\s*certif|credit\s*book|incentive\s*credit|cash\s*value\s*credit/i, fsGroupKey: "BS_LONG_TERM_LIABILITIES", type: "LIABILITY", highPrecedence: true },
  // Deposits Payable — single bucket for share-purchase /
  // waitlist / member / event / tournament / rental / banquet /
  // damage / security / external-group deposits.
  { test: /share\s*purch(ase)?\s*(credit|deposit)|waitlist[\s\W-]*(share\s*purchase|deposit)|designat(ed)?[\s\W-]*share\s*purchase|external\s*group\s*deposit|tournament\s*deposit|rental\s*deposit|banquet\s*deposit|damage\s*deposit|security\s*deposit|member\s*deposit|private\s*event\s*deposit|event\s*deposit|refundable\s*deposit/i, fsGroupKey: "BS_DEPOSITS_PAYABLE", type: "LIABILITY", highPrecedence: true },
  // Generic AP after the credit-card high-precedence rule so
  // "Accts Payable" + "Visa" land on AP either way.
  { test: /trade\s*pay|accounts?\s*payable|^ap\b|\bap\b\s*[-—]/i, fsGroupKey: "BS_AP", type: "LIABILITY" },
  { test: /deferred\s*revenue|dues.*deferred|deferred.*dues|unearned\s*revenue/i, fsGroupKey: "BS_DEFERRED_REVENUE", type: "LIABILITY" },
  // Founder rule 2026-07-01 v14.18 — "Capital Lease" and
  // "Finance Lease" are lease liabilities (financing arrangements
  // recognised on the balance sheet), so they route to
  // BS_LEASE_LIABILITIES. Prior regex only matched "Lease
  // Liability" / "Lease Obligation", so "Capital Lease - Sonoma
  // Smart Meter" (a real Jonas TB line) fell through to the 2xxx
  // bracket default (BS_OTHER_LIABILITIES). The bracket + LIABILITY
  // typing prevents this from firing on any EXPENSE-side
  // "equipment lease" account.
  { test: /capital\s*lease|finance\s*lease|lease\s*liab|lease\s*obligation/i, fsGroupKey: "BS_LEASE_LIABILITIES", type: "LIABILITY" },
  // Long-Term Debt — only genuine debt instruments. Gift cards /
  // credit books / deposits / deferred contributions live in
  // their own non-debt buckets above.
  { test: /long.?term\s*debt|mortgage|term\s*loan|bank\s*loan|loan\s*payable|note\s*payable|debenture|credit\s*facility|financing\s*debt/i, fsGroupKey: "BS_LONG_TERM_DEBT", type: "LIABILITY" },

  // ASSETS (investment / capital-asset context — must come
  // AFTER expense rules so "Vehicle Fuel" / "Equipment Maintenance"
  // never accidentally match. Cash / AR / Inventory / Prepaid
  // live at the top of the list instead.) -------------------------------
  { test: /\binvest(ment)?\b|marketable\s*secur|\bgic\b|long.?term\s*invest/i, fsGroupKey: "BS_INVESTMENTS", type: "ASSET" },
  // Construction in Progress (CIP) — the specific FS group for
  // unfinished capital projects. Recognises the full phrase
  // ("Construction in Progress"), the founder-observed shorthand
  // ("Construct in Progress") — a Jonas TB convention where the
  // -ion suffix was dropped for column-width reasons — and the
  // classical abbreviations ("CIP", "WIP", "Work in Progress",
  // "Capital Work in Progress"). Sub-classifiers on the tail
  // ("Teeboxes", "Irrigation", "Clubhouse") are captured as
  // department / project context downstream; they never displace
  // the primary CIP grouping while the asset is still under
  // construction.
  { test: /(?:construction|construct)\s*in\s*progress|capital\s*work\s*in\s*progress|\bcip\b|\bwip\b|work\s*in\s*progress/i, fsGroupKey: "BS_CIP", type: "ASSET" },
  { test: /right.?of.?use|rou\s*asset/i, fsGroupKey: "BS_ROU_ASSETS", type: "ASSET" },
  { test: /intangible|goodwill|trademark|software\s*licen[sc]e/i, fsGroupKey: "BS_INTANGIBLES", type: "ASSET" },
  // Capital assets — explicit asset language only (so "Vehicle
  // Fuel" hits IS_VEHICLE_EQUIPMENT above, not this).
  //
  // The pattern captures the canonical private-club capital-asset
  // vocabulary. Any single hit is enough — the founder's rule is
  // "obvious accounting terminology should never fall to Current
  // Assets / Other Assets". Guards:
  //   • building(?!\s*repair)              — "Building Repairs" stays with IS_REPAIRS_MAINTENANCE
  //   • capital(?!\s*(?:assess|lease|contrib|fund|reserve))
  //                                         — "Capital Assessment" (revenue), "Capital Lease" (liability),
  //                                           "Capital Contribution" (equity/liability),
  //                                           "Capital Fund" (equity), "Capital Reserve" (equity)
  //                                           are handled by their own dedicated rules.
  //   • equipment\s*(?:&|and)\s*(?:fixtures?|furniture|vehicles?|machinery|tools?)
  //                                         — asset-side "Equipment & Fixtures", "Equipment and Furniture", etc.
  //                                           Bracket-typed to ASSET, so operational lines like "Equipment
  //                                           Rental" (expense) can't match this rule.
  //   • furniture\s*(?:&|and)\s*fixtures?   — "Furniture & Fixtures" / "Furn & Fixtures"
  //   • equipment\s+under\s+financing       — asset side of financed equipment (the paired liability is
  //                                           "Capital Lease Liability" / "Lease Obligation").
  //   • leasehold\s*improve                 — leasehold improvements
  //   • computer\s*(?:equipment|hardware)   — capital IT (bare "computer" without "equipment" stays with
  //                                           IS_IT_SOFTWARE via the expense bracket).
  //   • \bvehicles?\b                       — bare "Vehicles" (asset context; expense-side "Vehicle Fuel /
  //                                           Repair / Maintenance / Rental" already matched IS_VEHICLE_EQUIPMENT
  //                                           via the earlier expense rule).
  { test: /\bland\b|building(?!\s*repair)|course\s*improve|leasehold\s*improve|capital\s*improve|equipment\s*(?:&|and)\s*(?:fixtures?|furniture|vehicles?|machinery|tools?)|furniture\s*(?:&|and)\s*fixtures?|equipment\s+under\s+financing|computer\s*(?:equipment|hardware)|machinery|accumulated\s*deprec|capital(?!\s*(?:assess|lease|contrib|fund|reserve))\s*asset|property\s*&\s*equipment|fixed\s*asset|\bvehicles?\b/i, fsGroupKey: "BS_CAPITAL_ASSETS", type: "ASSET" },

  // EQUITY ----------------------------------------------------------------
  // Share capital / member equity. Sprint 3 · 15K: "Shareholder
  // Equity" and "Shareholders' Equity" are common summary account
  // names on member-owned club balance sheets and should route to
  // BS_SHARE_CAPITAL. Bracket is EQUITY so this cannot fire on a
  // REVENUE-side "Shareholder ..." dues line.
  { test: /share\s*capital|member\s*share|paid.?in\s*capital|shareholders?'?\s*equity|shareholder\s*capital/i, fsGroupKey: "BS_SHARE_CAPITAL", type: "EQUITY" },
  { test: /retained\s*earning/i, fsGroupKey: "BS_RETAINED_EARNINGS", type: "EQUITY" },
  { test: /current.?year\s*earning|net\s*income\s*current/i, fsGroupKey: "BS_CURRENT_YEAR_EARNINGS", type: "EQUITY" },
  { test: /capital\s*reserve|capital\s*fund|reserve\s*fund/i, fsGroupKey: "BS_CAPITAL_RESERVE", type: "EQUITY" },
  { test: /accumulated\s*oci|other\s*comprehensive/i, fsGroupKey: "BS_ACCUMULATED_OCI", type: "EQUITY" },
];

// ---------------------------------------------------------------------------
// FS Group → Category mapping (canonical).
// Each canonical FS Group rolls into exactly one Category for
// auto-mapping purposes. Operators can override later.
// ---------------------------------------------------------------------------
// Exported for the v10 guard test: every key the predictor can
// emit MUST exist in DEFAULT_FS_GROUPS and MUST NOT appear in
// RETIRED_FS_GROUP_KEYS — otherwise the canonical sync deletes
// the FS Group right after creating it and validation rejects.
export const FS_GROUP_TO_CATEGORY: Record<string, string> = {
  // Assets
  BS_CASH_EQUIVALENTS: "CURRENT_ASSETS",
  BS_AR: "CURRENT_ASSETS",
  BS_MEMBER_AR: "CURRENT_ASSETS",
  BS_INVENTORY: "CURRENT_ASSETS",
  BS_PREPAID_EXPENSES: "CURRENT_ASSETS",
  BS_INVESTMENTS: "INVESTMENTS",
  BS_CAPITAL_ASSETS: "CAPITAL_ASSETS",
  BS_CIP: "CAPITAL_ASSETS",
  BS_ROU_ASSETS: "CAPITAL_ASSETS",
  BS_INTANGIBLES: "CAPITAL_ASSETS",
  // Non-current receivables (1400-range) — groups under
  // OTHER_ASSETS Category until a dedicated category exists.
  BS_LONG_TERM_RECEIVABLES: "OTHER_ASSETS",
  BS_OTHER_ASSETS: "OTHER_ASSETS",
  // Liabilities
  BS_AP: "CURRENT_LIABILITIES",
  BS_ACCRUED_LIABILITIES: "CURRENT_LIABILITIES",
  BS_PAYROLL_LIABILITIES: "CURRENT_LIABILITIES",
  BS_SALES_TAX_PAYABLE: "CURRENT_LIABILITIES",
  BS_DEFERRED_REVENUE: "CURRENT_LIABILITIES",
  // Founder rule 2026-06-29 v7 — single Deposits Payable bucket
  // for every deposit kind. Long-Term Liabilities is the generic
  // non-debt long-term bucket (gift cards / credit books).
  BS_DEPOSITS_PAYABLE: "LONG_TERM_LIABILITIES",
  BS_LONG_TERM_LIABILITIES: "LONG_TERM_LIABILITIES",
  // Founder rule 2026-06-29 v8 — Section Funds default. Clubs
  // that spend section balances within the fiscal year can
  // reconfigure this to CURRENT_LIABILITIES at the FS Group
  // level without touching the auto-mapper.
  BS_SECTION_FUNDS: "LONG_TERM_LIABILITIES",
  BS_DEFERRED_CAPITAL_CONTRIBUTIONS: "LONG_TERM_LIABILITIES",
  BS_LEASE_LIABILITIES: "LONG_TERM_LIABILITIES",
  BS_LONG_TERM_DEBT: "LONG_TERM_LIABILITIES",
  BS_OTHER_LIABILITIES: "LONG_TERM_LIABILITIES",
  // Equity
  BS_SHARE_CAPITAL: "EQUITY",
  BS_RETAINED_EARNINGS: "EQUITY",
  BS_CURRENT_YEAR_EARNINGS: "EQUITY",
  BS_CAPITAL_RESERVE: "EQUITY",
  BS_ACCUMULATED_OCI: "EQUITY",
  BS_OTHER_EQUITY: "EQUITY",
  // Revenue
  IS_MEMBERSHIP_DUES: "MEMBERSHIP_REVENUE",
  IS_ANNUAL_FEES: "MEMBERSHIP_REVENUE",
  IS_ENTRANCE_FEES: "MEMBERSHIP_REVENUE",
  IS_CAPITAL_ASSESSMENTS: "MEMBERSHIP_REVENUE",
  IS_GREEN_FEES: "GOLF_OPS_REVENUE",
  IS_CART_REVENUE: "GOLF_OPS_REVENUE",
  IS_DRIVING_RANGE: "GOLF_OPS_REVENUE",
  IS_GOLF_LESSONS: "GOLF_OPS_REVENUE",
  IS_TOURNAMENT: "GOLF_OPS_REVENUE",
  IS_PRO_SHOP_MERCH: "GOLF_OPS_REVENUE",
  IS_FOOD_SALES: "FB_REVENUE",
  IS_BEVERAGE_SALES: "FB_REVENUE",
  IS_CATERING: "FB_REVENUE",
  IS_EVENT_REVENUE: "EVENT_REVENUE",
  IS_FACILITY_RENTALS: "RENTAL_REVENUE",
  IS_INTEREST_INCOME: "OTHER_REVENUE",
  IS_ASSET_GAIN_LOSS: "OTHER_REVENUE",
  IS_OTHER_REVENUE: "OTHER_REVENUE",
  // Expenses
  IS_PAYROLL: "PAYROLL_BENEFITS",
  IS_COGS_MERCHANDISE: "COST_OF_SALES",
  IS_COGS_FOOD: "COST_OF_SALES",
  IS_COGS_BEVERAGE: "COST_OF_SALES",
  IS_UTILITIES: "UTILITIES",
  IS_REPAIRS_MAINTENANCE: "REPAIRS_MAINTENANCE",
  IS_PROPERTY_TAX: "OTHER_EXPENSES",
  IS_INCOME_TAX: "OTHER_EXPENSES",
  IS_INSURANCE: "INSURANCE",
  IS_OFFICE_SUPPLIES: "ADMIN_EXPENSES",
  IS_PROFESSIONAL_FEES: "PROFESSIONAL_SERVICES",
  IS_IT_SOFTWARE: "ADMIN_EXPENSES",
  IS_TELEPHONE_INTERNET: "ADMIN_EXPENSES",
  IS_BANK_CHARGES: "ADMIN_EXPENSES",
  IS_MERCHANT_FEES: "ADMIN_EXPENSES",
  IS_VEHICLE_EQUIPMENT: "REPAIRS_MAINTENANCE",
  IS_SMALL_TOOLS: "COURSE_GROUNDS",
  IS_JANITORIAL_SUPPLIES: "CLUBHOUSE_OPERATIONS",
  IS_CLEANING_SERVICES: "CLUBHOUSE_OPERATIONS",
  IS_SECURITY: "CLUBHOUSE_OPERATIONS",
  IS_STAFF_TRAINING: "ADMIN_EXPENSES",
  IS_MARKETING_ADVERTISING: "MARKETING_MEMBER_RELATIONS",
  IS_TRAVEL_MEALS: "ADMIN_EXPENSES",
  IS_MEMBERSHIPS_SUBS: "ADMIN_EXPENSES",
  IS_LICENCES_PERMITS: "ADMIN_EXPENSES",
  IS_DEPRECIATION: "OTHER_EXPENSES",
  IS_INTEREST_EXPENSE: "OTHER_EXPENSES",
  IS_OTHER_EXPENSES: "OTHER_EXPENSES",
};

// ---------------------------------------------------------------------------
// Number-range defaults (Type + sensible Category + "Other ..." FS Group).
// Used when neither existing-account match nor keyword match fires.
// ---------------------------------------------------------------------------
type NumberRangeDefault = {
  test: (n: number) => boolean;
  type: AccountType;
  categoryKey: string;
  fsGroupKey: string;
};
const NUMBER_RANGE_RULES: NumberRangeDefault[] = [
  { test: (n) => n >= 1000 && n <= 1999, type: "ASSET",     categoryKey: "CURRENT_ASSETS",     fsGroupKey: "BS_OTHER_ASSETS" },
  { test: (n) => n >= 2000 && n <= 2999, type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES",fsGroupKey: "BS_OTHER_LIABILITIES" },
  { test: (n) => n >= 3000 && n <= 3999, type: "EQUITY",    categoryKey: "EQUITY",             fsGroupKey: "BS_OTHER_EQUITY" },
  { test: (n) => n >= 4000 && n <= 4999, type: "REVENUE",   categoryKey: "OTHER_REVENUE",      fsGroupKey: "IS_OTHER_REVENUE" },
  { test: (n) => n >= 5000 && n <= 5999, type: "EXPENSE",   categoryKey: "COST_OF_SALES",      fsGroupKey: "IS_COGS_MERCHANDISE" },
  { test: (n) => n >= 6000 && n <= 8999, type: "EXPENSE",   categoryKey: "OTHER_EXPENSES",     fsGroupKey: "IS_OTHER_EXPENSES" },
  { test: (n) => n >= 9000 && n <= 9999, type: "EXPENSE",   categoryKey: "OTHER_EXPENSES",     fsGroupKey: "IS_OTHER_EXPENSES" },
];

const DEFAULT_PREDICTION: CoaPrediction = {
  type: "ASSET",
  categoryKey: "OTHER_ASSETS",
  fsGroupKey: "BS_OTHER_ASSETS",
  defaultDepartmentCode: null,
  fundApplicability: null, // ASSET default is BS → no fund tag
  confidence: "low",
  source: "default",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// FS Groups treated as "generic catch-all" buckets. An existing-
// account mapping pointing at one of these is treated as
// non-load-bearing — the number+name signal is allowed to
// override it. Specific buckets (anything not in this set)
// represent a deliberate prior decision and win precedence.
const GENERIC_FS_GROUPS = new Set<string>([
  "BS_OTHER_ASSETS",
  "BS_OTHER_LIABILITIES",
  "BS_OTHER_EQUITY",
  "IS_OTHER_REVENUE",
  "IS_OTHER_EXPENSES",
]);

// Founder rule 2026-06-29 v7 — high-precedence is now a per-
// rule flag (`highPrecedence: true` on the rule itself) rather
// than a hard-coded FS-group set. This lets the SAME FS group
// (e.g. BS_AP) be the target of both a high-precedence rule
// (credit cards always win) and a normal rule (generic
// "Accounts Payable" name doesn't override prior decisions).

/**
 * Founder rule 2026-06-29 refinement: the account NUMBER is the
 * single strongest predictor. When the number falls in a
 * conventional range, it determines the Type bracket; only
 * name-keyword rules of the matching Type are considered for
 * the specific FS Group within that bracket.
 *
 * 9xxx is intentionally not bracketed — it's ambiguous in the
 * standard (Other Revenue / Other Expense) and the founder
 * spec'd it to resolve via the account name.
 */
type TypeBracket = {
  type: AccountType;
  categoryKey: string;          // default Category when only the bracket fires
  fsGroupKey: string;            // default FS Group when only the bracket fires
};
function typeBracketForNumber(n: number): TypeBracket | null {
  if (n >= 1000 && n <= 1999) return { type: "ASSET",     categoryKey: "CURRENT_ASSETS",      fsGroupKey: "BS_OTHER_ASSETS" };
  if (n >= 2000 && n <= 2999) return { type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES", fsGroupKey: "BS_OTHER_LIABILITIES" };
  if (n >= 3000 && n <= 3999) return { type: "EQUITY",    categoryKey: "EQUITY",              fsGroupKey: "BS_OTHER_EQUITY" };
  if (n >= 4000 && n <= 4999) return { type: "REVENUE",   categoryKey: "OTHER_REVENUE",       fsGroupKey: "IS_OTHER_REVENUE" };
  if (n >= 5000 && n <= 5999) return { type: "EXPENSE",   categoryKey: "COST_OF_SALES",       fsGroupKey: "IS_COGS_MERCHANDISE" };
  if (n >= 6000 && n <= 8999) return { type: "EXPENSE",   categoryKey: "OTHER_EXPENSES",      fsGroupKey: "IS_OTHER_EXPENSES" };
  // 9xxx → ambiguous; let the name resolve.
  return null;
}

function firstKeywordMatch(
  name: string,
  ofType?: AccountType,
): typeof NAME_KEYWORD_RULES[number] | null {
  for (const rule of NAME_KEYWORD_RULES) {
    if (ofType && rule.type !== ofType) continue;
    if (rule.test.test(name)) return rule;
  }
  return null;
}

export function predictCoaRow(
  row: CoaPredictorInputRow,
  existingByNumber: ReadonlyMap<string, ExistingAccountSnapshot> = new Map(),
): CoaPrediction {
  // Founder rule 2026-06-29 v4 — expand common accounting
  // abbreviations BEFORE keyword matching. The original name in
  // `row.name` is preserved for display; only the prediction
  // pass sees the expanded text.
  //
  // Founder rule 2026-07-01 v14.18 — track whether normalization
  // actually changed the string, AND whether the keyword rule
  // that fired needed the expansion. When the original (pre-
  // expansion) name would NOT have matched the same rule, the
  // source is "abbreviation-normalized" so the UI can explain
  // ("interpreted 'Sctn' as 'Section'"). When the original
  // already matched, the source stays "name-keyword" — this
  // preserves the contract for names like "F&B Inventory" where
  // the trigger word is already recognisable.
  const originalName = row.name.trim().replace(/\s+/g, " ");
  const { normalized: name } =
    normalizeAccountNameForPredictionWithFlag(row.name);
  const keywordSource = (rule: KeywordRule): PredictionSource =>
    rule.test.test(originalName) ? "name-keyword" : "abbreviation-normalized";
  const num = Number.parseInt(row.number.trim(), 10);
  const bracket = Number.isFinite(num) ? typeBracketForNumber(num) : null;
  const existing = existingByNumber.get(row.number.trim());
  const existingIsSpecific =
    existing && existing.categoryKey && existing.fsGroupKey &&
    !GENERIC_FS_GROUPS.has(existing.fsGroupKey);

  // 1. NUMBER + NAME AGREE → highest confidence. Bracket limits
  //    keyword scope to the matching Type so revenue keywords
  //    can't hijack an asset row (the "Accts Receivable —
  //    Monthly Dues" bug). When existing-account exists AND is
  //    specific AND its Type also matches the bracket, prefer
  //    the existing mapping (operator's specific prior decision
  //    survives). Otherwise the bracket-constrained keyword
  //    rule picks the FS Group.
  if (bracket) {
    // Founder rule 2026-06-29 v5 — check the keyword FIRST and,
    // when it lands on a HIGH_PRECEDENCE bucket (credit cards,
    // sales tax — names that are unambiguous), return
    // immediately. This beats even a specific existing-account
    // mapping so a stale BS_LONG_TERM_DEBT seed can't keep
    // re-inheriting onto "Bank - Visa 8103" or "GST Collected".
    const bracketKeyword = firstKeywordMatch(name, bracket.type);
    if (bracketKeyword && bracketKeyword.highPrecedence) {
      return {
        type: bracket.type,
        categoryKey: FS_GROUP_TO_CATEGORY[bracketKeyword.fsGroupKey] ?? bracket.categoryKey,
        fsGroupKey: bracketKeyword.fsGroupKey,
        defaultDepartmentCode: null,
        fundApplicability: fundForPrediction(bracket.type, bracketKeyword.fsGroupKey),
        confidence: "high",
        source: keywordSource(bracketKeyword),
      };
    }
    if (existingIsSpecific && existing.type === bracket.type) {
      return {
        type: existing.type as AccountType,
        categoryKey: existing.categoryKey!,
        fsGroupKey: existing.fsGroupKey!,
        defaultDepartmentCode: existing.defaultDepartmentCode,
        fundApplicability: fundForPrediction(existing.type as AccountType, existing.fsGroupKey),
        confidence: "high",
        source: "existing-account",
      };
    }
    if (bracketKeyword) {
      // Founder rule 2026-06-29 v3 — 1400-1499 holds NON-current
      // receivables (share-financing notes, supplier rebates,
      // long-term loans receivable). When an AR-family keyword
      // fires inside that sub-bracket, route the FS Group to
      // BS_LONG_TERM_RECEIVABLES + Category OTHER_ASSETS so
      // share-financing AR doesn't get grouped with current
      // member AR on the balance sheet.
      const isLongTermReceivableRange = num >= 1400 && num <= 1499;
      const isArFamily =
        bracketKeyword.fsGroupKey === "BS_AR" ||
        bracketKeyword.fsGroupKey === "BS_MEMBER_AR";
      if (isLongTermReceivableRange && isArFamily) {
        // Founder rule 2026-07-01 v14.18 — this is the canonical
        // "nearby-account-range" case: keyword identifies the
        // receivable nature, and the 1400-1499 sub-bracket
        // routes it to the long-term shelf. Surfacing this as
        // its own source lets the UI explain: "keyword matched,
        // number range promoted to long-term".
        return {
          type: bracket.type,
          categoryKey: "OTHER_ASSETS",
          fsGroupKey: "BS_LONG_TERM_RECEIVABLES",
          defaultDepartmentCode: null,
          fundApplicability: fundForPrediction(bracket.type, "BS_LONG_TERM_RECEIVABLES"),
          confidence: "high",
          source: "nearby-account-range",
        };
      }
      return {
        type: bracket.type,
        categoryKey: FS_GROUP_TO_CATEGORY[bracketKeyword.fsGroupKey] ?? bracket.categoryKey,
        fsGroupKey: bracketKeyword.fsGroupKey,
        defaultDepartmentCode: null,
        fundApplicability: fundForPrediction(bracket.type, bracketKeyword.fsGroupKey),
        confidence: "high",
        source: keywordSource(bracketKeyword),
      };
    }
    // Bracket fired, no matching-type keyword — use bracket default.
    // The Type is still correct; only the FS Group is a fallback.
    return {
      type: bracket.type,
      categoryKey: bracket.categoryKey,
      fsGroupKey: bracket.fsGroupKey,
      defaultDepartmentCode: null,
      fundApplicability: fundForPrediction(bracket.type, bracket.fsGroupKey),
      confidence: "medium",
      source: "number-range",
    };
  }

  // 2. NO BRACKET — fall through to the keyword + existing path.
  //    Existing-account specific still wins; otherwise first
  //    keyword match wins; existing-account generic last.
  if (existingIsSpecific) {
    return {
      type: existing.type as AccountType,
      categoryKey: existing.categoryKey!,
      fsGroupKey: existing.fsGroupKey!,
      defaultDepartmentCode: existing.defaultDepartmentCode,
      fundApplicability: fundForPrediction(existing.type as AccountType, existing.fsGroupKey),
      confidence: "high",
      source: "existing-account",
    };
  }
  const anyKeyword = firstKeywordMatch(name);
  if (anyKeyword) {
    return {
      type: anyKeyword.type,
      categoryKey: FS_GROUP_TO_CATEGORY[anyKeyword.fsGroupKey] ?? "OTHER_EXPENSES",
      fsGroupKey: anyKeyword.fsGroupKey,
      defaultDepartmentCode: null,
      fundApplicability: fundForPrediction(anyKeyword.type, anyKeyword.fsGroupKey),
      confidence: "high",
      source: keywordSource(anyKeyword),
    };
  }
  if (existing && existing.categoryKey && existing.fsGroupKey) {
    return {
      type: existing.type as AccountType,
      categoryKey: existing.categoryKey,
      fsGroupKey: existing.fsGroupKey,
      defaultDepartmentCode: existing.defaultDepartmentCode,
      fundApplicability: fundForPrediction(existing.type as AccountType, existing.fsGroupKey),
      confidence: "high",
      source: "existing-account",
    };
  }

  // 3. 9xxx range catch-all when name also missed (still useful
  //    for "Other Revenue / Other Expense" defaults).
  if (Number.isFinite(num)) {
    for (const range of NUMBER_RANGE_RULES) {
      if (range.test(num)) {
        // Founder rule 2026-07-01 v14.22 — trial-balance sign as
        // a tie-breaker. Applies ONLY to the 9xxx "Other" bracket
        // (the only range the standard treats as ambiguous
        // between Other Revenue and Other Expense). A credit
        // balance on a 9xxx account promotes it from the
        // default EXPENSE bucket to REVENUE / IS_OTHER_REVENUE,
        // so a line like "Share Transfer Fee" that missed every
        // keyword still lands correctly. Sign is IGNORED in
        // 1xxx-8xxx — those ranges have unambiguous type
        // brackets and we don't want the predictor to silently
        // reinterpret a misfiled account.
        const isNineHundreds = num >= 9000 && num <= 9999;
        const debit = row.debit ?? 0;
        const credit = row.credit ?? 0;
        if (isNineHundreds && credit > debit && credit > 0) {
          return {
            type: "REVENUE",
            categoryKey: "OTHER_REVENUE",
            fsGroupKey: "IS_OTHER_REVENUE",
            defaultDepartmentCode: null,
            fundApplicability: fundForPrediction("REVENUE", "IS_OTHER_REVENUE"),
            confidence: "medium",
            source: "balance-sign-supported",
          };
        }
        return {
          type: range.type,
          categoryKey: range.categoryKey,
          fsGroupKey: range.fsGroupKey,
          defaultDepartmentCode: null,
          fundApplicability: fundForPrediction(range.type, range.fsGroupKey),
          confidence: "medium",
          source: "number-range",
        };
      }
    }
  }

  // 4. Fallback.
  return DEFAULT_PREDICTION;
}

/**
 * Predict mappings for a whole batch in one call. Runs the pure
 * per-row predictor for every row, then applies a chart-level
 * reasonableness pass that catches implausible mapping outcomes a
 * private-club COA cannot legitimately produce (Sprint 3 · 15K).
 *
 * The reasonableness pass is intentionally narrow: it only
 * PROMOTES rows that a specialised classifier would have caught if
 * its rule set were exhaustive. It NEVER downgrades a per-row
 * high-confidence match, and it NEVER writes into a category the
 * per-row engine hasn't already vetted. The output is an audit-
 * ready contract: a `chart-reassessment` source labels every row
 * the pass touched, so the UI + audit log can explain to the
 * founder why a "shareholder" account moved out of Other Revenue.
 */
export function predictCoaBatch(
  rows: ReadonlyArray<CoaPredictorInputRow>,
  existingByNumber: ReadonlyMap<string, ExistingAccountSnapshot> = new Map(),
): CoaPrediction[] {
  const predictions = rows.map((r) => predictCoaRow(r, existingByNumber));
  return applyChartReasonablenessPass(rows, predictions);
}

// ---------------------------------------------------------------------------
// Chart-level reasonableness pass (Sprint 3 · Checkpoint 15K)
// ---------------------------------------------------------------------------
//
// Detects private-club-specific implausible mapping outcomes and
// promotes clearly-attributable rows out of the generic "Other
// Revenue / Other Expense" catch-all bucket. Currently detects:
//
//   1. Membership-dues omission.
//      Trigger: ≥ 3 revenue rows whose names contain private-club
//        membership-class terminology (shareholder, designate
//        golfer, member dues, monthly/annual dues, or a graduated
//        Junior tier), AND 0 rows currently classified on
//        IS_MEMBERSHIP_DUES.
//      Action: promote every matching row from OTHER_REVENUE /
//        IS_OTHER_REVENUE to MEMBERSHIP_REVENUE / IS_MEMBERSHIP_DUES
//        with source `chart-reassessment` and confidence downgraded
//        to `medium` (the per-row engine considered it a Miss;
//        promotion is a defensible inference, not a direct match).
//
// Future omissions to detect (structure ready; not implemented yet):
//   • No cash accounts despite bank / petty cash names.
//   • No accounts receivable despite Member A/R names.
//   • No accumulated depreciation despite Accum Deprec names.
//   • No food/beverage revenue despite F&B account names.
//   • No salaries expense despite wage/payroll account names.
//
// Each detection lives in its own function so tests + tuning stay
// scoped. `applyChartReasonablenessPass` composes them.

const MEMBERSHIP_CLASS_HINT =
  /\bshareholder\b|\bdesignate[ds]?\s+golfer\b|membership\s*dues|monthly\s*dues|annual\s*dues|member\s*dues|(?:golf|male|senior|lady)\s+(?:golf\s+)?spouse\b|(?:sponsored\s+|junior\s+)?intermediate\b|\bjunior\s+(?:i{1,4}|iv|v|\d+|member|dues|class)\b|\bsocial\s+(?:member|dues|shareholder|silver|public|club)\b|premium\s+(?:dues|membership)\b|(?:inactive|honorary|life|associate|founding)\s+(?:member|shareholder|dues)/i;

function isMembershipHintName(name: string): boolean {
  const { normalized } = normalizeAccountNameForPredictionWithFlag(name);
  return MEMBERSHIP_CLASS_HINT.test(normalized);
}

/**
 * Returns a NEW prediction array with the chart-level pass applied.
 * Never mutates the input.
 */
function applyChartReasonablenessPass(
  rows: ReadonlyArray<CoaPredictorInputRow>,
  predictions: ReadonlyArray<CoaPrediction>,
): CoaPrediction[] {
  const out = predictions.map((p) => ({ ...p }));

  // ---- 1. Membership-dues omission --------------------------------
  const hintIndices: number[] = [];
  let hasMembershipDues = false;
  for (let i = 0; i < rows.length; i++) {
    const p = out[i];
    if (p.fsGroupKey === "IS_MEMBERSHIP_DUES") hasMembershipDues = true;
    // Only consider REVENUE-bracket rows currently sitting on the
    // generic "Other Revenue" bucket — those are the ones the per-
    // row engine gave up on. Rows that ALREADY landed on a specific
    // revenue bucket (green fees, cart, food, entrance) are left
    // alone.
    if (
      p.type === "REVENUE" &&
      p.fsGroupKey === "IS_OTHER_REVENUE" &&
      isMembershipHintName(rows[i].name)
    ) {
      hintIndices.push(i);
    }
  }
  // Trigger: ≥ 3 shareholder/member-class rows fell to Other Revenue
  // AND the chart has zero membership-dues classifications. A single
  // stray shareholder-named account (e.g. a one-off transfer fee)
  // isn't enough to justify a chart-wide promotion.
  if (!hasMembershipDues && hintIndices.length >= 3) {
    for (const i of hintIndices) {
      out[i] = {
        type: "REVENUE",
        categoryKey: "MEMBERSHIP_REVENUE",
        fsGroupKey: "IS_MEMBERSHIP_DUES",
        defaultDepartmentCode: null,
        fundApplicability: fundForPrediction("REVENUE", "IS_MEMBERSHIP_DUES"),
        // A batch-level defensible inference, not a direct per-row
        // match — downgraded to medium so the UI still flags it for
        // review.
        confidence: "medium",
        source: "chart-reassessment",
      };
    }
  }

  return out;
}
