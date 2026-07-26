# Workflow Surface Foundation Specification

**Status:** Phase 0 · Architecture concept · **not implemented**
**Reference concepts:**
- `public/design-concepts/workflow-surface/queue.html`
- `public/design-concepts/workflow-surface/detail.html`
- `public/design-concepts/workflow-surface/primitives.html`

**Composes with:**
- **Mission Control Foundation v1.0** (locked) — the executive briefing surfaces the count of pending workflow items on the home screen.
- **Data Workspace Foundation v1.0** (locked) — the Workflow Queue is a Data Workspace consumer. Every primitive from that foundation (table, selection bar, saved views, density, keyboard model) is inherited.

**Companion documents:**
- `docs/design/workflow-surface-state-model.md` — the state machine, transitions, guards, error paths, and the revert-window contract.
- `docs/design/workflow-surface-integration-plan.md` — the phased rollout, starting with AP Invoice Approval and generalising to Purchase Requests, Expense Claims, Journal Entry Approval, Payroll Exceptions, Capital Requests, Member Applications, HR Onboarding, and Work Orders.

## 1 · Purpose

Spectre's operational value is not that it renders data more beautifully than
the software it replaces — it is that Spectre **does the work** that a
Controller, GM, or Finance Committee member would otherwise do by hand. The
Workflow Surface is the pattern every one of those "Spectre does the work"
moments composes from.

Every workflow in Spectre answers the same five questions in the same shape:

