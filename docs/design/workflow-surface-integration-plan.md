# Workflow Surface — Integration Plan

**Status:** Phase 0 · Architecture concept · **founder approval required before Phase 1**
**Extends:** `docs/design/workflow-surface-foundation.md` + `docs/design/workflow-surface-state-model.md`

Phased rollout of the Workflow Surface Foundation, starting with **AP
Invoice Approval** as the reference workflow and generalising outward
across the seven follow-on workflow types. Every phase is behind a feature
flag, reversible in a single revert, and independently shippable.

## Guiding constraints

- The founder is non-technical; every phase must be independently understandable.
- Every phase leaves the production experience working end-to-end.
- No phase changes the accounting service layer or Prisma models for existing domains (AP invoices, member applications, etc.) — the Workflow Surface **wraps** those domains without duplicating their business logic.
- Every phase adds tests; no phase removes tests.
- Every phase respects the existing permission set — new workflow-typed permissions (`ap:invoice:approve`, `journal:entry:approve`, etc.) map to today's permission keys.
- Mission Control and Data Workspace are **locked**. This plan touches them only where §7 of the Foundation calls for it.

## Feature flags

Two flags gate every visible change:

```
WORKFLOW_SURFACE = "off" | "canary" | "on"
WORKFLOW_AP_INVOICE = "modal" | "workflow"
```

- `WORKFLOW_SURFACE=off` disables every route the Workflow Surface introduces. Kept behind this flag through Phase 4.
- `WORKFLOW_SURFACE=canary` exposes routes only to users in the `workflow-canary` group.
- `WORKFLOW_SURFACE=on` exposes routes to every authorised user.
- `WORKFLOW_AP_INVOICE=modal` keeps the existing AP invoice approval modal. `workflow` switches AP to the new surface.

Phase 8 flips defaults. Phase 10 removes the flag.

## Phase 0 · Architecture (current)

**Delivered by this sprint.** Foundation spec, state model, this integration
plan, three concept HTMLs. No production code. Awaiting founder approval.

## Phase 1 · Runtime + Prisma model

**Scope:** Land the `WorkflowItem` / `WorkflowActivityEntry` /
`WorkflowConversationEntry` Prisma models + the `src/lib/workflow/`
runtime. No UI. No visible change.

**Files affected**
- `prisma/schema.prisma` — three new models per the foundation spec §9.
- `prisma/migrations/<n>_workflow_surface_baseline/*` — new migration.
- `src/lib/workflow/registry.ts` — `registerWorkflow(config)` + `lookupWorkflow(type)`.
- `src/lib/workflow/state-model.ts` — the TypeScript state enum + transition table.
- `src/lib/workflow/runtime.ts` — the transition engine (guards, side effects, timeline writes).
- `src/lib/workflow/types.ts` — public types (`WorkflowConfig`, `WorkflowItem`, `EvidenceSection`, `RecommendationSchema`, …).
- `src/lib/workflow/actions.ts` — the server actions the surface will call.
- `tests/workflow-runtime.test.ts` — new suite covering every transition + every guard + audit-entry invariants.

**Risks**
- Prisma migration is the only irreversible piece. The models are additive and don't alter existing schemas; risk is bounded.
- `WorkflowItem.evidence` and `.recommendation` are `Json` columns — need Zod validators per workflow type registered on the runtime.

**Rollback**
- Revert the migration (safe — additive tables).
- Revert the code changes.

**Definition of done**
- Migration runs cleanly on a fresh DB and on the seeded demo DB.
- Runtime tests pass with 100 % transition coverage.
- `npm run typecheck` clean.
- `npm run scan:placeholders` clean.
- Zero user-visible change.

## Phase 2 · Shared UI primitives (dev gallery only)

**Scope:** Ship the nine primitives from Foundation §4 as isolated React
components under `src/components/workflow-surface/`. Publish them to a
private `/app/admin/design-system/workflow-surface` gallery route (behind
`WORKFLOW_SURFACE=canary`). No production consumer yet.

