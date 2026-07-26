# Workflow Surface — State Model

**Status:** Phase 0 · Architecture concept
**Extends:** `docs/design/workflow-surface-foundation.md`

This document defines the state machine every workflow item traverses. The
model is exhaustive: every state, every transition, every guard, every error
path, and the revert-window contract. New workflows may not add states; they
configure per-transition behaviour through the workflow config.

## 1 · State vocabulary

Fifteen states, four categories.

### Active (in-flight)

| State | Meaning | Terminal? |
|---|---|:---:|
| `INTAKE` | Item arrived; workflow type not yet assigned | no |
| `CLASSIFIED` | Spectre has assigned a workflow type | no |
| `ENRICHED` | Spectre has attached evidence | no |
| `RECOMMENDED` | Spectre has produced a recommendation | no |
| `PENDING` | Awaiting human review (queued to an assignee) | no |
| `IN_REVIEW` | A human has opened the item | no |

### Terminal

| State | Meaning | Terminal? |
|---|---|:---:|
| `APPROVED` | Human approved; write path fired | soft (revertible) |
| `REJECTED` | Human rejected with reason | soft |
| `COMPLETED` | All post-approval work done (revert window has closed OR the workflow declared no window) | yes |
| `REVERTED` | Approval undone inside the revert window | yes |
| `ARCHIVED` | Retained for audit only | yes |

### Exception (needs human unblock)

| State | Meaning | Terminal? |
|---|---|:---:|
| `EXCEPTION` | Blocking condition detected (missing evidence, referenced record deleted, permission gap) | no |
| `ON_HOLD` | Deferred by human with reason + reminder date | no |
| `ESCALATED` | Pushed to a senior approver | no |
| `REASSIGNED` | Routing changed by a human | no |

## 2 · Transitions

Every arrow is a legal transition. Missing arrows are illegal — a state
machine that attempts one throws.

```
                    ┌────────┐
                    │ INTAKE │
                    └───┬────┘
                        │ Spectre.classify()
                        ▼
                    ┌────────────┐
                    │ CLASSIFIED │
                    └───┬────────┘
                        │ Spectre.enrich()
                        ▼
                    ┌──────────┐
                    │ ENRICHED │
                    └───┬──────┘
                        │ Spectre.recommend()
                        ▼
                    ┌────────────┐
                    │ RECOMMENDED│
                    └───┬────────┘
                        │ system.route()
                        ▼
                    ┌─────────┐
                    │ PENDING │◄─────────────────────────────┐
                    └───┬─────┘                              │
                        │ human.open()                       │
                        ▼                                    │
                ┌─────────────┐                              │
                │ IN_REVIEW   │                              │
                └───┬──┬──┬──┬┴──┬─────────┬─────────┬───────┤
                    │  │  │  │   │         │         │       │
        approve()   │  │  │  │   │ hold()  │ reassign│esc.() │
                    ▼  ▼  ▼  ▼   ▼         ▼         ▼       │
              ┌────────┐│ ┌────────┐┌────────┐┌────────┐   (return to PENDING
              │APPROVED││ │REJECTED││ON_HOLD ││ESCALATED│    on reminder /
              └───┬────┘│ └───┬────┘└───┬────┘└───┬────┘    reassignment /
                  │     │     │         │         │          escalation complete)
       revert()   │     │     │         │         │
       within     │     │     │         │         │
       window     │  reject   │      reminder     │
                  ▼     ▼     ▼      fires        ▼
             ┌─────────┐  ┌─────────┐          (PENDING)
             │REVERTED │  │ARCHIVED │
             └─────────┘  └─────────┘
                  ▲
                  │
             (revert window expires)
                  │
             ┌──────────┐
             │COMPLETED │
             └──────────┘

  Any active state
       │  system.detectException()
       ▼
   ┌───────────┐
   │ EXCEPTION │──── human.unblock() ────► (return to previous active state)
   └───────────┘
```

## 3 · Transition table

Every legal transition, with actor, guard, and side-effects.

