// Sprint 3 Checkpoint 15L (2026-07-27) — GL-account recommendation
// rewritten to consult the actual committed Chart of Accounts and to
// produce a credible recommendation even when NO vendor record exists
// yet.
//
// Prior (15E) behaviour dropped every operating invoice with no
// vendor match onto `{ source: "NONE" }` — that surfaced as
// "CATEGORY —" on the AP intake card and blocked founder acceptance
// of the Coulee Ridge Microsoft invoice. The founder rule
// (Checkpoint 15L Phase 2): draft coding must complete before the
// vendor record exists; only the actual AP posting requires the
// vendor.
//
// This module is deterministic. No LLM, no OCR. Every recommendation
// exposes the evidence that produced it so the UI can render a
// rationale strip ("matched keyword 'software' against your GL
// account 6054 · Computer & IT Services").

import { prisma } from "@/lib/prisma";
import type { CapitalClass, CapitalVsOperatingState, ExtractedInvoice } from "./types";
import { classifyEconomicPurpose, type EconomicPurpose, type PurposeCandidate } from "./economic-purpose";

const RULE_VERSION = 2;

// A captured piece of evidence for a candidate's confidence score.
// Rendered by the UI when the operator opens the rationale panel.
export interface GlEvidence {
  kind:
    | "VENDOR_DEFAULT"
    | "PRIOR_CODING"           // Vendor previously coded to this account
    | "NAME_KEYWORD"           // Invoice vendor / description keyword hit an Account.name substring
    | "CATEGORY_MATCH"         // Category-key contains the semantic term (e.g. "PROFESSIONAL_SERVICES")
    | "FS_GROUP_MATCH"         // FS-Group key contains the semantic term (e.g. "IS_IT_SOFTWARE")
    | "CAPITAL_CLASS_MAP"      // Static capital-class → GL keyword map
    | "ECONOMIC_PURPOSE"       // Sprint 3 · 15Q — classified economic purpose boosts/penalises accounts
    | "ECONOMIC_PURPOSE_CONTRA";
  description: string;
  score: number;               // 0-100 contribution
}

export interface GlCandidate {
  accountId: string;
  accountNumber: string;
  accountName: string;
  categoryKey: string | null;
  fsGroupKey: string | null;
  confidence: number;          // 0-100 blended from evidence
  evidence: GlEvidence[];
}

export interface GlRecommendation {
  ruleVersion: number;
  // Best candidate — null when no credible match exists on the tenant.
  accountNumber: string | null;
  accountName: string | null;
  categoryKey: string | null;
  fsGroupKey: string | null;
  confidence: number | null;
  reason: string;
  source: "CAPITAL_CLASS_MAP" | "VENDOR_DEFAULT" | "PRIOR_CODING" | "NAME_KEYWORD" | "NONE";
  candidates: GlCandidate[];   // Ranked; first entry mirrors the best-candidate fields above.
}

export interface GlRecommendationArgs {
  clubId: string;
  vendorId: string | null;
  capitalState: CapitalVsOperatingState;
  capitalClass: CapitalClass | null;
  // 15L — the raw invoice signals the recommender can now use even
  // when no vendor record exists yet. Extracted vendor name,
  // extracted description / line items, extracted domain — anything
  // that helps identify the semantic category.
  extraction?: Pick<ExtractedInvoice, "vendor" | "description" | "lineItems"> | null;
}

// ---------------------------------------------------------------------------
// Semantic vocabulary
// ---------------------------------------------------------------------------
// Each entry maps a family of invoice keywords to (a) canonical FS
// Groups and Categories the club's COA is likely to contain, and (b)
// substring patterns that qualify an Account row as a plausible
// destination even when the account's number differs from the
// Spectre default template.
//
// Order matters — first match wins per keyword pass. Software /
// SaaS / cloud / subscription lives at the top because it's the
// tightest bucket; broader terms (office, professional, admin) sit
// lower. Every group is REVENUE-agnostic and stays inside the
// EXPENSE bracket except CAPITAL_CLASS which is asset-side.

