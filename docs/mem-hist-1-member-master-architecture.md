# MEM-HIST-1 — Member Master & Membership History Foundation

**Status:** architecture + importer-foundation phase (no DB writes, no real
data imported).
**Protected baseline hold:** Account=562, JournalEntry=0,
ReportingLedgerBatch=2, ReportingLedgerSnapshot=2. Dec 2025 + Jan 2026
TB snapshots untouched. February not uploaded.

This document is the full MEM-HIST-1 architecture + source-contract
response. The founder reads it to:

1. See the EXISTING Spectre member architecture before any new tables
   are proposed.
2. Approve the canonical Member / Membership / History / External
   Identity model.
3. Understand the privacy / sanitization contract.
4. Receive the exact Jonas export request to send to the current
   accounting partner (§S).

---

## B. Existing Spectre member architecture map

| Model | Line | Role |
|---|---|---|
| `Member` | prisma/schema.prisma:1190 | **Canonical person identity.** cuid `id`, tenant-scoped `memberNumber`, mutable `membershipCategory` + `status` + `joinDate`, rich back-relations. Already the single durable identity across modules. |
| `MemberAccount` | 1308 | 1:1 AR ledger cache (`memberId @unique`). Writes routed through `recomputeAccount()`. **Is already the AR account per directive §3.** |
| `MemberHouseholdMember` | 1801 | Secondary persons on a membership (spouse, dependent) — relationship-only, not a true Household entity. |
| `User.memberId` | 658 / 674 | 1:1 Member ↔ portal user. `@unique` on `memberId` already enforces that importing a Member does NOT create a user — §15 satisfied by the existing schema. |
| `MemberGroup` + `MemberGroupAssignment` | 1836 / 1851 | Many-to-many segmentation (tennis, sailing). Non-financial. |
| `MemberCustomFieldDefinition` + `MemberCustomFieldValue` | 1876 / 1896 | Per-club extensible fields. Non-financial. |
| `MemberPortalInvite` | 8860 | Opt-in portal invite flow — correctly decoupled from Member creation. |
| `Applicant` | 1070 | Waitlist / application record. `Member.applicantId` is the forward link. |
| `ApplicationHouseholdMember` | 1127 | Household composition captured at apply time. |
| `BillingCustomer` | 8146 | Separate concept — merchant payment-processor customer, not member identity. |
| `Charge` / `Payment` / `AccountAdjustment` / `Statement` | — | All anchored on `Member.id`. |

**Found and reused as canonical:**
- `Member` is the single durable identity.
- `MemberAccount` is the AR ledger (one per Member).
- `User.memberId` keeps portal auth separate from Member identity.

**Gaps that MEM-HIST-1 fills (architecture only; implementation lands
in MEM-HIST-2):**
1. **No effective-dated membership history.** `Member.membershipCategory`
   is a mutable string on `Member`. Mutating it today would rewrite
   January's Board package membership breakdown.
2. **No `MemberExternalIdentity` table** for Jonas / other-system
   identifiers.
3. **No `MembershipClassification` reference table** — classification is
   a free-text string with no referential integrity.
4. **No member-master import framework.**
5. **No deterministic privacy / sanitization helper** for synthetic
   staging identities.

---

## C. Canonical Member architecture decision

Keep **`Member`** as the single durable identity. Do not introduce
`ARMember` / `PortalMember` / `ReportingMember` variants (directive §3).

```
                      ┌──────────────────────────┐
                      │       Member             │
                      │  (Spectre cuid)          │
                      └──────────────────────────┘
                       ↑               │
                       │               │
   ┌───────────────────┴────────┐      │
   │ MemberExternalIdentity     │      │ 1:1
   │ (sourceSystem, extId)      │      │
   │  JONAS → "123456"          │      ├──→ MemberAccount (AR ledger)
   │  CLUB-NO → "0147"          │      │
   └────────────────────────────┘      ├──→ User (portal; optional)
                                       │
                                       ├──→ MembershipHistoryEntry[]
                                       │    (effective-dated)
                                       │
                                       ├──→ MemberHouseholdMember[]
                                       │
                                       ├──→ Charge / Payment / Statement
                                       │
                                       └──→ MemberGroupAssignment[]
```