**Files affected**
- `src/components/workflow-surface/WorkflowQueue.tsx`
- `src/components/workflow-surface/WorkflowDetail.tsx`
- `src/components/workflow-surface/EvidencePanel.tsx`
- `src/components/workflow-surface/RecommendationCard.tsx`
- `src/components/workflow-surface/ApprovalBar.tsx`
- `src/components/workflow-surface/ActivityTimeline.tsx`
- `src/components/workflow-surface/ConversationThread.tsx`
- `src/components/workflow-surface/StateChip.tsx`
- `src/components/workflow-surface/WorkflowBanner.tsx`
- `src/app/globals.css` — append `.spectre-ws-*` component classes composing the token layer.
- `src/app/app/admin/design-system/workflow-surface/page.tsx` — gallery route (canary-gated).

**Risks**
- CSS cascade — `.spectre-ws-*` prefix isolates rules; no existing `.spectre-*` / legacy `.card` / `.btn` classes touched.
- Component API surface is large; risk is around type-level correctness of `EvidenceSection` polymorphism.

**Rollback**
- Revert the components + CSS block. Gallery route disappears.

**Definition of done**
- Gallery renders every primitive at every state (viewing / editing / dirty / validation / saved) in a curated demo.
- Playwright captures at 1440 × 900 + 1920 × 1080 committed under `test-results/workflow-surface/gallery/`.
- Zero visual regression on Mission Control or the CoA workspace (baseline captures re-run and diffed).

## Phase 3 · AP Invoice Approval workflow config

**Scope:** Register the first workflow type. Config + service handler.

**Files affected**
- `src/lib/workflow/configs/ap-invoice-approval.ts` — the workflow config. Declares evidence schema (extracted fields, matched PO, vendor context, JE preview, historical similar invoices), recommendation schema (approve / reject / needs-judgment + confidence + reasoning bullets), approval actions, posting contract, revert window (7 days), `requiresConfirmation` predicate.
- `src/lib/workflow/handlers/ap-invoice-approval.ts` — the handlers (`onIntake`, `onEnrich`, `onRecommend`, `onApprove`, `onReject`, `onRevert`). Every handler delegates to the existing `src/lib/ap/invoices.ts` service — no duplication.
- `src/lib/workflow/registry.ts` — call `registerWorkflow(apInvoiceApprovalConfig)`.
- `tests/workflow-ap-invoice-approval.test.ts` — behavioural tests walking the state machine end-to-end + the revert path + the exception path.

**Risks**
- Handler must call the same `postJournalEntry` service the current approval modal calls. Any divergence is a bug.
- Enrichment reads several existing AP tables (Vendor, PurchaseOrder, APInvoice, JournalEntry preview) — verify permission-scoping.

**Rollback**
- Remove the `registerWorkflow` call. No production surface consumes it yet.

**Definition of done**
- End-to-end tests exercise: intake → classified → enriched → recommended → pending → in_review → approved → completed (after revert window).
- Rejection path tested.
- Exception + unblock path tested.
- Revert-within-window tested.
- Revert-outside-window refused with the expected guard result.
- `postJournalEntry` invoked with byte-identical FormData shape to the current modal path (verified via a snapshot test on the payload).

## Phase 4 · Intake pipeline — email + upload

**Scope:** Wire the AP invoice intake surface. Emails from configured vendor
addresses land in the AP inbox; uploads through the existing invoice-upload
page create `WorkflowItem` rows.

**Files affected**
- `src/lib/imap/ap-inbox-poller.ts` — new. Polls the configured mailbox; each new message produces a `WorkflowItem` via the AP workflow's `onIntake` handler.
- `src/app/api/webhooks/ap-inbox/route.ts` — new. Optional SendGrid-inbound webhook for real-time intake.
- `src/app/app/admin/ap/invoices/upload/page.tsx` — existing upload page emits a `WorkflowItem` alongside the current `APInvoice.create`. Feature-flagged.