1. **What arrived?** (intake — an invoice, a purchase request, an expense claim, an application, a work order)
2. **What is it?** (classification — Spectre identified the type + attached the right rules)
3. **What is the evidence?** (enrichment — extracted fields, matched purchase orders, verified vendor status, computed variance, looked up member history)
4. **What does Spectre recommend, and why?** (AI-assisted judgment — a stated recommendation with confidence, reasoning, and links to the evidence)
5. **What did the human decide?** (approval — the human's action, recorded with actor, reason, and timestamp; every approval remains reversible inside a bounded revert window)

The Workflow Surface Foundation makes those five questions render **the same
way**, feel **the same way**, and audit **the same way** across every
workflow-shaped surface in the product.

## 2 · Core principle — AI-assisted human judgment

Spectre's AI has three obligations:

1. **Recommend.** For every workflow item, produce an actionable recommendation the human can accept or reject in one click.
2. **Explain.** Every recommendation carries the reasoning the AI used — evidence bullets, confidence score, and links to the underlying documents. No black boxes.
3. **Yield.** The human's decision is always the source of truth. AI never silently rewrites human input; when it wants to correct or enrich, it proposes a diff the human confirms.

Concretely:

- **AI never approves.** Approval is a human act. Spectre may auto-classify, auto-enrich, and auto-recommend; it does not auto-approve a workflow item unless the workflow is explicitly configured for zero-touch AND the operation is trivially reversible AND the human is notified after the fact with a one-click revert.
- **Every AI action is logged.** Classification, enrichment, recommendation, and any silent action are all rows on the item's activity timeline with `actor: "spectre"`. The timeline is a first-class primitive precisely so the human can audit what the machine did.
- **Confidence must be displayed.** Every recommendation shows its confidence (%) alongside the reasoning. A recommendation shown without confidence is a black box; a recommendation shown without reasoning is a black box; both must appear.
- **Recommendations are strong opinions, not demands.** The recommendation card highlights the recommended action but always renders the full action-set (approve, reject, reassign, escalate, hold). The human is one click from disagreeing.
- **Every irreversible action has a revert window.** Approval + posting is reversible for a configurable window (default 7 days for financial workflows). Inside the window the human can revert with one click; the revert writes another timeline entry.

This principle is enforced by the primitives below. The `RecommendationCard`
component cannot render without a `reasoning` prop; the `ApprovalBar` cannot
render without a full action-set; the `ActivityTimeline` cannot render
without both actor and reason on every entry.

## 3 · Layout skeleton

Two production surface types compose from the primitives:

### Workflow Queue

A Data Workspace consumer. Renders one workflow type's pending items as a
scannable table. Inherits every Data Workspace primitive: header, toolbar,
saved views, search, selection bar, density, keyboard model. Adds three
workflow-specific columns: **State pill**, **Recommended action**,
**Assignee**.

```
┌────────────────────────────────────────────────────────────────┐
│ Sidebar │ Top bar  Admin › AP › Invoice Approval               │
│         ├───────────────────────────────────────────────────────┤
│         │ Data Workspace header (title, meta, primary actions)  │
│         │ Data Workspace toolbar (search, saved views, density) │
│         │ Data Workspace selection bar (contextual)             │
│         ├───────────────────────────────────────────────────────┤
│         │ Grouped queue table:                                  │
│         │   NEEDS YOUR JUDGMENT       (2 items)                 │
│         │   AI RECOMMENDED APPROVE    (12 items)                │
│         │   AI RECOMMENDED REJECT     (1 item)                  │
│         │   EXCEPTION — CANNOT ROUTE  (0 items)                 │
│         │   ON HOLD                   (3 items)                 │
│         │                                                       │
│         │   Row per item:                                       │
│         │     ☐ #INV-8241 · Ace Foods · $2,340.00 · Kitchen …   │
│         │     [State pill] [Recommended action]  Assignee: PB   │
│         │                                                       │
└─────────┴───────────────────────────────────────────────────────┘
```

Clicking a row opens the Workflow Detail for that item. Every URL from the
Data Workspace still resolves; the Workflow Queue adds one:

```
/app/admin/<domain>/<workflow>            → Workflow Queue
/app/admin/<domain>/<workflow>/<itemId>   → Workflow Detail
?edit=<itemId>                            → deep-link that opens Detail (bookmarkable)
```

### Workflow Detail

The single-item surface. Two columns: **Evidence Panel** (left, dominant),
**Workflow Rail** (right).

```
┌───────────────────────────────────────────────────────────────────┐
│ Sidebar │ Top bar   Admin › AP › Invoice Approval › INV-8241      │
│         ├──────────────────────────────────────────────────────────┤
│         │ Workflow Detail header                                   │
│         │   Item title · State pill · Prev/Next in queue           │
│         │   Submitted <when> by <who> · 1 of 4 in your queue       │
│         ├──────────────────────────────────┬───────────────────────┤
│         │                                  │                       │
│         │  EVIDENCE PANEL                  │  RECOMMENDATION CARD  │
│         │   • Original document (PDF)      │   Spectre recommends: │
│         │   • Extracted fields             │     Approve & post    │
│         │   • Matched purchase order       │   Confidence: 96 %    │
│         │   • Vendor context               │   Reasoning:          │
│         │   • Journal entry preview        │     · PO match: exact │
│         │   • Historical similar invoices  │     · GST verified 5% │
│         │                                  │     · Variance $0.00  │
│         │                                  │                       │
│         │                                  │  APPROVAL BAR         │
│         │                                  │   [Approve & post]    │
│         │                                  │   Reject   Reassign   │
│         │                                  │   Hold     Ask        │
│         │                                  │                       │
│         │                                  │  CONVERSATION THREAD  │
│         │                                  │   (empty)             │
│         │                                  │   [Ask a question]    │
│         │                                  │                       │
│         │                                  │  ACTIVITY TIMELINE    │
│         │                                  │   06:41 Intake        │
│         │                                  │   06:42 Classified    │
│         │                                  │   06:43 Enriched      │
│         │                                  │   06:44 Recommended   │
│         │                                  │   09:12 Opened by PB  │
└─────────┴──────────────────────────────────┴───────────────────────┘
```

Evidence dominates because that is what the human is judging. The workflow
rail is stable — its layout does not change between workflow types, only the
content of the recommendation card and the approval-bar actions vary.

## 4 · Primitives

Nine reusable primitives. Every workflow-shaped surface composes from this
set. New workflows add configuration; they do not add primitives.

### 4.1 · `<WorkflowQueue />`

A Data Workspace consumer for one workflow type. Props:

```ts
type WorkflowQueueProps = {
  workflowType: WorkflowType;
  items: WorkflowItem[];
  savedView: string;
  currentUserId: string;
  canApprove: boolean;
};
```

The queue groups by AI recommendation strength (needs judgment / recommend
approve / recommend reject / exception / on hold) — not by workflow state —
because that is how a Controller scans their morning queue. Sort keys are
Priority, Amount, Submitted, Assignee.

Every Data Workspace primitive applies (search, density, selection, saved
views, keyboard model). Bulk actions on the selection bar are workflow-typed:
for AP that is **Bulk approve** + **Bulk reassign**; for Journal Entry
Approval it is **Bulk approve** + **Bulk reject**; for Member Applications
it is **Bulk approve** + **Bulk defer**.

### 4.2 · `<WorkflowDetail />`

The single-item surface. Props:

```ts
type WorkflowDetailProps = {
  workflowType: WorkflowType;
  item: WorkflowItem;
  currentUserId: string;
  canApprove: boolean;
  queueContext?: { position: number; total: number; prevId: string | null; nextId: string | null };
};
```

Two-column layout: Evidence Panel (left) + Workflow Rail (right). The rail
composes the recommendation card, approval bar, conversation thread, and
activity timeline in that order. Keyboard model: `A` approves,
`R` opens reject-with-reason, `?` opens conversation, `↑ ↓` step through the
queue.

### 4.3 · `<EvidencePanel />`

Renders the raw material the AI reasoned over and the human is judging. Its
content is workflow-type-specific, driven by an evidence schema:

```ts
type EvidenceSection =
  | { kind: "document";      title: string; url: string; mime: string }
  | { kind: "extracted";     title: string; fields: Array<{ label: string; value: string; confidence?: number }> }
  | { kind: "match";         title: string; matched: MatchRow;    variance?: VarianceRow }
  | { kind: "context";       title: string; rows: Array<{ label: string; value: string }> }
  | { kind: "preview";       title: string; journalEntry: JournalEntryPreview }
  | { kind: "history";       title: string; rows: HistoryRow[] };
```

Every section has a **collapse** control. Sections are collapsed by
default when the recommendation confidence is high (the human doesn't need to
re-check evidence when Spectre is confident); they expand on demand.

Every extracted field carries a **field-level confidence** where applicable —
a `92 %` badge next to `PO #4832` tells the operator which specific data
point to double-check when the overall confidence is low.

### 4.4 · `<RecommendationCard />`

The AI's stated recommendation. Cannot render without `reasoning` and
`confidence`. Renders in one of three tones:

- **Recommend approve** (green tint) — Spectre thinks this should proceed.
- **Recommend reject** (red tint) — Spectre thinks this should not proceed.
- **Needs judgment** (amber tint) — Spectre has no strong recommendation; the operator has to decide.

Anatomy:

```
┌─ Spectre recommendation ────────────────────┐
│ Eyebrow: RECOMMEND · Confidence 96 %        │
│ Headline: Approve and post to GL 5200       │
│ Reasoning:                                  │
│   · PO #4832 match — exact ($2,340.00)      │
│   · GST verified at 5 % ($111.42)           │
│   · Vendor active, net-30                   │
│   · No hold flags on account                │
│ Evidence links: PO doc · Vendor · JE preview│
│ [Approve & post — recommended]              │
└─────────────────────────────────────────────┘
```

Every reasoning bullet is a link back into the evidence panel. Clicking a
bullet scrolls the evidence panel to the relevant section and highlights it.
This is how the operator verifies the AI's reasoning in one click.

If confidence is below a workflow-type threshold (default 70 %), the tone
falls back to **Needs judgment** regardless of the raw recommendation — a
low-confidence recommend-approve is still a needs-judgment item.

### 4.5 · `<ApprovalBar />`

The primary action surface. Always renders every workflow-appropriate action
even when Spectre recommends one — the human is always one click from
disagreeing. Anatomy:

```
┌─ Approval bar ──────────────────────────────┐
│ [Approve & post] (primary, green)           │
│ Reject with reason  Reassign  Hold  Ask     │
└─────────────────────────────────────────────┘
```

- The primary button is the workflow's default approval verb ("Approve &
  post" for AP, "Approve applicant" for Member Applications, "Approve entry"
  for Journal Entry Approval).
