# Spectre Automation

> The operating system for private golf and country clubs.

Spectre Automation is a multi-tenant SaaS platform giving each private club its own isolated operating ecosystem — onboarding, accounts receivable, collections, financing, events, accounting, and a polished member experience — on a single shared codebase.

This repository contains the working clickable application plus the Phase 1 production foundation: hardened auth, granular RBAC, an immutable audit log, a tenant-safe service layer, security headers, and a real test suite.

---

## Stack

| Layer       | Choice                                                                 |
| ----------- | ---------------------------------------------------------------------- |
| App         | Next.js 14 App Router + TypeScript (strict)                            |
| Styling     | Tailwind CSS                                                           |
| Database    | Prisma ORM, SQLite locally (Postgres-ready — see "Switching to Postgres") |
| Auth        | iron-session (AES-256 signed+encrypted cookies) + bcrypt + lockout     |
| Validation  | Zod (env + service input)                                              |
| Tests       | Vitest                                                                 |

---

## Getting started

```bash
# 1. Dependencies (runs prisma generate via postinstall)
npm install

# 2. Configure environment (copy and edit)
cp .env.example .env
#    then set SPECTRE_SESSION_SECRET to a real 32+ char value:
#    openssl rand -hex 48

# 3. Database
npm run db:push     # apply schema
npm run db:seed     # demo data

# 4. Run
npm run dev         # http://localhost:3000

# 5. Tests
npm test
```

Reset DB to a known-good demo state at any time:

```bash
npm run db:reset
```

### Switching to PostgreSQL

1. `prisma/schema.prisma` → change `datasource db { provider = "sqlite" }` → `"postgresql"`.
2. `.env` → set `DATABASE_URL` to a Postgres connection string.
3. `npm run db:push` (or move to `prisma migrate dev` for tracked migrations).
4. `npm run db:seed`.

Enum-style fields are plain strings so the schema ports cleanly.

---

## Demo accounts

Password for all: `password`.

| Role             | Email                         | Notes                                          |
| ---------------- | ----------------------------- | ---------------------------------------------- |
| SUPER_ADMIN      | `super@spectre.app`           | Spectre platform staff, cross-tenant.          |
| CLUB_ADMIN       | `admin@silversprings.club`    | Full admin nav for Silver Springs.             |
| FINANCE_ADMIN    | `finance@silversprings.club`  | Finance-scoped permissions (no member writes). |
| GENERAL_MANAGER  | `gm@silversprings.club`       | Broader operating access incl. AP approvals.   |
| MEMBER           | `member@silversprings.club`   | Member portal (James Whitfield).               |

After 5 failed sign-in attempts an account is locked for 15 minutes; you can demonstrate the lockout safely with an arbitrary email.

---

## Production foundation (Phase 1)

### Multi-tenancy

Every club-scoped record carries a `clubId`. **Read all of [`src/lib/services/tenant.ts`](src/lib/services/tenant.ts) before adding a new service** — it defines the only sanctioned patterns:

- `tenantScope(principal)` — for tenant-aware list queries.
- `tenantWhere(principal, clubId)` — strict, throws if the principal has no access to `clubId`.
- `assertTenantOwned(record, principal)` — defense-in-depth check after any `findUnique` on a primary key.

Tests in [`tests/tenant-isolation.test.ts`](tests/tenant-isolation.test.ts) verify that cross-tenant operations fail with `TenantViolationError` and never mutate the target club's state.

### RBAC

Roles and permissions are **data**, not code enums.

- 14 system roles seeded in [`src/lib/permissions.ts`](src/lib/permissions.ts) and projected into the `Role` / `RolePermission` tables.
- Permission keys follow `<domain>:<action>` (`members:write`, `gl:post`, `ap:approve`, `self:account:read`, etc.).
- Authorization is enforced by `hasPermission(principal, clubId, key)` / `requirePermission(...)` in [`src/lib/rbac.ts`](src/lib/rbac.ts).
- A `User` can hold roles at multiple clubs via `UserClubRole`. `SUPER_ADMIN` is represented by a row with `clubId = null`.

UI and route guards always check **permissions**, never role names directly. Route guards live in pages and layouts; service-layer guards in `src/lib/services/*`.

### Audit log

`AuditLog` is append-only. Every sensitive write in the service layer calls [`audit()`](src/lib/audit.ts) with `before` and `after` snapshots; the helper redacts known-sensitive keys (`passwordHash`, `mfaSecret`, etc.) and captures IP + user agent from [`getRequestContext()`](src/lib/request-context.ts). Failures in `audit()` are swallowed and logged — they never block legitimate work.

In production, restrict the application DB role from `UPDATE`/`DELETE` on `AuditLog` so the table is enforced as append-only at the DB level.

### Authentication

- Sessions: AES-256 signed+encrypted cookies via `iron-session` ([`src/lib/session.ts`](src/lib/session.ts)). Cookie is HTTP-only, `SameSite=Lax`, `Secure` in production.
- Passwords: bcrypt (12 rounds in production). The login service performs a fake bcrypt compare for unknown emails to remove timing oracles.
- Lockout: 5 failed attempts → 15-minute lock with `User.status = "LOCKED"` and `lockedUntil` set. Lockout supersedes a normal account-disabled check.
- All login successes and failures audit-log (`auth.login_success`, `auth.login_failed`, `auth.account_locked`, `auth.login_blocked`).
- MFA is scaffolded on `User` (`mfaEnabled`, `mfaSecret`) but not yet enforced — Phase 8.

### Service layer

Business logic moved out of pages into [`src/lib/services/`](src/lib/services/). Every service function:

1. Validates input with Zod.
2. Loads the target entity by primary key and runs `assertTenantOwned`.
3. Calls `requirePermission` for the action.
4. Performs the write inside a Prisma transaction where multiple tables move together.
5. Writes an audit log row.

Services implemented in Phase 1:

- [`auth.ts`](src/lib/services/auth.ts) — login, lockout, password hashing.
- [`applications.ts`](src/lib/services/applications.ts) — public submit, approve, deny, waitlist, internal notes.
- [`members.ts`](src/lib/services/members.ts) — status, access, collection notice generation, tenant-safe reads.
- [`payment-methods.ts`](src/lib/services/payment-methods.ts) — add/primary/backup/remove, supports both admin and member-self paths.
- [`principal.ts`](src/lib/services/principal.ts) — resolve the current request's Principal.
- [`tenant.ts`](src/lib/services/tenant.ts) — tenant-safe query helpers.

### Environment validation

[`src/lib/env.ts`](src/lib/env.ts) validates `process.env` with Zod at module load. Missing or weak values fail fast with a clear error rather than at request time. The `SPECTRE_SESSION_SECRET` minimum length (32) is enforced.

### Security middleware

[`src/middleware.ts`](src/middleware.ts) applies a hard security baseline to every response:

