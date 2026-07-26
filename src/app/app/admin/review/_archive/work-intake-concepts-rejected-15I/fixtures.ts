// Sprint 3 Checkpoint 15I — Work Intake concept review.
//
// Fixtures are static, in-memory, and never touch Prisma / staging / prod.
// Every concept renders THE SAME fixture set so the founder can compare
// concepts on identical data. Shape mirrors what the production loader
// would eventually project (see docs/adr/0001-work-intake-origin-architecture.md
// and docs/design/workflow-surface-state-model.md) but is deliberately
// simplified — a concept review is not a full-fidelity mock.

// Lifecycle state values match the LIVE WorkIntakeItem.status vocabulary
// on production (verified against src/lib/work-intake/actions.ts and
// prisma-postgres/schema.prisma:8553-8610). The founder-proposed additions
// (WAITING / SNOOZED / DISMISSED) and the planned 15-state model in
// docs/design/workflow-surface-state-model.md are OUT OF SCOPE for this
// concept review — the concepts test presentation over the current data,
// not a schema migration.
export type LifecycleCategory = "active" | "terminal" | "informational";

export type LifecycleState =
  | "OPEN"           // waiting for human review
  | "IN_PROGRESS"    // a human has taken it up but not resolved
  | "DEFERRED"       // set aside with an optional deferredUntil
  | "RESOLVED"       // human resolved — terminal
  | "INFORMATIONAL"  // acknowledged as FYI-only, no action taken — terminal
  | "SUPPRESSED";    // system filtered out of the feed (e.g. child of another intake)

export const CATEGORY_OF: Record<LifecycleState, LifecycleCategory> = {
  OPEN: "active",
  IN_PROGRESS: "active",
  DEFERRED: "active",
  RESOLVED: "terminal",
  INFORMATIONAL: "informational",
  SUPPRESSED: "terminal",
};

// Human-facing verb for the "clear from queue" action per concept.
// Concepts choose different labels; the winning concept's label guides
// the production terminology and any state additions.
export const RESOLVE_ACTIONS = {
  RESOLVE: "Resolve",
  COMPLETE: "Complete",
  CLEAR: "Clear from Work Intake",
  DISMISS: "Dismiss",
} as const;
export type ResolveActionKind = keyof typeof RESOLVE_ACTIONS;

export type EntityType =
  | "vendor"
  | "member"
  | "employee"
  | "external-contact"
  | "committee"
  | "project";

export interface LinkedEntity {
  type: EntityType;
  name: string;
  // How the concept surfaces "you should go look at this entity's timeline".
  // Not wired to a real page in this checkpoint; concepts render it as a
  // subdued link so the founder can see the affordance.
  timelineHref: string | null;
  // A compact context line the concept can render alongside the name.
  // Empty string when unmatched — that's the "unresolved" signal.
  contextLine: string;
  // For the entity-first concept (E) — a mini-timeline of the last 5
  // events on the linked entity. Null when the entity is unresolved.
  recentEvents:
    | Array<{ label: string; whenRelative: string; kind: "event" | "note" }>
    | null;
}

export interface AttachmentSummary {
  filename: string;
  contentType: string;
  byteLength: number;
  classification: "INVOICE" | "STATEMENT" | "MEMBER_LETTER" | "INTERNAL_MEMO" | "OTHER";
  isInline: boolean;
  extractionState: "COMPLETE" | "PARTIAL" | "UNREADABLE" | "PENDING";
  analysisState: "COMPLETE" | "PENDING" | "SKIPPED";
}

export interface ConversationSummary {
  from: string;             // display name of the sender
  fromAddress: string;      // email address of the sender
  subject: string;          // raw email subject
  receivedAtISO: string;    // ISO timestamp
  messageCount: number;
  preview: string;          // one-line preview of the email body
}

// Intelligence hierarchy — every concept renders these five slots but
// arranges them differently.
export interface IntelligenceHierarchy {
  happened: string;         // What happened (source fact)
  spectreFound: string;     // What Spectre determined
  issue: string | null;     // Outstanding uncertainty or blocker
  whyItMatters: string;     // Consequence / operational impact
  recommendedAction: string; // The next step
  confidence: "high" | "medium" | "low" | "unresolved";
}

