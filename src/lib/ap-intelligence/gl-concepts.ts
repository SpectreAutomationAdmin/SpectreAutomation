// Sprint 3 · Checkpoint 15U (2026-07-28) — accounting-concept catalog.
//
// Founder rule (15U §6): a small, generalized, testable accounting-
// domain vocabulary. Organized by canonical accounting concepts —
// NOT vendors, NOT invoice numbers, NOT tenant-specific account
// numbers. Each concept carries:
//
//   * synonyms         — natural-language variants used both in
//                        invoice text and in COA account names
//   * parent           — the broader concept in the taxonomy tree
//   * contradicts      — concepts that are semantically incompatible;
//                        an account tagged with a contradicting
//                        concept receives a penalty when the invoice
//                        strongly supports THIS concept
//   * fsGroupKeyHints  — canonical Spectre FS-group keys this
//                        concept typically inhabits (supporting
//                        taxonomy evidence, not a hard route)
//   * categoryKeyHints — canonical Category keys likewise
//   * depth            — 1 = root family, 2 = subfamily, 3 = leaf
//
// Depth drives §5 specificity: a direct depth-3 match outranks a
// direct depth-1 match. The catalog is deliberately small and
// documented — adding a concept is the intended extension path;
// per-vendor branches are not.

export interface AccountingConcept {
  id: string;
  canonicalName: string;
  synonyms: string[];
  parent: string | null;
  contradicts: string[];
  fsGroupKeyHints: string[];
  categoryKeyHints: string[];
  depth: number;
}

// -----------------------------------------------------------------------------
// The catalog
// -----------------------------------------------------------------------------