- `Member.id` — Spectre-owned, immutable, cuid.
- External systems resolve via `MemberExternalIdentity.externalIdentifier`
  for a given `sourceSystem` + `clubId`.
- No external system's identifier is ever elevated to primary.

---

## D. Member vs Membership model

**Member** — a person (or corporate entity) known to the Club. Mostly
immutable: name, DOB, external identifiers. The identity that AR / portal
/ reporting all resolve to.

**Membership** (modeled as **`MembershipHistoryEntry[]`** on the Member)
— the time-varying relationship between the Member and the Club:
- classification (category, type)
- status (ACTIVE / INACTIVE / RESIGNED / TERMINATED / APPLICANT /
  WAITLIST)
- shareholder flag
- effective-from / effective-to window
- source + source effective date
- import batch id

A Member can have 0..n `MembershipHistoryEntry` rows over their lifetime.
Current operational code reading `Member.membershipCategory` continues to
work as the "latest known" snapshot; the new history table is the
authoritative source for **as-of** questions.

Dedicated distinction preserved:
- **MEMBER COUNT** = `COUNT(DISTINCT Member)` at a date.
- **MEMBERSHIP COUNT** = `COUNT(MembershipHistoryEntry WHERE active at date)`.
- **HOUSEHOLD COUNT** = separate concept, see §M below.

---

## E. Effective-dated membership history model

### Proposed `MembershipHistoryEntry` shape

```prisma
model MembershipHistoryEntry {
  id                   String   @id @default(cuid())
  clubId               String
  memberId             String
  member               Member   @relation(fields: [memberId], references: [id])

  // CLASSIFICATION — references the MembershipClassification lookup
  // table rather than carrying a free-text string.
  classificationId     String
  classification       MembershipClassification @relation(fields: [classificationId], references: [id])

  // STATUS — the lifecycle state during this effective window.
  status               String   // ACTIVE / INACTIVE / RESIGNED / TERMINATED / APPLICANT / WAITLIST
  isShareholder        Boolean  @default(false)

  // EFFECTIVE WINDOW — half-open [effectiveFrom, effectiveTo).
  // effectiveTo = NULL means "currently in effect".
  effectiveFrom        DateTime
  effectiveTo          DateTime?

  // PROVENANCE
  sourceSystem         String   // JONAS / MANUAL / IMPORT
  sourceEffectiveDate  DateTime
  importBatchId        String?

  createdAt            DateTime @default(now())

  @@index([clubId, memberId, effectiveFrom])
  @@index([clubId, effectiveFrom, effectiveTo])
}
```

### `MembershipClassification` reference table

```prisma
model MembershipClassification {
  id        String @id @default(cuid())
  clubId    String
  code      String // SHAREHOLDER_FULL / INTERMEDIATE / SOCIAL / CORPORATE / JUNIOR / NON_RESIDENT / HONORARY
  name      String
  isShareholderClass Boolean @default(false)
  sortOrder Int    @default(100)

  entries   MembershipHistoryEntry[]

  @@unique([clubId, code])
}
```

### Resolver contract (as-of)

```ts
export async function resolveMembershipAsOf(opts: {
  clubId: string;
  memberId: string;
  asOf: Date;
}): Promise<ResolvedMembership | null>
```

Where `ResolvedMembership = { classificationCode, classificationName,
status, isShareholder, effectiveFrom, effectiveTo, sourceSystem,
sourceEffectiveDate }`. Returns `null` when the Member had no active
MembershipHistoryEntry at `asOf`.

### Overlap prevention

Enforce in service layer (not DB uniqueness, because `effectiveTo` null
is valid): on insert of a new entry, service closes any currently-open
row (`effectiveTo = newRow.effectiveFrom`) before creating the new row.
Enables uninterrupted history + atomic transitions.

### Why this satisfies §7

> *If Member A is Intermediate on Jan 31 and Shareholder on Oct 31,
> the January Board package must continue reporting Member A as
> Intermediate for January.*

The January reporting resolver always queries with `asOf = 2026-01-31`;
the row effective `2025-xx-xx → 2026-10-30` (Intermediate) wins at that
date. The October change inserts a NEW row effective `2026-10-31 →
null` without touching the earlier row. Historical reproducibility is
preserved by *construction*.