// AP-specific extraction (for invoice fixtures only).
export interface InvoiceExtraction {
  vendorGuess: string | null;
  vendorMatchedToSpectreRecord: boolean;
  invoiceNumber: string | null;
  total: string | null;
  currency: string | null;
  capitalOrOperating: "operating_candidate" | "capital_candidate" | "unresolved";
  findings: Array<{
    key: string;
    severity: "HIGH" | "MEDIUM" | "LOW" | "INFO";
    statement: string;
  }>;
}

// The Work Intake fixture — one row = one card. Shape mirrors what a
// production loader would project.
export interface WorkIntakeFixture {
  id: string;
  fixtureLabel: string;               // human-readable name for the switcher
  fixtureDescription: string;         // one-sentence purpose statement
  lifecycleState: LifecycleState;
  // Matches the real WorkIntakeItem.judgmentRequired column. When true,
  // Spectre has flagged the item as needing human decision even if the
  // status is still OPEN.
  judgmentRequired: boolean;
  conversation: ConversationSummary | null;  // null for system-generated items
  attachments: AttachmentSummary[];
  intelligence: IntelligenceHierarchy;
  entity: LinkedEntity;
  invoice: InvoiceExtraction | null;  // present only for INVOICE-classified items
  // Contextual tab set — the loader would compute this; here it's fixed.
  availableTabs: Array<"conversation" | "attachments" | "invoice" | "activity">;
  // Activity timeline for the item itself (not the entity's timeline).
  activity: Array<{
    at: string;          // relative label ("2h ago")
    actor: string;       // "Spectre" or a user display name
    action: string;      // short verb-form ("Materialised", "Analysis refreshed")
    note?: string;
  }>;
}

const NOW_ISO = "2026-07-25T15:09:16Z";