**Risks**
- Intake creates DB rows in production. Rate-limit the poller.
- Duplicate detection needs to run on intake (existing `vendorReference` uniqueness).

**Rollback**
- Kill the poller cron. New items stop arriving; existing items remain in their current state.

**Definition of done**
- A test AP inbox message produces a `WorkflowItem` in `INTAKE`, then transitions to `CLASSIFIED → ENRICHED → RECOMMENDED → PENDING` within 60 seconds.
- Existing AP upload page continues to create `APInvoice` rows unchanged; the new `WorkflowItem` row is a side-effect.

## Phase 5 · AP Invoice Approval Queue (canary)

**Scope:** Ship the production Workflow Queue for AP Invoice Approval at
`/app/admin/ap/approvals` behind `WORKFLOW_SURFACE=canary`. The queue is a
Data Workspace consumer.

**Files affected**
- `src/app/app/admin/ap/approvals/page.tsx` — new route. Server component; fetches items via `lookupWorkflow("ap-invoice-approval").queryQueue(principal, clubId, filters)`.
- `src/app/app/admin/ap/approvals/workspace-client.tsx` — client component wrapping `<WorkflowQueue />` from Phase 2. Adds AP-specific column configuration.
- `src/components/admin/AdminShell.tsx` — add `/app/admin/ap/approvals` to `SPECTRE_MODE_PREFIXES` under the `WORKFLOW_SURFACE=canary|on` guard.
- `src/components/Sidebar.tsx` + `src/components/spectre/SpectreSidebar.tsx` — add "Invoice Approval" under Accounts Payable (canary users only).

**Risks**
- New nav entry — canary-gated to prevent surprise for non-canary users.
- Queue query hits the new indexes on `WorkflowItem` — validate index usage on the seed DB with EXPLAIN.

**Rollback**
- Flip flag to `off`. Route 404s. Nav entry disappears.

**Definition of done**
- Queue renders with real seed AP invoices as `WorkflowItem` rows.
- Data Workspace primitives (search, saved views, density, selection, keyboard model) all work.
- Selection-bar bulk-approve fires per-item transitions; per-item failures surface in the warning banner.

## Phase 6 · AP Invoice Approval Detail (canary)

**Scope:** Ship `/app/admin/ap/approvals/<id>` — the single-item Workflow
Detail. Composes every primitive from Phase 2.

**Files affected**
- `src/app/app/admin/ap/approvals/[id]/page.tsx` — new. Server component fetches the workflow item, evidence, and activity + conversation logs.
- `src/app/app/admin/ap/approvals/[id]/detail-client.tsx` — client component wrapping `<WorkflowDetail />`.
- Server actions from `src/lib/workflow/actions.ts` are wired to the approval bar, conversation, and revert affordances.

**Risks**
- Evidence panel renders per section — polymorphic; needs thorough state test coverage.
- Prev / Next queue navigation must respect the user's current filter set (the queue's saved view state persists across detail navigations).

**Rollback**
- Flip flag to `off`. Detail 404s.

**Definition of done**
- Approving from the detail fires the same `postJournalEntry` call the existing modal fires today.
- Rejecting with reason writes the timeline row and archives the item.
- Reassign, hold, escalate, and revert all work end-to-end.
- Conversation thread with an external recipient sends an email via the existing communications service.
- Keyboard shortcuts (A / R / ? / ↑ / ↓ / Esc) all wired.

## Phase 7 · Mission Control briefing integration

**Scope:** The Mission Control executive briefing reads its "Ready for
approval / Needs judgment / Completed automatically" counts from the
Workflow Surface aggregation instead of the ad-hoc per-service queries it
uses today.

**Files affected**
- `src/lib/mission-control/index.ts` — swap the ad-hoc AP invoice `count()` + AR aged accounts `count()` for `lookupWorkflow(...).count(...)` aggregations across every registered workflow.
- `src/app/app/admin/page.tsx` — no visible change; the counts arrive from a different source.