---

## F. External identity + matching model

### `MemberExternalIdentity`

```prisma
model MemberExternalIdentity {
  id                 String   @id @default(cuid())
  clubId             String
  memberId           String
  member             Member   @relation(fields: [memberId], references: [id])

  sourceSystem       String   // JONAS / NORTHSTAR / CLUBESSENTIAL / CLUB-NO / ...
  externalIdentifier String

  effectiveFrom      DateTime @default(now())
  effectiveTo        DateTime?

  @@unique([clubId, sourceSystem, externalIdentifier])
  @@index([clubId, memberId])
}
```

### Match outcomes (hard enum)

```ts
export type MemberMatchOutcome =
  | "MATCHED"       // single Member resolved via MemberExternalIdentity
  | "UNMATCHED"     // no Member resolved
  | "AMBIGUOUS"     // 2+ Members share the external identity (data defect)
  | "INVALID"       // row failed validation (missing identifier, malformed)
  | "NEW";          // intended new-member on this import batch
```

### §5 — No name-based financial matching

Fuzzy name matching is forbidden for AR attachment. The AR importer in
MEM-HIST-2 will only attach a balance when the resolver returns
`MATCHED`. `UNMATCHED` / `AMBIGUOUS` / `INVALID` rows are quarantined to
a review queue, never silently attached.

---

## G. Privacy / sanitization architecture

The real Jonas Member Master MUST NEVER be uploaded to Spectre
staging. The founder keeps the real workbook local.

### Deterministic synthetic identity

A pure helper takes a real Jonas member number + a founder-controlled
salt (OUTSIDE the repo) and returns:
- `syntheticExternalIdentifier` — SHA-256(salt + realIdentifier),
  prefixed with `CR-` and truncated → `CR-7a3e9b`.
- `syntheticMemberNumber` — stable short code `Member 7a3e`.

The salt lives in the founder's own machine (`.env.local` on their
workstation), NOT in the Spectre repo. If the salt is lost, synthetic
IDs change — this is the intended privacy property (no reversible
mapping in Spectre).

### Fields that MUST be sanitized or omitted before upload

| Field | Treatment |
|---|---|
| First name | → `Member 7a3e` (synthetic) |
| Last name | → `` (empty) or synthetic |
| Member number | → `CR-7a3e9b` (synthetic external) |
| Email | **Do NOT provide** |
| Phone | **Do NOT provide** |
| Address lines, city, postal code | **Do NOT provide** |
| Date of birth | **Do NOT provide** |
| Spouse / dependent name | → synthetic or omit |
| Emergency contact | **Do NOT provide** |
| Free-text notes | **Do NOT provide** |

### §G guarantees

- No real identity ever enters the Spectre repo.
- No real↔synthetic crosswalk persists in the Spectre application
  database. The founder's local salt + hash is the one-way map.
- `.gitignore` includes patterns to block real member workbooks (see
  §I.1 below).

---

## H. Minimum-data classification

### REQUIRED (needed for the Jan 2026 Board package Membership breakdown + AR integration)

- **external identifier** (sanitized Jonas member key) — resolves AR rows
- **classification code** (e.g. SHAREHOLDER_FULL, INTERMEDIATE, SOCIAL)
- **membership status** (ACTIVE / RESIGNED / etc.)
- **effective-from date** of the current classification
- **joined-club date** (one per Member — not effective-dated; informational)
- **isShareholder flag** OR classification code implies it

### HIGHLY DESIRABLE (unlocks additional Board metrics)

- **resignation / termination date** (when status is RESIGNED / TERMINATED)
- **previous classification + change date** (if a conversion happened in
  the reporting year — supports MovementBetweenCategories)
- **household primary flag** (if a membership covers multiple persons)

### OPTIONAL

- synthetic first name only (never real) — for display in staging UIs
- membership type code hierarchy (Full → Full Golf → Full Golf-Senior)
  if Jonas carries sub-codes

### DO NOT PROVIDE for staging

- email / phone / addresses / DOB / spouse-dependent identity /
  emergency contact / free-text notes / photos / signatures /
  credit-card tokens / bank accounts / anything PCI-adjacent