export const ACCOUNTING_CONCEPTS: AccountingConcept[] = [
  // ================================================================
  // Memberships & Subscriptions family
  // ================================================================
  {
    id: "memberships_and_subscriptions",
    canonicalName: "Memberships and subscriptions",
    synonyms: ["memberships", "subscriptions", "memberships and subscriptions", "memberships & subscriptions"],
    parent: null,
    contradicts: [],
    fsGroupKeyHints: ["IS_MEMBERSHIPS_SUBS"],
    categoryKeyHints: ["MEMBERSHIPS_SUBSCRIPTIONS"],
    depth: 1,
  },
  {
    id: "professional_membership_dues",
    canonicalName: "Professional membership dues",
    synonyms: [
      "membership dues", "member dues", "professional dues", "annual dues",
      "membership fee", "member fee", "membership fees", "member fees",
      "professional membership", "association dues", "society dues",
      "chartered membership", "regulatory body dues", "membership application",
    ],
    parent: "memberships_and_subscriptions",
    contradicts: ["external_accounting_services", "software_subscription_service", "publications_or_periodicals"],
    // Sprint 3 · Checkpoint 15U — no fs-group hint at this depth.
    // Sub-concepts of memberships_and_subscriptions are distinguished
    // by account NAME (Membership & Dues vs Subscriptions vs
    // Magazine Subs), not by shared fs-group. Only depth-1 parents
    // hint at their fs-group.
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 2,
  },
  {
    id: "software_subscription_service",
    canonicalName: "Software subscription service",
    synonyms: [
      "software subscription", "saas subscription", "saas", "cloud subscription",
      "hosting subscription", "software licence", "software license", "annual software",
      "monthly software", "software service", "software as a service", "cloud service",
    ],
    parent: "memberships_and_subscriptions",
    contradicts: ["professional_membership_dues"],
    // Sprint 3 · Checkpoint 15U — only the IT-Software FS group hints
    // at software-subscription. IS_MEMBERSHIPS_SUBS is the parent's
    // hint; putting it here would falsely tag every Memberships & Subs
    // account as a software-subscription account.
    fsGroupKeyHints: ["IS_IT_SOFTWARE"],
    categoryKeyHints: [],
    depth: 2,
  },
  {
    id: "publications_or_periodicals",
    canonicalName: "Publications and periodicals",
    synonyms: [
      "magazine subscription", "journal subscription", "newspaper subscription",
      "publication subscription", "trade publication", "periodical",
    ],
    parent: "memberships_and_subscriptions",
    contradicts: ["professional_membership_dues"],
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 2,
  },

  // ================================================================
  // Communications family (telephony + connectivity + broadcast)
  // ================================================================
  {
    id: "communications",
    canonicalName: "Communications",
    synonyms: ["communications", "telecommunications", "telecom"],
    parent: null,
    contradicts: [],
    fsGroupKeyHints: ["IS_TELEPHONE_INTERNET", "IS_COMMUNICATIONS"],
    categoryKeyHints: [],
    depth: 1,
  },
  {
    id: "telephony",
    canonicalName: "Telephone service",
    synonyms: [
      "telephone", "phone", "phone service", "landline", "mobile",
      "cellular", "cell phone", "voip", "voice service", "phone line",
    ],
    parent: "communications",
    contradicts: ["printing_services"],
    // FS-group hint intentionally on the parent (communications)
    // only. Sub-concepts distinguish via NAME.
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 2,
  },
  {
    id: "connectivity_internet",
    canonicalName: "Internet and connectivity",
    synonyms: [
      "internet", "internet service", "broadband", "fibre", "fiber",
      "data plan", "data circuit", "connectivity", "ethernet service",
      "bandwidth", "mbps", "mbit", "gbps", "gbit", "mbit/s", "gbit/s",
      "residential internet", "business internet", "network service",
    ],
    parent: "communications",
    contradicts: ["printing_services"],
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 2,
  },
  {
    id: "telephone_and_internet_bundle",
    canonicalName: "Telephone and internet (bundled)",
    synonyms: ["telephone & internet", "phone & internet", "telephone and internet", "phone and internet"],
    parent: "communications",
    contradicts: ["printing_services"],
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 2,
  },
  {
    id: "cable_music_pa",
    canonicalName: "Cable, music, PA systems",
    synonyms: ["cable tv", "music service", "streaming service", "pa system", "public address"],
    parent: "communications",
    contradicts: [],
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 2,
  },

  // ================================================================
  // Utilities family
  // ================================================================
  {
    id: "utilities",
    canonicalName: "Utilities",
    synonyms: ["utility", "utilities", "utility service"],
    parent: null,
    contradicts: [],
    fsGroupKeyHints: ["IS_UTILITIES"],
    categoryKeyHints: ["UTILITIES"],
    depth: 1,
  },
  {
    id: "electricity_utility",
    canonicalName: "Electricity",
    synonyms: ["electricity", "electric", "power", "hydro", "kwh"],
    parent: "utilities",
    contradicts: [],
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 2,
  },
  {
    id: "natural_gas_utility",
    canonicalName: "Natural gas",
    synonyms: ["natural gas", "gas utility", "gj", "gigajoule"],
    parent: "utilities",
    contradicts: [],
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 2,
  },
  {
    id: "water_sewer_utility",
    canonicalName: "Water and sewer",
    synonyms: ["water utility", "sewer", "water and sewer", "wastewater"],
    parent: "utilities",
    contradicts: [],
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 2,
  },
  {
    id: "waste_disposal_utility",
    canonicalName: "Waste disposal",
    synonyms: ["waste disposal", "garbage collection", "sanitation service", "recycling service"],
    parent: "utilities",
    contradicts: [],
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 2,
  },

  // ================================================================
  // Professional services family
  // ================================================================
  {
    id: "professional_services",
    canonicalName: "Professional services",
    synonyms: ["professional services", "professional fees"],
    parent: null,
    contradicts: [],
    fsGroupKeyHints: ["IS_PROFESSIONAL_FEES"],
    categoryKeyHints: ["PROFESSIONAL_SERVICES"],
    depth: 1,
  },
  {
    id: "external_accounting_services",
    canonicalName: "External accounting or audit services",
    synonyms: [
      "accounting services", "accounting fee", "accounting fees", "audit services",
      "audit fee", "audit fees", "review engagement", "tax return preparation",
      "financial statement preparation", "bookkeeping services", "compilation",
      "accountant", "auditor",
    ],
    parent: "professional_services",
    contradicts: ["professional_membership_dues"],
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 2,
  },
  {
    id: "legal_services",
    canonicalName: "Legal services",
    synonyms: [
      "legal services", "legal fees", "legal fee", "attorney",
      "solicitor", "barrister", "law firm", "counsel",
    ],
    parent: "professional_services",
    contradicts: [],
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 2,
  },
  {
    id: "consulting_services",
    canonicalName: "Consulting services",
    synonyms: [
      "consulting services", "consulting fee", "consultant", "advisory services",
      "retainer",
    ],
    parent: "professional_services",
    contradicts: [],
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 2,
  },

  // ================================================================
  // Information technology services
  // ================================================================
  {
    id: "it_services",
    canonicalName: "Information technology services",
    synonyms: [
      "it services", "computer services", "information technology",
      "technology services", "managed it", "it support",
    ],
    parent: null,
    contradicts: [],
    fsGroupKeyHints: ["IS_IT_SOFTWARE"],
    categoryKeyHints: ["ADMIN_EXPENSES"],
    depth: 1,
  },

  // ================================================================
  // Office supplies family
  // ================================================================
  {
    id: "office_supplies_general",
    canonicalName: "Office supplies",
    synonyms: [
      "office supplies", "office expense", "stationery", "office materials",
    ],
    parent: null,
    contradicts: [],
    fsGroupKeyHints: ["IS_OFFICE_SUPPLIES"],
    categoryKeyHints: ["ADMIN_EXPENSES"],
    depth: 1,
  },
  {
    id: "postage_and_shipping",
    canonicalName: "Postage and shipping",
    synonyms: ["postage", "shipping", "courier", "mail service", "parcel"],
    parent: "office_supplies_general",
    contradicts: [],
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 2,
  },

  // ================================================================
  // Printing services family
  // ================================================================
  {
    id: "printing_services",
    canonicalName: "Printing services",
    synonyms: [
      "printing", "print services", "printed materials", "printshop",
      "print job", "printing services",
    ],
    parent: null,
    contradicts: ["connectivity_internet", "telephony", "electricity_utility", "natural_gas_utility"],
    fsGroupKeyHints: ["IS_OFFICE_SUPPLIES"],
    categoryKeyHints: [],
    depth: 1,
  },
  {
    id: "score_cards_printing",
    canonicalName: "Score cards and printed course materials",
    synonyms: ["score card", "score cards", "scorecard", "scorecards", "course guide", "yardage book"],
    parent: "printing_services",
    contradicts: ["connectivity_internet", "telephony", "electricity_utility", "natural_gas_utility"],
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 2,
  },
  {
    id: "newsletter_or_roster_printing",
    canonicalName: "Newsletter or member roster printing",
    synonyms: ["newsletter", "roster", "member roster", "annual report printing", "brochure", "flyer"],
    parent: "printing_services",
    contradicts: ["connectivity_internet", "telephony"],
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 2,
  },

  // ================================================================
  // Finance / interest / bank
  // ================================================================
  {
    id: "bank_charges",
    canonicalName: "Bank charges and fees",
    synonyms: ["bank charge", "bank fee", "monthly service charge", "nsf fee", "wire fee"],
    parent: null,
    contradicts: [],
    fsGroupKeyHints: ["IS_BANK_CHARGES"],
    categoryKeyHints: ["ADMIN_EXPENSES"],
    depth: 1,
  },
  {
    id: "interest_and_penalties",
    canonicalName: "Interest and late-payment penalties",
    synonyms: [
      "interest expense", "interest charge", "late payment", "late-payment penalty",
      "late fee", "penalty", "finance charge",
    ],
    parent: null,
    contradicts: [],
    fsGroupKeyHints: ["IS_INTEREST_EXPENSE", "IS_BANK_CHARGES"],
    categoryKeyHints: [],
    depth: 1,
  },

  // ================================================================
  // Insurance
  // ================================================================
  {
    id: "insurance_expense",
    canonicalName: "Insurance",
    synonyms: ["insurance", "insurance premium", "policy premium", "liability insurance", "property insurance"],
    parent: null,
    contradicts: [],
    fsGroupKeyHints: ["IS_INSURANCE"],
    categoryKeyHints: [],
    depth: 1,
  },

  // ================================================================
  // Licences & permits
  // ================================================================
  {
    id: "licences_and_permits",
    canonicalName: "Licences and permits",
    synonyms: [
      "licence", "license", "licenses", "licences", "permit",
      "regulatory fee", "renewal fee", "licence fee", "license fee",
      "operating licence", "business licence", "liquor licence",
    ],
    parent: null,
    contradicts: ["professional_membership_dues"],
    fsGroupKeyHints: ["IS_LICENCES_PERMITS"],
    categoryKeyHints: [],
    depth: 1,
  },

  // ================================================================
  // Training & education
  // ================================================================
  {
    id: "training_and_education",
    canonicalName: "Training and education",
    synonyms: [
      "training", "continuing education", "cpe", "ceu", "professional development",
      "seminar", "conference", "course", "workshop",
    ],
    parent: null,
    contradicts: [],
    fsGroupKeyHints: [],
    categoryKeyHints: [],
    depth: 1,
  },

  // ================================================================
  // Repairs & maintenance
  // ================================================================
  {
    id: "repairs_and_maintenance",
    canonicalName: "Repairs and maintenance",
    synonyms: ["repair", "repairs", "maintenance", "service call", "servicing"],
    parent: null,
    contradicts: [],
    fsGroupKeyHints: ["IS_REPAIRS_MAINT"],
    categoryKeyHints: [],
    depth: 1,
  },

  // ================================================================
  // Food & beverage supplies
  // ================================================================
  {
    id: "food_and_beverage_supplies",
    canonicalName: "Food and beverage supplies",
    synonyms: [
      "food supplies", "beverage supplies", "grocery", "produce",
      "meat", "dairy", "kitchen supplies", "restaurant supplies",
    ],
    parent: null,
    contradicts: [],
    fsGroupKeyHints: ["IS_COGS_FOOD", "IS_COGS_BEV", "IS_FB_SUPPLIES"],
    categoryKeyHints: [],
    depth: 1,
  },

  // ================================================================
  // Course maintenance (golf)
  // ================================================================
  {
    id: "course_maintenance_supplies",
    canonicalName: "Golf course maintenance supplies",
    synonyms: [
      "fertilizer", "fertiliser", "seed", "greens", "fairway",
      "turf care", "irrigation supplies", "sand", "topdressing",
    ],
    parent: null,
    contradicts: [],
    fsGroupKeyHints: ["IS_COURSE_MAINT"],
    categoryKeyHints: [],
    depth: 1,
  },
];