**Risks**
- Mission Control is **locked**. This is the one exception §7 of the foundation calls out. Verify the visual result is byte-identical to the current briefing (Playwright diff against the Mission Control baseline captures).

**Rollback**
- Revert the Mission Control service change. Ad-hoc queries return.

**Definition of done**
- Mission Control renders identically before and after (visual diff = zero).
- The briefing count now includes every registered workflow's pending items, not just AP.
- Mission Control tests all pass.

## Phase 8 · Flip AP default

**Scope:** Set `WORKFLOW_AP_INVOICE=workflow` as the production default.
Existing invoice-approval modal paths become deprecated but still work
(users can hit the legacy URL until Phase 10).

**Files affected**
- `src/lib/feature-flags.ts` — flip default.
- Any test that assumes the modal is the primary path re-targets the workflow.

**Risks**
- User surprise — the AP approval experience changes for every non-canary user.
- Preserve the legacy modal for one full accounting cycle before Phase 10.

**Rollback**
- Set flag back to `modal`. Modal returns for every user.

**Definition of done**
- Every AP approval e2e test targets the workflow surface and passes.
- Manual walkthrough with the founder's finance team validates the workflow feels the same as the modal (Bloomberg-precise scan-and-approve pattern).
- A one-week canary observation period passes with zero regressions.

## Phase 9 · Second workflow type — Journal Entry Approval

**Scope:** Register the second workflow type, validating the Foundation's
"new workflow = one config + one handler" success condition.

**Files affected**
- `src/lib/workflow/configs/journal-entry-approval.ts` — new.
- `src/lib/workflow/handlers/journal-entry-approval.ts` — new. Delegates to the existing `postJournalEntry` service.
- `src/lib/workflow/registry.ts` — one line added.
- `src/app/app/admin/finance/journal-entries/approvals/page.tsx` — new route.
- Sidebar entry.
- Test suite.

**Zero changes** to `src/components/workflow-surface/*` or `src/lib/workflow/runtime.ts`.

**Definition of done**
- Journal Entry Approval works end-to-end.
- The delta from Phase 1 to Phase 9 (excluding tests + JSON schema files) is under 400 lines.
- Every workflow primitive renders correctly against the new evidence schema without extension.

## Phase 10 · Retire legacy AP approval modal

**Scope:** Delete the legacy AP invoice approval modal. Remove
`WORKFLOW_AP_INVOICE` flag.

**Files affected**
- `src/app/app/admin/ap/invoices/[id]/approve-modal.tsx` — delete.
- `src/app/app/admin/ap/invoices/page.tsx` — remove the modal render site.
- `src/lib/feature-flags.ts` — remove the flag.

**Preserve**
- `src/lib/ap/invoices.ts` — untouched.
- Every existing AP action + query.
- The `/app/admin/ap/invoices/[id]` legacy detail route.
- Every existing `data-testid` the AP e2e suite targets.

**Definition of done**
- No `AccountModal` / `ApproveModal` render sites remain in AP.
- Every legacy AP URL still resolves (approvals go through the workflow surface).
- Every existing AP test passes (retargeted where necessary against the new surface).

## Phase 11 · Third workflow type — Member Application

**Scope:** Register Member Application Approval. Validates the Foundation
against a non-financial workflow.

Same shape as Phase 9. New evidence sections (application form,
references, financial disclosure, background-check result). New
recommendation schema (approve / defer / reject).

## Phase 12 · Fourth workflow type — Payroll Batch Exception

**Scope:** Register Payroll Batch Exception. Validates the Foundation
against a workflow with a **24-hour revert window** (before direct deposit
fires).

## Phase 13 · Fifth workflow type — Purchase Request

**Scope:** Register Purchase Request. Validates the multi-approver escalation
path (line manager → controller → GM).

## Phase 14 · Sixth workflow type — Expense Claim

**Scope:** Register Expense Claim. Validates receipt-attachment evidence.

## Phase 15 · Seventh workflow type — Capital Request