---

## I. Importer architecture

### Pipeline (same shape as the Jonas TB importer)

```
Upload → Parse → Preview → Validate → Commit
```

Preview is STRICTLY read-only. Commit is explicit.

### Importer stages (future MEM-HIST-2)

1. **`parseMemberMasterWorkbook(buffer)`** — reads XLSX; emits typed rows.
2. **`validateMemberMasterRows(rows, context)`** — row-level + aggregate
   validation. Enforces required fields, classification codes exist,
   dates are sane, duplicate external IDs flagged.
3. **`resolveMemberMatchOutcomes(rows, context)`** — attempts to match
   each row via `MemberExternalIdentity`. Returns one of MATCHED / NEW /
   AMBIGUOUS / UNMATCHED / INVALID per row.
4. **`buildPreview(rows)`** — read-only summary + diff vs. current state.
5. **`commitBatch(rows)`** — opens a `MemberMasterImportBatch`, upserts
   `Member` + `MemberExternalIdentity`, inserts
   `MembershipHistoryEntry` with the batch's `sourceEffectiveDate`.
   Explicit action; never implicit.

### `MemberMasterImportBatch` (MEM-HIST-2 schema; sketched here)

```prisma
model MemberMasterImportBatch {
  id                 String   @id @default(cuid())
  clubId             String
  status             String   // PREVIEW / COMMITTED / VOIDED
  sourceSystem       String
  sourceFileHash     String
  sourceEffectiveDate DateTime
  uploadedByUserId   String
  uploadedAt         DateTime @default(now())

  rowCount           Int
  matchedCount       Int
  newCount           Int
  conflictingCount   Int
  invalidCount       Int

  committedAt        DateTime?

  @@unique([clubId, sourceSystem, sourceFileHash, sourceEffectiveDate])
}
```

### MEM-HIST-1 scope — foundation only

MEM-HIST-1 delivers the **parser + validator + match-outcome resolver
+ privacy helper** as pure code. The DB-writing stages (`commitBatch` +
`MemberMasterImportBatch`) ship in MEM-HIST-2 once the founder has a
sanitized workbook.

---

## J. Idempotency

Idempotency keys (unique):
`(clubId, sourceSystem, sourceFileHash, sourceEffectiveDate)`

Behaviors:

| Scenario | Expected |
|---|---|
| Identical file re-upload | Rejected by the unique constraint; preview shows "already committed on …". |
| Corrected file for same date | Operator must VOID the prior committed batch (new row with status VOIDED), then commit the correction. |
| New monthly snapshot | Different `sourceEffectiveDate` → inserts cleanly; prior entries are closed by effectiveTo. |
| Classification changed between months | New `MembershipHistoryEntry` inserted effective at the new `sourceEffectiveDate`; prior entry closed. |
| New member in later file | NEW outcome → upserts `Member` + initial `MembershipHistoryEntry`. |
| Resigned member (status flipped) | Updates by inserting a new entry with status=RESIGNED effective-dated at the new source. |
| Member ABSENT from a later file | **Does NOT automatically mean resignation.** The resolver returns the last-known classification; the batch reports "N absent members, review before marking resigned." |

---

## K. Future AR integration contract (MEM-HIST-3)

```
Sanitized Jonas AR identifier
    ↓ MemberExternalIdentity (sourceSystem=JONAS, externalIdentifier=…)
    ↓
Spectre Member
    ↓
AR aging record (new table)
```

- AR aging remains a **subledger**. It does NOT alter the TB, does NOT
  create a journal entry, does NOT force the GL to match.
- `reconcileAgainstGlControl(subledgerTotal, glControlTotal)` — the
  TB-HIST-12A parser already supplies this; AR integration consumes it
  verbatim.
- Difference ≠ 0 → surface a reconciliation warning. Never silently
  adjust either side.
- Any `UNMATCHED` / `AMBIGUOUS` / `INVALID` AR row is quarantined; no
  authoritative balance attached to any Member.

---

## L. Member Portal identity contract

**Decision:** no schema change. The existing `User.memberId @unique`
(line 674 in `schema.prisma`) is already the correct contract:
- Importing a `Member` does NOT create a `User`. Portal access is a
  **separate** opt-in act (via `MemberPortalInvite`).