- The secondary actions are always present: **Reject with reason** (opens a
  reason-required prompt), **Reassign** (opens a searchable user picker),
  **Hold** (opens a defer-until-date picker), **Ask** (opens the
  conversation thread).
- Every action writes to the activity timeline with actor + reason (where
  applicable) + timestamp.
- Every approval + posting operation carries a **revert affordance** for the
  configured revert window. See §7 (Revert window).

### 4.6 · `<ActivityTimeline />`

A first-class primitive precisely because AI transparency requires it. Every
event on the item is a row: `<who> <did-what> <when> [<optional-reason>]`.

```
┌─ Activity ──────────────────────────────────┐
│ 09:14 Patricia Bell approved · posted JE-8241│
│ 09:12 Patricia Bell opened this item        │
│ 06:44 Spectre recommended approve · 96 %    │
│ 06:43 Spectre enriched · PO #4832 matched   │
│ 06:42 Spectre classified as AP invoice      │
│ 06:41 Intake · email · billing@acefoods.com │
└─────────────────────────────────────────────┘
```

Every row carries:
- `actor` — a Prisma User FK OR the literal `"spectre"` for AI.
- `verb` — a constrained set per workflow type.
- `timestamp` — precise to the second.
- `reason` — free-text (for rejects, holds, reassignments) or structured
  (for enrichment steps).