- `Content-Security-Policy` (self + inline styles; inline-script CSP nonces are a Phase 8 follow-up).
- `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.
- `Permissions-Policy` denying camera/mic/geo/payment.
- Cookie-presence auth gate on `/app/**` so unauthenticated requests are bounced to `/login?next=…` without server-component evaluation.

### Tests

```bash
npm test          # one-shot
npm run test:watch
```

What's covered today (24 tests, all green):

- [`tests/rbac.test.ts`](tests/rbac.test.ts) — every role's permission matrix, including `SUPER_ADMIN` cross-tenant access, `AUDITOR_READ_ONLY` read-only enforcement, and `BOARD_READ_ONLY` scope.
- [`tests/tenant-isolation.test.ts`](tests/tenant-isolation.test.ts) — cross-tenant approve/deny/notice attempts fail with `TenantViolationError`; admins at club A cannot mutate club B; `SUPER_ADMIN` can.
- [`tests/audit.test.ts`](tests/audit.test.ts) — application approve/deny actions write audit logs with correct actor, before/after snapshots, and meta.
- [`tests/auth.test.ts`](tests/auth.test.ts) — login success, generic-error for unknown user, lockout after 5 failures, disabled account rejection, password salting.
- [`tests/finance.test.ts`](tests/finance.test.ts) — amortization math (zero-balance at final payment, total-paid invariant, 0% interest case).

Tests run against an isolated `prisma/test.db` (configured at module top-level in [`tests/setup.ts`](tests/setup.ts) — moving these mutations into `beforeAll` would silently let tests write into `dev.db` because the Prisma singleton would already be bound).

---

## Routes

```
/                                       Marketing site
/login                                  Sign in (encrypted session, lockout)
/clubs/[clubSlug]/apply                 Public membership application
/clubs/[clubSlug]/apply/confirmation    Confirmation

/app                                    Routes signed-in user to admin or member home
/app/admin                              Club admin dashboard
/app/admin/applications                 Applications list + filters
/app/admin/applications/[id]            Application detail + approve/deny/waitlist/note (audited)
/app/admin/members                      Members list
/app/admin/members/[id]                 Member 360
/app/admin/members/[id]/approve         Approval / payment selection
/app/admin/members/[id]/financing/new   Financing calculator + accept-and-sign
/app/admin/finance                      Finance dashboard
/app/admin/collections                  Collections queue + notice workflow
/app/admin/financing                    Financing agreements list
/app/admin/milestones                   CRUD for the welcome-timeline content
/app/admin/events                       Event creation + registrations
/app/admin/settings                     Club profile, branding, future integrations

/app/welcome/timeline                   Magical onboarding timeline
/app/welcome/preferences                Netflix-style preference setup

/app/member                             Member hub
/app/member/account                     AR portal
/app/member/payment-methods             Add/manage payment methods (audited; metadata-only)
/app/member/events                      View and register for events
```

---

## Phase 2 — Productionized member workflows

### Member applications (2A)

Multi-step public application with **DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED/DENIED/WAITLISTED** (plus side branches **PENDING_INFORMATION** and **WITHDRAWN**) enforced by [`application-state.ts`](src/lib/services/application-state.ts). Drafts are resumable via HMAC-signed tokens (`/clubs/[slug]/apply/[token]/...`). Public submission, household, document metadata, signed-submission IP / user-agent, reviewer assignment, waitlist priority, request-more-information, and a per-applicant activity timeline are all wired through [`applications.ts`](src/lib/services/applications.ts) and audited.

### Onboarding (2B)

When an application is approved, [`onboarding.ts`](src/lib/services/onboarding.ts) seeds a per-member checklist (`WELCOME → TIMELINE → ORIENTATION → PAYMENT_METHOD → PREFERENCES → DASHBOARD → INCENTIVES → COMPLETED`). Completing the final `COMPLETED` item requires all required prerequisites and flips the member from `ONBOARDING` to `ACTIVE`. Approval also copies household members into the post-join `MemberHouseholdMember` table. Incentive credits are first-class (`IncentiveCredit`).

### Member Hub & profile (2C)

Widget registry in [`widgets.ts`](src/lib/widgets.ts) ships 17 known widgets with per-club enable/disable (`ClubWidgetConfig`) and per-member ordering (`DashboardWidget`). Members get a real profile page at `/app/member/profile` for contact info, household add/remove, interests, and notification preferences — all gated through [`member-profile.ts`](src/lib/services/member-profile.ts) and the `self:profile:write` permission. Club announcements (`ClubAnnouncement`) are seeded for the hub.

### AR engine & statements (2D)

Production AR with **financial integrity** as the brief required:

- **Charges, Payments, Adjustments** are append-only. Mistakes are corrected via **void** (same-day fix; row stays POSTED-but-voided with audit) or **reverse** (a contra row is posted offsetting the original; original transitions to REVERSED). Never deletes.
- `MemberAccount.*Balance` fields are denormalized **caches** rewritten only by [`recomputeAccount()`](src/lib/services/ar.ts). UI never computes balances.
- Aging is a pure function — [`calculateAging()`](src/lib/services/aging.ts) — with full **current / 30 / 60 / 90 / 120+** buckets, FIFO payment allocation against the oldest unpaid charge, voided/failed rows excluded.
- **Statements** are *point-in-time snapshots* — [`statements.ts`](src/lib/services/statements.ts) denormalizes the line items into `linesJson` so future void/reversal activity never retroactively changes a previously-issued statement.
- **Payment promises**, **disputes**, **account notes**, and **adjustments** (CREDIT / DEBIT / WRITE_OFF / REFUND / TRANSFER) all run through audited service entry points.

Permission split: `ar:write` (post), `ar:adjust` (credits/refunds), `ar:void` (void/reverse), `ar:statements:issue`, `ar:notes:write`. `FINANCE_ADMIN` cannot void; `CONTROLLER` can — and tests prove it.

### Collections (2D, continued)

[`collections.ts`](src/lib/services/collections.ts) ships:

- **Editable per-club notice templates** with `{{firstName}}`, `{{currentBalance}}` substitution. Seeded defaults: Friendly Reminder, Over-30/60/90/120, Card Declined, PAP Failed, Suspension Warning, Final Notice.
- **Configurable collection stages** (`STAGE_30 / STAGE_60 / STAGE_90 / STAGE_120 / STAGE_FINAL`) with trigger thresholds, default template, and auto-suspend flags.
- Notice lifecycle (DRAFT → SENT → RESOLVED) and access actions (SUSPEND_CHARGE / SUSPEND_TEE / FULL_SUSPEND / RESTORE) — each writes a `CollectionAction` and an audit log.
- Admin UI at `/app/admin/collections` and editable templates at `/app/admin/collections/templates`.

### Financing (2E)

[`financing.ts`](src/lib/services/financing.ts) productionizes:

- DRAFT → ACTIVE via typed signature, with **versioned `FinancingDocument`** stamped with a SHA-256 content hash and signing IP/user-agent.
- **Apply payment** uses FIFO allocation across the schedule, splitting principal/interest proportionally; rows transition SCHEDULED → PARTIAL → PAID, and the agreement auto-flips to PAID_OFF when the last installment is satisfied.
- **`payoffQuote()`** for prepayment.
- **`sweepMissedPayments()`** marks scheduled installments MISSED past the grace window and flips agreements DEFAULTED after a configurable threshold.
- Cancellation rejects on terminal agreements.

### UX polish (2F)

URL-driven `<Toast />` component picks up `?error=` / `?ok=` redirect params, shows a dismissible toast, and strips the param. `Empty` and `Skeleton` components for empty/loading states.

### Tests (2G — 54 passing)

| Suite | Coverage |
| --- | --- |
| `rbac.test.ts` | Permission matrix across 14 roles. |
| `tenant-isolation.test.ts` | Cross-tenant approve/deny/notice rejected. |
| `audit.test.ts` | Before/after snapshots, actor capture. |
| `auth.test.ts` | Login, lockout, disabled, generic-error. |
| `finance.test.ts` | Amortization invariants. |
| `applications.test.ts` | State machine; draft create/save/submit/withdraw; approve creates member + account + household + checklist. |
| `ar.test.ts` | Charge/payment posting, void, reverse, failed payments, voiding non-POSTED rejected, CREDIT adjustment, aging buckets, FIFO. |
| `collections.test.ts` | Idempotent seed, template variable rendering, notice lifecycle, access actions. |
| `statements.test.ts` | Snapshot correctness; permission gating (member vs other-member). |
| `financing.test.ts` | Draft + sign + content-hash document, FIFO allocation, payoff quote, default sweep, cancel rejection. |
| `onboarding.test.ts` | Idempotent checklist, self-completion, COMPLETED prerequisite invariant, member ACTIVE flip. |

---

## Phase 3 — Accounting core

### Architecture

Accounting lives in [src/lib/accounting/](src/lib/accounting/) — a separate folder from `services/` to keep the domain boundary visible at a glance. UI imports from this layer; routes never read or write `JournalEntry*` tables directly.

| Module | Responsibility |
| --- | --- |
| [`decimal.ts`](src/lib/accounting/decimal.ts) | Money helpers around Prisma's `Decimal`. Rejects NaN/Infinity at the boundary. |
| [`types.ts`](src/lib/accounting/types.ts) | Account types, normal balances, journal statuses, FS statements. |
| [`coa.ts`](src/lib/accounting/coa.ts) + [`coa-template.ts`](src/lib/accounting/coa-template.ts) | Chart of Accounts CRUD + default golf-club template (~50 accounts, hierarchy, FS-group mapping). |
| [`periods.ts`](src/lib/accounting/periods.ts) | Fiscal year + monthly periods. OPEN → SOFT_LOCKED → HARD_LOCKED → CLOSED. `resolvePostingPeriod` is the post-time gate. |
| [`journal.ts`](src/lib/accounting/journal.ts) | Validation + posting engine: `createDraft`, `approve`, `post`, `voidDraft`, `reverse`, `createPostedFromAdapter`. |
| [`balance.ts`](src/lib/accounting/balance.ts) | Single source of truth for balances and drilldown activity. |
| [`reports.ts`](src/lib/accounting/reports.ts) | Trial balance, balance sheet, income statement, dept P&L — all pure consumers of `balance.ts`. |
| [`events.ts`](src/lib/accounting/events.ts) | AR→GL adapter (charges, payments, adjustments) + `backfillArToGl`. |

### Financial integrity guarantees

- **Decimal arithmetic.** All GL monetary fields use Prisma `Decimal`. `toMoney()` rejects NaN/Infinity at the boundary; `0.1 + 0.2 === 0.3` round-trips.
- **Double-entry validation.** `validateEntry()` rejects unbalanced lines, header-account postings, unknown accounts, inactive accounts, and manual posting to control accounts (only the adapter override allows them).
- **Centralized posting.** The only paths to `status=POSTED` are `journal.post()` and `journal.createPostedFromAdapter()`.
- **No destructive deletes.** Drafts can be voided. Posted entries can only be **reversed** — a contra entry is created and the original remains POSTED on the books. "This was reversed" is a back-relation, never a status mutation.
- **Period locks.** OPEN (anyone) / SOFT_LOCKED (adapters only) / HARD_LOCKED + CLOSED (requires `gl:close_period` to reopen, never to post through).
- **Idempotent posting.** `post()` on an already-POSTED entry returns the existing row. Adapter writes use `(sourceEntityType, sourceEntityId)` as a natural key — replaying the backfill is a no-op.
- **Permission split.** `coa:read` / `coa:write`, `gl:read` / `gl:post` / `gl:reverse` / `gl:close_period`. `CONTROLLER` has all four GL permissions; `FINANCE_ADMIN` lacks `gl:post`; `AUDITOR_READ_ONLY` is read-only across CoA + GL.

### Reporting capabilities

Available today (data-correct, premium UI):

- **Trial Balance** — every account with non-zero activity, debit/credit columns, balanced-status banner.
- **Balance Sheet** — Assets / Liabilities / Equity from the `FinancialStatementGroup` tree, with current-year earnings computed from the FY-to-date IS, and a balance check.
- **Income Statement** — Revenue → Gross Margin → Net Income with hierarchical group rollups.
- **Income by Department** — revenue / COGS / opex / contribution per department + consolidated row.
- **GL Account Detail** — opening / period activity / closing with running-balance drilldown and date filters.

Verification on seeded demo data:

```
TB:   rows=6   dr=3,246   cr=3,246   bal=true
BS:   assets=3,246   liab=0   equity=3,246   earnings=3,246   bal=true
IS:   rev=3,246   cogs=0   opex=0   ni=3,246
Dept: 4 rows · totalRev=3,246 · totalContrib=3,246
```

### System-generated entries (AR → GL)

| AR event | DR | CR |
| --- | --- | --- |
| Charge (DUES) | 1110 Member AR (Control) | 4000 Membership Dues |
| Charge (PRO_SHOP) | 1110 | 4300 Pro Shop Revenue |
| Charge (FOOD_BEVERAGE) | 1110 | 4200 F&B Dining |
| Payment (SUCCESS) | 1010 Operating Bank | 1110 |
| Adjustment (CREDIT) | 4900 | 1110 |
| Adjustment (WRITE_OFF) | 6500 Bad Debt | 1110 |
| Adjustment (REFUND) | 1110 | 1010 |

Adapter calls are wrapped in `try/catch` inside the AR service so a misconfigured COA never blocks the operational write — failures log for ops.

### UI

- **Chart of Accounts** at `/app/admin/coa` (grouped by type, header rows highlighted, control/bank/cash/tax flags) + new-account form.
- **Fiscal Periods** at `/app/admin/periods` (status badges, per-period state transitions).
- **General Ledger** at `/app/admin/gl` (status filters).
- **Journal Detail** at `/app/admin/gl/[id]` (lines table, totals, reverse/void/approve/post actions gated by permission).
- **New Journal** at `/app/admin/gl/new` (client-side balance checker; account/department dropdowns hydrated from `/api/admin/coa/options`).
- **Account Drilldown** at `/app/admin/gl/account/[id]` (opening, activity, closing with date range).
- **Reports hub** at `/app/admin/reports` with TB / BS / IS / Dept P&L pages.

### Tests — 75 passing across 12 suites

Phase-3 suite (`tests/accounting.test.ts`, 21 tests):

- **Validation:** unbalanced, header-account, unknown-account, control-account (manual rejected; adapter allowed), bad line shape.
- **Posting:** balance recompute, idempotency, draft void, void rejected on POSTED, reverse rejected on non-POSTED.
- **Reversal:** contra entry posted with `reversesId`; original remains POSTED with `reversedBy` link; net balance returns to zero.
- **Period locks:** HARD_LOCKED rejects all posts; SOFT_LOCKED rejects manual posts but lets adapters through.
- **RBAC:** `FINANCE_ADMIN` denied `gl:post`; `AUDITOR_READ_ONLY` denied `gl:reverse`.
- **Reports:** trial balance balanced after a series; balance sheet balanced after AR adapter posts (assets = current-year earnings); IS and department P&L attribute correctly; running-balance drilldown.
- **Tenant isolation:** cross-tenant journal creation rejected.
- **Decimal helpers:** NaN/Infinity rejected; 0.1 + 0.2 == 0.3.

### Outstanding future dependencies

- **PDF / spreadsheet export** wires to the Phase 7 storage adapter.
- **Cash flow statement** is structurally wired (`isCashAccount`, `cashFlowSection`); full indirect-method automation lands in Phase 4.
- **Recurring & auto-reversing journals** — `RecurringJournal` model is in place; the scheduled runner is Phase 7.
- **Year-end close** — `CLOSED` status + retained-earnings closing entries are scaffolded; the close wizard ships in Phase 4.
- **AP→GL, payroll→GL, financing→GL adapters** — `createPostedFromAdapter()` is the canonical entry point; new adapters drop in alongside AR with one function each. Targeted in Phase 4–5.
- **Database-level append-only** for `AuditLog` and `JournalEntry*` — today enforced in code; production deployment removes `UPDATE`/`DELETE` grants from the app DB role.

### Recommended Phase 4 sequencing

1. **AP module + AP→GL adapter** — drops into the existing pattern.
2. **Year-end close wizard** — sums P&L, posts retained-earnings closing entries, transitions periods to CLOSED.
3. **Budget vs actual** — the IS report engine just needs a parallel `Budget` read in the same shape as `accountBalances`.
4. **Cash flow indirect-method automation** — using the `isCashAccount` / `cashFlowSection` tags already on the model.
5. **Saved report layouts + drag-and-drop FS-group editor** — the `FinancialStatementGroup` parent/child tree is the foundation.

---

## Phase 4 — Accounts Payable

### Architecture

AP lives in [src/lib/ap/](src/lib/ap/) — a separate folder from `accounting/` so the operational/AP boundary is visible at a glance. All posting goes through the Phase-3 `createPostedFromAdapter` entry point; AP never touches `JournalEntry*` tables directly.

| Module | Responsibility |
| --- | --- |
| [`types.ts`](src/lib/ap/types.ts) | Status enums + approval rule shape. |
| [`tax-codes.ts`](src/lib/ap/tax-codes.ts) | TaxCode model + seed (GST 5, HST 13/15, EXEMPT, ZERO_RATED) + region-fit check. |
| [`approvals.ts`](src/lib/ap/approvals.ts) | Reusable approval engine — policies, threshold-based rules, decisions, SoD guards. Used by vendors, banking, AP invoices, and payment batches. |
| [`vendors.ts`](src/lib/ap/vendors.ts) | Vendor CRUD + DRAFT → PENDING_APPROVAL → ACTIVE → INACTIVE/BLOCKED lifecycle; banking profiles; penny tests. |
| [`ocr.ts`](src/lib/ap/ocr.ts) | Mock OCR adapter — deterministic synthetic extraction from a filename so the capture flow is exercisable end-to-end. Phase 7 replaces the function body. |
| [`capture.ts`](src/lib/ap/capture.ts) | Receipt inbox: upload → OCR → coding suggestion → duplicate hint → convert-to-invoice. |
| [`invoices.ts`](src/lib/ap/invoices.ts) | AP invoice domain: header + lines with Decimal totals, full lifecycle, duplicate detection. |
| [`ap-events.ts`](src/lib/ap/ap-events.ts) | AP → GL adapter (post, reverse, vendor payment) — idempotent on `(sourceEntityType, sourceEntityId)`. |
| [`payments.ts`](src/lib/ap/payments.ts) | Direct vendor payment + `processPayment` primitive used by the batch service. |
| [`payment-batches.ts`](src/lib/ap/payment-batches.ts) | Payment batch creation, item add/remove, approval workflow, processing, "suggest invoices due". |
| [`exceptions.ts`](src/lib/ap/exceptions.ts) | Risk-flag engine: duplicate detection, banking-change watch, exceeds-normal-spend, unexpected tax, missing attachment, blocked vendor, self-approved hint. |
| [`reports.ts`](src/lib/ap/reports.ts) | AP aging by vendor (current / 30 / 60 / 90 / 120+), AP-to-GL reconciliation, dashboard stats. |

### Vendor management

- Vendor master with default expense account, department, tax code, payment terms, and method.
- Vendor lifecycle: `DRAFT → PENDING_APPROVAL → ACTIVE`, plus `INACTIVE` and `BLOCKED`. Activation is gated by an `ApprovalRequest`; blocking refuses new invoice creation immediately.
- Banking profiles are **tokenized metadata only** (`accountLastFour` + `processorToken`). Raw account numbers are never stored.
- Banking-change workflow: `addBankingProfile` → `submitBankingForApproval` → 2-approver request → `verifyBanking` (requires at least one CONFIRMED penny test; `skipPennyTest: true` only for `ap:exception:override` holders).
- Penny-test flow: `initiatePennyTest(amount)` → vendor confirms → `confirmPennyTest(confirmedAmount)` — matches within $0.01 mark it CONFIRMED, otherwise FAILED.

### Invoice capture

- Upload metadata-only (`storageKey` placeholder for the Phase-7 storage adapter).
- Mock OCR populates `extractedJson` (vendor, invoice #, dates, subtotal, tax, total, currency) and `suggestionJson` (expense account, department, tax code) with a confidence score.
- Duplicate detection at upload: matches existing AP invoice by `(vendorName, invoiceNumber)` and marks the capture `DUPLICATE` so it can't be auto-converted.
- "Convert to invoice" pre-fills the AP-invoice form via `/api/admin/ap/captures/[id]`. Once converted, the capture transitions to `CONVERTED` and links via `APInvoice.captureId`.

### AP invoice service

- Strict double-entry validation: `sum(line.amount) === subtotal`, `subtotal + sum(line.taxAmount) === total`, positive total, valid accounts (no header, no inactive, no control-account manual post), valid tax code, valid department/cost center.
- Per-line tax handling: recoverable tax DR's the recoverable account (`1310 GST ITC`); non-recoverable tax is rolled into the expense line.
- Duplicate detection on `(vendor, vendorReference)` enforced both in code and via DB unique constraint.
- Lifecycle: `DRAFT → PENDING_APPROVAL → APPROVED → POSTED → PARTIALLY_PAID → PAID` plus `VOIDED` (only via reverse on POSTED) and `DISPUTED`.

### AP → GL posting

Every adapter call uses `createPostedFromAdapter` with `allowControlAccounts: true`. Period locks apply: manual `postInvoice` respects soft locks; adapter writes pass through (consistent with the AR pattern). Both AP↔GL mappings tested:

| Event | DR | CR |
| --- | --- | --- |
| Invoice post | Expense / inventory accounts (per line) + recoverable tax (`1310`) | AP Control (`2010`) for invoice total |
| Invoice reverse | Contra of the above (uses same expense/tax breakdown, swapped DR/CR) | — |
| Vendor payment | AP Control (`2010`) | Bank account (default `1010`) |
| Void payment | Reverses the payment JE via `journal.reverse` | — |

`backfillArToGl` (Phase 3) and `postInvoiceToGl` / `postPaymentToGl` (Phase 4) follow the same idempotency contract — keyed on `(sourceEntityType, sourceEntityId)`.

### Approval workflow (reusable)

Single engine, four entity types (`AP_INVOICE`, `VENDOR`, `VENDOR_BANKING`, `PAYMENT_BATCH`). Policies are `ApprovalPolicy.rulesJson` with threshold buckets:

```jsonc
// AP invoice defaults
[
  { "maxAmount": 3000,  "requiredApprovals": 1, "eligibleRoleKeys": ["CONTROLLER", "FINANCE_ADMIN", "GENERAL_MANAGER"] },
  { "maxAmount": 15000, "requiredApprovals": 2, "eligibleRoleKeys": ["CONTROLLER", "GENERAL_MANAGER"] },
  { "maxAmount": null,  "requiredApprovals": 3, "eligibleRoleKeys": ["CONTROLLER", "GENERAL_MANAGER", "BOARD_READ_ONLY"] }
]
```

Hard guarantees:

- **Segregation of duties.** A requester can never approve their own request, regardless of permission level. Own requests are hidden from `listPendingForUser`.
- **Eligibility.** Only users holding one of the rule's `eligibleRoleKeys` can decide.
- **One decision per user.** DB-unique `(requestId, userId)` enforces it.
- **Quorum.** Status flips to `APPROVED` only when the count of `APPROVE` decisions ≥ `requiredApprovals`. A single `REJECT` resolves the request as `REJECTED`.

### Payment batches

- `createBatch(description, paymentDate, bankAccount, paymentMethod)` → `addItem` per invoice (suggested list pre-filtered by EFT banking + non-blocked vendor) → `submitBatchForApproval` → `processBatch`.
- `processBatch` iterates items, re-checks EFT eligibility at processing time, posts a `VendorPayment` per item with a per-payment GL entry, and rolls up the batch status.
- Failed items don't block the batch; they're flagged `FAILED` / `EXCLUDED` with a note.
- Overpayment is rejected at three points: per-invoice outstanding check on add, per-invoice check at payment processing, and a structural "no negative balance" invariant on the recompute.

### Exception engine

`detectInvoiceExceptions` runs after every invoice create/edit. Detected flags (LOW/MEDIUM/HIGH):

- **DUPLICATE_INVOICE_NUMBER** (LOW) when vendorReference is absent
- **DUPLICATE_AMOUNT_DATE** (MEDIUM) within ±7 days, same vendor + total
- **NEW_VENDOR** (MEDIUM) first AP invoice for the vendor
- **BANKING_RECENTLY_CHANGED** (HIGH) banking updated in last 30 days
- **EXCEEDS_NORMAL_SPEND** (MEDIUM) > 3× vendor's 6-month average
- **UNEXPECTED_TAX** (LOW) region mismatch (AB club + HST line, etc.)
- **MISSING_ATTACHMENT** (MEDIUM) total > $500 without attachment
- **BLOCKED_VENDOR** (HIGH) — but invoice creation is blocked at service level too
- **SELF_APPROVED** (LOW) hint that the approval workflow will enforce SoD

Resolution: low/medium can be resolved with a note by any AP user. HIGH severity requires `ap:exception:override`.

### Reports + dashboard

- **AP aging** by vendor (current / 30 / 60 / 90 / 120+) with column totals.
- **AP-to-GL reconciliation** at `/app/admin/ap/reports/recon` — subledger total of outstanding invoices vs the `2010` GL natural balance, with a balance/out-of-balance banner.
- **AP dashboard** at `/app/admin/ap` — outstanding, awaiting approval, due-this-week, overdue, batches pending, vendors pending, capture inbox count, open exceptions, plus mini recon and aging cards.

Seeded demo data round-trips correctly:

```
TB:   rows=9   dr=4,548   cr=4,548   bal=true
AP:   1 vendor row · total=1,302
Recon: sub=1,302  gl=1,302  diff=0  bal=true
```

### Permissions

20 new keys across `vendor:*`, `ap:invoice:*`, `ap:payment:*`, `ap:capture:*`, plus `ap:exception:override` and `ap:report:view`. Role grants:

- **CONTROLLER** — full set including post, void, banking-approve, exception-override.
- **FINANCE_ADMIN** — create/edit + payment-create, but no approve/post/void.
- **CLUB_ADMIN** — full set (matches CONTROLLER for AP).
- **GENERAL_MANAGER** — vendor-approve, invoice-approve, payment-approve, banking-approve, exception-override.
- **DEPARTMENT_MANAGER** — view + invoice-approve (for low-threshold rules in future per-department policies).
- **AUDITOR_READ_ONLY** — view + reports only.

### Tests (96 passing across 13 suites)

New Phase-4 suite (`tests/ap.test.ts`, 21 tests) covers:

- **Vendor lifecycle** — tenant safety, audit on activate, banking change requires approval, penny-test SENT/CONFIRMED/FAILED.
- **Invoice validation** — header-account rejection, zero-invoice rejection, duplicate `(vendor, vendorReference)` rejection.
- **Authorization** — FINANCE_ADMIN cannot post; BLOCKED vendor blocks creation; cross-tenant create rejected.
- **Period locks** — HARD_LOCKED period blocks posting.
- **GL posting** — balanced JE on post; AP control = total; recoverable tax to 1310; expense to line account; reversal nets to zero.
- **Aging + reconciliation** — buckets correct; subledger matches GL.
- **Payments** — partial payment updates balance, full payment marks PAID, overpayment rejected, EFT requires verified banking.
- **Payment batches** — blocked vendor excluded, no-banking EFT excluded, self-approval blocked, FINANCE_ADMIN approves low-threshold batch, processing creates payments + balanced JEs, recon ties.
- **Void payment** — reverses GL, restores invoice balance, recon ties.
- **Capture** — mock OCR populates extraction + suggestion; status NEEDS_REVIEW.
- **Exceptions** — EXCEEDS_NORMAL_SPEND detected; override requires permission.

### Outstanding production considerations

- **Real OCR adapter** (Dext, Veryfi, Textract) wires in Phase 7 by replacing the body of `mockOcrExtract` only.
- **Storage adapter** for invoice/vendor attachments — `storageKey` field is already on every relevant model.
- **Banking adapter** for EFT / penny-test execution. Today the penny-test is a workflow record; Phase 7 hooks it to a real ACH/EFT processor.
- **AP-to-GL recon scheduled job** — production should run `reconcileApToGl()` nightly and alert on `isBalanced=false`.
- **AppendOnly enforcement** for `AuditLog`, `JournalEntry*`, and `APInvoice` (posted-after-state) at the DB role level.
- **Multi-currency** — `currency` field is on `APInvoice` and `PaymentBatch` but FX-aware posting is Phase 5+.

### Recommended Phase 5 sequencing

1. **Year-end close wizard** — sum P&L, post retained-earnings closing JEs, transition all periods of the FY to CLOSED.
2. **Inventory & Pro Shop** — inventory items + PO + receiving + matching to AP. AP-line `isInventory` flag is already in place to mark inventory accruals when received-not-invoiced.
3. **Capital assets** — `isCapital` on AP lines auto-creates an asset register entry. Depreciation engine becomes its own monthly adapter.
4. **Payroll + timekeeping** — `payroll:read/write` permission slots exist; the payroll → GL adapter follows the AP pattern.
5. **Budgeting & forecasting** — parallel `Budget` table read in the same shape as `accountBalances`, with department-level allocation.

---

## Phase 5 — Operational core

Phase 5 layers the day-to-day operational business modules on top of the accounting + AP foundation. Every operational action that has a financial consequence emits a balanced journal entry through the same `createPostedFromAdapter` posting engine used by AR and AP, so the GL remains the single source of truth.

### Architecture

- `src/lib/ops/inventory.ts` — items, locations, categories, receiving (DR Inventory / CR 2050 GRNI), adjustments (signed; DR or CR Inventory ↔ adjustment expense), sales (DR COGS / CR Inventory), counts, transfers. Weighted-average cost is the source of truth and is recomputed on every cost-affecting transaction.
- `src/lib/ops/private-events.ts` — inquiry → booking → deposit → final billing. Deposits sit in liability 2230 (Private Event Deposits) until the final bill recognizes revenue and (optionally) charges a member's AR.
- `src/lib/ops/lessons.ts` — booking, instructor confirmation, Head Pro approval, accrued instructor payable. **`LessonPayable` is created only at Head Pro approval** — the only path that emits the member-side AR JE (DR 1110 / CR 4400) and the accrual JE (DR instructor expense / CR 2060). This is the "honour system" guard.
- `src/lib/ops/payroll.ts` — employees, pay periods (`createPeriod` / `lockPeriod`), timesheets (`ensureTimesheet` / `addTimesheetEntry` / `submitTimesheet` / `approveTimesheet`), runs (`buildRun` from approved timesheets only, then `postRun`). Posting maps department codes to wage expense accounts (6000/6100/6200/6300/6400) on the DR side and credits 2030 (Accrued Payroll) and 2040 (Accrued Source Deductions). Tax calculation is a **configurable placeholder** (a flat 22% withholding constant) — production deployments must wire a jurisdiction-specific payroll-provider adapter; the codebase deliberately does not claim payroll compliance.
- `src/lib/ops/assets.ts` — register (auto asset number FA-NNNNN), monthly depreciation (straight-line + declining-balance), disposal. `runDepreciation` is **idempotent on (asset, periodLabel)** via a Prisma `@@unique`. Depreciation caps at remaining NBV − residual and flips an asset to `FULLY_DEPRECIATED` automatically. Disposal posts DR Cash + DR Accumulated Depr / CR Asset cost, routing the gain/loss to 4900 or 6500.
- `src/lib/ops/budgets.ts` — `Budget` per `FiscalYear` with versions; `BudgetLine` per (account, department) with 12 monthly amounts stored as JSON. `budgetVsActual` compares against `accountBalances()` for the same fiscal-year window, pro-rating budget by month-elapsed.

### AP → operational integration

Two flags on `APInvoiceLine` route the debit side of an AP invoice to the right operational account:

- `isInventory: true` → the line's DR posts to **2050 (Goods Received Not Invoiced)** instead of the expense account, clearing the GRNI balance previously credited by the inventory-receiving JE. This is the three-way match between PO/receiving/invoice.
- `isCapital: true` → the line's DR posts to the chosen asset account (e.g., 1540 Equipment & Vehicles) and a `CapitalAsset` register entry is linked back via `sourceApInvoiceId`.

### Chart of Accounts additions

| Account | Name                                | Purpose                                           |
| ------- | ----------------------------------- | ------------------------------------------------- |
| 2030    | Accrued Payroll                     | Net pay owed to employees between run and pay date |
| 2035    | Accrued Vacation                    | Accrued vacation liability                         |
| 2040    | Accrued Source Deductions           | Tax/CPP/EI withheld, owed to government            |
| 2050    | Goods Received Not Invoiced (GRNI)  | Control account — inventory receipts pending AP    |
| 2060    | Accrued Lesson Payable              | Instructor pay accrued, settled later via AP       |
| 2230    | Private Event Deposits              | Deferred-revenue liability for booked events       |

### Permissions

New keys (with role grants in `src/lib/permissions.ts`):

- Inventory: `inventory:view/adjust/receive/count/transfer`
- Events: `events:private:read/manage`
- Lessons: `lessons:view/manage/approve` (Head Pro approval gate)
- Payroll: `payroll:employees:manage`, `payroll:timesheets:read/approve`, `payroll:run`, `payroll:approve`
- Assets: `assets:read/manage/depreciate/dispose`
- Budgets: `budget:read/edit/approve`

### UI

Operational hub at `/app/admin/ops` with sub-pages for each module:

- `/app/admin/ops/inventory` — item list with inline quick-receive and quick-adjust forms
- `/app/admin/ops/private-events` — inquiries + bookings with confirm/deposit/bill actions
- `/app/admin/ops/lessons` — bookings with instructor-confirm / head-pro-approve, accrued payables list
- `/app/admin/ops/payroll` — employees, pay periods (lock/build), runs (post to GL)
- `/app/admin/ops/assets` — assets with dispose action, depreciation runner, recent depreciation entries
- `/app/admin/ops/budgets` and `/app/admin/ops/budgets/[id]` — budget list, variance table, 12-month line editor

### Tests — 112 passing across 14 suites

`tests/ops.test.ts` adds 16 tests covering:

- Inventory receiving posts balanced DR Inventory / CR 2050; weighted-average cost recompute; adjustments; tenant isolation.
- Private event deposit posts balanced DR 1010 / CR 2230.
- `LessonPayable` is created only at Head Pro approval, not at instructor confirm; permission gate enforced.
- Payroll period locking; run posting credits both 2030 and 2040.
- Asset depreciation math (straight-line + declining-balance); idempotency on (asset, period); disposal posts a balanced JE.
- Budget approval/activation lifecycle (one ACTIVE per FY); variance against posted GL; `budget:edit` permission gate.

Run with `npm test`.

### Out of scope for Phase 5

These items are explicitly deferred and not built in this phase: full POS (transactional cash-register UI), full tee-sheet booking engine, mobile native app, hardware/IoT integrations (POS terminals, time clocks), AI-driven commentary, automated bank-feed reconciliation, and production OCR/ML for capture. The AP capture inbox remains a manual-upload + manual-extraction surface with the adapter shape ready for a Phase 6+ ML hook.

### Production caveats

- **Payroll tax computation is a placeholder.** The current 22% flat withholding constant is not a jurisdictional tax calculation. Wire a real payroll-provider adapter (Wagepoint, ADP, Gusto, etc.) before processing real pay runs.
- **POS / inventory sales linkage is open.** `inventory.postSale()` exists as the integration seam, but the AR layer currently does not link Charge line-items to inventory items. A Phase 6 POS module will close this.

---

## Phase 6 — Enterprise reporting, governance, communications, documents, KPIs

Phase 6 lifts Spectre from operational software into an executive operating platform: a centralized reporting engine, board / finance-committee package generator, auditor portal, notification engine, unified document store, KPI dashboards, governance workflows, cross-module insights, global search, and an audited settings layer.

### Architecture

All new code lives under [`src/lib/enterprise/`](src/lib/enterprise/) with a shared barrel at [`src/lib/enterprise/index.ts`](src/lib/enterprise/index.ts).

- **`reports.ts`** — `ReportDefinition` → `SavedReport` → `ReportRun` → `ReportExport`. Renderers (`REPORT_RENDERERS`) dispatch by `definition.key`; `runReport` is permission-gated and writes an immutable result snapshot.
- **`exports.ts`** — Export pipeline with pluggable `ExportAdapter` per format. CSV is real; XLSX / PDF / PPTX are placeholders that emit a marker so the audit chain (`ReportExport`) is end-to-end testable; replace adapters with `pdfkit`/`exceljs`/`pptxgenjs` for production.
- **`packages.ts`** — Reporting packages with sections (frozen `ReportRun` snapshots), management commentary, distribution, and approval. **Self-approval is blocked** at the service layer.
- **`auditor.ts`** — Time-limited, audited, read-only access for external auditors. Token-based invite acceptance; `AuditorSession` for activity logging; PBC request workflow with item-level fulfilment.
- **`notifications.ts`** — Templates + preferences + queue + delivery + append-only `CommunicationLog`. `NotificationDeliveryAdapter` is the seam (default is a logging adapter; wire SES / Twilio / FCM at startup).
- **`documents.ts`** — Unified `Document` store with `DocumentFolder`, `DocumentTag`, `DocumentVersion`, `DocumentAccess` (signed-URL tokens), `DocumentRetentionPolicy`, and `DocumentAuditLog`. Pluggable `StorageAdapter`; default is in-memory.
- **`kpi.ts`** — `KPI` + `KPIValue` (monthly buckets, idempotent on `(kpiId, periodLabel)`) + `KPIDashboard` + `KPIWidget` + `KPIThreshold` + `KPIAlert`. 9 default KPIs and 4 default dashboards (GM, Controller, Board, Membership).
- **`workflow.ts`** — Generic multi-step workflow engine: `Workflow` → `WorkflowStep` (APPROVAL / ASSIGNMENT / NOTIFICATION / TASK) → `WorkflowApproval` / `WorkflowComment` / `WorkflowHistory`. **Self-approval is blocked.** Step role gates honor `approverRoleKey`.
- **`insights.ts`** — Rule engine with six baked-in rules: aged member balance + declining spend, vendor invoice trend anomaly, labour overrun, inventory shrinkage spike, repeated member payment failures, financing default watch. AI integration is intentionally an adapter seam, not wired.
- **`search.ts`** — `SearchIndexEntry` table for permission-aware global search across members, vendors, invoices, journal entries, packages, assets, employees, and documents.
- **`settings.ts`** — Keyed/typed `ClubSetting` store with curated defaults across BILLING, APPROVAL_THRESHOLDS, DOCUMENTS, NOTIFICATIONS, GOVERNANCE.

### Schema additions

28 new Prisma models in [`prisma/schema.prisma`](prisma/schema.prisma). All Phase 6 models are club-scoped and integrated into the existing Audit / RBAC / Tenant safety architecture; no destructive deletes for governance records (use status transitions, archival, or `isSoftDeleted`).

### Permission additions (Phase 6)

`reports:read/write/export`, `packages:read/write/approve/distribute`, `auditor:invite/revoke/respond`, `notifications:read/write/send`, `documents:read/write/delete`, `kpi:read/write`, `workflow:read/write/approve`, `insights:read/write`, `settings:read/write`, `search:read`.

The two existing read-only roles `AUDITOR_READ_ONLY` and `BOARD_READ_ONLY` were extended with appropriate Phase 6 grants — boards get reports / packages / KPI / documents / search; auditors get reports / documents / search / `auditor:respond`.

### UI additions

- [`/app/admin/governance`](src/app/app/admin/governance/page.tsx) — hub
- [`/app/admin/governance/packages`](src/app/app/admin/governance/packages/page.tsx) + `[id]` — board package builder
- [`/app/admin/governance/auditor`](src/app/app/admin/governance/auditor/page.tsx) — auditor invitations + PBC requests
- [`/app/admin/governance/workflows`](src/app/app/admin/governance/workflows/page.tsx) — active + recent governance workflows
- [`/app/admin/dashboards`](src/app/app/admin/dashboards/page.tsx) + `[key]` — KPI dashboards with sparkline trends
- [`/app/admin/insights`](src/app/app/admin/insights/page.tsx) — cross-module insights with acknowledge / resolve
- [`/app/admin/documents`](src/app/app/admin/documents/page.tsx) — searchable document library
- [`/app/admin/notifications`](src/app/app/admin/notifications/page.tsx) — inbox + template list + communication log
- [`/app/admin/search`](src/app/app/admin/search/page.tsx) — global permission-aware search
- [`/app/admin/settings`](src/app/app/admin/settings/page.tsx) — extended with operational `ClubSetting` panel

### Tests — 130 passing across 15 suites

`tests/phase6.test.ts` adds 18 tests covering:

- Reporting: builtin idempotency, saved-report flow, frozen ReportRun snapshots.
- Exports: CSV body, audit row, permission gate.
- Packages: REPORT-section snapshots; self-approval blocked; distribution requires APPROVED.
- Auditor: invite → accept → session → revoke lifecycle; expired invites rejected.
- Notifications: SENT/QUEUED/READ delivery state; preference opt-out suppression with retained intent.
- Documents: v1 → v2 versioning, soft-delete / restore, audit log entries (UPLOAD/VIEW/DOWNLOAD/DELETE), tag + folder filtering.
- KPIs: compute persists values + breach raises alerts; default GM/Controller dashboards seeded.
- Workflow: two-step approval advances; self-approval blocked; role gate enforced.
- Insights: rules raise + are deduped on re-run within a week.
- Search: index + permission-aware filtering (BOARD_READ_ONLY without `members:read` cannot see MEMBER hits).
- Settings: set/get round-trip + permission gate.
- Tenant isolation: cross-club document and package reads rejected.

Run with `npm test`.

### Adapter seams (production wiring points)

- **`NotificationDeliveryAdapter`** in [`src/lib/enterprise/notifications.ts`](src/lib/enterprise/notifications.ts) — wire SES / SendGrid / Postmark / Twilio at startup with `setDeliveryAdapter(...)`.
- **`StorageAdapter`** in [`src/lib/enterprise/documents.ts`](src/lib/enterprise/documents.ts) — wire S3 / GCS / Azure Blob via `setStorageAdapter(...)`.
- **`ExportAdapter`** in [`src/lib/enterprise/exports.ts`](src/lib/enterprise/exports.ts) — replace `pdfAdapter`, `xlsxAdapter`, `pptxAdapter` with real renderers.
- **AI commentary** in [`src/lib/enterprise/insights.ts`](src/lib/enterprise/insights.ts) — the rule registry returns `InsightCandidate` with a free-form `body`; a future LLM adapter can enrich `body` and `title` without schema changes.

### Out of scope for Phase 6

These items are explicitly deferred: native mobile apps, full AI / LLM integration (only seams are present), hardware integrations (POS terminals, time clocks, door locks), live GPS / course mapping, full tee-sheet engine, real-time IoT systems, and production OCR / ML training pipelines.

### Recommended Phase 7 sequencing

1. **Production export renderers** — swap CSV/PDF/PPTX adapters for real implementations (`pdfkit`, `exceljs`, `pptxgenjs`).
2. **Email & SMS delivery** — wire SES (or Postmark) and Twilio behind the existing `NotificationDeliveryAdapter`.
3. **S3 / Azure Blob storage** — wire production storage behind `StorageAdapter`; migrate scattered attachment tables (MemberDocument, JournalAttachment, APInvoiceAttachment, etc.) into the unified `Document` table with backfill jobs.
4. **POS module** — the Phase 5 `inventory.postSale()` hook closes the loop with the AR Charge layer.
5. **AI commentary** — wire a model (Claude/OpenAI) to enrich `Insight.body` and `ReportingPackageCommentary` drafts; route through `InsightRule.parametersJson` for tunable thresholds.
6. **Mobile apps + tee-sheet engine** — once the operating + governance core is stable, the membership-facing surfaces become viable.

---

## Phase 7 — Integration-ready SaaS

Phase 7 turns the Phase 6 architecture from "executive operating platform" into "integration-ready SaaS". Every adapter seam introduced in Phase 6 is now matched by a production adapter selected per-club from an audited `IntegrationSetting` row; the bundled dev/mock adapters remain the safe fallback so Spectre runs end-to-end without any external account.

### Architecture

| Layer | Real adapter | Dev / fallback | Selected by |
|---|---|---|---|
| Export PDF | `pdfkit` ([renderPDF](src/lib/integrations/exports.ts)) | placeholder | exportReportRun() |
| Export XLSX | `exceljs` ([renderXLSX](src/lib/integrations/exports.ts)) | placeholder | exportReportRun() |
| Export PPTX | `pptxgenjs` ([renderPPTX](src/lib/integrations/exports.ts)) | placeholder | exportReportRun() |
| Email | `@aws-sdk/client-ses` (dynamic import) | console-logging dev adapter | `selectEmailAdapter(clubId)` |
| SMS | `twilio` (dynamic import) | console-logging dev adapter | `selectSmsAdapter(clubId)` |
| Storage | `@aws-sdk/client-s3` or local FS | in-memory | `selectStorageAdapter(clubId, fallback)` |
| LLM | `@anthropic-ai/sdk` / `openai` (dynamic import) | deterministic mock | `selectLLMProvider(clubId)` |

Cloud SDKs are **optional npm dependencies**. They load through [optional-import.ts](src/lib/integrations/optional-import.ts) — `npm install` doesn't pull them, and clubs that don't configure SES/Twilio/S3/OpenAI/Anthropic never need them installed.

### New domain (~14 models)

- POS: `POSLocation`, `POSTerminal`, `POSSession`, `POSSale`, `POSSaleLine`, `POSPayment`, `POSTaxLine`, `POSDiscount`, `POSIntegrationProvider`
- Integrations: `IntegrationSetting`, `IntegrationCheck`
- Backfill: `DocumentBackfillBatch`
- AI: `LLMCommentaryDraft` (linked from `ReportingPackageCommentary` via `aiDraftId`)
- `ReportExport` extended with `status` (QUEUED/PROCESSING/COMPLETED/FAILED), `startedAt`, `finishedAt`, `errorMessage`

### POS module

[src/lib/pos/index.ts](src/lib/pos/index.ts) provides three transactional operations:

- **`createSale`** — DRAFT sale with lines, taxes, discounts, payments. Idempotent on `(providerId, externalReference)` — duplicate webhooks return the existing sale rather than creating a new row.
- **`completeSale`** — Finalizes:
  - For each INVENTORY-kind line: calls [inventory.postSale](src/lib/ops/inventory.ts) which deducts quantity and posts `DR COGS / CR Inventory`.
  - Revenue side: if `chargeMode = MEMBER_ACCOUNT`, posts `DR Member AR (1110) / CR Revenue` and creates an AR `Charge` via the existing AR service (`recomputeAccount`). Otherwise posts `DR Cash (1010) / CR Revenue`.
  - Tax: `CR 2110 (GST Collected)`. Gratuities: `CR 2030 (Accrued Payroll/Tips)`.
- **`refundSale`** — Creates a contra `POSSale` with `refundOfSaleId`, returns inventory (kind=RETURN transactions), posts a reversing JE, and creates a negative-amount `Charge` to reverse member AR.

### Document backfill

[backfill.ts](src/lib/enterprise/backfill.ts) walks the 7 scattered attachment tables (`MemberDocument`, `JournalAttachment`, `APInvoiceAttachment`, `ApplicationDocument`, `FinancingDocument`, `VendorDocument`, `ReceiptCapture`) and creates unified `Document` rows. Idempotency: each migrated row carries `searchText = "backfill:<table>:<id>"`, so reruns detect existing migrations and skip. Dry-run mode reports candidate counts without writing.

### LLM commentary

[llm-commentary.ts](src/lib/enterprise/llm-commentary.ts) generates draft commentary for governance packages, insights, variances, and collections. Hard safety constraints:

- Drafts are **always** stored as `PENDING → READY` and never auto-finalize.
- An AI commentary becomes a `ReportingPackageCommentary` only when a human calls `acceptDraftAsCommentary`, and it's tagged `isAIDraft=true` for downstream UI.
- Provider-agnostic: `LLMProvider` is the seam; `mockLLMProvider` is the default. Real Anthropic / OpenAI loaders are dynamic imports.
- Tenant safety: prompts are rendered with already-aggregated data; raw PII (SIN, PANs) is redacted upstream in `audit.ts`.

### Integration UI

- [/app/admin/integrations](src/app/app/admin/integrations/page.tsx) — Configure providers per scope, test-connection button (executes a no-op send/round-trip), check history.
- [/app/admin/ops/pos](src/app/app/admin/ops/pos/page.tsx) — POS location + quick-sale UI that exercises the full create→complete→refund flow.

### Permissions reused

POS uses existing `inventory:read/write` (admin/controller/pro-shop-manager roles). LLM commentary reuses `packages:write` / `packages:read`. Integration settings use `settings:read/write`.

### Tests — 149 passing across 16 suites

`tests/phase7.test.ts` adds 19 tests covering:

- PDF / XLSX / PPTX export produce real magic-byte-correct files + link a Document.
- Export FAILED state is recorded on render error (`errorMessage` populated, status `FAILED`).
- Email adapter selection + secret masking.
- Notification preference opt-out yields FAILED delivery for the suppressed channel.
- Storage round-trip + signed-URL access tokens.
- Document backfill dry-run preview vs. real run; idempotent on rerun.
- POS sale: inventory deduction, COGS JE balance, AR Charge created.
- POS duplicate prevention via `(provider, externalReference)`.
- POS refund: inventory restored, AR offset, contra JE balanced.
- POS permission gate (STAFF rejected).
- LLM mock provider produces a READY draft + audit entry; `acceptDraftAsCommentary` requires human action.
- Integration health: `recordIntegrationCheck` surfaces in `integrationStatusSummary`.
- Tenant isolation: cross-club POS sales rejected.

Run with `npm test`.

### Production caveats

- **Secrets storage.** The `IntegrationSetting.secretsJson` column is convenience for local / staging. For production, fetch secrets from a platform secret store (AWS Secrets Manager, GCP Secret Manager, Doppler, 1Password Connect) and feed them through the `secrets` field at runtime — not at write time.
- **POS webhooks.** Schema includes `POSIntegrationProvider.webhookSecret` and `POS_WEBHOOK_SIGNING_SECRET` env var; webhook signature verification is a placeholder that must be wired before exposing public POS webhook endpoints.
- **Background jobs.** Exports and notifications still run inline. Wire a queue (BullMQ, AWS SQS, Cloud Tasks) for high-volume tenants — the `ReportExport.status` lifecycle is already QUEUED-aware.
- **Rate limiting.** Public endpoints (POS webhooks, signed-URL downloads) need a layer-7 limiter before going public.
- **AI commentary is mock-only out of the box.** Configure an integration row for `LLM · anthropic` or `LLM · openai` to enable real generation — Spectre never auto-finalizes AI output.

### Outstanding enterprise-readiness considerations

1. **Secret rotation tooling** — the `IntegrationSetting` row has `lastTestedAt`/`lastTestStatus` but no rotation schedule. A future job could rotate AWS access keys and re-test.
2. **Per-tenant migration of legacy attachments.** Backfill is idempotent; an admin must trigger it per club. A background runner could automate this on first-touch.
3. **POS provider adapters.** Square / Lightspeed / Clover adapters are scaffolded by the `POSIntegrationProvider` table but not implemented (the in-app POS UI uses the internal provider).
4. **Observability.** `IntegrationCheck` captures health but doesn't expose Prometheus / OTel metrics yet.

### Recommended Phase 8 sequencing

1. **Background job runner + queue** — extract export/notification dispatch into BullMQ workers. `ReportExport.status = QUEUED` is already the seam.
2. **POS integration adapters** — Square + Lightspeed adapters that consume webhooks and emit POS sales via the existing service.
3. **Tee-sheet engine** — first member-facing operating module, integrated with the lesson booking flow.
4. **Mobile apps** — read-only first (statements, account balance, dashboards), then write paths.
5. **Hardware/IoT integrations** — door access, beverage-cart requests, locker unlocks; gated by an auth+audit gateway.
6. **AI commentary in production** — once a vendor is selected, finalize prompt templates per scope and add per-tenant token-budget tracking on `LLMCommentaryDraft`.

---

## Phase 8 — Production deployment readiness

Phase 8 makes Spectre **queue-driven**, **integration-scalable**, **observable**, **horizontally scalable**, and **deployment-ready** for pilot-club onboarding. Phase 7 sat behind a "single Node process" assumption; Phase 8 separates web and worker tiers, introduces a real queue, and hardens every public surface.

### Queue architecture

[`src/lib/queue/index.ts`](src/lib/queue/index.ts) ships an in-memory + BullMQ dual adapter. Every queued unit of work is a `BackgroundJob` row — durable audit trail independent of the runtime adapter. Jobs use **stable `idempotencyKey`s** so duplicate enqueues are no-ops, and **exponential backoff** on failure: 2ⁿ seconds per attempt until `maxAttempts`, then `DEAD_LETTER`. Handlers are registered by `kind` (EXPORT / NOTIFICATION / LLM_COMMENTARY / DOCUMENT_BACKFILL / POS_WEBHOOK / INVENTORY_SYNC / TEE_SHEET_SYNC / SCHEDULED_REPORT / SCHEDULED_NOTIFICATION).

Worker entrypoint: [`bin/worker.ts`](bin/worker.ts). Run as `tsx bin/worker.ts` for in-process draining (dev/tests) or `REDIS_URL=redis://… tsx bin/worker.ts` for distributed BullMQ workers. Web tier exposes admin UI at `/app/admin/queues` showing depth, retries, dead letters, and a one-click `Snapshot health` button that writes a `QueueHealth` row.

### POS integration summary

Production POS webhook receiver at `/api/integrations/pos/[provider]/webhook?clubId=…`. Each provider has an adapter implementing `verifySignature` + `parse` + `importSale`:

- **Square** — HMAC-SHA256 over `url + rawBody` using the per-provider webhookSecret.
- **Lightspeed** — HMAC-SHA256 over rawBody (hex signature).
- **Clover** — placeholder; rejects with an explicit error.

Security layers stacked on the public webhook surface:

- **Signature verification** with `timingSafeEqual` to avoid timing oracles
- **Replay prevention** via `WebhookReplay` unique on `(scope, nonce)`
- **Idempotent processing** — `POSWebhookEvent` unique on `(clubId, providerKey, externalEventId)`; duplicate deliveries return `DUPLICATE`
- **Rate limiting** via the token-bucket limiter (`webhook_pos` profile)
- **Async dispatch** — verified events enqueue a `POS_WEBHOOK` job whose idempotencyKey matches the external event ID, so the downstream sale-import is also duplicate-safe

### Tee-sheet engine summary

[`src/lib/teesheet/index.ts`](src/lib/teesheet/index.ts) ships the foundational golf-ops module:

- `Course` + `CourseHole` for course config
- `TeeSheet` per (course, date) with booking-window enforcement
- `TeeTime` generation in configurable intervals + starting tees
- `TeeTimeBooking` with primary member + additional players + guests, respecting `maxPlayers`, `TEE_SHEET.max_guests_per_booking` setting, and member privilege suspension (`accessStatus`)
- `TeeLottery` + `TeeLotteryEntry` with `RANDOM` or `PRIORITY_TENURE` strategy; `drawLottery()` atomically converts lottery winners into confirmed bookings
- `PaceOfPlayRecord`, `CartAssignment` scaffolds for future operational features
- Self-approval and tenant-isolation guards reused from Phase 7

### Mobile / PWA summary

[`public/manifest.json`](public/manifest.json) + [`public/sw.js`](public/sw.js) + [`public/offline.html`](public/offline.html) make Spectre installable. The service worker:

- **Network-first** for HTML routes (fall back to offline page)
- **Cache-first** for `/_next/static/` and `/icons/`
- **Never** caches `/api/*` (live data only)
- Push-notification handler wired (no-op without VAPID — Phase 9)

The root layout registers `/sw.js` on the `load` event and ships proper viewport / theme-color metadata.

### Hardware / IoT architecture summary

[`src/lib/hardware/index.ts`](src/lib/hardware/index.ts) provides a device registry, an `HardwareAdapter` interface, and a public ingestion endpoint at `/api/hardware/events`. Devices register with a raw auth token (stored only as a sha256 hash); ingestion verifies the hash, then writes a `DeviceEvent` and (for `HEARTBEAT`) a `DeviceStatus` snapshot. Supported kinds: `GPS_BAG_TAG`, `DOOR_ACCESS`, `LOCKER`, `BEVERAGE_CART_RADIO`, `DRIVING_RANGE_CAMERA`, `PARKING_GATE`, `GEOFENCE`.

### Observability summary

[`src/lib/observability/logger.ts`](src/lib/observability/logger.ts) emits one-line JSON logs (cloudwatch / Datadog / Honeycomb friendly). An `AsyncLocalStorage`-backed correlation context propagates a `correlationId` through queue handlers and HTTP requests. Secret keys (`password`, `apiKey`, `accessKeyId`, `processorToken`, `ssn`, etc.) are auto-redacted before serialization. The `/api/health` endpoint runs DB + queue checks and returns `200 / 503 / 200-warn` JSON suitable for k8s readiness probes.

### Secrets management summary

[`src/lib/secrets/index.ts`](src/lib/secrets/index.ts) resolves secrets in three tiers:

1. **Environment variable** — naming convention `SPECTRE_<SCOPE>_<PROVIDER>_<KEYNAME>` (+ `__<CLUBSLUG>` per-club override)
2. **`SecretsProvider` adapter** — AWS Secrets Manager is bundled; GCP / Doppler can plug in via the same interface
3. **DB fallback** — only in dev/staging or when `SPECTRE_ALLOW_DB_SECRETS=1` is set explicitly. Production refuses DB-stored secrets by default.

### Security hardening summary

- **Rate limiting** via [`src/lib/security/rate-limit.ts`](src/lib/security/rate-limit.ts) — token-bucket with in-memory and DB-persisted adapters. Profiles: `login`, `password_reset`, `public_application`, `webhook_pos`, `download`, `export`.
- **Webhook replay protection** via the `WebhookReplay` table
- **Signed-URL expiry** already enforced on `DocumentAccess.expiresAt` (Phase 7)
- **Auth-token hashing** for hardware devices — never stored in plain text
- **CSP-friendly script registration** in the root layout (single `next/script` block)

### Deployment readiness summary

- [`Dockerfile`](Dockerfile) — multi-stage Node 20 alpine production image with healthcheck targeting `/api/health` and a non-root user
- [`Dockerfile.worker`](Dockerfile.worker) — worker image that runs `tsx bin/worker.ts`
- [`docker-compose.yml`](docker-compose.yml) — local Postgres + Redis + web + worker stack
- [`.dockerignore`](.dockerignore) — keeps build context small

### Pilot-club readiness summary

- [`src/lib/flags/index.ts`](src/lib/flags/index.ts) — `FeatureFlag` per club (or global), with **deterministic hash-based gradual rollout** (the same club always sees the same answer for a given key, regardless of cluster instance)
- [`/app/admin/pilot`](src/app/app/admin/pilot/page.tsx) — flag manager + super-admin club roster + latest queue-health snapshots
- [`/app/admin/queues`](src/app/app/admin/queues/page.tsx) — queue depth, in-flight, failed-1h, dead-letter; per-job requeue / cancel
- [`/app/admin/devices`](src/app/app/admin/devices/page.tsx) — hardware registry with auth-token management

### Tests — 165 passing across 17 suites

[`tests/phase8.test.ts`](tests/phase8.test.ts) adds 16 tests covering:

- Queue idempotency on `idempotencyKey` + retry → DEAD_LETTER cycle + requeue/cancel + `processPending` honoring `scheduledFor` + queue-health snapshots
- Square webhook signature verification (valid → QUEUED, invalid → FAILED + `POSImportError`) + duplicate delivery → `DUPLICATE`
- Tee-sheet generation slot count + max-player + suspended-privilege rejection + lottery enter + draw assignment
- Feature flag club-override + 0%/100% rollout
- Hardware device registration + auth-token-verified event ingestion (good token accepted, bad token rejected)
- Rate-limit bucket caps at capacity + retry-after returned
- Secrets resolution prefers env over DB
- Tenant isolation: club A admin can't draw club B's lottery

### Final production readiness assessment

**Ready for pilot-club onboarding** with the following operational checklist:

1. Set `REDIS_URL` and run at least one `Dockerfile.worker` container so async work doesn't stay inline.
2. Switch `IntegrationSetting.secretsJson` to env vars or AWS Secrets Manager (set `SPECTRE_ALLOW_DB_SECRETS=0` in production).
3. Set `TRUST_PROXY=true` behind a load balancer / CDN so `request-context` resolves the right IP.
4. Configure POS provider rows with real `webhookSecret` values pulled from the secrets store.
5. Wire a real notification provider (SES or Postmark) and storage adapter (S3) via `IntegrationSetting` rows or env vars.
6. Run `prisma migrate deploy` in production (don't use `db push`).
7. Configure the `/api/health` endpoint as the readiness probe target.

### Outstanding production considerations

- **Observability backend** — logger emits JSON but no metrics exporter (OpenTelemetry / Prometheus) wired yet.
- **Brute-force protection** — login/password endpoints respect the rate limiter, but the limiter itself isn't yet wired into the auth routes. (Pulled into Phase 9.)
- **CSP / security headers** — the layout is CSP-friendly but a Next.js middleware that emits `content-security-policy` / `strict-transport-security` / `x-frame-options` is a Phase 9 item.
- **VAPID push notifications** — PWA service worker has the handler, but no key generation or subscription registry yet.
- **Pace-of-play + cart-assignment** are schema-only stubs.

### Recommended Phase 9 sequencing

1. **Real observability** — wire OpenTelemetry (traces) + Prometheus (metrics) + Sentry (errors) behind a single ObservabilityAdapter.
2. **CSP/HSTS middleware + brute-force enforcement on auth routes**.
3. **Push notifications** — VAPID key issuance + `WebPushSubscription` table + a notification adapter that pushes to the browser.
4. **POS production adapters** — finish Lightspeed mapping logic; ship Clover.
5. **Tournament management** — built on the tee-sheet foundation; ladder + matchplay scoring.
6. **Mobile native app** — wraps the PWA in a thin Capacitor / Expo shell for App Store / Play Store distribution.
7. **OpenAPI / external API** — generate a typed OpenAPI spec from the service layer for partner integrations.

---

## Phase 9 — Production hardening for pilot exposure

Phase 9 closes the production hardening gaps left over from Phase 8 and ships the next high-value operating modules. The platform now has real observability, security middleware, brute-force lockout, browser push, Lightspeed + Clover POS importers, tournament management, an external API, and a pilot readiness validation system.

### Observability summary

[src/lib/observability/adapter.ts](src/lib/observability/adapter.ts) — single `ObservabilityAdapter` interface with three adapters: default (logger + DB rollups), OpenTelemetry (dynamic-import), Sentry (dynamic-import). `startSpan`/`incrCounter`/`recordError`/`exportMetrics` cover traces, metrics, errors, and Prometheus exposition. `trace()` helper wraps async work with a span; correlation IDs flow through the Phase 8 AsyncLocalStorage so HTTP → queue → worker share the same ID. New `/api/metrics` endpoint emits a Prometheus 0.0.4 text format for scrape, rate-limited to discourage abuse.

### Security hardening summary

[src/middleware.ts](src/middleware.ts) now emits a strict CSP (per-request nonce + dev-only `unsafe-eval`), HSTS in production, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `X-Frame-Options: DENY`, and `X-Correlation-Id`. Trusted domains for scripts/connect-src are a single-source array — extend it once for CDNs / payment / analytics. The middleware forwards both `x-nonce` and `x-correlation-id` to server components.

### Auth rate limit + lockout summary

[src/lib/security/auth-guard.ts](src/lib/security/auth-guard.ts) wraps the existing `login()` service:

- **Per-IP and per-email** token-bucket rate limit (using the Phase 8 limiter)
- **Persistent AuthAttempt** rows record outcome (`SUCCESS` / `INVALID_PASSWORD` / `UNKNOWN_USER` / `LOCKED` / `RATE_LIMITED`); email is stored only as sha256 hash
- **Cross-session AccountLock** — 5 failures in 15min → 15-minute lock; 10 → 1-hour lock. Manual unlock by admin via [/app/admin/security](src/app/app/admin/security/page.tsx)
- **SuspiciousActivityEvent** raised on brute-force detection
- **Generic error message** for `UNKNOWN_USER` and `INVALID_PASSWORD` avoids account enumeration

### Push notification summary

[src/lib/push/index.ts](src/lib/push/index.ts) — `PushAdapter` interface, `devPushAdapter` (default), `webPushAdapter` (dynamic-imports the `web-push` package + VAPID keys from the secrets manager). Endpoints: `POST /api/push/subscribe` for browser registration, `DELETE` to unsubscribe. Queue-driven delivery via the Phase 8 `NOTIFICATION` queue (`payload.kind = "PUSH"` distinguishes from email/SMS). Failed deliveries with 404/410 auto-deactivate the subscription. Preference opt-out via the existing `NotificationPreference` table suppresses sends.

### POS provider completion summary

- **Lightspeed**: real `importSale` mapping with POSMapping lookups for LOCATION / MEMBER / ITEM (falls back to OTHER kind for unmapped items)
- **Clover**: HMAC-SHA256-base64 signature verification + envelope parsing (`merchants.{id}[{objectId, type, ts}]`); creates POSSale stubs for CREATE/UPDATE events
- **Reconciliation reports** ([src/lib/pos/reconciliation.ts](src/lib/pos/reconciliation.ts)): `posVsGl`, `posVsAr`, `posVsInventory`, `listUnmappedExternalIds` — surface gaps between POS sales, posted JEs, member AR charges, and inventory transactions

### Tournament management summary

[src/lib/tournament/index.ts](src/lib/tournament/index.ts) — strokes, match play, scrambles, stableford + ladder placeholders. Registration with entry fees creates an AR `Charge` via the existing AR service; cancellation reverses via `reverseCharge`. Score entry is idempotent on `(roundId, registrationId, holeNumber)` and updates the leaderboard atomically. Match play winners advance into the next bracket slot via `bracketSlot / 2` math. Admin UI at [/app/admin/ops/tournaments](src/app/app/admin/ops/tournaments/page.tsx).

### Mobile native shell summary

[mobile/capacitor.config.json](mobile/capacitor.config.json) + [mobile/README.md](mobile/README.md) scaffold a Capacitor wrapper around the PWA. **Strategic decision**: the mobile app is the PWA — Capacitor is a thin shell, not a rewrite. The README documents push notification compatibility, deep links, file downloads, authentication, and offline behavior. Phase 10 will produce real binaries.

### OpenAPI / external API summary

[src/lib/api/keys.ts](src/lib/api/keys.ts) — `ApiKey` model with sha256-hashed storage; raw key returned only at creation. `authenticate()` resolves keys by prefix → hash, supports IP allowlists, expiry, and scoped permissions. [src/lib/api/handler.ts](src/lib/api/handler.ts) wraps Next.js route handlers with auth + permission gate + rate limit + request logging (`ApiRequestLog`). First v1 routes: `/api/v1/members`, `/api/v1/inventory/items`. OpenAPI 3.0.3 spec generated at runtime at `/api/openapi.json` from [src/lib/api/openapi.ts](src/lib/api/openapi.ts). Admin UI at [/app/admin/api-keys](src/app/app/admin/api-keys/page.tsx) issues + revokes keys with a one-time raw-key flash on creation.

### Pilot readiness summary

[src/lib/pilot/index.ts](src/lib/pilot/index.ts) — runtime probes (Redis, worker activity, TRUST_PROXY, health, secrets-allowlist in production, rate-limiter, email provider, storage provider, migrations, initial users) combined with manual checklist items (staff training, backup plan, go-live date, data migration). Status: PENDING / IN_PROGRESS / COMPLETE / NOT_APPLICABLE. `enforceProductionSafety()` refuses to start in production if `SPECTRE_ALLOW_DB_SECRETS=1`. Dashboard at [/app/admin/pilot/readiness](src/app/app/admin/pilot/readiness/page.tsx).

### Test/build summary

- **184/184 tests passing across 18 suites** (Phase 9 adds 19 tests)
- **TypeScript: clean** (`tsc --noEmit`)
- **Production build: clean** (`npm run build`)
- **Seed: clean** (`npm run db:reset` reports: `Phase 9 demo: readiness probes run, 1 tournament scaffolded.`)

### Remaining production risks

- **VAPID keys** — push works in dev via the no-op adapter; production needs real VAPID key issuance + secrets-manager wiring before push goes live.
- **OpenAPI spec is hand-curated** — adding a new public route requires editing both the route handler and `openapi.ts`. A code-gen pass from a typed registry is a Phase 10 item.
- **Tournament tee-time assignment** — `TournamentRegistration` doesn't yet auto-create `TeeTimeBooking` rows. Phase 10 should close this loop.
- **External API only has 2 routes wired** — members + inventory. Vendors / events / charges / tee-times / reports are spec'd but unimplemented.
- **Webhook subscription delivery** (`WebhookSubscription` + `WebhookDelivery`) is schema-only; outbound webhooks to API consumers are not yet dispatched.
- **Brute-force lock UI** doesn't yet surface the underlying `User` records — admins see hashed emails only. Cross-referencing with `User.email` requires a deliberate decision about privacy.

### Recommended Phase 10 sequencing

1. **VAPID key management UI + real push delivery** — close the last gap between subscribe-flow and production push.
2. **Native mobile binaries** — finish the Capacitor build pipeline, push notifications via APNs/FCM, App Store / Play Store submission.
3. **Outbound webhook delivery** — wire `WebhookSubscription` to a `WEBHOOK_DELIVERY` queue handler with signed payloads + retry.
4. **External API expansion** — vendors, events, charges, tee-times, reports endpoints; OpenAPI code generation.
5. **Tournament ↔ tee-sheet integration** — pairing + tee-time assignment + leaderboard publishing.
6. **Member-facing tournament UI** — registration, leaderboard, score entry on the PWA.
7. **OpenTelemetry exporter wiring** — push spans to a backend (Honeycomb / Lightstep / Datadog).

---

## Phase 10 — Commercial SaaS readiness

Phase 10 transforms Spectre from a pilot-ready platform into a commercially deployable enterprise golf-club ecosystem. The platform now ships real push infrastructure, signed outbound webhooks, an expanded external API, tournament/tee-sheet integration, a member-facing tournament UX, an OTLP-ready observability adapter, SaaS entitlements, enterprise operational tooling, and production resilience surfaces.

### Push infrastructure summary

[src/lib/push/vapid.ts](src/lib/push/vapid.ts) — VAPID key generation through the optional `web-push` package with a dev fallback. Keys are stored in `IntegrationSetting` (scope=PUSH, provider=vapid). Every send now writes a `PushDeliveryAttempt` row with status / providerMessageId / durationMs — feeds the push delivery monitor and analytics. `PushCampaign` model scaffolds batch sends for Phase 11. Expired endpoints (404/410) auto-deactivate the subscription.

### Webhook delivery summary

[src/lib/webhooks/index.ts](src/lib/webhooks/index.ts) — outbound delivery flows through a dedicated `WEBHOOK_DELIVERY` queue (new Phase 10 `JobKind`). HMAC-SHA256 signs `${timestamp}.${body}` with the per-subscription secret; headers include `x-spectre-event`, `x-spectre-delivery-id`, `x-spectre-timestamp`, `x-spectre-signature`. 410/404 responses auto-disable subscriptions; non-2xx triggers exponential-backoff retry. Sensitive keys (`passwordHash`, `apiKey`, `processorToken`, etc.) are redacted from payloads before persistence. Admin UI at [/app/admin/webhooks](src/app/app/admin/webhooks/page.tsx) shows subscriptions + delivery history with manual replay.

### External API expansion summary

5 new v1 routes:
- [/api/v1/vendors](src/app/api/v1/vendors/route.ts) — gated by `vendor:view`
- [/api/v1/events](src/app/api/v1/events/route.ts) — `events:read`
- [/api/v1/charges](src/app/api/v1/charges/route.ts) — `ar:read`, filterable by `memberId` + `since`
- [/api/v1/tee-times](src/app/api/v1/tee-times/route.ts) — `lessons:view`
- [/api/v1/tournaments](src/app/api/v1/tournaments/route.ts) — `lessons:view`

OpenAPI 3.0.3 spec at `/api/openapi.json` updated with all 7 resource paths and schemas.

### Tournament ↔ tee-sheet integration summary

[src/lib/tournament/pairings.ts](src/lib/tournament/pairings.ts) — `buildPairings()` orders registrations by strategy (`RANDOM` / `HANDICAP_BANDED` / `REGISTRATION_ORDER`), chunks into groups of N, and books a tee time per group. The transaction creates `TeeTimeBooking` + `TeeTimePlayer` rows directly so booking validation runs unchanged. `publishLeaderboard()` emits a `tournament.score_submitted` webhook event so external integrations mirror the standings.

### Mobile production readiness summary

Phase 9's [mobile/](mobile/) scaffold stands; Phase 10 adds the deeper deployment notes in [mobile/README.md](mobile/README.md). PWA remains first-class; Capacitor wraps the same routes; deep links resolve to existing PWA paths; iron-session cookies persist across iOS/Android WebView the same way; push handler in `/sw.js` is compatible with APNs/FCM via Capacitor's `PushNotifications` plugin. **Native binaries are out of scope for this phase — they're a real build pipeline (Xcode/Android Studio + signing + App Store Connect/Play Console) and ship in Phase 11.**

### OpenTelemetry summary

[src/lib/observability/adapter.ts](src/lib/observability/adapter.ts) — `otelAdapter` now actually instruments. When `@opentelemetry/api` + `@opentelemetry/sdk-trace-node` + `@opentelemetry/exporter-trace-otlp-http` + `@opentelemetry/resources` are installed, the adapter creates a real `NodeTracerProvider` + OTLP HTTP exporter. `trace()` wraps async work; correlation IDs propagate from HTTP middleware → queue → worker.

### SaaS readiness summary

[src/lib/entitlements/index.ts](src/lib/entitlements/index.ts) — `SubscriptionPlan` catalog (PILOT / STARTER / PROFESSIONAL / ENTERPRISE / UNLIMITED) with `featuresJson` arrays. `ClubSubscription` rows track per-club plan + status (PILOT / ACTIVE / TRIAL / PAUSED / CANCELLED). `requireEntitlement(clubId, feature)` is the single feature-gate; PILOT clubs default open, PAUSED clubs are denied. `UsageMetric` records API calls, push deliveries, exports, webhooks per club per month. Super-admin UI at [/app/admin/saas](src/app/app/admin/saas/page.tsx) lists all clubs, assigns plans, suspends/reactivates.

### Operational tooling summary

[src/lib/ops/replay.ts](src/lib/ops/replay.ts) — `replayFailedJob`, `replayWebhookDelivery`, `regenerateExport`, `pauseQueue`/`resumeQueue` (SUPER_ADMIN only), `operationalDiagnostics`. Operations dashboard at [/app/admin/ops/system](src/app/app/admin/ops/system/page.tsx) shows queue depth / in-flight / dead-letter / recent failures, plus a SUPER_ADMIN queue pause/resume control and an inline DR runbook.

### Final production readiness assessment

Spectre is **commercially deployable** for pilot golf-club rollouts with the following operational checklist:

1. Configure `REDIS_URL` and run at least one worker container.
2. Move `IntegrationSetting.secretsJson` to env vars or AWS Secrets Manager.
3. Configure POS provider `webhookSecret` values from the secrets store.
4. Wire real notification (SES/Postmark), storage (S3), VAPID, and (optional) LLM providers.
5. Set up an OTLP collector (Honeycomb / Datadog / Lightstep / Grafana Tempo).
6. Run `prisma migrate deploy` against production Postgres.
7. Configure `/api/health` as the readiness probe target.
8. Assign each pilot club to a `SubscriptionPlan` via [/app/admin/saas](src/app/app/admin/saas/page.tsx).

### Tests — 204 passing across 19 suites

[tests/phase10.test.ts](tests/phase10.test.ts) adds 20 tests covering VAPID, push attempts, webhook signing/redaction/disable-on-410, OpenAPI expansion, pairings, leaderboard webhooks, entitlement gating (PILOT / STARTER / PAUSED), usage metering, operational replay, queue pause/resume, and traced async work.

### Remaining production risks

- **Webhook secrets stored cleartext** in `WebhookSubscription.secret` so we can sign outbound payloads. Rotation tooling lives in Phase 11.
- **`POSMapping` admin UI** is read-only — pair-building / unmapped-item resolution UI not yet built.
- **OpenAPI spec is hand-curated**; a typed-route registry that generates the spec automatically is queued for Phase 11.
- **OTLP exporter** loads only when SDK packages are installed; the dev fallback is logger-only.
- **Native mobile binaries** are not yet shipped — the Capacitor config is production-ready but Xcode/Android Studio builds + App Store / Play Store submission live in Phase 11.

### Recommended Phase 11 sequencing

1. **App Store / Play Store submission** — finish iOS + Android binaries, signing, store assets.
2. **Webhook secret rotation** — rotate-while-active flow + old-secret grace window.
3. **POSMapping admin UI** — visual mapping editor for unmapped POS items / locations / tax codes.
4. **OpenAPI typed registry** — code-generate the spec from route file metadata; eliminate hand-curation drift.
5. **Tournament scoring on the PWA** — member-side hole-by-hole entry with offline queue.
6. **Stripe / payment gateway integration** — convert `BillingCycle` placeholders into real invoices + automatic billing.
7. **MFA + SSO** (Auth0 / Okta / Google Workspace SAML) for staff accounts.

---

## Phase 11 — Launch-ready enterprise SaaS

Phase 11 transforms Spectre from a commercially deployable pilot platform into a launch-ready enterprise SaaS. Real webhook secret rotation, a POS mapping admin UI, a typed OpenAPI registry, full member-facing tournament scoring, Stripe-backed SaaS billing, TOTP/SSO for staff, and production hard-block launch gates.

### Mobile binary readiness summary

[mobile/capacitor.config.json](mobile/capacitor.config.json) + [mobile/README.md](mobile/README.md) — production-ready Capacitor scaffold with environment-switching, deep-link configuration, APNs/FCM push compatibility notes, App Store / Play Store submission checklists, signing/certificate guidance, and a complete versioning + offline-scoring strategy. **Native binary builds happen in your local Xcode / Android Studio environment** — store assets, certificates, and signing material are deliberately kept out of the repo.

### Webhook secret rotation summary

[src/lib/webhooks/rotation.ts](src/lib/webhooks/rotation.ts) — `WebhookSecretVersion` table with `ACTIVE` / `PENDING` / `EXPIRED` / `REVOKED` state machine. `rotate()` creates a `PENDING` version; `activate()` swaps ACTIVE and sets a configurable grace window (default 7 days) on the previous version; `rollback()` revokes the pending rotation; `expirePrevious()` ends the grace window. Outbound delivery in [webhooks/index.ts](src/lib/webhooks/index.ts) now signs with `activeSecretFor()`. Every transition writes a `WebhookSecretRotation` audit row. Admin UI at [/app/admin/webhooks/[id]/rotation](src/app/app/admin/webhooks/[id]/rotation/page.tsx).

### POSMapping UI summary

[src/lib/pos/mapping.ts](src/lib/pos/mapping.ts) — `POSMapping` CRUD with `POSMappingHistory` audit trail, bulk-create helper, unmapped-error queue (`unmappedQueue`), and idempotent reprocessing of failed imports. Admin UI at [/app/admin/pos-mapping](src/app/app/admin/pos-mapping/page.tsx) shows current mappings + failed-import queue with one-click reprocess.

### OpenAPI registry summary

[src/lib/api/registry.ts](src/lib/api/registry.ts) — central typed route registry with `RegisteredRoute` metadata (path, method, permission scope, version, status, response schema, examples). [src/lib/api/openapi.ts](src/lib/api/openapi.ts) generates the OpenAPI 3.0.3 spec from the registry — adding a new route to the registry surfaces it in `/api/openapi.json` without touching the spec generator. `validateRegistryCompleteness()` is the test-time guard that catches missing schemas.

### Tournament scoring summary

[src/lib/tournament/scoring.ts](src/lib/tournament/scoring.ts) — `TournamentScoreDraft` per `(round, registration)` with `DRAFT` / `SUBMITTED` / `ACCEPTED` lifecycle. Members hit `saveDraft()` repeatedly with partial scores (offline-friendly: the PWA caches locally). `submitDraft()` moves to admin review; `acceptDraft()` fans into individual `TournamentScore` rows and atomically updates the leaderboard. `correctScore()` writes an auditable `TournamentScoreCorrection`. Member PWA page at [/app/member/tournaments/[id]/score/[roundId]](src/app/app/member/tournaments/[id]/score/[roundId]/page.tsx) — mobile-first hole-by-hole entry with large touch targets.

### SaaS billing summary

[src/lib/billing/index.ts](src/lib/billing/index.ts) — `BillingProvider` interface with `mockBillingProvider` (default) and `stripeBillingProvider` (dynamic-import `stripe`). Provider-agnostic schema: `BillingCustomer`, `BillingSubscription`, `BillingInvoice`, `BillingPaymentAttempt`, `BillingWebhookEvent`. Webhook handler at [/api/integrations/billing/webhook](src/app/api/integrations/billing/webhook/route.ts) verifies signatures, deduplicates by event ID, and propagates subscription status changes into `ClubSubscription` (which gates Phase 10 entitlements). Failed payments automatically pause the club. Admin UI at [/app/admin/billing](src/app/app/admin/billing/page.tsx).

### MFA / SSO summary

[src/lib/mfa/index.ts](src/lib/mfa/index.ts) — self-contained TOTP (RFC 6238, SHA-1, ±1 window). `startEnrollment()` returns a base32 secret + `otpauth://` URI; `completeEnrollment()` verifies the first code, marks the factor `ACTIVE`, and issues 8 single-use recovery codes (sha256-hashed at rest). `verifyMfa()` accepts either a TOTP code or a recovery code; recovery codes consume on first use. `isMfaRequiredForUser()` enforces MFA for SUPER_ADMIN / CLUB_ADMIN / CONTROLLER / FINANCE_ADMIN. Admin reset path via `disableMfa()`. Trusted-device support via `rememberDevice()` (sha256 token hash, configurable TTL).

[src/lib/sso/index.ts](src/lib/sso/index.ts) — `SsoProvider` model with `OIDC` and `SAML` kinds. `upsertProvider()` configures per-club identity providers; `findOrProvisionUser()` accepts a verified SSO assertion, applies the email-domain restriction, and just-in-time provisions new users with the provider's `defaultRoleKey`. All login attempts (SUCCESS / DENIED / ERROR) are recorded in `SsoLoginAttempt`. The actual `openid-client` / `@node-saml/node-saml` exchange remains optional-import.

Admin UI at [/app/admin/mfa](src/app/app/admin/mfa/page.tsx) — TOTP enrollment for the current user with one-time recovery code display.

### Launch readiness summary

[src/lib/launch/index.ts](src/lib/launch/index.ts) — 10 launch checks across INFRA / SECURITY / BILLING / INTEGRATIONS / MOBILE. Each check has a severity: `HARD_BLOCK` (fails production startup) or `WARNING`. `enforceProductionLaunchSafety()` is the startup gate that throws if any HARD_BLOCK fails:

- DB-stored secrets disabled in production
- `SPECTRE_SESSION_SECRET` ≥ 32 chars
- Database reachable
- Billing webhook secret configured when `SPECTRE_BILLING_PROVIDER=stripe`

Warnings (don't block startup but surface in the dashboard): `TRUST_PROXY` for LB, `REDIS_URL` configured, production email provider, production storage provider, VAPID keys for push, mobile native config documented.

`multiClubReadiness()` gives SUPER_ADMIN a per-club rollup. Admin UI at [/app/admin/launch](src/app/app/admin/launch/page.tsx).

### Test/build summary

- **229/229 tests passing across 20 suites** (Phase 11 adds 25 tests)
- **TypeScript: clean** (`tsc --noEmit`)
- **Production build: clean** (`npm run build`)
- **Seed: clean** (`npm run db:reset` runs end-to-end)

### Remaining launch risks

- **Webhook signing secret cleartext** still required for outbound HMAC signing. The new rotation flow + grace window minimize exposure; full at-rest encryption requires KMS integration (Phase 12).
- **SSO providers ship with scaffolded `openid-client` / `@node-saml/node-saml` callouts** — real production exchange (token validation, JWT signature checking, group claim mapping) is dynamic-import optional and needs operator configuration.
- **Stripe webhook handling does not yet drive `BillingPaymentAttempt`** rows for every payment intent — only invoice-level events. Phase 12 should close this loop.
- **Tournament scoring offline queue** uses `localStorage` on the client; conflict resolution on reconnect (admin already accepted a different version) lives in Phase 12.
- **Mobile binaries** are not in the repo — your CI/CD pipeline produces them locally.

### Recommended Phase 12 sequencing

1. **KMS-backed webhook secret encryption at rest** (AWS KMS / GCP KMS / Azure Key Vault).
2. **SSO production integration** — wire real `openid-client` exchange + group claim → role mapping + IdP-initiated SAML flow.
3. **Tournament scoring offline conflict resolution** — last-write-wins server-side + client-side reconciliation UI.
4. **Customer-facing billing portal** — Stripe Customer Portal embed for plan changes / invoice downloads / payment method updates.
5. **Sub-second push delivery analytics** — wire OTLP traces all the way to delivery + render a real-time push delivery dashboard.
6. **Marketplace ecosystem foundations** — third-party app catalog + scoped OAuth grants (deferred from Phase 11 scope).
7. **Compliance & SOC 2 preparation** — auditor-ready evidence collection from existing AuditLog, AuthAttempt, AccountLock, and BillingWebhookEvent surfaces.

---

## Phase 12 — Enterprise scale, compliance, and ecosystem

Phase 12 adds the enterprise-readiness layer: real envelope-encrypted secrets, production OIDC role mapping, tournament conflict resolution, member billing portal, push analytics, third-party marketplace foundations, SOC 2 access-review tooling, and a platform-resilience layer (circuit breakers + retry budgets).

### KMS envelope encryption (12A)

[src/lib/kms/index.ts](src/lib/kms/index.ts) — provider interface (`KmsProvider`) with `localKmsProvider` (AES-256-GCM, key derived from `SPECTRE_LOCAL_KMS_KEY`), `awsKmsProvider` (dynamic-import `@aws-sdk/client-kms`), and a GCP placeholder. Ciphertext format `enc:<provider>:<keyId>:<base64>` so a single column can hold both legacy plaintext and encrypted blobs — `isEncryptedBlob()` decides. Every encrypt/decrypt is recorded in `SecretAccessLog`; `EncryptedSecretMetadata` tracks the per-secret provider/key fingerprint; `recordKeyRotation()` writes `KeyRotationEvent`.

Webhook secret rotation ([rotation.ts](src/lib/webhooks/rotation.ts)) now stores the rotated secret encrypted; `activeSecretFor()` transparently decrypts at signing time. Cleartext rows from before Phase 12 keep working.

Admin UI at [/app/admin/security/kms](src/app/app/admin/security/kms/page.tsx) — active provider fingerprint, encrypted-secret inventory, recent access log, key-rotation events, and a "local KMS in production" alarm via `isInsecureKmsModeInProduction()`.

### Production SSO OIDC (12B)

[src/lib/sso/oidc.ts](src/lib/sso/oidc.ts) — `exchangeAuthCode()` dynamically imports `openid-client` for the real code-flow + userinfo handshake, with a deterministic dev fallback (base64-JSON code) so the role-mapping path is testable without a live IdP. `mapRoleFromClaims()` walks the provider's group/role mapping JSON (stored in the existing `SsoProvider.certificate` column) and maps to a Spectre `RoleKey`. CSRF state helpers `generateState()` / `verifyState()` use `timingSafeEqual`.

### Tournament conflict resolution (12C)

[src/lib/tournament/conflict.ts](src/lib/tournament/conflict.ts) — optimistic-concurrency `saveDraftVersioned()` accepts an `expectedVersion`; a mismatch creates a `TournamentScoreConflict` row instead of overwriting. `resolveConflict()` lets an admin choose `KEPT_SERVER`, `KEPT_CLIENT`, `MERGED`, or `DISMISSED`. All transitions audited.

### Customer billing portal (12D)

[src/lib/portal/billing.ts](src/lib/portal/billing.ts) — self-service surface for members: overview (balances, last statement, recent activity), statements, payment-method list / make-primary / remove (soft-delete only), and `openDispute()`. Cross-member access is refused at the principal layer. UI at [/app/member/billing](src/app/app/member/billing/page.tsx).

### Push analytics (12E)

[src/lib/push/analytics/index.ts](src/lib/push/analytics/index.ts) — `summarize(window)` rolls `PushDeliveryAttempt` over 1h/24h/7d/30d windows and returns total/sent/failed/expired, latency p50/p95/p99, free-text failure bucketing, and per-campaign breakdown. Emits Prometheus counters via the observability adapter. `subscriptionHealth()` returns active/total/recently-failed counts. UI at [/app/admin/notifications/analytics](src/app/app/admin/notifications/analytics/page.tsx).

### Marketplace foundations (12F)

[src/lib/marketplace/index.ts](src/lib/marketplace/index.ts) — `registerApp()` (SUPER_ADMIN only) issues a public `clientId` and a sha256-hashed `clientSecret` shown exactly once. `installApp()` / `uninstallApp()` is tenant-scoped with scope validation against the publisher's `defaultScopes`. `authorize()` mints an in-process auth code (sha256-hashed) tied to the install; `exchangeCode()` verifies client credentials and issues a Bearer access token (and refresh token) — both stored as sha256 hashes only. `resolveAccessToken()` is the gate for inbound API calls. `subscribeAppWebhook()` returns the raw signing secret once. Admin UI at [/app/admin/marketplace](src/app/app/admin/marketplace/page.tsx).

### Compliance + access reviews (12G)

[src/lib/compliance/index.ts](src/lib/compliance/index.ts) — `startReview(scope)` snapshots current users / role grants / API keys / installed apps / SSO providers into `AccessReviewItem` rows. `decideReviewItem()` records `APPROVED` or `REVOKED` — segregation of duties is enforced: the reviewer cannot decide on items in a review they started themselves. `completeReview()` requires zero pending items. `generateEvidence()` produces point-in-time row-count snapshots of `AuditLog` / `AuthAttempt` / `AccessReview` / `WebhookDelivery` for the requested window. `requestPolicyAck()` / `acknowledgePolicy()` track policy acknowledgement state per user. Admin UI at [/app/admin/compliance](src/app/app/admin/compliance/page.tsx) + [/app/admin/compliance/[id]](src/app/app/admin/compliance/[id]/page.tsx).

### Platform resilience (12I)

[src/lib/resilience/index.ts](src/lib/resilience/index.ts) — circuit breaker (`CLOSED` / `OPEN` / `HALF_OPEN`) persisted in `CircuitBreakerState` so multiple workers share the same view. `withBreaker({ resourceKey, call })` short-circuits with `CircuitOpenError` while open, probes once after the cooldown, and resets only after the configured number of trial successes. `withRetryBudget()` bounds concurrent retries per resource key to prevent retry storms. Admin override at [/app/admin/ops/resilience](src/app/app/admin/ops/resilience/page.tsx) — list, force-open, and force-close any breaker.

### Test/build summary

- **255/255 tests passing** (Phase 12 adds 26 tests — KMS round-trip, OIDC role mapping, tournament conflicts, push analytics, marketplace install + OAuth, compliance reviews, circuit breaker)
- **TypeScript: clean** (`tsc --noEmit`)
- **Production build: clean** (`npm run build`)
- **Seed: clean** (`npm run db:reset` end-to-end)

### Recommended Phase 13 sequencing

1. **Production GCP / Azure KMS adapters** — finish the providers behind the existing `KmsProvider` interface; add scheduled key-rotation jobs.
2. **Marketplace UX** — public app listing, app submission/review queue, developer portal with key issuance and webhook test events.
3. **Automated access reviews** — quarterly cron that auto-creates reviews for `USERS` / `API_KEYS` / `INSTALLED_APPS` scopes and pages an owner if pending items exceed SLA.
4. **Compliance evidence export** — wire `generateEvidence()` to the documents service so packaged exports are downloadable.
5. **Live circuit breaker integration** — wrap POS, billing, and push adapters in `withBreaker()` so downstream outages don't cascade.
6. **Tournament conflict UX** — surface unresolved conflicts in the scoring page and let admins choose a side from a side-by-side diff view.
7. **Customer portal Stripe-Portal handoff** — embed the actual Stripe Customer Portal session for self-serve plan changes / invoice downloads.

---

## Phase 13 — Pilot readiness

Phase 13 prepares Spectre for its first real pilot golf club. Focus is on onboarding, migration, operator workflows, and real-world usability — not new product modules.

### Pilot onboarding wizard (13A)

[src/lib/pilot-onboarding/index.ts](src/lib/pilot-onboarding/index.ts) — `createProject()` seeds a 15-step plan (club profile → branding → fiscal → tax → membership categories → COA → departments → opening balances → member import → vendor import → staff → flags → integrations → billing → readiness) plus 5 signoff slots (FINANCE, OPS, MEMBERSHIP, SECURITY, EXECUTIVE). `saveStep()` persists per-step `dataJson` for resume. `readinessSummary()` returns the hard-block list; `approveGoLive()` refuses if any required step / HIGH-CRITICAL blocker / unsigned category remains. Admin UI at [/app/admin/pilot/onboarding](src/app/app/admin/pilot/onboarding/page.tsx).

### Data migration tooling (13B)

[src/lib/imports/index.ts](src/lib/imports/index.ts) — `ImportBatch` / `ImportRow` / `ImportError` model with a strict three-phase flow: `createBatch` → `validateBatch` (dry-run, populates per-row validity + duplicate detection within the batch) → `commitBatch` (refuses by default if any rows are invalid; `allowPartial: true` opts in). Eight domains: MEMBERS, VENDORS, COA, OPENING_TRIAL_BALANCE, INVENTORY, EMPLOYEES, EVENTS, AR_HISTORY. `rollbackBatch()` soft-deletes imported members/vendors/inventory; financial rows are never destroyed. Admin UI at [/app/admin/imports](src/app/app/admin/imports/page.tsx).

### Opening balance setup (13C)

[src/lib/opening-balance/index.ts](src/lib/opening-balance/index.ts) — `OpeningBalanceSet` is the staging table; `validateSet()` enforces debits == credits and (when supplied) reconciles AR/AP subledgers against control accounts. `postSet()` writes a single `JournalEntry` with `source="OPENING_BALANCE"` against the requested period. `lockSet()` is one-way after POST. Gated on `gl:post` so CONTROLLER drives it. Admin UI at [/app/admin/opening-balances](src/app/app/admin/opening-balances/page.tsx).

### Member portal invites (13D)

[src/lib/member-invites/index.ts](src/lib/member-invites/index.ts) — `MemberPortalInvite` with tokenHash (sha256), PENDING → SENT → OPENED → ACTIVATED state machine. `bulkCreateInvites()` issues up to 100 per batch and skips members without an email or with an already-active invite. `activateInvite()` provisions a MEMBER User + role on first activation; `buildInviteEmail()` returns a non-tech preview. Admin UI at [/app/admin/members/invites](src/app/app/admin/members/invites/page.tsx).

### Staff training mode (13E)

[src/lib/training/index.ts](src/lib/training/index.ts) — `ClubTrainingMode` is a single-row toggle with TTL. `assertNotTraining(clubId, action)` is the boundary helper for posting routes — throws `TrainingModeBlockedError` while practice mode is on. `TrainingScenario` ships 10 default role-specific scenarios (controller close, GM approve invoice, pro shop sale, etc.) auto-seeded on first enable. A red admin banner lights up across the admin UI while training mode is active. Admin UI at [/app/admin/pilot/training](src/app/app/admin/pilot/training/page.tsx).

### Safe support access (13F)

[src/lib/support-access/index.ts](src/lib/support-access/index.ts) — `SupportAccessGrant` / `SupportSession` / `SupportActionLog`. SUPER_ADMIN requests access with a written reason, the target club's admin (or SUPER_ADMIN for break-glass) approves, then `startSession()` opens a logged window. `assertAllowedAction()` is the boundary check — in READ_ONLY mode, write-shaped actions throw `SupportReadOnlyError` and record `allowed=false`. A red banner is rendered in the admin layout for any active session. Admin UI at [/app/admin/support/access](src/app/app/admin/support/access/page.tsx).

### Tournament conflict UI (13G)

[/app/admin/ops/tournaments/conflicts](src/app/app/admin/ops/tournaments/conflicts/page.tsx) — pending conflict queue with a side-by-side server-vs-client hole table; one-click keep-server / keep-client / dismiss. Members see a conflict banner on their scoring page (no client-side merge yet — staff own resolution).

### Production smoke tests (13H)

[src/lib/smoke/index.ts](src/lib/smoke/index.ts) + [scripts/smoke.ts](scripts/smoke.ts) — `npm run smoke` runs the suite (DB reachable, schema in sync, KMS round-trip, session secret strength, observability adapter, storage adapter, launch checks, tenant isolation sanity, queue health, circuit breakers) and exits 0 on PASS+WARN, 1 on any FAIL.

### Performance / indexing review (13I)

Added composite indexes on `Member` for the queries that pilot implementation teams hit most: `(clubId, status)`, `(clubId, lastName)`, `(clubId, email)`, `(clubId, membershipCategory)`. The rest of the schema was already well-indexed — Phase 13 explicitly avoids premature optimization.

### Support / incident tooling (13K)

[src/lib/incidents/index.ts](src/lib/incidents/index.ts) — `Incident` with SEV1–SEV4 + auto-timeline events on every transition, `SupportTicket` for customer-raised questions, and `KnownIssue` for cross-tenant published notices that surface as a banner in the support page. Admin UI at [/app/admin/support](src/app/app/admin/support/page.tsx).

### Go-live control center (13L)

[src/lib/go-live/index.ts](src/lib/go-live/index.ts) — `buildSnapshot(projectId)` aggregates onboarding readiness, import status, opening-balance status, member invite stats, training scenario completion, open tickets/incidents, smoke results, and launch checks into a single `GoLiveSnapshot` with a GO / CAUTION / NO_GO recommendation. Admin UI at [/app/admin/pilot/go-live/[id]](src/app/app/admin/pilot/go-live/[id]/page.tsx).

### Test/build summary

- **287 / 287 tests passing** (Phase 13 adds 32 tests across the 7 services that ship in this phase)
- **TypeScript: clean** (`tsc --noEmit`)
- **Production build: clean** (`npm run build`)
- **Smoke runner: clean** (`npm run smoke`)

### Remaining pilot risks

- **Email delivery** is still adapter-pluggable but doesn't ship a default SMTP / transactional provider; the pilot operator must configure one before the bulk-invite flow is useful.
- **Jonas import** is generic CSV-shaped; the per-source column-name dictionaries (`JonasMembers.csv`, `JonasTrialBalance.xlsx`) will need a mapping cheat sheet maintained by the implementation team.
- **Opening balance subledger import** is parameterized (callers pass `arSubledger[]` / `apSubledger[]`) but no UI exists to upload a per-member or per-vendor subledger separately. Implementation staff feed it through the API for the first pilot.
- **Training mode** blocks postings via an explicit `assertNotTraining()` call; not every service currently calls it. A follow-up pass should wire it into every posting boundary.
- **Support session banner** displays for any user with an active session — but the read-only enforcement is via `assertAllowedAction()` only, so any service that doesn't call it can still write. The full audit comes from `SupportActionLog` regardless.

### Recommended Phase 14 sequencing

1. **Wire `assertNotTraining()` / `assertAllowedAction()` into every posting / mutating service** so training mode and support-read-only are unconditional, not opt-in.
2. **Jonas-specific column mappers** — saved templates by source so implementation staff don't re-map per import.
3. **Member portal Email-bounce handling** — automatic FAILED transition when the mail adapter reports a hard bounce; retry-with-resend UX.
4. **Opening AR / AP subledger upload UIs** — full member-level and vendor-level upload tied into reconciliation.
5. **First pilot retrospective rollup** — feedback collection model + admin dashboard.
6. **Native mobile binaries for the pilot** — CI-driven Capacitor builds, signed and uploaded to TestFlight + Play Internal.
7. **Cross-club implementation playbook** — a SUPER_ADMIN dashboard that compares onboarding velocity across pilot clubs once a second one is signed.

---

## Phase 14 — Pilot launch hardening

Phase 14 closes the practical gaps that remained from Phase 13 so the first real pilot golf club can be onboarded with confidence. Focus is enforcement, not new features.

### Centralised posting guard (14A + 14B)

[src/lib/posting-guard/index.ts](src/lib/posting-guard/index.ts) — single `assertPostingAllowed(principal, clubId, action, entityType?, entityId?)` helper that composes the two Phase 13 gates: `assertNotTraining()` (per-club training mode) and `assertAllowedAction()` (per support-session read-only enforcement). Sensitive non-financial actions (secret rotation, billing edits) use the narrower `assertSensitiveActionAllowed()` companion.

Wired into every posting / sensitive boundary:
- GL: `post`, `voidDraft`, `reverse`, `createPostedFromAdapter`
- AR: `postCharge`, `voidCharge`, `reverseCharge`, `postPayment`, `voidPayment`, `postAdjustment`, `voidAdjustment`
- AP: `postInvoice`, `reverseInvoice`, `payInvoice`, `processPayment`, `voidPayment`
- POS: `completeSale`, `refundSale`, `voidSale`
- Inventory: `postReceiving`, `postAdjustment`, `postSale`
- Opening balance: `postSet`
- Imports: `commitBatch` for financial domains (COA, OPENING_TRIAL_BALANCE, AR_HISTORY)
- Webhook secrets: `rotate`, `activate`

Lessons / private events / payroll / capital assets / tournaments are covered transitively because they route through `createPostedFromAdapter` or `postCharge` / `reverseCharge`.

### Saved import templates (14C)

[src/lib/import-templates/index.ts](src/lib/import-templates/index.ts) — ten shipped templates: 8 Jonas (members, member balances, AR aging, vendors, COA, trial balance, AP vendor balances, inventory) + 2 generic (CSV members, XLSX COA). Each template has a versioned column-name mapping + required-column list + per-column transforms. `applyTemplateToBatch()` copies the mapping into an `ImportBatch.mappingJson` after validating that the uploaded CSV contains every required column. UI at [/app/admin/imports/templates](src/app/app/admin/imports/templates/page.tsx).

Tenant model: SUPER_ADMIN publishes GLOBAL templates; club admins can save CLUB-scoped customizations. Bumping a template creates a new version row so in-flight batches don't have their mapping mutated under them.

### Email bounce + suppression (14D)

[src/lib/email-delivery/index.ts](src/lib/email-delivery/index.ts) — `recordEvent()` is the provider-webhook entry point (DELIVERED / OPENED / CLICKED / HARD_BOUNCE / SOFT_BOUNCE / SPAM_COMPLAINT / UNSUBSCRIBE / DELAYED / FAILED). Hard failure kinds (HARD_BOUNCE, SPAM_COMPLAINT, UNSUBSCRIBE) automatically suppress the address. `isSuppressed()` is the boundary check called by every mail adapter and by `createInvite()` so a hard-bounced address can never be re-sent without explicit removal. `resendWithCorrectedEmail()` issues a fresh invite to a corrected address. Admin UI at [/app/admin/notifications/email-health](src/app/app/admin/notifications/email-health/page.tsx).

### Opening-balance subledger upload UI (14E)

[/app/admin/opening-balances/[id]/subledgers](src/app/app/admin/opening-balances/[id]/subledgers/page.tsx) — paste a CSV of memberNumber + balance (or vendor + balance), and the page resolves entity refs to ids, persists the subledger JSON onto the set, and re-runs reconciliation immediately. Unresolved refs surface as inline errors. The service-layer additions are `uploadSubledger()` and `subledgerSummary()` in `src/lib/opening-balance/index.ts`.

### Pilot retrospective rollup (14F)

[src/lib/retrospective/index.ts](src/lib/retrospective/index.ts) — `PilotRetrospective` (GO_LIVE_DAY / WEEK_1 / MONTH_1 / CUSTOM) with `RetrospectiveItem` (categorized friction reports) + `RetrospectiveAction` (prioritized follow-ups). Closing a retrospective refuses while any action is OPEN / IN_PROGRESS. `captureMetricSnapshot()` produces a `PilotMetricSnapshot` rollup of open tickets, resolved tickets, incidents, failed jobs, invite activation rate, import error count, recent member logins, AP/AR pace, and smoke pass/fail counts. Admin UI at [/app/admin/pilot/retrospective](src/app/app/admin/pilot/retrospective/page.tsx).

### CI-driven mobile builds (14G)

[.github/workflows/mobile-ios.yml](.github/workflows/mobile-ios.yml) and [.github/workflows/mobile-android.yml](.github/workflows/mobile-android.yml) — `workflow_dispatch`-only pipelines that build signed iOS IPA / Android AAB artifacts when implementation staff trigger them. No secrets in the repo; required GitHub secrets are documented in [mobile/BUILD.md](mobile/BUILD.md). Production environment requires GitHub environment protection (manual approver).

### Cross-club implementation playbook (14H)

[src/lib/playbook/index.ts](src/lib/playbook/index.ts) — 15-entry playbook keyed to the Phase 13A onboarding-wizard steps. `cloneIntoProject(projectId)` seeds the playbook as `PilotOnboardingTask` rows (idempotent). `exportMarkdown()` renders the playbook for the implementation team to share offline. Admin UI at [/app/admin/pilot/playbook](src/app/app/admin/pilot/playbook/page.tsx).

### Refined go-live checks (14I)

The go-live snapshot now adds four pilot-readiness checks: published-template count, email-provider configured (`HARD_BLOCK` if missing), 24h hard-bounce count (`WARNING` if > 10), and retrospective scheduling (`WARNING` if none).

### Test/build summary

- **312 / 312 tests passing** (Phase 14 adds 25 tests across all 14 sub-phases)
- **TypeScript: clean** (`tsc --noEmit`)
- **Production build: clean** (`npm run build`)
- **Smoke runner: clean** (`npm run smoke`)

### Remaining pilot risks

- **Provider webhook signatures** for SES / Postmark / SendGrid bounce events are accepted by `recordEvent()` without provider-side signature verification. Add the per-provider HMAC check in the webhook route before letting an unauthenticated source mark an address suppressed.
- **Mobile auto-publish** — both CI workflows produce artifacts but do not auto-upload to TestFlight / Play Console. That's deliberate for the first pilot; wire Fastlane + upload steps once the cadence stabilizes.
- **Retrospective metric snapshot timing** is operator-driven (cron-less). A scheduled job that captures Day-1, Week-1, Month-1 snapshots automatically would close that loop.
- **Subledger UI** is a paste-CSV control. A drag-and-drop XLSX import shares the same backend; wiring it up is mechanical.

### Recommended Phase 15 sequencing (if any)

1. **Provider-signed webhook verification** for SES / Postmark / SendGrid email bounce events (HMAC sigs).
2. **Auto-publish step** in the mobile CI workflows (Fastlane → TestFlight Internal, Play Internal).
3. **Scheduled metric-snapshot job** so retrospective metrics capture themselves at Day 1 / Week 1 / Month 1.
4. **Drag-and-drop XLSX import** for opening-balance subledgers + member roster (uses the same backend).
5. **Cross-club implementation dashboard** — SUPER_ADMIN view comparing onboarding velocity across multiple pilots once the second pilot signs.
6. **Pilot-feedback inbox** — surface RetrospectiveItem rows across all clubs to the platform team for product prioritization.

---

## License

For evaluation only. Not for production deployment without further hardening (real TLS, real secrets, MFA enforcement, payment tokenization, log shipping, backup strategy, jurisdiction-specific payroll/tax validation).