- A `Member` MAY become authenticated later. The link is 1:1 (unique).
- No credential field (`passwordHash`, `email`, `mfaSecret`, etc.) is
  part of the member-master importer.

MEM-HIST-1 adds no new tables for portal identity.

---

## M. Household / family decision

The current `MemberHouseholdMember` model stores secondary persons on a
Member record. It is NOT a true Household entity (there is no
household-primary / household-member relationship across Members).

**MEM-HIST-1 decision: do not promote `MemberHouseholdMember` into a
first-class Household yet.**

Rationale:
1. The Jonas export the founder is being asked to provide may not
   consistently emit household primary + members as linked rows.
2. Board Reporting member counts can be derived from `Member` alone
   until the household-primary flag is present in source data.
3. If Jonas confirms a household-primary field, MEM-HIST-2 can add a
   `householdPrimaryMemberId` nullable self-reference on `Member`
   without a Household table — simplest possible step.

**Documented in Board reporting:** MEMBER COUNT ≠ MEMBERSHIP COUNT ≠
HOUSEHOLD COUNT. The Chapter III Membership resolver must label which
metric it is reporting; if HOUSEHOLD COUNT is unsupportable from the
imported data, that specific tile is Unavailable, not the chapter.

---

## N. Board Reporting membership resolver design

Pure read-only resolver, lives at `src/lib/reporting/membership-history-resolver.ts`:

```ts
export async function getActiveMembershipsAsOf(opts: {
  clubId: string;
  asOf: Date;
}): Promise<Array<{
  memberId: string;
  classificationCode: string;
  classificationName: string;
  status: string;
  isShareholder: boolean;
}>>

export async function countMembershipsByCategoryAsOf(opts: {
  clubId: string;
  asOf: Date;
}): Promise<Array<{
  classificationCode: string;
  classificationName: string;
  count: number;
}>>
```

**Reads only from `MembershipHistoryEntry`** — never from
`Member.membershipCategory`. Guarantees §8 historical reproducibility.

**Snapshot principle:** when a Board package is **PUBLISHED**, the
Chair's Dashboard membership counts are already frozen into
`packagePayloadJson` (TB-HIST-9 lifecycle). Published packages read
from the frozen payload; subsequent member changes cannot rewrite
historical results. For DRAFT packages, the resolver runs live against
`MembershipHistoryEntry` with the as-of filter.

---

## O. Synthetic test fixture coverage

Fixture `tests/fixtures/member-master/synthetic-member-master.ts`
exercises:

- active shareholder
- active non-shareholder (intermediate)
- active social member
- membership category conversion between two effective dates
- resigned member
- new member on a later file (NEW outcome)
- duplicate external identifier (AMBIGUOUS outcome)
- missing external identifier (INVALID outcome)
- same member across two effective dates
- member absent from a later file (ABSENT, not RESIGNED)
- corporate membership
- junior member transitioning to adult

Identities: `CR-0001` / `Member 0001` through `CR-00NN` — all synthetic.
No real Silver Springs names / member numbers / emails / addresses /
phones anywhere in the fixture.

---

## P/Q. Test results + staging verification

See §19 scenarios covered in
[tests/mem-hist-1-architecture.test.ts](tests/mem-hist-1-architecture.test.ts)
+ [tests/mem-hist-1-member-master-parser.test.ts](tests/mem-hist-1-member-master-parser.test.ts).

Staging acceptance confirms the protected accounting baseline unchanged
(see §A above). No Member architecture surfaces are rendered on
staging in this phase (no DB tables yet).

---

## R. DRH-1 commits + releases

`staging-deploy/mem-hist-1-member-master-foundation` — see commit log.

---

## S. **EXACT JONAS SOURCE CONTRACT FOR THE FOUNDER**

### Operational instruction

> **"Go to Jonas Club Management → Reports → Member Master Export (or
> the equivalent 'Member List with Classifications and Status History'
> report). Export to Excel (XLSX). Include the following fields.
> Before uploading, follow the sanitization steps in §G above. DO NOT
> upload the raw file — sanitize it locally first."**

### Required export fields

