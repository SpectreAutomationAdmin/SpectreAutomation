# ADR 0001 — Work Intake Origin Architecture

- **Status**: Accepted
- **Date**: 2026-07-19
- **Sprint**: 2 (Outlook integration), Phase B1
- **Decision-makers**: Founder (approved Phase A revised architecture); implementation by Claude Code
- **Supersedes**: Phase A original proposal to store intake state directly on `EmailMessage`

## Context

Sprint 2 introduces external mailbox ingestion. Mission Control already renders two Work Intake cards from real production data:

- `loadPendingAPInvoiceItems` → `APInvoice.status === "PENDING_APPROVAL"`
- `loadOverdueMemberARItems` → `MemberAccount` rows with overdue balances

Both are projected into a `WorkItem` shape at read time — no materialised intake row exists on the origin side.

Adding email as a third source raises the intake model to the top of the architecture. The founder's roadmap names ten planned sources: Outlook, AP invoices, member requests, web forms, reservations, POS anomalies, payroll exceptions, weather alerts, government filings, and AI-generated operational insights. The Work Intake orchestration state — owner, status, classification, defer, resolve, activity — must live somewhere that is not any one origin's table.

Founder-mandated architectural constraints for the choice:

1. **Source extensibility** — adding a new source must not require altering the canonical intake table.
2. **Database integrity** — foreign-key enforcement where practical.
3. **Tenant isolation** — every intake row and every origin link is club-scoped.
4. **Idempotent materialisation** — resyncing evidence must produce the same intake state.
5. **Deletion and retention** — the intake outlives its evidence when the evidence is retracted or purged.
6. **One origin producing multiple intake items** — a single email can spawn N intake items (e.g. an invoice attached to a message that also contains an unrelated question).
7. **One intake item accumulating multiple pieces of evidence** — a conversation thread of emails, or an email + a reservation conflict, may back a single intake.
8. **Avoid a migration to the core table for every future source.**

## Options considered

### Option A — Nullable source-specific foreign keys on the canonical table

```prisma
model WorkIntakeItem {
  emailMessageId    String?   @unique
  apInvoiceId       String?   @unique
  weatherAlertId    String?   @unique
  // ... one nullable FK per source ...
}
```

- **For**: Direct database-enforced integrity for every source.
- **Against**: The canonical intake table grows a column for every new source type. Constraint 8 fails. Constraint 6 fails: a single email cannot spawn two intake items because `emailMessageId` is unique. Constraint 7 fails: an intake row can point to only one origin at a time.

### Option B — Generic origin identity on the canonical table

```prisma
model WorkIntakeItem {
  source          String   // EMAIL_MESSAGE | AP_INVOICE | ...
  sourceRecordId  String
  @@unique([clubId, source, sourceRecordId])
}
```

- **For**: The canonical table never grows for a new source. Constraint 8 passes.
- **Against**: No database-level foreign key from `sourceRecordId` to `EmailMessage.id`, `APInvoice.id`, etc. Constraint 2 fails. Deletion is manual and error-prone. Prisma queries cannot `include` the origin idiomatically — the loader has to switch on `source` and hand-select from the right table for every read. Constraint 6 fails: `@@unique([clubId, source, sourceRecordId])` prevents multiple intakes from the same origin. Constraint 7 fails: one intake row cannot reference multiple pieces of evidence.

### Option C — Dedicated origin-link records

Canonical `WorkIntakeItem` is source-neutral. Each source type has its own link table that carries the FK to the source record:

```prisma
model WorkIntakeItem {
  id                  String   @id
  // Orchestration state ONLY. No source columns.
  // Denormalised display projection is refreshed by materialisers.
  emailOrigins        EmailWorkIntakeOrigin[]
  // Later: apInvoiceOrigins, weatherAlertOrigins, ...
}

model EmailWorkIntakeOrigin {
  workIntakeItemId    String
  emailMessageId      String
  role                String   // "PRIMARY" | "EVIDENCE"
  @@unique([workIntakeItemId, emailMessageId])
}
```

- **For**: The canonical table never gains a source column (constraint 8 passes). Each link table carries a real FK to its origin (constraint 2 passes). An email can spawn N intakes (multiple link rows with different `workIntakeItemId`, constraint 6 passes). An intake can accumulate M pieces of evidence (multiple link rows on the same `workIntakeItemId`, constraint 7 passes). Deletion of an origin cascades to its link only, leaving the intake alive so orchestration history is preserved (constraint 5 passes). Idempotent materialisation is a `PRIMARY`-role lookup on `emailMessageId` (constraint 4 passes).
- **Against**: One extra join to reach the origin. A materialiser per source must exist rather than a single generic loader; the source materialiser contract makes this explicit.
- **Neutral**: A new source is a new link table + a new materialiser. The canonical table stays untouched forever.

## Decision

**Option C — dedicated origin-link records.**

The founder's constraint list is 8 requirements long. Option A fails 4 and 6, 7, 8. Option B fails 2, 6, 7. Option C satisfies all 8.

The extra join cost is one-time per intake render and Mission Control renders at most ~50 items per snapshot — well within Prisma's `include` overhead. A source materialiser contract (§4 of the Sprint 2 Phase B directive) formalises the "one materialiser per source" pattern, so the extra link tables come with an explicit code contract rather than sprawling glue.

## Consequences

- `WorkIntakeItem` is the canonical intake row. It carries orchestration state (owner, status, classification, defer, resolve) and a denormalised display projection maintained by materialisers. It has no direct FK to any origin.
- Each origin type gets a link table (`EmailWorkIntakeOrigin` in B1; `APInvoiceWorkIntakeOrigin`, `WeatherAlertWorkIntakeOrigin`, etc. in later phases). The link table carries `role` (`PRIMARY` vs `EVIDENCE`) so a materialiser can locate its idempotency key while allowing manual "attach as evidence" later.
- Every source ships with a materialiser that satisfies the `SourceMaterializer` contract in [src/lib/work-intake/materializer.ts](../../src/lib/work-intake/materializer.ts). The contract enforces idempotency and preservation of user-entered orchestration state.
- Mission Control reads from `WorkIntakeItem` via `loadIntakeItems(clubId)`. The two existing AP/AR projections stay intact for B1 and are migrated into materialisers as a separate future task.
- A partial-unique invariant — "at most one PRIMARY link per email" — is enforced by the email materialiser and covered by a unit test. Postgres partial indexes can express this at the DB layer in a later hardening migration; SQLite cannot, so B1 does not attempt to add the index and relies on the materialiser's idempotency guard.

## Rejected during founder review of Phase A

- Original proposal: `intakeStatus`, `ownerUserId`, `classification` on `EmailMessage`. Rejected because it forces the same orchestration columns onto every future origin table and does not admit multiple intakes per email or multiple evidence per intake.
- `sharedWithUserIds String[]` for shared-mailbox authorisation. Replaced by relational `MailboxAccess` (§5 of the founder's Phase B directive).
- `MailboxType` value `SERVICE`. Removed in favour of `PERSONAL` and `SHARED` only; a `SERVICE` value can be added later when its authorisation semantics are defined.