- `revertible` — a boolean flag; if true, the row carries an inline **Revert**
  affordance inside the workflow's revert window.

The timeline is **append-only**. A revert does not delete rows; it appends a
new "Reverted" row that references the reverted event by id.

### 4.7 · `<ConversationThread />`

Human-to-human messaging when the operator needs to ask a question before
approving. Anatomy:

```
┌─ Conversation ──────────────────────────────┐
│ Patricia Bell → Ace Foods (billing@)        │
│ 09:18 · sent                                │
│   "Can you confirm the delivery dates for   │
│    PO #4832? The invoice ships everything   │
│    on the 12th but the PO expected split."  │
│                                             │
│ (awaiting reply)                            │
│                                             │
│ [Reply]                                     │
└─────────────────────────────────────────────┘
```

Threads have three recipient kinds:

- **External** (vendor / applicant / member — sends via email or SMS through
  the existing communications service).
- **Internal** (another Spectre user — appears in their Mission Control feed).
- **Spectre** (asks the AI to re-run enrichment with a new hint — this is
  where a Controller says "check PO #4820 too, this vendor sometimes
  cross-references").

Every message is timeline-eventful: sending, receiving, and reading each
append a row to the activity timeline.

### 4.8 · `<StateChip />`

The workflow state indicator. Follows the Data Workspace lifecycle-pill
vocabulary (Active · Inactive · Archived) but adds workflow states:

- **Active states**: Intake · Classified · Enriched · Recommended · Pending · In Review
- **Terminal states**: Approved · Rejected · Completed · Reverted · Archived
- **Exception states**: Exception · On Hold · Escalated · Reassigned

Every state has a colour + shape combination (never colour alone). Full
vocabulary in the state-model doc.

### 4.9 · `<WorkflowBanner />`

Compact top-of-detail banners for one-shot state announcements. Composes
with the Data Workspace inspector banner styles (`ok` / `warn` / `err`). Used for:

- **Post-approval revert affordance**: `Approved 09:14 EDT · [Revert]`
- **Reassignment notice**: `Reassigned to Alex Cho at 09:22 EDT`
- **Escalation notice**: `Escalated to General Manager · awaiting review`
- **Exception explanation**: `Cannot post — GL 5200 is inactive · [Fix mapping]`

Banners are transient except **exception** and **on-hold**, which persist.

## 5 · Interaction standards

The Workflow Surface inherits Mission Control and Data Workspace behaviour
verbatim; this section adds only what is workflow-specific.

### 5.1 · Keyboard model

Composes with the Data Workspace keyboard model. Workflow Detail adds:

| Key | Action |
|-----|--------|
| `A` | Fire the primary approval action (with a confirmation dialog for high-value items) |
| `R` | Open the reject-with-reason prompt |
| `?` | Open the conversation thread with focus on the compose box |
| `↑` / `↓` | Step to previous / next item in the queue (only when a queue context exists) |
| `Esc` | Close the item, returning to the queue |

Every workflow-typed shortcut is disabled inside form fields.

### 5.2 · Save contract

Every approval action is an explicit, deliberate click — no autosave. This
matches the Data Workspace save contract for accounting master data.

**Approval flow:**

1. Operator clicks the primary button (e.g. **Approve & post**).
2. Confirmation dialog fires when the workflow's `requiresConfirmation` predicate is true (default: amount > threshold OR recommendation confidence < 80 % OR the human is disagreeing with Spectre).
3. Server action runs the workflow's `onApprove` handler. For AP, that fires the same `updateAccount` + `postJournalEntry` service the existing screens use — no parallel business logic.
4. On success, the item transitions to **Approved** (and immediately to **Completed** if the workflow has no post-approval work). The activity timeline gains a row. The revert affordance is displayed inline for the configured window.
5. `router.refresh()` re-runs the RSC. The queue's counts update. The next item in the queue is auto-highlighted (never auto-opened).

**Rejection flow:**

1. Operator clicks **Reject with reason**.
2. Modal-less inline prompt asks for the rejection reason (free-text, min 10 characters, canned suggestions).
3. Server action runs the workflow's `onReject` handler.
4. Item transitions to **Rejected → Archived** (per workflow config).
5. Timeline row appended. Vendor/applicant is notified if the workflow's `notifyOnReject` flag is true.

### 5.3 · Reload-less save

Every approval / reject / reassign / hold / ask action returns a discriminated
result and lets the client `router.refresh()`. No full-page redirect. This
matches the Data Workspace inspector-save contract.

### 5.4 · Bulk actions

The queue's selection bar supports bulk approve + bulk reject + bulk reassign
for items where the workflow allows it. Bulk approval respects individual
confirmations — a bulk **Approve 12 recommended items** click still runs
each item's `requiresConfirmation` predicate; any that require confirmation
open a batch-confirm dialog listing them.

Bulk approval is atomic-per-item, not atomic-per-batch: five items succeed,
two fail with validation errors, they are reported in the warning banner
individually. This matches the Data Workspace `bulkArchiveAccountsAction`
pattern.

### 5.5 · Accessibility

- Every state pill combines colour + shape + label.
- Every recommendation carries its confidence as a text label ("Confidence 96 %"), not only visually.
- Every action button carries an ARIA label distinguishing recommended actions from equivalent-priority alternatives.
- Every activity-timeline row is read as `<actor> <verb> <target> at <timestamp>`.
- Focus visible on every interactive control (inherits `*:focus-visible` from the token layer).

## 6 · State model

Full state model in `docs/design/workflow-surface-state-model.md`. Summary:

| State | Meaning | Terminal? |
|---|---|---:|
| Intake | Item arrived; not yet classified | no |
| Classified | Spectre knows the workflow type | no |
| Enriched | Evidence attached | no |
| Recommended | AI has produced a recommendation | no |
| Pending | Awaiting human review | no |
| In Review | A human has opened it | no |
| Approved | Human approved; write path fired | no (revertible for the window) |
| Rejected | Human rejected with reason | yes |
| Exception | System detected blocking condition | no (needs human unblock) |
| Reassigned | Routing changed by a human | no (returns to Pending under new assignee) |
| On Hold | Deferred with reason + reminder date | no (auto-returns to Pending on reminder) |
| Escalated | Pushed to a senior approver | no (returns to Pending under new assignee) |
| Completed | All post-approval work done | yes |
| Reverted | Approval undone inside the revert window | yes |
| Archived | Retained for audit only | yes |

Every transition writes to the activity timeline. Every transition has an
explicit guard (permission + workflow-type rule + state validity). See the
state-model doc.

## 7 · Revert window

Every workflow whose approval fires an irreversible write path — posting an
AP invoice, approving a payroll batch, admitting a member — declares a
**revert window**. Inside the window, one click undoes the operation and
appends a "Reverted" event to the timeline.

Defaults:

- AP Invoice Approval → 7 days (aligned with the reconciliation cycle).
- Journal Entry Approval → 7 days.
- Payroll Batch Approval → 24 hours (before direct deposit fires).
- Member Application Approval → 24 hours (before member notification fires).
- Purchase Request → 7 days.
- Expense Claim → 7 days.
- Capital Request → 0 (board-approved; not operator-revertible).
- Work Order → configurable per work order (defaults to 7 days).

The revert window is a workflow-config, not a code path. New workflows
declare their window; the runtime enforces it.

**Revert is not delete.** Every reverted operation:

1. Runs the workflow's `onRevert` handler (which typically calls the
   existing reverse-JE / reverse-batch service).