interface SemanticGroup {
  key: string;
  // A vendor-name / description substring that turns this group on.
  vendorPatterns: RegExp[];
  // Substring patterns to score an Account.name against.
  accountNamePatterns: RegExp[];
  // Canonical FS-Group keys any of which the group can also target
  // directly (used when the tenant's Account rows use the canonical
  // labels — a very common case for Spectre-provisioned clubs).
  fsGroupKeys: string[];
  // Canonical Category keys the recommender considers matching.
  categoryKeys: string[];
  // Human label for the rationale.
  humanLabel: string;
}

const SEMANTIC_GROUPS: SemanticGroup[] = [
  {
    key: "IT_SOFTWARE",
    vendorPatterns: [
      /\b(microsoft|adobe|google\s*workspace|dropbox|salesforce|slack|github|gitlab|atlassian|jira|zoom|okta|aws|amazon\s*web|azure|office\s*365|m365|oracle|sap|quickbooks|xero|freshbooks|sage|jonas)\b/i,
    ],
    accountNamePatterns: [
      /software|saas|subscription|licen[sc]e|cloud|hosting|technology|\bit\b|information\s*technology|computer(?:\s+(?:service|expense|equipment|hardware))?|internet(?:\s+service)?/i,
    ],
    fsGroupKeys: ["IS_IT_SOFTWARE", "IS_TELEPHONE_INTERNET"],
    categoryKeys: ["ADMIN_EXPENSES"],
    humanLabel: "Software / IT services",
  },
  {
    key: "OFFICE",
    vendorPatterns: [
      /\b(staples|office\s*depot|amazon\s*business|costco\s*business)\b/i,
    ],
    accountNamePatterns: [
      /office\s*suppl|office\s*expense|stationery|printing|postage/i,
    ],
    fsGroupKeys: ["IS_OFFICE_SUPPLIES"],
    categoryKeys: ["ADMIN_EXPENSES"],
    humanLabel: "Office supplies",
  },
  {
    key: "PROFESSIONAL",
    // Sprint 3 · Checkpoint 15Q — the bare token "cpa" was removed
    // from this pattern. It conflated:
    //   (a) a Chartered Professional Accountants MEMBER ASSOCIATION
    //       — a licensing body billing its members for annual dues,
    //   (b) an accounting FIRM — an external service provider.
    // Category (b) is a professional-fees expense; category (a) is
    // professional-membership dues (a distinct concept — see
    // src/lib/ap-intelligence/economic-purpose.ts). Matching (a)
    // as (b) is the founder-observed 6061 defect. The economic-
    // purpose classifier now determines which concept applies and
    // this recommender consults it.
    //
    // Firm-naming shapes ("LLP", partnership language, big-4 names)
    // stay — they're unambiguous accounting firms.
    vendorPatterns: [
      /\b(law|legal|attorneys?|counsel|accounting\s+services|accounting\s+firm|auditor|kpmg|deloitte|pwc|grant\s*thornton|bdo|LLP)\b/i,
    ],
    accountNamePatterns: [
      /professional\s*fee|legal\s*fee|audit\s*fee|accounting\s*fee|consulting/i,
    ],
    fsGroupKeys: ["IS_PROFESSIONAL_FEES"],
    categoryKeys: ["PROFESSIONAL_SERVICES"],
    humanLabel: "Professional fees",
  },
  {
    key: "UTILITIES",
    vendorPatterns: [
      /\b(hydro|enmax|epcor|fortis|atco|shaw|telus|rogers|bell|utility|water|gas\s*company|natural\s*gas|propane)\b/i,
    ],
    accountNamePatterns: [
      /utilit|electric|hydro|natural\s*gas|propane|sewer|water\s*(bill|util)/i,
    ],
    fsGroupKeys: ["IS_UTILITIES"],
    categoryKeys: ["UTILITIES"],
    humanLabel: "Utilities",
  },
  {
    key: "TELECOM",
    vendorPatterns: [
      /\b(telus|shaw|rogers|bell|internet|phone|comcast|verizon|at&t)\b/i,
    ],
    accountNamePatterns: [
      /telephone|internet|phone\s*&\s*internet|cell\s*phone|mobile|data\s*plan/i,
    ],
    fsGroupKeys: ["IS_TELEPHONE_INTERNET"],
    categoryKeys: ["ADMIN_EXPENSES"],
    humanLabel: "Telephone & internet",
  },
  {
    key: "INSURANCE",
    vendorPatterns: [
      /\b(insurance|assurance|mutual|indemnity|marsh|aon|willis|hub\s*insurance)\b/i,
    ],
    accountNamePatterns: [
      /insurance(?!\s*receivable)/i,
    ],
    fsGroupKeys: ["IS_INSURANCE"],
    categoryKeys: ["INSURANCE"],
    humanLabel: "Insurance",
  },
  {
    key: "REPAIRS",
    vendorPatterns: [
      /\b(repair|maintenance|service\s*co|hvac|plumbing|roofing)\b/i,
    ],
    accountNamePatterns: [
      /repair|maintenance|r\s*&\s*m\b|building\s*repair/i,
    ],
    fsGroupKeys: ["IS_REPAIRS_MAINTENANCE"],
    categoryKeys: ["REPAIRS_MAINTENANCE"],
    humanLabel: "Repairs & maintenance",
  },
  {
    key: "BANK_FEES",
    vendorPatterns: [
      /\b(bank\s*of|royal\s*bank|scotiabank|cibc|td\s*bank|hsbc)\b/i,
    ],
    accountNamePatterns: [
      /bank\s*charge|bank\s*fee|wire\s*fee|nsf\s*fee|monthly\s*service\s*charge/i,
    ],
    fsGroupKeys: ["IS_BANK_CHARGES"],
    categoryKeys: ["ADMIN_EXPENSES"],
    humanLabel: "Bank charges",
  },
  {
    key: "MERCHANT_FEES",
    vendorPatterns: [
      /\b(stripe|square|paypal|moneris|global\s*payments|elavon|adyen|first\s*data)\b/i,
    ],
    accountNamePatterns: [
      /merchant\s*(processing\s*)?fee|credit\s*card\s*fee|interchange|payment\s*processing/i,
    ],
    fsGroupKeys: ["IS_MERCHANT_FEES"],
    categoryKeys: ["ADMIN_EXPENSES"],
    humanLabel: "Merchant / card fees",
  },
];