export const FIXTURES: WorkIntakeFixture[] = [
  // ---------------------------------------------------------------------------
  // Fixture 1 — Microsoft invoice (founder's canonical acceptance case)
  // ---------------------------------------------------------------------------
  {
    id: "fx-microsoft-invoice",
    fixtureLabel: "Microsoft invoice",
    fixtureDescription:
      "AP invoice from an unknown vendor — tests sender-vs-vendor distinction and unresolved-entity handling.",
    lifecycleState: "OPEN",
    judgmentRequired: true,
    conversation: {
      from: "Chris Turcato",
      fromAddress: "spectreautomation.admin@gmail.com",
      subject: "Invoice #93458725404",
      receivedAtISO: NOW_ISO,
      messageCount: 1,
      preview:
        "Please see attached invoice for the recent subscription renewal. Payment terms Net 30.",
    },
    attachments: [
      {
        filename: "93458725404.pdf",
        contentType: "application/pdf",
        byteLength: 234_684,
        classification: "INVOICE",
        isInline: false,
        extractionState: "COMPLETE",
        analysisState: "COMPLETE",
      },
    ],
    intelligence: {
      happened: "An invoice was received by email.",
      spectreFound:
        "The attached PDF identifies Microsoft Corporation as the vendor. Invoice E0701097E3, CAD 31.29.",
      issue:
        "Microsoft Corporation is not on file as a Spectre vendor. The email was sent by Chris Turcato — sender is provenance only, not the vendor.",
      whyItMatters:
        "The invoice cannot proceed to AP until the vendor is matched or a new vendor record is created.",
      recommendedAction:
        "Match Microsoft Corporation to an existing vendor, or create a new vendor record.",
      confidence: "high",
    },
    entity: {
      type: "vendor",
      name: "Microsoft Corporation",
      timelineHref: null,       // unresolved — no timeline exists yet
      contextLine: "Not on file",
      recentEvents: null,
    },
    invoice: {
      vendorGuess: "Microsoft Corporation",
      vendorMatchedToSpectreRecord: false,
      invoiceNumber: "E0701097E3",
      total: "31.29",
      currency: "CAD",
      capitalOrOperating: "operating_candidate",
      findings: [
        {
          key: "ap.invoice.vendor_not_found",
          severity: "MEDIUM",
          statement:
            "The vendor could not be resolved from the extracted invoice. Reviewer must select or create a vendor.",
        },
        {
          key: "ap.invoice.operating_candidate",
          severity: "INFO",
          statement:
            "Small-value invoice with no capital-suggesting language; recommend operating expense treatment.",
        },
      ],
    },
    availableTabs: ["conversation", "attachments", "invoice", "activity"],
    activity: [
      { at: "just now",  actor: "Spectre", action: "Analysis refreshed", note: "+3 findings" },
      { at: "1m ago",    actor: "Spectre", action: "Materialised",       note: "AP intelligence" },
      { at: "1m ago",    actor: "Spectre", action: "Ingested attachment", note: "93458725404.pdf · 229 KB" },
    ],
  },

  // ---------------------------------------------------------------------------
  // Fixture 2 — Member matter (non-AP)
  // ---------------------------------------------------------------------------
  {
    id: "fx-member-matter",
    fixtureLabel: "Member matter",
    fixtureDescription:
      "A member-flagged concern arriving by email — tests contextual tabs (no Invoice Review) and member entity linkage.",
    lifecycleState: "OPEN",
    judgmentRequired: true,
    conversation: {
      from: "Patricia Hollingsworth",
      fromAddress: "phollingsworth@gmail.com",
      subject: "Cart barn access — need code updated",
      receivedAtISO: "2026-07-25T13:42:00Z",
      messageCount: 2,
      preview:
        "Hi, my keycard stopped opening the cart barn on Tuesday. I've tried both the main door and side door. Can you reset it before the invitational this weekend?",
    },
    attachments: [],
    intelligence: {
      happened:
        "Member Patricia Hollingsworth reports her cart-barn keycard stopped working.",
      spectreFound:
        "Her access record shows the card was last used Sunday 10:14 AM. No revocation events since. The Winston Cup invitational is Saturday.",
      issue: null,
      whyItMatters:
        "A voting member locked out of the cart barn ahead of a member-guest invitational is a service failure the pro shop should own before Friday close.",
      recommendedAction:
        "Reissue keycard access to Patricia Hollingsworth and confirm by end of day Friday.",
      confidence: "high",
    },
    entity: {
      type: "member",
      name: "Patricia Hollingsworth",
      timelineHref: "/app/admin/members/mem_hollingsworth_p",
      contextLine: "Member since 2014 · Individual Voting · House balance $0",
      recentEvents: [
        { label: "Statement issued",           whenRelative: "3d ago",  kind: "event" },
        { label: "Dining charge — Grill Room", whenRelative: "6d ago",  kind: "event" },
        { label: "Guest sponsored — J. Kim",   whenRelative: "12d ago", kind: "event" },
        { label: "Reservation — 07:12 AM",     whenRelative: "14d ago", kind: "event" },
        { label: "Card issued (replacement)",  whenRelative: "3mo ago", kind: "event" },
      ],
    },
    invoice: null,
    availableTabs: ["conversation", "activity"],
    activity: [
      { at: "8m ago",  actor: "Spectre", action: "Classified", note: "Member request · high urgency (event weekend)" },
      { at: "8m ago",  actor: "Spectre", action: "Ingested",   note: "1 email · 0 attachments" },
    ],
  },

  // ---------------------------------------------------------------------------
  // Fixture 3 — Operational / employee matter (system-generated)
  // ---------------------------------------------------------------------------
  {
    id: "fx-operational-matter",
    fixtureLabel: "Operational matter",
    fixtureDescription:
      "System-generated operational alert — tests non-email origin, employee entity, and a decisive recommended action.",
    lifecycleState: "OPEN",
    judgmentRequired: true,
    conversation: null,     // system-generated, no email
    attachments: [],
    intelligence: {
      happened:
        "The pro shop close-out ran short by $312.40 on the 5:30 PM shift.",
      spectreFound:
        "Cash + card reconciliation matches sales except for a $312.40 gap. Two credit voids by user M. Alvarez sit unreconciled against POS receipts.",
      issue:
        "The two voids were entered without a manager override PIN — the void audit trail cannot confirm approval.",
      whyItMatters:
        "Unauthorised voids are the most common form of pro-shop shrinkage. A confirmed gap of >$250 warrants a manager conversation before the next shift.",
      recommendedAction:
        "Ask the closing manager to walk the void log with M. Alvarez and log a note against the shift.",
      confidence: "medium",
    },
    entity: {
      type: "employee",
      name: "Marco Alvarez",
      timelineHref: "/app/admin/employees/emp_alvarez_m",
      contextLine: "Pro shop attendant · 14 months · No prior variance flags",
      recentEvents: [
        { label: "Shift closed — variance $0.00",      whenRelative: "yesterday", kind: "event" },
        { label: "Shift closed — variance $0.00",      whenRelative: "2d ago",    kind: "event" },
        { label: "Guest merchandise sale ($842)",      whenRelative: "3d ago",    kind: "event" },
        { label: "Training completed — POS refresher", whenRelative: "1mo ago",   kind: "event" },
        { label: "Employed",                            whenRelative: "14mo ago",  kind: "note"  },
      ],
    },
    invoice: null,
    availableTabs: ["activity"],
    activity: [
      { at: "22m ago", actor: "Spectre",       action: "Classified", note: "Operational variance · manager review" },
      { at: "22m ago", actor: "System (POS)",  action: "Generated",  note: "Close-out variance $312.40" },
    ],
  },

  // ---------------------------------------------------------------------------
  // Fixture 4 — Resolved / completed item
  // ---------------------------------------------------------------------------
  {
    id: "fx-resolved-invoice",
    fixtureLabel: "Resolved invoice",
    fixtureDescription:
      "A completed item — tests read-state + how the concept surfaces \"done\" without deleting the record.",
    lifecycleState: "RESOLVED",
    judgmentRequired: false,
    conversation: {
      from: "Fairway Turf Supply — Billing",
      fromAddress: "billing@fairwayturf.com",
      subject: "Invoice INV-2026-8811",
      receivedAtISO: "2026-07-22T09:18:00Z",
      messageCount: 1,
      preview:
        "Attached: your July fertilizer order invoice. Terms Net 30. Payable to Fairway Turf Supply.",
    },
    attachments: [
      {
        filename: "INV-2026-8811.pdf",
        contentType: "application/pdf",
        byteLength: 118_442,
        classification: "INVOICE",
        isInline: false,
        extractionState: "COMPLETE",
        analysisState: "COMPLETE",
      },
    ],
    intelligence: {
      happened: "An invoice was received by email.",
      spectreFound:
        "Vendor matched to Fairway Turf Supply (Spectre vendor ID vnd_fairwayturf). Invoice INV-2026-8811, CAD 4,218.90, operating expense.",
      issue: null,
      whyItMatters: "AP invoice, mapped and posted.",
      recommendedAction: "No action — approved and posted.",
      confidence: "high",
    },
    entity: {
      type: "vendor",
      name: "Fairway Turf Supply",
      timelineHref: "/app/admin/vendors/vnd_fairwayturf",
      contextLine: "Vendor since 2019 · Last invoice paid Jul 3 · Open invoices: 0",
      recentEvents: [
        { label: "Invoice paid — INV-2026-8811", whenRelative: "yesterday", kind: "event" },
        { label: "Invoice received",             whenRelative: "3d ago",    kind: "event" },
        { label: "Invoice paid — INV-2026-8791", whenRelative: "22d ago",   kind: "event" },
        { label: "Statement received",           whenRelative: "1mo ago",   kind: "event" },
        { label: "Onboarded",                    whenRelative: "6y ago",    kind: "note"  },
      ],
    },
    invoice: {
      vendorGuess: "Fairway Turf Supply",
      vendorMatchedToSpectreRecord: true,
      invoiceNumber: "INV-2026-8811",
      total: "4218.90",
      currency: "CAD",
      capitalOrOperating: "operating_candidate",
      findings: [],
    },
    availableTabs: ["conversation", "attachments", "invoice", "activity"],
    activity: [
      { at: "yesterday", actor: "System",   action: "Payment scheduled", note: "AP batch AP-2026-142" },
      { at: "yesterday", actor: "P. Bell",  action: "Approved",         note: "Posted JE-8241"        },
      { at: "3d ago",    actor: "Spectre",  action: "Recommended",      note: "Match confidence: high" },
      { at: "3d ago",    actor: "Spectre",  action: "Materialised",     note: "AP intelligence"       },
    ],
  },

  // ---------------------------------------------------------------------------
  // Fixture 5 — Uncertain classification
  // ---------------------------------------------------------------------------
  {
    id: "fx-uncertain-classification",
    fixtureLabel: "Uncertain classification",
    fixtureDescription:
      "An item Spectre could not confidently classify — tests honest presentation of low confidence.",
    lifecycleState: "OPEN",
    judgmentRequired: true,
    conversation: {
      from: "Elaine Whittaker",
      fromAddress: "ewhittaker@bramble-associates.example",
      subject: "Following up on last month's discussion",
      receivedAtISO: "2026-07-24T18:03:00Z",
      messageCount: 3,
      preview:
        "Wanted to circle back on the items we spoke about. Attached is the summary I mentioned. Let me know if the numbers hold up on your side.",
    },
    attachments: [
      {
        filename: "summary.pdf",
        contentType: "application/pdf",
        byteLength: 62_310,
        classification: "OTHER",
        isInline: false,
        extractionState: "PARTIAL",
        analysisState: "SKIPPED",
      },
    ],
    intelligence: {
      happened:
        "A three-message email thread with an attached PDF was received from an external sender.",
      spectreFound:
        "The sender is not on file as a vendor, member, or known committee contact. The attachment's text extraction was partial — the PDF may be a scan.",
      issue:
        "Spectre could not confidently classify this item. It may be an invoice, a proposal, a legal document, or member-related correspondence.",
      whyItMatters:
        "Uncertain items should be reviewed by a person before being routed. Auto-routing on low confidence has been the source of past mis-filings.",
      recommendedAction:
        "Open the message and attachment, decide the correct classification, then re-file or resolve.",
      confidence: "low",
    },
    entity: {
      type: "external-contact",
      name: "Elaine Whittaker (Bramble Associates)",
      timelineHref: null,
      contextLine: "Unknown contact",
      recentEvents: null,
    },
    invoice: null,
    availableTabs: ["conversation", "attachments", "activity"],
    activity: [
      { at: "12h ago", actor: "Spectre", action: "Classification failed", note: "Confidence < 40% — routed to human triage" },
      { at: "12h ago", actor: "Spectre", action: "Ingested",              note: "3 messages · 1 attachment (partial extract)" },
    ],
  },
];