| From | To | Actor | Trigger | Guard | Side effects |
|---|---|---|---|---|---|
| `INTAKE` | `CLASSIFIED` | Spectre | Intake handler runs | Item has enough signal to classify (attachment / sender / subject line) | Append `Classified` event with reasoning + confidence |
| `INTAKE` | `EXCEPTION` | Spectre | Intake handler fails | Confidence < 40 % OR no known workflow matches | Append `Exception` event; assign to workflow's default triage queue |
| `CLASSIFIED` | `ENRICHED` | Spectre | Enrichment handler runs | Domain data reachable (vendor exists, PO exists) | Append `Enriched` event with structured evidence |
| `CLASSIFIED` | `EXCEPTION` | Spectre | Enrichment fails | Required domain data missing | Append `Exception`; item stays in EXCEPTION until a human resolves |
| `ENRICHED` | `RECOMMENDED` | Spectre | Recommender runs | Enrichment complete | Append `Recommended` event with recommendation + confidence + reasoning |
| `RECOMMENDED` | `PENDING` | system | Post-recommendation routing | Assignee resolvable (workflow's routing rule) | Assignee set on item; append `Routed` event |
| `RECOMMENDED` | `EXCEPTION` | system | Routing fails | No matching assignee | Append `Exception` |
| `PENDING` | `IN_REVIEW` | user | User opens the detail | User has `permissions.read` | Append `Opened by <user>` event |
| `IN_REVIEW` | `APPROVED` | user | User clicks Approve | User has `permissions.approve` AND workflow's `requiresConfirmation` predicate satisfied | Run workflow's `onApprove` handler (posts JE, notifies applicant, etc.). Set `approvedAt`, `approvedByUserId`, `revertibleUntil = now + revertWindowHours`. Append `Approved` event with the domain-write reference |
| `IN_REVIEW` | `REJECTED` | user | User clicks Reject | User has `permissions.approve` AND `reason.length >= 10` | Run workflow's `onReject` handler. Append `Rejected` event with `reason`. Transition to `ARCHIVED` (per workflow config `notifyOnReject`) |
| `IN_REVIEW` | `ON_HOLD` | user | User clicks Hold | User has `permissions.approve` AND `reminderDate > now` | Set `remindAt`. Append `Held` event with reason + `remindAt` |
| `IN_REVIEW` | `REASSIGNED` | user | User clicks Reassign | User has `permissions.reassign` AND target user has `permissions.approve` | Update `assignedUserId`. Append `Reassigned` event with `to` and reason. Transition auto-flows to `PENDING` on the new assignee |
| `IN_REVIEW` | `ESCALATED` | user | User clicks Escalate | User has `permissions.approve` AND escalation target exists in workflow config | Update `assignedUserId` to escalation target. Append `Escalated` event with reason. Transition auto-flows to `PENDING` |
| `ON_HOLD` | `PENDING` | system | `remindAt` reached | (none) | Append `Reminder fired` event |
| `REASSIGNED` | `PENDING` | system | Immediate | (none) | (transition is atomic with `IN_REVIEW → REASSIGNED`) |
| `ESCALATED` | `PENDING` | system | Immediate | (none) | (transition is atomic with `IN_REVIEW → ESCALATED`) |
| `EXCEPTION` | previous state | user | User clicks Unblock | User has `permissions.reassign` OR `permissions.approve` | Append `Unblocked` event with resolution reason. Return to the state the item was in before the exception fired |
| `APPROVED` | `REVERTED` | user | User clicks Revert (inside `revertibleUntil` window) | User has `permissions.revert` AND `now < revertibleUntil` | Run workflow's `onRevert` handler (reverse-JE, revoke access, etc.). Append `Reverted` event with reference to the original `Approved` event id. `revertibleUntil` cleared |
| `APPROVED` | `COMPLETED` | system | `revertibleUntil` passes | (none) | Append `Completed` event. `revertibleUntil` cleared |
| `REJECTED` | `ARCHIVED` | system | Immediate (workflow config) | Workflow's `archiveOnReject === true` | Append `Archived` event |
| `COMPLETED` | `ARCHIVED` | system | Nightly job | Item is older than the workflow's retention period | Append `Archived` event |
| any active state | `EXCEPTION` | Spectre | System-detected condition | (workflow-specific — e.g. referenced GL account deleted) | Append `Exception` event with reason; retain the previous state for `Unblock` return |

Any attempted transition not on this table throws `InvalidWorkflowTransition`
and appends nothing.

## 4 · Guards

Guards prevent illegal transitions before any side effect fires. Every
transition passes through the guard runtime:

```ts
type TransitionGuard<TEvidence, TRecommendation> = (
  item: WorkflowItem<TEvidence, TRecommendation>,
  actor: Principal | "spectre",
  intent: TransitionIntent,
) => GuardResult;

type GuardResult =
  | { status: "allow" }
  | { status: "deny";       reason: string }
  | { status: "confirm";    prompt: string }
  | { status: "invalidate"; validationErrors: Array<{ field: string; message: string }> };
```

Guards run in a fixed order per transition:

1. **Permission** — does the actor have the workflow's `permissions.<verb>`?
2. **State** — is the current state legal for this transition?
3. **Business** — workflow-typed rule (e.g. AP: the vendor is not blocked; Journal Entry: the period is open; Member Application: no duplicate email).
4. **Confirmation** — the workflow's `requiresConfirmation` predicate.
5. **Validation** — for approvals: the domain row still validates (Prisma constraints, service-layer rules).

A `deny` result appends a `TransitionDenied` timeline event with the reason
so the audit trail records both the attempt and its refusal.

## 5 · Revert-window contract

**Every write-path approval declares a revert window.** Defaults per
workflow type in the foundation spec §7.

At approval time:

```ts
revertibleUntil = approvedAt + workflowConfig.revertWindowHours * 3600 * 1000;
```

Inside the window:

- The `WorkflowBanner` renders a persistent `Approved <when> · Revert` affordance.
- The `ApprovalBar` is replaced by a `RevertBar` with a single button.
- Clicking `Revert` fires the workflow's `onRevert` handler.
- The `onRevert` handler is responsible for undoing the domain write (reverse-JE, reverse-batch, revoke access, notify vendor of retracted approval, etc.).
- A `Reverted` timeline event is appended with `revertibleEventId` pointing to the original `Approved` event.
- The item transitions to `REVERTED`, terminal.

Outside the window:

- The revert affordance disappears.
- Any attempt to hit the revert endpoint returns a `WindowExpired` guard result.
- The banner is replaced with a compact `Completed <when>` note.
- The workflow config's alternative reversal path (usually creating a new item — a credit-note item for AP, a reversal-JE item for Journal Entry Approval) is offered inline.

**Revert is not delete.** Every reverted event remains on the timeline. The
timeline records:

```
09:14 Patricia Bell approved · posted JE-8241        [Reverted at 15:22]
15:22 Patricia Bell reverted · reversed JE-8242      [references 09:14]
```

Both rows visible forever. Auditors read the same shape on every workflow.

## 6 · Reminders

Held items auto-return to `PENDING` when `remindAt` is reached. A nightly
job (`workflowReminderTick`) walks every held item where `remindAt <= now`
and fires the transition. Every hold carries a reminder date; a nullable
reminder is disallowed by the guard.

Reminders are workflow-typed: an AP invoice held past due-date takes
priority-boost when it returns to PENDING; a member application held past
prospect-follow-up date returns with a "prospect stale" tag.

## 7 · Idempotency

Every transition is idempotent per `(itemId, transition, actor, timestamp)`
tuple. A double-fire (network retry, form re-submit) produces one timeline
entry, not two. The `WorkflowActivityEntry` unique index covers this.

## 8 · Exception recovery

An item in `EXCEPTION` displays:

- The reason (from the appended timeline event).
- The workflow-typed remediation actions (e.g. AP: "Fix vendor status" → deep-links to the vendor edit page).
- A generic **Unblock** button — clicking it appends a resolution reason and returns the item to whichever active state it was in before the exception (recorded in the timeline event's `from`).

An unblocked item that immediately re-hits the exception condition
re-transitions to `EXCEPTION` with a new event. The activity timeline shows
every attempt; nothing is hidden.

## 9 · Bulk approval semantics

Bulk approve fires each item's transition independently:

1. For each selected item: check permission, check state, run guards, run `onApprove`.
2. Aggregate per-item results: `{approved: [...ids], denied: [{id, reason}...], failed: [{id, error}...]}`.
3. Report the aggregate in the workflow queue's warning banner:
   `"12 approved · 1 denied (vendor blocked) · 2 failed (validation errors)"`.
4. Denied and failed items are surfaced in the queue with their exception state so the operator can address them individually.

Bulk approval is never atomic across items. Never present a bulk approval
as "all or nothing" — that is a workflow anti-pattern per §12 of the
foundation spec.

## 10 · Auditing

Every timeline entry answers:

- **Who** — a User FK or the literal `"spectre"`.
- **What** — a constrained verb (see §3 transition table).
- **When** — a timestamp precise to the second.
- **Why** — a reason string (for holds / rejects / reassignments / reverts) or a structured `reasoningJson` (for AI actions).
- **From / to** — the state transition, if any.
- **Revertible ref** — for revert events, a pointer back to the reverted event.

Audit consumers (the Board audit report, the accounting audit trail, the
compliance officer's dashboard) query the timeline directly — no
denormalisation, no derived audit stores. One append-only log per item is
the single source of truth.

## 11 · Persistence

The state machine's runtime lives in `src/lib/workflow/` (new module,
introduced in Sprint 2 Phase 1):

```
src/lib/workflow/
  registry.ts        — registerWorkflow() + lookupWorkflow()
  runtime.ts         — the transition engine (guards, side effects, timeline writes)
  state-model.ts     — TypeScript enum + transition table
  actions.ts         — server actions the workspace + detail call
  types.ts           — WorkflowItem, WorkflowActivityEntry, WorkflowConversationEntry
```

The runtime is domain-agnostic — it takes a `WorkflowConfig` + an intent +
an actor + a Prisma transaction. Domain code plugs in via `onApprove` /
`onReject` / `onRevert` / `onEnrich` handlers declared on the config.

## 12 · Testing contract

Every workflow ships:

1. A **state machine test** that walks the transition table for the workflow's active states.
2. A **guard test** for every workflow-specific business rule.
3. An **audit test** proving every state transition appends exactly one timeline entry with actor + verb + timestamp + reason.
4. A **revert test** proving `onRevert` correctly undoes `onApprove` inside the window and refuses outside it.
5. A **permission test** proving every transition guards against missing permissions on both actor and (for reassignments) the target user.

Source-contract tests hold the runtime; behavioural tests hold each
workflow.