// Capital-class → asset-side keyword hint. Mirrors the pre-15L
// static map but treated as EVIDENCE instead of a hard route so the
// COA-search path can override it when a specific tenant Account
// row is a stronger match.
const CAPITAL_CLASS_HINTS: Record<CapitalClass, { patterns: RegExp[]; label: string }> = {
  COURSE_EQUIPMENT:      { patterns: [/course\s*(equipment|machinery)|greens\s*(mower|equipment)/i], label: "Course equipment" },
  KITCHEN_EQUIPMENT:     { patterns: [/kitchen\s*(equipment|appliance)|oven|refrigerat|walk[-\s]?in\s*cooler/i], label: "Kitchen equipment" },
  GOLF_EQUIPMENT:        { patterns: [/golf\s*(equipment|cart|bag)|driving\s*range/i], label: "Golf equipment" },
  BUILDING_IMPROVEMENTS: { patterns: [/building\s*improve|leasehold\s*improve|renovation|clubhouse/i], label: "Building improvements" },
  FURNITURE:             { patterns: [/furniture\s*(&|and)?\s*fixtures?|furn(iture)?/i], label: "Furniture & fixtures" },
  COMPUTER_EQUIPMENT:    { patterns: [/computer\s*(equipment|hardware)|laptop|workstation|server(?!\s*fee)/i], label: "Computer equipment" },
  VEHICLES:              { patterns: [/vehicles?|truck|van|utility\s*vehicle/i], label: "Vehicles" },
  IRRIGATION:            { patterns: [/irrigation|sprinkler|water(?:ing)?\s*system/i], label: "Irrigation" },
  OTHER_CAPITAL:         { patterns: [/capital\s*asset|fixed\s*asset|property\s*&\s*equipment/i], label: "Capital assets" },
};

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function recommendGlAccount(args: GlRecommendationArgs): Promise<GlRecommendation> {
  // Snapshot the live COA once. All downstream scoring runs off this
  // in-memory list — one DB round-trip per recommendation regardless
  // of how many candidates we consider.
  const accounts = await prisma.account.findMany({
    where: { clubId: args.clubId, isActive: true },
    include: {
      category: { select: { key: true, name: true } },
      fsGroup: { select: { key: true, name: true } },
    },
  });

  // Empty COA → the caller (summariseApIntake) applies the runtime
  // CHART_OF_ACCOUNTS_REQUIRED override; we still return a well-
  // formed "no candidates" result so the caller doesn't crash.
  if (accounts.length === 0) {
    return emptyRecommendation("No chart of accounts is loaded on this club — cannot recommend a GL account.");
  }

  // Only EXPENSE + ASSET accounts are plausible AP-invoice destinations
  // (a REVENUE / LIABILITY / EQUITY account is never a valid AP debit
  // leg). Filter early so downstream scoring stays tight.
  const candidates = accounts.filter((a) => a.type === "EXPENSE" || a.type === "ASSET");

  // Signal 1: vendor default GL. Strongest per-club signal — a human
  // has already made the coding decision at least once for this vendor.
  if (args.vendorId) {
    const vendor = await prisma.vendor.findFirst({
      where: { id: args.vendorId, clubId: args.clubId },
      select: {
        legalName: true,
        defaultExpenseAccount: {
          select: {
            id: true, accountNumber: true, name: true,
            category: { select: { key: true } },
            fsGroup: { select: { key: true } },
          },
        },
      },
    });
    if (vendor?.defaultExpenseAccount) {
      const c: GlCandidate = {
        accountId: vendor.defaultExpenseAccount.id,
        accountNumber: vendor.defaultExpenseAccount.accountNumber,
        accountName: vendor.defaultExpenseAccount.name,
        categoryKey: vendor.defaultExpenseAccount.category?.key ?? null,
        fsGroupKey: vendor.defaultExpenseAccount.fsGroup?.key ?? null,
        confidence: 92,
        evidence: [{
          kind: "VENDOR_DEFAULT",
          description: `Vendor ${vendor.legalName} has this GL as its default expense account.`,
          score: 92,
        }],
      };
      return finaliseRecommendation([c], "VENDOR_DEFAULT",
        `Operating expense; using ${vendor.legalName}'s default GL (${c.accountNumber} — ${c.accountName}).`);
    }

    // Signal 2: prior-coding — the vendor's most-recent APInvoice's
    // most-common GL. Cheaper than a full history sweep.
    const priorHistory = await prisma.aPInvoiceLine.findMany({
      where: { clubId: args.clubId, invoice: { vendorId: args.vendorId } },
      select: { expenseAccountId: true },
      take: 50,
    });
    if (priorHistory.length > 0) {
      const counts = new Map<string, number>();
      for (const l of priorHistory) counts.set(l.expenseAccountId, (counts.get(l.expenseAccountId) ?? 0) + 1);
      const [topId, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
      const acct = topId ? candidates.find((a) => a.id === topId) : null;
      if (acct && count >= 2) {
        const c: GlCandidate = {
          accountId: acct.id,
          accountNumber: acct.accountNumber,
          accountName: acct.name,
          categoryKey: acct.category?.key ?? null,
          fsGroupKey: acct.fsGroup?.key ?? null,
          confidence: Math.min(88, 60 + count * 3),
          evidence: [{
            kind: "PRIOR_CODING",
            description: `Vendor has been coded to ${acct.accountNumber} ${acct.name} on ${count} prior invoice line${count === 1 ? "" : "s"}.`,
            score: Math.min(88, 60 + count * 3),
          }],
        };
        return finaliseRecommendation([c], "PRIOR_CODING",
          `Operating expense; vendor's recent coding history points to ${c.accountNumber} — ${c.accountName}.`);
      }
    }
  }

  // Signal 3: name-keyword semantic search. Runs against BOTH the
  // extracted vendor name / description and every Account name on
  // the tenant. Scores each account across all matching semantic
  // groups; the strongest score wins.
  const vendorHay = `${args.extraction?.vendor.guessedName ?? ""} ${args.extraction?.description ?? ""} ${(args.extraction?.lineItems ?? []).map((l) => l.description).join(" ")}`.trim();
  const scored = new Map<string, GlCandidate>();

  for (const group of SEMANTIC_GROUPS) {
    // Does any vendor pattern match the invoice's vendor / description?
    const vendorHit = group.vendorPatterns.find((p) => p.test(vendorHay));
    // Also gather every account whose name / category / fs-group matches
    // the group — even without a vendor hit, a purely account-name match
    // is a valid weaker signal.
    for (const a of candidates) {
      const nameHay = `${a.name ?? ""}`.toLowerCase();
      const nameHit = group.accountNamePatterns.find((p) => p.test(nameHay));
      const fsHit = a.fsGroup && group.fsGroupKeys.includes(a.fsGroup.key);
      const catHit = a.category && group.categoryKeys.includes(a.category.key);
      if (!nameHit && !fsHit && !catHit) continue;

      // Score: vendor + fs-group match is the strongest combo.
      let score = 0;
      const evidence: GlEvidence[] = [];
      if (vendorHit) {
        score += 40;
        evidence.push({
          kind: "NAME_KEYWORD",
          description: `Invoice vendor / description matched "${humaniseMatch(vendorHay, vendorHit)}" — a signal for ${group.humanLabel.toLowerCase()}.`,
          score: 40,
        });
      }
      if (nameHit) {
        score += 30;
        evidence.push({
          kind: "NAME_KEYWORD",
          description: `Account name "${a.name}" matched keyword "${humaniseMatch(a.name, nameHit)}".`,
          score: 30,
        });
      }
      if (fsHit) {
        score += 20;
        evidence.push({
          kind: "FS_GROUP_MATCH",
          description: `Account sits in FS Group ${a.fsGroup!.key} — a canonical ${group.humanLabel.toLowerCase()} bucket.`,
          score: 20,
        });
      }
      if (catHit) {
        score += 15;
        evidence.push({
          kind: "CATEGORY_MATCH",
          description: `Account category ${a.category!.key} is a canonical ${group.humanLabel.toLowerCase()} category.`,
          score: 15,
        });
      }
      // Consolidate — a single account can appear in multiple groups
      // (e.g. Microsoft matches SOFTWARE + a Computer & IT account
      // name matches OFFICE via generic keywords). Keep the strongest.
      const existing = scored.get(a.id);
      if (!existing || score > existing.confidence) {
        scored.set(a.id, {
          accountId: a.id,
          accountNumber: a.accountNumber,
          accountName: a.name,
          categoryKey: a.category?.key ?? null,
          fsGroupKey: a.fsGroup?.key ?? null,
          confidence: Math.min(95, score),
          evidence,
        });
      }
    }
  }

  // Sprint 3 · Checkpoint 15Q — economic-purpose classifier signal.
  // The pre-15Q recommender matched vendor-name keywords ("cpa" →
  // accounting firm). The classifier reasons about what the
  // expenditure IS FOR (professional membership dues vs external
  // accounting services vs member-charged revenue) and boosts /
  // penalises accounts according to the top purpose's SUGGESTED
  // ROLES. Role → account-name matching is a small lookup below.
  const purposeCandidates = classifyPurposeFromExtraction(args.extraction);
  const topPurpose = purposeCandidates[0] ?? null;
  if (topPurpose && topPurpose.score >= 20) {
    for (const a of candidates) {
      const nameHay = `${a.name ?? ""}`.toLowerCase();
      const roleHit = topPurpose.suggestedAccountRoles.find((role) => {
        const roleRe = ROLE_NAME_PATTERNS[role];
        return roleRe && roleRe.test(nameHay);
      });
      if (roleHit) {
        const boost = 25;
        const existing = scored.get(a.id);
        const evidence: GlEvidence = {
          kind: "ECONOMIC_PURPOSE",
          description: `Classified purpose "${topPurpose.classificationConcept}" — account name matches role "${roleHit}".`,
          score: boost,
        };
        if (existing) {
          existing.confidence = Math.min(95, existing.confidence + boost);
          existing.evidence.push(evidence);
        } else {
          scored.set(a.id, {
            accountId: a.id,
            accountNumber: a.accountNumber,
            accountName: a.name,
            categoryKey: a.category?.key ?? null,
            fsGroupKey: a.fsGroup?.key ?? null,
            confidence: Math.min(95, 40 + boost),
            evidence: [evidence],
          });
        }
      }
    }
    // Contradiction penalty — accounts matching a role that is
    // CONTRADICTED by the top classifier lose confidence. e.g. when
    // the top classification is "employee_professional_membership_dues",
    // any account named "accounting fee" / "audit fee" is penalised.
    const contradictedRoles = collectContradictedRoles(topPurpose.purpose);
    for (const a of candidates) {
      const nameHay = `${a.name ?? ""}`.toLowerCase();
      const contraHit = contradictedRoles.find((role) => {
        const re = ROLE_NAME_PATTERNS[role];
        return re && re.test(nameHay);
      });
      if (contraHit) {
        const existing = scored.get(a.id);
        if (existing) {
          const penalty = 25;
          existing.confidence = Math.max(0, existing.confidence - penalty);
          existing.evidence.push({
            kind: "ECONOMIC_PURPOSE_CONTRA",
            description: `Classified purpose "${topPurpose.classificationConcept}" contradicts role "${contraHit}" — confidence reduced.`,
            score: -penalty,
          });
        }
      }
    }
  }

  // Signal 4: capital-class hints. Only fires when the analyser
  // already classified the invoice as CAPITAL and identified a class.
  if (args.capitalState === "CAPITAL" && args.capitalClass) {
    const hint = CAPITAL_CLASS_HINTS[args.capitalClass];
    for (const a of candidates.filter((a) => a.type === "ASSET")) {
      const nameHit = hint.patterns.find((p) => p.test(a.name));
      if (!nameHit) continue;
      const score = 65;
      const existing = scored.get(a.id);
      if (!existing || score > existing.confidence) {
        scored.set(a.id, {
          accountId: a.id,
          accountNumber: a.accountNumber,
          accountName: a.name,
          categoryKey: a.category?.key ?? null,
          fsGroupKey: a.fsGroup?.key ?? null,
          confidence: score,
          evidence: [{
            kind: "CAPITAL_CLASS_MAP",
            description: `Analyser classified this invoice as ${hint.label}; account name matches the canonical capital-asset vocabulary.`,
            score,
          }],
        });
      }
    }
  }

  const ranked = [...scored.values()].sort((a, b) => b.confidence - a.confidence);
  if (ranked.length === 0) {
    return emptyRecommendation(
      "No sufficiently supported GL match found on this club's chart of accounts.",
    );
  }

  const best = ranked[0];
  const source: GlRecommendation["source"] =
    best.evidence.some((e) => e.kind === "CAPITAL_CLASS_MAP") ? "CAPITAL_CLASS_MAP" : "NAME_KEYWORD";
  return finaliseRecommendation(
    ranked.slice(0, 5),
    source,
    `${humanReason(best)}.`,
  );
}

function finaliseRecommendation(
  candidates: GlCandidate[],
  source: GlRecommendation["source"],
  reason: string,
): GlRecommendation {
  const best = candidates[0];
  return {
    ruleVersion: RULE_VERSION,
    accountNumber: best.accountNumber,
    accountName: best.accountName,
    categoryKey: best.categoryKey,
    fsGroupKey: best.fsGroupKey,
    confidence: best.confidence,
    reason,
    source,
    candidates,
  };
}

function emptyRecommendation(reason: string): GlRecommendation {
  return {
    ruleVersion: RULE_VERSION,
    accountNumber: null,
    accountName: null,
    categoryKey: null,
    fsGroupKey: null,
    confidence: null,
    reason,
    source: "NONE",
    candidates: [],
  };
}

function humanReason(c: GlCandidate): string {
  return `Draft coding: ${c.accountNumber} — ${c.accountName} (confidence ${c.confidence}%)`;
}

function humaniseMatch(hay: string, pattern: RegExp): string {
  const m = pattern.exec(hay);
  return m?.[0] ?? "";
}

// ---------------------------------------------------------------------------
// Sprint 3 · Checkpoint 15Q — economic-purpose helpers
// ---------------------------------------------------------------------------
//
// Role → account-name pattern lookup. When the classifier says the
// invoice is `employee_professional_membership_dues`, any tenant
// account named "Membership dues", "Professional development",
// "Training and dues", etc. becomes a plausible destination. The
// mapping is generic — no vendor-specific rules — and additive.
const ROLE_NAME_PATTERNS: Record<string, RegExp> = {
  EMPLOYEE_MEMBERSHIP_DUES: /(?:membership\s*(?:dues|fee)|employee\s*(?:membership|dues)|dues\s*(?:and|&)\s*(?:memberships?|subscriptions?))/i,
  PROFESSIONAL_DEVELOPMENT: /professional\s*(?:development|dues|memberships?)/i,
  TRAINING_AND_DUES: /training\s*(?:and|&)\s*(?:dues|memberships?)/i,
  ACCOUNTING_AND_AUDIT_FEES: /(?:accounting\s*(?:fee|services?)|audit(?:ing|or)?\s*(?:fee|services?))/i,
  PROFESSIONAL_FEES: /professional\s*fee/i,
  MEMBER_DUES_REVENUE: /member(?:ship)?\s*dues\s*revenue|dues\s*revenue|member\s*revenue/i,
  MEMBERSHIP_REVENUE: /membership\s*revenue|initiation\s*fee\s*revenue/i,
  INTEREST_AND_PENALTIES: /(?:interest\s*(?:and|&)\s*penalt|late\s*(?:fee|payment)|finance\s*charge)/i,
  BANK_CHARGES: /bank\s*(?:charge|fee)|nsf\s*fee/i,
  TRAINING_AND_EDUCATION: /training\s*(?:and|&)\s*education|continuing\s*education|education\s*and\s*training/i,
  LICENCES_AND_PERMITS: /licen[sc]es?\s*(?:and|&)\s*permits?|permit\s*fee/i,
  REGULATORY_FEES: /regulatory\s*fee/i,
  LEGAL_FEES: /legal\s*fee/i,
  CONSULTING_FEES: /consulting\s*fee/i,
  GENERAL_EXPENSES: /(?:general\s*(?:expense|admin)|miscellaneous)/i,
};

// Mapping of concept → the OTHER concept's roles that must be
// penalised when this concept is the classifier's top pick. This is
// where the founder-observed misclassification is defended against:
// membership dues NEVER routes to accounting fees + vice-versa.
const CONTRADICTED_ROLES_MAP: Partial<Record<EconomicPurpose, string[]>> = {
  employee_professional_membership_dues: ["ACCOUNTING_AND_AUDIT_FEES"],
  external_accounting_or_audit_services: ["EMPLOYEE_MEMBERSHIP_DUES", "PROFESSIONAL_DEVELOPMENT"],
  member_dues_charged_by_club: ["EMPLOYEE_MEMBERSHIP_DUES", "ACCOUNTING_AND_AUDIT_FEES"],
  penalties_and_late_fees: ["EMPLOYEE_MEMBERSHIP_DUES", "ACCOUNTING_AND_AUDIT_FEES"],
};

function collectContradictedRoles(purpose: EconomicPurpose): string[] {
  return CONTRADICTED_ROLES_MAP[purpose] ?? [];
}

// Derive the classifier inputs from the ExtractedInvoice. Direction
// defaults to "club_pays_vendor" — every AP-analyser path is AP.
// A future member-portal / AR pipeline that reuses this classifier
// can pass an override.
function classifyPurposeFromExtraction(
  extraction: GlRecommendationArgs["extraction"],
): PurposeCandidate[] {
  if (!extraction) return [];
  const supplierName = extraction.vendor?.guessedName ?? null;
  const lineDescriptions = (extraction.lineItems ?? []).map((l) => l.description || "");
  const combinedText = `${supplierName ?? ""} ${extraction.description ?? ""} ${lineDescriptions.join(" ")}`.toLowerCase();
  const hasPenaltyLine = /\b(?:penalty|late[-\s]?fee|late[-\s]?payment|finance\s+charge|interest\s+charge|nsf)\b/i.test(combinedText);
  const hasMembershipLine = /\b(?:membership|annual\s+dues|professional\s+dues|member(?:ship)?\s+fee)\b/i.test(combinedText);
  const hasProfessionalCredentialContext =
    supplierName != null &&
    /\b(?:association|society|college|institute|order\s+of|academy|federation|chartered\s+(?:professional|accountants?|engineers?|surveyors?)|regulatory\s+body|professional\s+body)\b/i.test(supplierName);
  return classifyEconomicPurpose({
    supplierName,
    lineDescriptions,
    paymentDirection: "club_pays_vendor",
    hasPenaltyLine,
    hasMembershipLine,
    hasProfessionalCredentialContext,
  });
}