**Scope:** Register Capital Request. Validates the **zero revert window**
case (board-approved; not operator-revertible).

## Phase 16 · Eighth workflow type — HR Onboarding + Work Orders

**Scope:** Register HR Onboarding and Work Orders. Validates the
Foundation against non-approval workflows (task-completion vs. approval).

## Phase 17 · Foundation lock

**Scope:** Regression testing across every registered workflow. Lock the
Workflow Surface Foundation.

**Definition of done**
- Every workflow's tests pass.
- Runtime coverage on the state machine remains 100 %.
- Foundation-lock captured in `docs/design/Sprint Roadmap.md`.
- Workflow Surface row: Concept ✅ · Founder Approved ✅ · Integrated ✅ · Locked ✅.

## Files affected — summary

The following production surfaces will be touched across phases:

| File / directory | Phases | Nature of change |
|---|---|---|
| `prisma/schema.prisma` | 1 | Add three additive models |
| `src/lib/workflow/*` | 1, 3, 9–16 | New module — runtime + configs + handlers |
| `src/components/workflow-surface/*` | 2 | New component tree |
| `src/app/globals.css` | 2 | Append `.spectre-ws-*` component classes |
| `src/app/app/admin/ap/approvals/**` | 5, 6 | New AP-workflow-specific routes |
| `src/lib/mission-control/index.ts` | 7 | Aggregate from workflow registry |
| `src/lib/feature-flags.ts` | 5, 8, 10 | Add + flip + remove flag |
| `src/components/Sidebar.tsx` + `SpectreSidebar.tsx` | 5, 9, 11–16 | Add nav entries per workflow |
| `src/app/app/admin/design-system/workflow-surface/page.tsx` | 2 | Canary-only primitive gallery |

**Untouched throughout:**
- `src/lib/accounting/coa` (Data Workspace foundation service layer)
- `src/lib/reporting/**` (Executive reporting)
- Mission Control primitives
- Every legacy CoA / Mission Control test file

## Rollback strategy — summary

| Phase | Rollback | Blast radius |
|------:|----------|--------------|
| 1 | Revert migration + code | Zero user impact |
| 2 | Revert components + CSS | Zero user impact (canary-only) |
| 3 | Remove `registerWorkflow` call | Zero user impact |
| 4 | Kill intake pipeline | New items stop arriving |
| 5 | Flag = `off` | Canary users lose the queue |
| 6 | Flag = `off` | Canary users lose the detail |
| 7 | Revert Mission Control change | Ad-hoc counts return |
| 8 | Flag = `modal` | Legacy AP modal returns for every user |
| 9–16 | Remove `registerWorkflow` calls | Workflow-type surfaces disappear |
| 10 | Restore legacy modal code | Legacy AP modal returns |
| 17 | Reopen roadmap; no code changes | Zero |

Only phase 1 is code-irreversible (migration). Every other phase is a code
revert away from the previous state.

## Risks that cannot be rolled back

- Prisma migration in Phase 1 (three new tables). Safe because additive.
- Intake pipeline in Phase 4 producing production `WorkflowItem` rows. Safe because idempotent per external message.
- The eight domain service layers (AP, Journal Entries, Members, Payroll, Purchase Requests, Expense Claims, Capital Requests, HR / Work Orders) — **this plan never modifies any of them**. Every handler delegates to the existing service.

## Success condition

The Workflow Surface Foundation is locked when:

1. Adding a new workflow type takes one config + one handler + one test suite. No changes to primitives or runtime.
2. Every workflow's approval feels identical to the operator.
3. Every AI action appears in the timeline within one click.
4. Every irreversible operation has a revert window a human can exercise.
5. Mission Control's briefing counts read from one aggregation across all workflows.
6. Nine workflow types are in production (AP + Journal Entries + Member Applications + Payroll Exceptions + Purchase Requests + Expense Claims + Capital Requests + HR Onboarding + Work Orders).
7. Zero legacy approval modals remain.