// -----------------------------------------------------------------------------
// Lookup index — id → concept (frozen).
// -----------------------------------------------------------------------------

export const CONCEPT_BY_ID: Readonly<Record<string, AccountingConcept>> =
  Object.freeze(Object.fromEntries(ACCOUNTING_CONCEPTS.map((c) => [c.id, c])));

// -----------------------------------------------------------------------------
// Concept relatedness — a symmetric-ish score in [0, 100] describing
// how semantically close two concepts are.
// -----------------------------------------------------------------------------

export function conceptRelatedness(aId: string, bId: string): number {
  if (aId === bId) return 100;
  const a = CONCEPT_BY_ID[aId];
  const b = CONCEPT_BY_ID[bId];
  if (!a || !b) return 0;
  // Parent-child: 65
  if (a.parent === b.id) return 65;
  if (b.parent === a.id) return 65;
  // Sibling (same parent, both non-root)
  if (a.parent && a.parent === b.parent) return 55;
  // Grandparent / grandchild (transitive)
  const aParent = a.parent ? CONCEPT_BY_ID[a.parent] : null;
  const bParent = b.parent ? CONCEPT_BY_ID[b.parent] : null;
  if (aParent && aParent.parent === b.id) return 40;
  if (bParent && bParent.parent === a.id) return 40;
  return 0;
}

export function isContradiction(queryConceptId: string, accountConceptId: string): boolean {
  const q = CONCEPT_BY_ID[queryConceptId];
  const a = CONCEPT_BY_ID[accountConceptId];
  if (!q || !a) return false;
  if (q.contradicts.includes(accountConceptId)) return true;
  if (a.contradicts.includes(queryConceptId)) return true;
  return false;
}