2. Writes a new "Reverted" event to the timeline referencing the reverted
   event's id.
3. Transitions the item to **Reverted** (terminal).
4. The reverted event remains visible on the timeline forever — audit
   trails are append-only.

Attempting to revert after the window closes surfaces an inline exception
banner explaining why and offering the workflow's alternative reversal path
(usually a new item of the reverse type — a credit-note item for AP, a
reverse-JE item for Journal Entry Approval).

## 8 · Workflow configuration

A workflow type is a typed configuration object. New workflows are
implemented by adding a config + a service handler; they never touch the
primitives.

```ts
type WorkflowConfig<TEvidence, TRecommendation> = {
  workflowType: string;                         // e.g. "ap-invoice-approval"
  displayName: string;                          // e.g. "AP Invoice Approval"
  domain: "ap" | "ar" | "hr" | "governance" | "operations";
  routeBase: string;                            // e.g. "/app/admin/ap/approvals"
  intakeSources: IntakeSource[];                // email, upload, api, manual
  evidenceSchema: EvidenceSchema<TEvidence>;
  recommendationSchema: RecommendationSchema<TRecommendation>;
  states: StateModel;
  approvalActions: ApprovalActionConfig;
  postingContract: PostingContract;             // what fires on approval
  revertWindowHours: number;
  requiresConfirmation: (item: WorkflowItem<TEvidence, TRecommendation>) => boolean;
  notifyOnReject: boolean;
  bulkActions: Array<"approve" | "reject" | "reassign" | "hold">;
  permissions: {
    read:    PermissionKey;                     // e.g. "ap:invoice:view"
    approve: PermissionKey;                     // e.g. "ap:invoice:approve"
    reassign:PermissionKey;
    revert:  PermissionKey;
  };
};
```