| Jonas field label (typical) | Why Spectre needs it | Sanitize? | Deterministic matching? | Effective-dated? |
|---|---|---|---|---|
| **Member Number** (or Account Number) | Resolves AR rows via `MemberExternalIdentity`. Primary external key. | **Yes — SHA-256 hash with founder salt → `CR-NNNNNN`.** | Yes | No (identity) |
| **First Name** | Display only in staging UIs | **Yes — replace with "Member NNNN".** | No | No |
| **Last Name** | Display only in staging UIs | **Yes — leave empty or synthetic.** | No | No |
| **Membership Category** / Class Code | Core — effective-dated classification | No sanitization (code string) | Yes | Yes (effective at Jan 31) |
| **Membership Status** (Active / Resigned / etc.) | Core — effective-dated status | No | Yes | Yes |
| **Shareholder Flag** (Y/N) | Chapter III metric | No | — | — |
| **Join Date** / Original Join Date | Member tenure | No | — | No (identity-level) |
| **Effective-From Date** of current classification | Required for history insertion | No | — | **Yes** |
| **Snapshot As-Of Date** (file date, usually Dec 31 or Jan 31) | Required as `sourceEffectiveDate` | No | Yes | **Yes** |

### Highly desirable (unlocks richer Chapter III metrics)

| Field | Why | Sanitize? |
|---|---|---|
| **Resignation Date** | Supports resigned-this-period metric | No |
| **Previous Classification** + change date | Supports conversions-this-period | No |
| **Household Primary Flag** / Head-of-household link | Supports distinct HOUSEHOLD COUNT vs MEMBER COUNT | No (code) |

### Optional

- Membership type sub-code hierarchy (e.g. "Full-Golf-Senior").
- Date member was added to waitlist (for waitlist-aging on the Member
  Portal).

### **DO NOT EXPORT / DO NOT PROVIDE for staging**

- Email addresses
- Phone numbers
- Mailing / billing / seasonal addresses
- Postal / ZIP codes
- Date of birth
- Spouse / dependent names, DOBs, contact info
- Emergency contact
- Account balance / dues schedule (that's the AR aging file, separate)
- Free-text notes / comments
- Photo / signature
- Credit-card tokens, bank account details, direct-debit mandates
- Social-insurance / tax numbers
- Login credentials of any kind

### If Jonas cannot provide a required field

- **Member Number is MANDATORY.** If Jonas cannot export it as a stable
  key, AR integration is blocked until that key is available.
- **Classification + Status + Effective-From Date are MANDATORY.**
  Without them the Chapter III as-of resolver cannot produce historical
  figures. The founder should expect to request the "Member List with
  Classification Change Date" report explicitly if the default export
  omits it.
- **Snapshot As-Of Date is MANDATORY.** Spectre needs to know which
  calendar date the row describes.

### If Jonas emits ONE export vs multiple

Both patterns are supported:

- **Single file** with all required columns per row → parser consumes
  directly; each row produces one `MembershipHistoryEntry` effective
  at the file's as-of date.
- **Separate files** (member master + classification history +
  shareholder register + household relationships) → each file goes
  through the same parser; outcomes merge on `externalIdentifier`.
  The parser never names-matches.

### Delivery

Once the sanitized export is ready, the founder sends ONLY the
sanitized workbook via the Admin → Imports → Member Master page
(coming in MEM-HIST-2). The real workbook stays on the founder's
machine.

---

## Appendix — Full `MembershipClassification` seed codes

The reference-table codes Spectre proposes to standardize on (clubs may
override). Each is a stable string the Jonas export maps to:

| Code | Name | isShareholder |
|---|---|---|
| `SHAREHOLDER_FULL` | Full Shareholder | true |
| `SHAREHOLDER_SOCIAL` | Social Shareholder | true |
| `SHAREHOLDER_SENIOR` | Senior Shareholder | true |
| `INTERMEDIATE` | Intermediate | false |
| `SOCIAL` | Social | false |
| `JUNIOR` | Junior | false |
| `NON_RESIDENT` | Non-Resident | false |
| `CORPORATE` | Corporate | true |
| `HONORARY` | Honorary | false |
| `APPLICANT` | Applicant / Waitlist | false |