// Helper — display formatters shared across concepts.
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatCurrency(amount: string, currency: string): string {
  const n = Number.parseFloat(amount);
  if (Number.isNaN(n)) return `${currency} ${amount}`;
  return `${currency} ${n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function relativeFromISO(iso: string, now = new Date("2026-07-25T15:20:00Z")): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

// Concept metadata for the switcher.
export const CONCEPTS = [
  {
    key: "A",
    slug: "correspondence-queue",
    name: "Correspondence Queue",
    thesis:
      "Volume-first. Dense single-row cards inspired by a premium inbox; depth lives inside expansion.",
  },
  {
    key: "B",
    slug: "executive-briefing",
    name: "Executive Briefing",
    thesis:
      "Verdict-first. Spectre's operational statement is the card title; source is background evidence.",
  },
  {
    key: "C",
    slug: "intelligence-case-file",
    name: "Intelligence Case File",
    thesis:
      "Structured case. Named sections (Evidence, Findings, Confidence, Open question) make Spectre's reasoning legible.",
  },
  {
    key: "D",
    slug: "decision-sentence",
    name: "Decision Sentence",
    thesis:
      "One-sentence action per card. Forces every item onto a to-do line; receipts sit below.",
  },
  {
    key: "E",
    slug: "timeline-anchor",
    name: "Timeline Anchor",
    thesis:
      "Entity-first. Card is split; the linked entity's mini-timeline is the primary context strip.",
  },
] as const;

export type ConceptKey = (typeof CONCEPTS)[number]["key"];