Registration:

```ts
// src/lib/workflow/registry.ts
registerWorkflow(apInvoiceApprovalConfig);
registerWorkflow(memberApplicationConfig);
registerWorkflow(journalEntryApprovalConfig);
// …
```

The runtime looks up the config by `workflowType` for every render, every
server action, and every state transition. Adding a workflow does not touch
the primitives or the state-machine runtime.

## 9 · Data model

One Prisma model backs every workflow item:

```prisma
model WorkflowItem {
  id                String   @id @default(cuid())
  clubId            String
  club              Club     @relation(fields: [clubId], references: [id])
  workflowType      String                                          // fk to WorkflowConfig.workflowType
  externalId        String?                                         // links to the domain row (e.g. APInvoice.id)
  state             String                                          // see state model doc
  priorityScore     Int      @default(0)                            // computed at enrichment
  assignedUserId    String?                                         // current assignee
  submittedAt       DateTime
  submittedByUserId String?                                         // null for external intake
  approvedAt        DateTime?
  approvedByUserId  String?
  revertibleUntil   DateTime?                                       // computed at approval + workflow revert window
  evidence          Json                                            // typed by TEvidence per workflow
  recommendation    Json                                            // typed by TRecommendation per workflow
  activityLog       WorkflowActivityEntry[]
  conversationLog   WorkflowConversationEntry[]
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([clubId, workflowType, state])
  @@index([clubId, assignedUserId, state])
}

model WorkflowActivityEntry {
  id                 String   @id @default(cuid())
  clubId             String
  itemId             String
  item               WorkflowItem @relation(fields: [itemId], references: [id])
  actor              String                              // userId | "spectre"
  verb               String                              // "classified" | "enriched" | "recommended" | "approved" | …
  from               String?                             // previous state
  to                 String?                             // new state
  reason             String?
  reasoningJson      Json?                               // for AI actions — structured evidence
  revertibleEventId  String?                             // if this is a revert, points to the original event
  timestamp          DateTime @default(now())
  @@index([itemId, timestamp])
}

model WorkflowConversationEntry {
  id             String   @id @default(cuid())
  clubId         String
  itemId         String
  item           WorkflowItem @relation(fields: [itemId], references: [id])
  senderUserId   String?                                  // null for AI / external
  senderKind     String                                   // "user" | "external" | "spectre"
  recipientKind  String                                   // "user" | "external" | "spectre"
  body           String
  attachmentUrls String[]                                 // future — links to uploaded evidence
  sentAt         DateTime @default(now())
  readAt         DateTime?
  @@index([itemId, sentAt])
}
```

Every domain workflow (AP, Member Applications, etc.) has an `externalId`
pointing back to its own domain row so posting handlers can fire against
the existing service layer. The Workflow Surface never duplicates domain
state — it wraps it.

## 10 · Composition with Mission Control + Data Workspace

### Mission Control consumes the queue

The Mission Control executive briefing already renders "Ready for approval /
Needs judgment / Completed automatically" counts. Post-Sprint 2, those
counts come from the Workflow Surface aggregation across every registered
workflow type. Mission Control does not change.

### Data Workspace powers the queue

The Workflow Queue is a Data Workspace consumer. It inherits every
primitive: header, toolbar, search, saved views, density, selection, keyboard
model, saved-view URL grammar. Adds only workflow-specific bulk actions and
group-by rules.

### The inspector overlaps

A Workflow Item selected from the Data Workspace queue opens the Workflow
Detail — either as a full route (`.../<itemId>`) or as an overlay similar
to the Data Workspace inspector (a workflow config toggle). The default is
the full route for AP (invoices deserve a dedicated screen for the evidence
panel) and the inspector for Member Applications (smaller evidence surface).

## 11 · Where AI runs

Three touchpoints. All three write to the activity timeline; none of them
approve.

1. **Intake classification** — an incoming email + attachment or an uploaded document is classified into a workflow type + club. Writes `Classified` to the timeline with the reasoning it used.
2. **Evidence enrichment** — extracts fields, matches POs, verifies vendor status, computes variance, looks up member history. Writes `Enriched` with structured evidence and per-field confidence.
3. **Recommendation** — reads the enriched evidence and produces a recommended action + confidence + reasoning. Writes `Recommended` with the same structure the `RecommendationCard` renders.

Everything else is human. Approval, rejection, reassignment, holds,
escalations, conversations — every one appends a `WorkflowActivityEntry`
with `actor = userId`.

## 12 · Anti-patterns (locked forbidden list)

The Workflow Surface Foundation prohibits:

- **Silent AI mutations** — AI never writes to a domain row without a corresponding activity entry the human can audit.
- **Recommendation cards without reasoning** — the primitive won't render without it.
- **Approval without an activity entry** — every approval writes to the timeline; skipping the write is a system error.
- **Irreversible actions with no revert window** — every workflow that fires a write path declares a revert window (or is explicitly exempted with founder approval, as with Capital Requests).
- **Modal-only detail views** — the detail is a persistent page or an inspector, never a temporary modal.
- **Bulk actions that hide their per-item results** — every bulk action reports per-item success / failure in the warning banner.
- **Workflow types implemented outside the registry** — new workflows must declare a config; ad-hoc workflow logic scattered through domain code is forbidden.
- **Autosave on approval fields** — every approval is deliberate.
- **AI confidence displayed without the reasoning** — both must appear or neither may appear.
- **"Recommend approve" tone rendered when confidence < workflow threshold** — the tone falls back to Needs judgment.

## 13 · Success condition

The Workflow Surface Foundation succeeds when:

1. A new workflow type can be added by writing one config + one service handler, with zero changes to the primitives.
2. Every workflow's approval flow feels the same to the operator — same keyboard shortcuts, same layout, same audit trail.
3. Every AI action is auditable in the activity timeline within one click.
4. Every irreversible operation has a revert window that a human can exercise without contacting engineering.
5. Mission Control's briefing counts read from one aggregation across all workflow types.
6. The AP Invoice Approval implementation (Sprint 2 Phase 1) reuses every primitive without extension.
7. Adding Purchase Requests (Sprint 3) adds one config file + one service handler and nothing else.

The intended result is a foundation where **every future operational
workflow in Spectre inherits the same shape, the same audit trail, and the
same AI-transparency guarantees** without any team re-inventing them.
