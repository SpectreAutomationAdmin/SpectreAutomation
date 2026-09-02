# TA-1A — Tenant Administration: Identity, Organization & Responsibility Architecture

**Slice:** Phase TA-1A (architecture-only). No product behaviour changes.
**Branch:** `tenant-admin-ta1`, forked from tag `payroll-3b5b3a-founder-accepted` (`5a2cbd0`).
**Status:** Awaiting founder review. **No Prisma migrations, no deployments, no Coulee Ridge role edits.**
**Governing rule (single sentence):**
> *Titles describe people. Responsibilities route work. Permissions authorize actions. Memberships bind a person to a tenant. Keep these four distinct.*

This document is a repository-grounded audit + canonical model proposal.
Every claim is either cited to a file:line in the current tree at HEAD
`5a2cbd0`, or explicitly labelled as a proposal.

---

## 0. Reading order & scope

Read sections **1–8** for what the codebase *is* today (audit).
Read sections **9–20** for what we propose (design).
Read sections **21–25** for how we get from here to there (migration + rollout).

Nothing in this document is implemented. There is one file changed on
`tenant-admin-ta1`: this document itself.

---

## 1. Existing identity architecture

Spectre has **three distinct identity systems** and one guest-grant
surface, none of which are cleanly unified today.

| System | Cookie | Backing tables | Principal shape | Notes |
|---|---|---|---|---|
| Admin / Member User | `spectre_session` (iron-session) | `User` (`prisma/schema.prisma:594-663`) + `UserClubRole` (`:709-723`) | `Principal { id, memberships:[{clubId,roleKey}], activeClubId, memberId }` at `src/lib/rbac.ts:11-23` | Powers `/app/admin/**` AND `/app/member/**`; distinguished only by `User.role` scalar redirect at `src/app/app/admin/layout.tsx:32` |
| Employee onboarding | `spectre_hr_onboarding` (magic-link, transient) | `EmployeeOnboardingInvitation` (`prisma/schema.prisma:10706-10733`) + `EmployeeOnboardingSession` (`:10738-10762`) | Anonymous invite session at `src/lib/hr/employee-onboarding-session.ts:26` | Not a User. Redeemed → HR portal handoff. |
| Employee Portal | `spectre_employee_session` | `EmployeePortalCredential` (`prisma/schema.prisma:10900-10915`), 1:1 with `Employee` | `{ employeeId, clubId, generation, establishedAt }` at `src/lib/employee-portal-session.ts:25-36` | **Not a User.** Portal auth deliberately bypasses `User`; see `src/lib/hr/employee-portal-credential.ts:19-21`. |
| Auditor grant | Custom session | `AuditorAccessGrant` (`prisma/schema.prisma:4445-4471`) + `AuditorSession` (`:4473`) | External-auditor magic link; not a User | Read-only. |

**Load path for the admin/member Principal:**

1. `getCurrentPrincipal()` at `src/lib/services/principal.ts:9-19` reads the iron-session cookie.
2. `loadPrincipal(userId, activeClubId)` at `src/lib/rbac.ts:74-91` reads `user.clubRoles` and projects it into `memberships`. Non-`ACTIVE` users return `null`.
3. `resolveActiveClubId(...)` at `src/lib/rbac.ts:140-154` resolves the active club with priority: session → first non-global membership → for SUPER_ADMIN, first club by `createdAt asc`.

**Two Principal types coexist.** `src/lib/rbac.ts:11` (canonical,
memberships-based) vs `src/lib/tenant.ts:7` (legacy,
`Pick<User, "id"|"clubId"|"role">`). The legacy variant reads the
DEPRECATED `User.role` column and is still exported. The top-level
`src/lib/tenant.ts` file is currently orphaned by relative-import
resolution (callers import from `./tenant` under `src/lib/services`,
which resolves to `src/lib/services/tenant.ts`) but remains a
footgun for future refactors.

---

## 2. Existing tenant membership architecture

**`Club`** — `prisma/schema.prisma:22-497`. Single tenant record.
Uniqueness: `slug @unique` only. `Club.timezone` is nullable — payroll
civil-date math will silently misbehave if this is unset; the schema
comment forbids a default but the DB doesn't enforce.

**`UserClubRole`** — `prisma/schema.prisma:709-723`. The **canonical**
membership row.

```
model UserClubRole {
  id        String   @id @default(cuid())
  userId    String
  clubId    String?  // null = global (SUPER_ADMIN)
  roleKey   String
  createdAt DateTime @default(now())
  @@unique([userId, clubId, roleKey])
  @@index([userId]); @@index([clubId]); @@index([roleKey])
}
```

- Composite unique `(userId, clubId, roleKey)` allows one user to hold
  multiple roles at one club, and roles at multiple clubs.
- `clubId=null` is the SUPER_ADMIN marker (schema comment `:706-708`,
  detection in `isSuperAdmin` at `src/lib/rbac.ts:25-27`).
- Multi-club is *structurally* supported; single active club is
  *operationally* enforced by `SessionData.activeClubId`
  (`src/lib/session.ts:14`).

**Writers of `UserClubRole` today** (grep-verified):

- `src/lib/sso/index.ts:111-113` — JIT provisioning on first SSO login.
- `src/lib/member-invites/index.ts:180-198` — MEMBER role granted when
  `MemberPortalInvite` is activated (upsert-on-existing).
- `prisma/seed.ts:618-641` — seed script.

**No third writer.** There is no code path in `src/**` that creates a
`UserClubRole` for a non-MEMBER role outside SSO JIT or seed. New
admins can arrive only via SSO first-login, direct DB insert, or
seed.

**Tenant scoping helpers** — `src/lib/services/tenant.ts:18-45`:
`tenantScope`, `tenantWhere`, `assertTenantOwned`. These are the
runtime authority for tenant isolation. `SUPER_ADMIN` short-circuits
scope to `{}` at `:20-22`.

**Legacy tenancy helper** — `src/lib/tenant.ts:9-17` still exports a
`tenantWhere(user)` that branches on the deprecated `User.role ===
"SUPER_ADMIN"` scalar. Callers *should* be reaching
`src/lib/services/tenant.ts` via relative imports, but the shape drift
means a stray import of `@/lib/tenant` bypasses memberships.

---

## 3. Existing Employee ↔ User relationship

**`Employee`** — `prisma/schema.prisma:3293-3432`. Every HR profile
attribute plus:

- `userId String? @unique` (`:3317`) — optional link to a User.
- `memberId String? @unique` (`:3370`) — optional link to a Member.
- `managerEmployeeId String?` (`:3379`) — self-referential (Employee → Employee), NOT Employee → User.

**Four parallel state machines on Employee:**
`status` (ACTIVE|LEAVE|TERMINATED), `employeeLifecycle`
(PRE_HIRE|ACTIVE|LEAVE|TERMINATED|ARCHIVED), `onboardingState`
(DRAFT|INVITED|IN_PROGRESS|SUBMITTED|APPROVED|REJECTED|REVOKED), and
`payrollReadiness` (NOT_READY|READY|ACTIVE). No DB-level
cross-invariants; service-layer only.

**Cardinality allowed today:**

| Case | Allowed? | Notes |
|---|---|---|
| User without Employee | ✅ | Every admin User (CLUB_ADMIN etc.) is one; every MEMBER User created via portal invite is one. |
| Employee without User | ✅ | `createEmployee` at `src/lib/hr/employees.ts:180-220` NEVER sets `userId`. |
| Employee ↔ User linked (one-to-one, both directions) | ✅ | `Employee.userId` and `User.employee` back-relation. |
| Two Employees linked to the same User | ❌ | `Employee.userId @unique` — single row globally. Prevents a person being a "different Employee" at Club A and Club B. |
| Employee also linked to Member | ✅ | `Employee.memberId @unique`; service-layer enforces same-tenant invariant at `src/lib/hr/employees.ts:9-11`. |

**Load-bearing fact:** the `Employee.userId` FK is DB-declared but
**operationally dead**. Grep for writers that populate `userId` on an
Employee returns zero hits in `src/**` outside tests. Every reader
(`src/lib/hr/notify-hr-change.ts:126-138`) treats the link as
best-effort optional. The Employee Portal auth path
(`src/lib/employee-portal-session.ts`) deliberately runs *without* a
linked User, so the link was designed but never adopted as the
canonical bridge.

**Consequences for TA-1:**
- An admin User with no Employee has no reporting line, no
  department, no position — they cannot appear on an org chart.
- An Employee with no User cannot own a WorkIntakeItem, cannot log
  into the admin surface, cannot be reachable by the "notify
  by capability" broadcast (that helper filters `User.clubRoles`).
- The "same person" concept — an admin who is also an Employee who
  is also a Member — requires up to three rows tied by two
  optional-nullable FK links, with no DB-enforced invariant that
  they are consistent.

---

## 4. Existing roles

**Fifteen role literals**, defined at `src/lib/permissions.ts:276-291`:

```
SUPER_ADMIN, CLUB_ADMIN, GENERAL_MANAGER, CONTROLLER, FINANCE_ADMIN,
DEPARTMENT_MANAGER, PRO_SHOP_MANAGER, F_AND_B_MANAGER, EVENT_MANAGER,
PAYROLL_ADMIN, MEMBER, STAFF, AUDITOR_READ_ONLY, BOARD_READ_ONLY
```

`Role.key` is a plain `String @id` on `Role`
(`prisma/schema.prisma:674-683`) — not a Prisma enum. The `ROLES`
const object in code is the source of truth; `prisma/seed.ts:344-354`
projects it into DB rows on reset.

**Scope of each role:**

| Role | Scope | Where checked (representative) | Represents |
|---|---|---|---|
| SUPER_ADMIN | Global (via `UserClubRole.clubId=null`) | `src/lib/rbac.ts:25-27, 44-45` | Platform-super |
| CLUB_ADMIN | Per-club | `src/app/app/admin/layout.tsx:17-21` | Tenant super-admin *by convention* |
| GENERAL_MANAGER | Per-club | `src/lib/enterprise/kpi.ts:230`, `src/lib/support-access/index.ts:72` | Both authority and title |
| CONTROLLER | Per-club | `src/lib/payroll/club-config.ts:263-272` (title check!), `src/lib/ap/approvals.ts:32-49` | Both authority and title |
| FINANCE_ADMIN | Per-club | `src/lib/ap/approvals.ts:32` | Authority |
| DEPARTMENT_MANAGER | Per-club | `src/lib/permissions.ts:539` | Title (routing derived from HR assignments) |
| PRO_SHOP_MANAGER / F_AND_B_MANAGER / EVENT_MANAGER | Per-club | Various | Titles |
| PAYROLL_ADMIN | Per-club | `src/lib/payroll/club-config.ts:252-262` (title check!) | Both authority and title |
| MEMBER | Per-club | `src/app/login/page.tsx:28` (routing) | Not admin |
| STAFF | Per-club | `src/lib/permissions.ts:615-618` | Minimal |
| AUDITOR_READ_ONLY / BOARD_READ_ONLY | Per-club | Various | Read-only tiers |

**Role → permission map** is fully static at
`src/lib/permissions.ts:299-676`. `SUPER_ADMIN` grants
`allPermissionKeys()`; `CLUB_ADMIN` grants ~130 keys and is
intentionally near-super at a single club. The Prisma tables `Role /
Permission / RolePermission` (`schema.prisma:674-703`) exist and are
seeded from the code map, but **the runtime authorization path in
`hasPermission` at `rbac.ts:47` reads `ROLE_PERMISSIONS[role]`
directly** — DB-side delegation is not honored.

**Comment-vs-code drift.** `permissions.ts:312-319` documents that
Controllers can delegate `coa:write` to a specific CLUB_ADMIN "through
the permissions / role-management system" — but this promise is not
kept: DB writes to `RolePermission` are ignored at runtime.

---

## 5. Existing permissions

**~180 permission keys** at `src/lib/permissions.ts:9-265`, grouped by
domain. Highlights and gaps:

- **Payroll canonical grants** (Payroll-3A, added 2026-08-28,
  `:102-113`): `payroll:prepare / edit / submit / post / void /
  paygroup:read|write / config:read|write`. **`payroll:submit`,
  `payroll:post`, `payroll:prepare`, `payroll:edit`, `payroll:void`
  are declared but not checked anywhere in `src/**`.** Grep confirms
  zero call sites. The service layer still gates on
  `payroll:run|read|write`. Dead grants that any near-term refactor
  should either activate or delete.
- **`system:super_admin`** (`:11`) declared but never consulted;
  super-admin is detected only via `isSuperAdmin(p)` (membership
  shape).
- **Sensitive reveals** (`:219-228`) — `hr:sin:reveal`,
  `hr:banking:reveal`, `hr:tax:reveal`. **Granted ONLY to
  `PAYROLL_ADMIN` (`:598-601`).** CLUB_ADMIN and CONTROLLER are
  explicitly excluded (comments at `:361-372` and `:490-500`).
- **`assertHasPermission`** does not exist — the throwing helper is
  `requirePermission` at `src/lib/rbac.ts:60-65`.
- **Capability→user resolver**: `resolveRecipientsByPermission`
  at `src/lib/rbac.ts:109-133` is the ONLY function that translates
  a permission grant into a user set. Used by exactly one caller:
  `src/lib/hr/notify-hr-change.ts:165` for fan-out on HR sensitive-
  field changes. Comment at `rbac.ts:96-99` states the founder rule:
  *"never branch on role names (roles change over time; the
  capability is the durable identifier)."*

---

## 6. Existing department / manager / position architecture

**`Department`** — `prisma/schema.prisma:1800-1839`.
Fields: `id, clubId, code, name, description, isActive, sortOrder,
parentDepartmentId`. Uniqueness `@@unique([clubId, code])`.
**Self-referential tree** (`parentDepartmentId`), no
`managerUserId` / `managerEmployeeId` on Department itself.

**`EmployeePosition`** — `prisma/schema.prisma:3271-3289`.
This is the "job title" concept. Fields: `code, name, departmentId,
defaultPayRate, isExempt, isActive`. Uniqueness `@@unique([clubId,
code])`.

**No `JobTitle`, `Position`, `Manager`, `Supervisor` models exist**
beyond the above.

**Manager pointers** live only on Employee-anchored rows:
- `Employee.managerEmployeeId` (`:3379`) — self-relation `"EmployeeReports"`.
- `EmployeeEmploymentAssignment.managerEmployeeId` (`:3463`) — per-role manager.
- `EmploymentPeriod.managerEmployeeId` (`:10328`) — historical.

**`managerUserId` does NOT exist anywhere in the schema** (grep-verified).
This is the load-bearing gap: a manager is always an Employee, never
a User directly. An admin User without an Employee row cannot appear
in the reporting graph.

**Department manager resolution today** (Payroll only) — see §7.

---

## 7. Existing Work Intake ownership architecture

**`WorkIntakeItem`** — `prisma/schema.prisma:9087-9192`.
`ownerUserId String?` is nullable at `:9095` with relation
`"WorkIntakeOwner"` at `:9096`. Index `@@index([ownerUserId, status])`
at `:9189` — the schema is prepared to be queried by owner, but
nothing currently does. Contract stated in the model comment at
`:9092`:
> *"Orchestration state. User-owned. NEVER overwritten by a resync."*

**`WorkIntakeOrigin`** — `prisma/schema.prisma:9367-9382`.
Polymorphic `kind + referenceId + role` with idempotency key
`@@unique([workIntakeItemId, kind, referenceId, role])`. This is the
canonical "why does this WI exist?" record.

**Nine files create WorkIntakeItems.** Ownership behaviour by writer:

| # | Writer | Kind | ownerUserId source |
|---|---|---|---|
| 1 | `src/lib/mailbox/email-materializer.ts:136` | (via `EmailWorkIntakeOrigin`) | **Never set** — creation `data` block omits `ownerUserId` |
| 2 | `src/lib/ap-intelligence/materialise.ts:465` | `INGESTED_DOCUMENT` (AP invoice review) | **Never set** |
| 3 | `src/lib/ap-statement-intelligence/materialise.ts:230` | `INGESTED_DOCUMENT` (statement review) | **Never set** |
| 4 | `src/lib/vendor-intelligence/materialise.ts:338` | (vendor consolidation review) | **Never set** |
| 5 | `src/lib/intelligence/materialisers/ar-aging.ts:271` | `MEMBER_ACCOUNT / MEMBER` (AR aging) | **Never set** |
| 6 | `src/lib/payroll/calculation-execute.ts:516` | `PAYROLL_FINAL_APPROVAL` | `config.controllerUserId` (fail-closed with `.controller-gap` audit) |
| 7 | `src/lib/payroll/orchestration.ts:112` (`ensureOriginBackedItem`) | `PAYROLL_DEPARTMENT_APPROVAL / PAYROLL_ADMIN_PROCESSING / PAYROLL_REVIEW` | `args.ownerUserId` (from caller) |
| 8 | `src/lib/payroll/opening-balance-import.ts:305` | `PAYROLL_OPENING_BALANCE_REVIEW` | `config?.payrollAdminUserId ?? null` — **creates ownerless orphan when config missing** |
| 9 | `src/lib/intelligence/origins.ts:137` (`upsertOrigins`) | polymorphic — origin-only writer | n/a |

**Mission Control does NOT filter WI cards by `ownerUserId`.** Every
loader in `src/lib/mission-control/index.ts:614-831` returns the same
tenant-scoped set to every viewer with mailbox visibility. Per-user
personalisation is limited to `WorkIntakeItemRead` (`viewerHasRead`
markers) and Outlook mirror `isRead`. Consequence: **owner is a
display-only signal today; two viewers see the same feed**.

**The one dynamic ownership resolver** —
`resolveDepartmentManagerUserIds` at
`src/lib/payroll/department-approval.ts:143-196`:

1. `EmployeeEmploymentAssignment.managerEmployeeId` for the department
   (PRIMARY, effective) →
2. `Employee.userId` (drops employees without linked User) →
3. Capability filter `payroll:timesheets:approve` →
4. Deduped set of eligible User IDs.

Selection in `orchestration.ts:196-206`:
- 0 managers → `ownerUserId = null` + returned in `unresolvableDepartments`.
- 1 manager → assign.
- ≥2 managers → `sortedIds[0]` (**lex-first-userId tiebreak**), populates
  `ownershipNote` on the returned DTO. Whether the UI surfaces the note
  is a separate open question.

**Only cross-user assignment API:** `assignToSelf` at
`src/lib/work-intake/actions.ts:240-260`. Comment `:12-13`:
> *"Broad cross-user assignment is intentionally out of scope. B4
> supports self-assignment only."*

**There is no `assignToUser(userId)`, no `reassign`, no `unassign` API.**

---

## 8. Complete routing inventory

Full inventory of every mechanism that determines "who receives / can
act on this work" across every audited module.

| # | Module | Workflow | Current mechanism | Source | Classification |
|---|---|---|---|---|---|
| 1 | Payroll | Department time approval WI | Employee-graph traversal + capability filter + lex-first tiebreak | `orchestration.ts:196-206`, `department-approval.ts:143-196` | **REPLACE** — silent tiebreak; move to `resolveResponsibilityOwner("DEPARTMENT_TIME_APPROVAL", scope=departmentId)` |
| 2 | Payroll | Payroll admin processing WI | `PayrollClubConfig.payrollAdminUserId` (fail-closed) | `orchestration.ts:305-343, 371` | **ADAPT** — write-through migration to `PAYROLL_ADMINISTRATION` responsibility |
| 3 | Payroll | Payroll review handoff WI | `PayrollClubConfig.payrollAdminUserId` | `orchestration.ts:432-506` | **ADAPT** — same as #2 |
| 4 | Payroll | Controller final approval WI | `PayrollClubConfig.controllerUserId` (fail-closed with gap audit) | `calculation-execute.ts:409-420, 519` | **ADAPT** — write-through to `PAYROLL_FINAL_APPROVAL` responsibility |
| 5 | Payroll | Opening balance review WI | `config?.payrollAdminUserId ?? null` (ownerless orphan when null) | `opening-balance-import.ts:283-310` | **REPLACE** — inconsistent with #2/#3, should fail-closed |
| 6 | Payroll | Controller Approval Queue page filter | Club + kind + status filter (NO user filter) | `src/app/app/admin/payroll/process/page.tsx:65-83` | **REPLACE** — visible to every `payroll:read` holder |
| 7 | Payroll | PayrollClubConfig activation preconditions | Role-title assertion (`userHasRoleAtClub` requires role literal) | `club-config.ts:252-273` | **DEPRECATE** — assert responsibility assignment instead |
| 8 | AP | Invoice / statement / vendor-consolidation review WI | Ownerless — never set at creation | `ap-intelligence/materialise.ts:465-483` etc. | **REPLACE** — needs `AP_PROCESSING` responsibility routing |
| 9 | AP | Invoice / vendor / payment-batch / vendor-banking approval | Role-bucket policy engine with `eligibleRoleKeys` CSV + segregation-of-duties | `src/lib/ap/approvals.ts:32-49, 79-120, 225-242` | **ADAPT** — replace role literals with responsibility keys (`AP_APPROVAL`, `VENDOR_APPROVAL`) at threshold |
| 10 | AP | Capture inbox | Permission-gated shared list; no per-user routing | `src/lib/ap/capture.ts:47-78` | **KEEP** — list mode is intentional |
| 11 | HR | New employee creation | `createdByUserId` audit only, no notification, no WI | `src/lib/hr/employees.ts:180-260` | **UNKNOWN** — founder decision on whether HR needs a routing seat |
| 12 | HR | Onboarding invitation issued / submitted | `issuedByUserId` audit only; no admin owner | `src/lib/hr/invitations.ts`, `hr/onboarding-sessions.ts` | **UNKNOWN** — same |
| 13 | HR | Approve & activate | Dual capability gate (`hr:onboarding:approve` + `hr:employee:write`); no preassigned approver | `src/lib/hr/onboarding-approve-activate.ts:54-141` | **ADAPT** — bind to `EMPLOYEE_ONBOARDING` responsibility |
| 14 | HR | Sensitive-field notification (SIN/banking/address) | Fan-out via `resolveRecipientsByPermission` (capability broadcast) | `src/lib/hr/notify-hr-change.ts:159-233` | **KEEP** — capability broadcast is correct; not ownership |
| 15 | Governance | Reporting package approval | `packages:approve` permission + self-approval SoD; approver written at decide-time | `src/lib/enterprise/packages.ts:145-165` | **KEEP** for now; **ADAPT** later to `REPORTING_APPROVAL` responsibility |
| 16 | Governance | Monthly package lifecycle | No routing — audit fields only | `src/lib/reporting/monthly-package-lifecycle.ts` | **KEEP** — list/dashboard mode |
| 17 | Governance | Generic `Workflow` engine | Per-step `approverUserId` OR `approverRoleKey` (explicit at creation) | `src/lib/enterprise/workflow.ts:36-65, 99-106` | **ADAPT** — allow `approverResponsibilityKey` as third option |
| 18 | Membership | Applicant reviewer | Manual per-row `Applicant.reviewerId` pick | `src/lib/services/applications.ts:508-532` | **KEEP** manual pick; optionally add `MEMBER_ADMINISTRATION` as default |
| 19 | Membership | Member portal invite / bulk invite | `createdByUserId` audit only; no follow-up owner | `src/lib/member-invites/index.ts:66-77, 128-148` | **UNKNOWN** |
| 20 | Support | `SupportTicket.assignedToUserId` | User-picked `assignTicket(userId)` | `src/lib/incidents/index.ts:146-178` | **KEEP** manual |
| 21 | Hospitality | Service-recovery escalation | `DepartmentNotificationRule` per `(clubId, departmentKey)` explicit routing | `src/lib/hospitality/surveys.ts:385-464` | **ADAPT** — becomes a scoped responsibility |
| 22 | Platform | Active-club SUPER_ADMIN fallback | `prisma.club.findFirst({ orderBy: createdAt asc })` | `src/lib/rbac.ts:149-151`, `src/lib/active-club.ts:26` | **KEEP** — super-admin convenience, not routing |
| 23 | Platform | Pilot readiness "initial_users" | Existence-count of any `roleKey="CLUB_ADMIN"` at club | `src/lib/pilot/index.ts:97` | **REPLACE** — should check `TENANT_ADMINISTRATION` responsibility |
| 24 | Cross-cutting | `KPIThreshold.notifyUserId / notifyRoleKey` | Written by `upsertThreshold`, never read | `src/lib/enterprise/kpi.ts:127-139` | **DEPRECATE** — latent scaffolding |
| 25 | Cross-cutting | Role-literal columns (`approverRoleKey`, `assigneeRoleKey`, `notifyRoleKey`, `defaultRoleKey`, `TrainingScenario.roleKey`) | 7 schema-level uses (see §17 of the roles audit) | Various | **ADAPT** — allow responsibility key alongside role key |

**Silent-selection anti-patterns confirmed** (in ranked risk order):

1. **Lex-first-userId tiebreak** on department manager selection —
   `orchestration.ts:200-203`. The only true silent WI-routing pattern
   in the repo.
2. **Ownerless AP invoice / statement / vendor / AR-aging WIs** — five
   materialisers create WI with no owner; Mission Control does not
   filter by owner, so every user with the visibility gate sees them.
3. **Opening-balance review orphan** — inconsistent with other Payroll
   fail-closed behaviour.
4. **Controller Approval Queue no user filter** — page-level `payroll:read`
   gate means CLUB_ADMIN, GM, PAYROLL_ADMIN, FINANCE_ADMIN, and
   AUDITOR_READ_ONLY all see the Controller's queue.
5. **Hospitality `FB_MANAGER` literal typo** at
   `src/app/app/admin/hospitality/feedback/page.tsx:153` — the query
   filters for a role literal that does not exist (canonical is
   `F_AND_B_MANAGER`), silently matching zero rows.
6. **Duplicated inline `isSuperAdmin` shape checks** at 8+ locations
   — bakes the assumption that `roleKey === "SUPER_ADMIN"` implies
   platform-super rather than reading a capability.

---

## 9. Architectural problems discovered

Consolidating the audits into a numbered problem list. Every problem
must be addressable by the proposed model.

**P1. Job titles are the *only* declaration of "what someone does".**
`UserClubRole.roleKey` is asked to be both an authorization anchor
AND an organizational descriptor. Every code site that reads
`roleKey === "CONTROLLER"` is doing the wrong thing for one of the
two purposes.

**P2. Roles are equated with operational responsibilities.**
`PayrollClubConfig` requires a Controller to be assigned by picking a
User who holds the `CONTROLLER` role literal (`club-config.ts:263-273`).
Similar assertions for PAYROLL_ADMIN (`:252-262`). A Club whose
Controller has the title "Director of Finance" today has no way to
route Payroll approvals without first inventing a role called
`CONTROLLER` and assigning it to the person. Titles vary by club;
routing must not.

**P3. Roles are equated with authority tiers.**
The `ADMIN_ROLES` set at `src/app/app/admin/layout.tsx:17-21` gates
the entire `/app/admin` shell on 13 hard-coded role literals. Adding
a new organizational title (e.g. "Assistant General Manager") requires
editing a code file to be admitted to the admin surface at all.

**P4. Ownership routing is a shortcut, not a system.**
Only Payroll routes work to specific users, and it does so through
two hard-coded FK columns on a per-module config table. AP, HR,
governance, membership have no routing at all — every WI they emit
lands ownerless and everyone sees it.

**P5. Silent tiebreaks and silent unroutable states.**
The department-manager `sortedIds[0]` tiebreak
(`orchestration.ts:200-203`) picks a specific person for a specific
task with no user-visible signal beyond a `DTO.ownershipNote` field
whose renderer we cannot locate.

**P6. Capabilities and roles are conflated in HR sensitive access.**
`hr:sin:reveal`, `hr:banking:reveal`, `hr:tax:reveal` are all granted
to a single role (`PAYROLL_ADMIN`). A Club cannot say "this person
runs Payroll but does not reveal SIN" without editing the code map.

**P7. The `Employee.userId` bridge is dead scaffolding.**
Present in the schema, never populated. The Employee Portal invented a
parallel identity system rather than adopt the link. Reconciliation
between "a person's admin identity" and "a person's HR identity"
is currently manual and fragile.

**P8. `User.role` and `User.clubId` are documented DEPRECATED but
still authoritative in specific paths.** The admin shell gate at
`layout.tsx:32`, all login redirects, all `/app/member` redirects.
Migration off these columns has stalled.

**P9. Comment-vs-code drift on delegation.**
`permissions.ts:312-319` promises DB-side delegation works. It
doesn't (`rbac.ts:47` reads the code map). Any future "let admins
delegate a capability to a specific user" work has to pick a lane.

**P10. No admin invitation flow exists.**
`User.status="INVITED"` is documented but has no writer. New admins
arrive only via SSO JIT or seed. Founder onboarding a Controller to a
new Club requires SSO configuration or direct DB action today.

**P11. Latent workflow scaffolding.**
`WorkflowAssignment.assigneeUserId / assigneeRoleKey`,
`KPIThreshold.notifyRoleKey / notifyUserId` — schema present, no
runtime reader. Any responsibility model must either wire these in
or explicitly deprecate them so they don't fossilise.

**P12. Multi-tenant identity boundary is soft.**
`User.email` is globally unique. The same real person at two Clubs
either shares one User (single email) or has two Users with two
emails and is treated as two people.

---

## 10. Proposed canonical organizational model

The proposal is **strictly additive**. Every existing table stays.
Every existing service keeps working during the compatibility period.
No `_prisma_migrations` edits, no destructive column removals in
this phase.

### 10.1 Concepts (in order of dependency)

```
Club                       (existing — the tenant boundary)
  ├─ User                  (existing — auth principal)
  │    └─ UserClubRole     (existing — membership + role literal for RBAC)
  │
  ├─ UserClubProfile       (NEW — organizational sidecar per user × club)
  │    ├─ title            e.g. "Controller", "Director of Finance"
  │    ├─ departmentId?    optional: primary department
  │    ├─ reportsToUserId? optional: direct-report edge (User → User)
  │    ├─ isTenantAdmin    computed / stored: holds TENANT_ADMINISTRATION
  │    └─ status           ACTIVE | INVITED | SUSPENDED | REVOKED
  │
  ├─ Responsibility        (NEW — canonical operational key catalogue)
  │    ├─ key              e.g. "PAYROLL_ADMINISTRATION"
  │    ├─ scopeKind        CLUB | DEPARTMENT | DOLLAR_THRESHOLD | VENDOR | ...
  │    ├─ cardinality      SINGLE_PRIMARY | PRIMARY_AND_BACKUPS | MULTIPLE_PRIMARIES
  │    ├─ recommendedPermissions[] soft link
  │    ├─ requiredPermissions[]    hard link — resolver rejects if user missing
  │    ├─ incompatibleWith[]       for SoD warnings
  │    └─ isSpectreDefined  true (platform-canonical; no club-created keys)
  │
  ├─ ResponsibilityAssignment  (NEW — the join)
  │    ├─ userId
  │    ├─ clubId              scope: which tenant
  │    ├─ responsibilityKey
  │    ├─ scopeJson           canonical scope value (e.g. {departmentId:"..."})
  │    ├─ role                PRIMARY | BACKUP
  │    ├─ effectiveFrom
  │    ├─ effectiveTo?        null = open-ended
  │    ├─ assignedByUserId    audit
  │    └─ notes?
  │
  └─ ResponsibilityDelegation  (NEW — temporary override; DEFERRED, not TA-1A)
       ├─ delegatorUserId
       ├─ delegateUserId
       ├─ responsibilityKey
       ├─ scopeJson
       ├─ effectiveFrom / effectiveTo
       └─ reason
```

### 10.2 Why a `UserClubProfile` sidecar (not new columns on `UserClubRole`)

- `UserClubRole` is the authorization row and is composite-unique on
  `(userId, clubId, roleKey)`. A user can hold multiple roles at one
  club; their organizational title is one value per club, not per
  role. A sidecar makes cardinality explicit.
- Keeps the authorization row minimal and hot; the sidecar can gain
  columns (photo, preferred name, timezone override) without touching
  the RBAC hot-path.
- Enables `status = INVITED` to be represented cleanly (see §16 —
  invitations) without adding lifecycle fields to `UserClubRole`,
  which cascade-deletes on User removal.

### 10.3 Explicit non-goals for TA-1A

- We are **not** proposing a `Position` model that competes with
  `EmployeePosition`. HR employment positions and organizational
  admin titles are different concepts (an admin User may not be an
  Employee).
- We are **not** proposing to delete or renumber the 15 existing
  roles. They remain the authorization anchor.
- We are **not** proposing to merge `User` and `Employee`. The
  `Employee.userId` link stays optional; we recommend a follow-up
  slice to activate the link during onboarding.

---

## 11. Proposed responsibility model

**Responsibility keys are the canonical machine-readable operational
identifiers.** They live in code (like permissions), platform-defined,
never club-authored.

**Initial catalogue** (subject to founder edit — this is the
strawman derived from routing inventory §8):

### Payroll
- `PAYROLL_ADMINISTRATION` (scope: CLUB; cardinality: SINGLE_PRIMARY;
  required: `payroll:read`, `payroll:write`, `payroll:run`;
  incompatible: `PAYROLL_FINAL_APPROVAL` [SoD warning, not block])
- `PAYROLL_FINAL_APPROVAL` (scope: CLUB; SINGLE_PRIMARY;
  required: `payroll:read`, `payroll:approve`, `payroll:post`)
- `DEPARTMENT_TIME_APPROVAL` (scope: DEPARTMENT; MULTIPLE_PRIMARIES
  allowed with explicit tiebreak rule;
  required: `payroll:timesheets:approve`)

### Accounts Payable
- `AP_PROCESSING` (scope: CLUB; SINGLE_PRIMARY; required:
  `ap:invoice:create`, `ap:invoice:submit`)
- `AP_APPROVAL` (scope: DOLLAR_THRESHOLD; ordered thresholds; each
  band has a PRIMARY; required: `ap:invoice:approve` at threshold)
- `VENDOR_ADMINISTRATION` (scope: CLUB; SINGLE_PRIMARY; required:
  `vendor:approve`, `vendor:banking:approve`)

### HR
- `EMPLOYEE_ONBOARDING` (scope: CLUB; PRIMARY_AND_BACKUPS;
  required: `hr:onboarding:approve`, `hr:employee:write`)
- `EMPLOYEE_RECORDS_ADMINISTRATION` (scope: CLUB; SINGLE_PRIMARY;
  required: `hr:employee:read`, `hr:employee:write`)
- `BENEFITS_ADMINISTRATION` (scope: CLUB; SINGLE_PRIMARY;
  required: `hr:employee:read`, `hr:allowance:write`)

### Membership
- `MEMBER_ADMINISTRATION` (scope: CLUB; PRIMARY_AND_BACKUPS;
  required: `members:read`, `members:write`, `applications:review`)

### Finance
- `MONTH_END_CLOSE` (scope: CLUB; SINGLE_PRIMARY; required:
  `gl:read`, `gl:close_period`)
- `FINANCIAL_REPORTING` (scope: CLUB; SINGLE_PRIMARY; required:
  `packages:read`, `packages:approve`)
- `BANK_RECONCILIATION` (scope: CLUB; SINGLE_PRIMARY; required:
  `gl:read`, `gl:post`)

### Platform
- `TENANT_ADMINISTRATION` (scope: CLUB; SINGLE_PRIMARY per club;
  required: `users:invite`, `users:roles:write`; this is the
  "Tenant Super Admin" concept from the brief)

**Extension policy.** New keys are added by code change and
migration, seeded via a `prisma/seed.ts` addition. No API allows a
Club to invent a responsibility. Display labels can be club-customised
(see §12) but the underlying key is immutable.

---

## 12. Proposed responsibility-assignment model

`ResponsibilityAssignment` is the row that binds one User to one
Responsibility in one Club, optionally scoped.

**Fields:**
- `id, clubId, userId, responsibilityKey, scopeJson, role, effectiveFrom, effectiveTo, assignedByUserId, notes, createdAt, updatedAt`
- `role` enum: `PRIMARY | BACKUP`
- `scopeJson` shape depends on `Responsibility.scopeKind`:
  - `CLUB` → `null`
  - `DEPARTMENT` → `{ departmentId: "..." }`
  - `DOLLAR_THRESHOLD` → `{ minAmount: 0, maxAmount: 3000 }` (per band)
  - `VENDOR` → `{ vendorId: "..." }`
  - Extensible via new scope kinds without schema change.

**Uniqueness constraints (proposed):**
- Prevent duplicate assignments: `@@unique([clubId, userId, responsibilityKey, scopeJson_hash, role, effectiveFrom])`
- The `scopeJson_hash` is a computed string index (Postgres) or an
  application-normalized column (SQLite) to make partial-JSON
  uniqueness enforceable.

**Immutability:** rows are append-only. A change to primary owner
creates a new row with a new `effectiveFrom` and closes the previous
row's `effectiveTo`. This preserves audit history at the row level
without needing a separate change-log table.

**Club-customised display label:** a separate lightweight table
`ResponsibilityDisplayLabel(clubId, responsibilityKey, label)` allows
a Club to display "Payroll Boss" instead of "Payroll Administration"
without changing the key. Modules never read the label.

---

## 13. Scope model

Responsibilities carry an explicit `scopeKind` (§11); assignments
carry a `scopeJson` value that matches. The resolver contract (§15)
takes a `scope?` parameter of the shape the responsibility declares.

**Rules:**
- A `CLUB`-scoped responsibility has at most one PRIMARY row per
  `(clubId, responsibilityKey)`. Enforced by a partial unique index
  `WHERE role='PRIMARY' AND effectiveTo IS NULL`.
- A `DEPARTMENT`-scoped responsibility has at most one PRIMARY row
  per `(clubId, responsibilityKey, departmentId)`. Same partial-index
  strategy.
- A `DOLLAR_THRESHOLD`-scoped responsibility MAY have multiple bands;
  each band's owner is looked up by the request amount at
  resolve-time. Overlapping bands are a configuration error surfaced
  at write-time.

**Adding a new scope kind** does not require changing the assignment
schema — only the `Responsibility.scopeKind` catalogue entry and the
resolver's shape-validator.

---

## 14. Primary / backup / delegation model

**PRIMARY:** normally receives the work. Exactly one per (club,
responsibility, scope) for `SINGLE_PRIMARY` responsibilities; multiple
allowed for `MULTIPLE_PRIMARIES` and `PRIMARY_AND_BACKUPS`.

**BACKUP:** authorized alternate. Never automatically routed to —
resolver returns `{ primaries: [...], backups: [...] }` and the
caller decides. Backups become the visible signal for "if primary
is unavailable, escalate to this person."

**Delegation (deferred to TA-1F, not TA-1A):**
`ResponsibilityDelegation(delegatorId, delegateId, responsibilityKey,
scopeJson, effectiveFrom, effectiveTo, reason)`. The resolver applies
active delegations *after* looking up the assignment row.
Delegation does NOT rewrite the assignment; the delegator remains
the accountable party.

**Tiebreak for `MULTIPLE_PRIMARIES` responsibilities (esp.
`DEPARTMENT_TIME_APPROVAL`):** the resolver returns *all* primaries.
Callers that need one owner must pass an explicit tiebreak policy
(e.g. `preferSelf: false, roundRobin: false`). **No silent lex-first
selection.** If the caller cannot make a deterministic choice, the
resolver returns `AMBIGUOUS` with the full candidate list.

---

## 15. Proposed resolver contract

Single public function:

```ts
async function resolveResponsibilityOwner(args: {
  clubId: string;
  responsibilityKey: ResponsibilityKey;
  scope?: unknown;      // must match Responsibility.scopeKind
  effectiveAt?: Date;   // default: now()
  purpose?: "route" | "audit" | "check";  // for logging
}): Promise<ResponsibilityResolution>;

type ResponsibilityResolution =
  | { kind: "RESOLVED";
      primary: { userId: string; assignmentId: string; scope: unknown };
      backups: Array<{ userId: string; assignmentId: string }>;
      delegatedFrom?: { userId: string; delegationId: string };
      provenance: "assignment" | "delegation";
    }
  | { kind: "UNASSIGNED";     responsibilityKey: ResponsibilityKey; scope: unknown }
  | { kind: "AMBIGUOUS";      candidates: Array<{ userId: string; assignmentId: string }>; reason: string }
  | { kind: "INACTIVE_OWNER"; userId: string; assignmentId: string; userStatus: string }
  | { kind: "INSUFFICIENT_PERMISSION"; userId: string; missingPermissions: PermissionKey[] }
  | { kind: "UNKNOWN_RESPONSIBILITY"; responsibilityKey: string }
  | { kind: "SCOPE_INVALID";  responsibilityKey: ResponsibilityKey; expected: string; received: unknown };
```

**Every failure mode is a structured result, never a thrown exception.**
Config gaps are expected states, not bugs. Throwing here would push
callers to `try/catch` and mask silently. The resolver returns the
data; the caller decides whether to materialize a WI, escalate to
Tenant Admin, or refuse.

**Never returns "first admin" or "any CLUB_ADMIN" as a fallback.**
Absence of an assignment is `UNASSIGNED` — the only correct answer.

---

## 16. Unassigned / ambiguous behavior

Explicit contract, applied by every caller:

| Resolver result | Caller behaviour (proposed default) |
|---|---|
| `RESOLVED` (single primary or clear tiebreak) | Materialize the WI with `ownerUserId = primary.userId`. Also carry `backups[]` on the WI's origin metadata for future escalation UI. |
| `UNASSIGNED` | **Do NOT create the routed WI.** Emit an audit event `responsibility.unassigned.<key>` with the resolve context. Materialize a second WI of kind `RESPONSIBILITY_GAP` with `ownerUserId = <Tenant Super Admin for this club>` and a fixed subject like "Assign a Payroll Administrator". |
| `AMBIGUOUS` | Materialize WI with `ownerUserId = null` (visible to all backups and both primaries in Mission Control). Emit `responsibility.ambiguous.<key>` audit. Do NOT lex-first-pick. |
| `INACTIVE_OWNER` | Treat as `UNASSIGNED` for the routing purpose, plus a separate `responsibility.owner.inactive.<key>` audit and a Tenant-Super-Admin-owned reassignment card. |
| `INSUFFICIENT_PERMISSION` | Treat as `UNASSIGNED` for routing + emit `responsibility.owner.permission-mismatch` audit. This catches drift when a permission grant is later removed but the assignment is not. |
| `UNKNOWN_RESPONSIBILITY` / `SCOPE_INVALID` | Programmer error — throw. The caller should not have asked. |

**Design invariant:** *"never silently pick a plausible-looking user."*
The current lex-first tiebreak at `orchestration.ts:200-203` is a
direct violation of this future-invariant and is the pattern the
model exists to eliminate.

---

## 17. Permission interaction

**Responsibilities and permissions are orthogonal:**

- A responsibility MAY declare `requiredPermissions[]` — the resolver
  refuses to route to a user missing them (result: `INSUFFICIENT_PERMISSION`).
- A responsibility MAY declare `recommendedPermissions[]` — the
  assignment UI surfaces these as "recommended grants" and offers a
  one-click "grant recommended permissions" workflow.
- Assigning a responsibility **NEVER silently grants a permission.**
  Every permission grant is an explicit action, auditable via the
  existing `audit()` helper.
- Removing a permission does NOT auto-remove a responsibility —
  instead, the next resolve call surfaces `INSUFFICIENT_PERMISSION`
  and prompts the Tenant Super Admin to either restore the permission
  or reassign the responsibility.

**This preserves the founder security rule:** *"payroll responsibilities
must NOT grant SIN / banking / KMS access unless separately authorized."*
`PAYROLL_ADMINISTRATION` requires `payroll:*` capabilities but does not
require `hr:sin:reveal` etc. A club that wants to separate "runs
payroll" from "reveals SIN plaintext" can assign the responsibility
to one User and grant the reveal permission (via a to-be-designed
capability-grant surface, not TA-1A) to another.

---

## 18. Segregation-of-duties model

`Responsibility.incompatibleWith: ResponsibilityKey[]` declares soft
SoD conflicts.

**Behaviour when the assignment UI attempts an incompatible pair:**
- Not a hard block by default (small clubs may need to combine roles).
- Warn: "This user already holds `PAYROLL_ADMINISTRATION`. Assigning
  `PAYROLL_FINAL_APPROVAL` to the same person means the processor and
  approver are the same. Continue?"
- Emit `responsibility.sod.warning.acknowledged` audit on confirm.

**Hard blocks** are configurable per Club via a future
`ResponsibilityPolicy(clubId, incompatiblePair, mode:'WARN'|'BLOCK')`
table. Not built in TA-1A.

---

## 19. Tenant Super Admin architecture

**Concept:** the first administrative User of a Club, canonically the
holder of `TENANT_ADMINISTRATION` responsibility.

**Bootstrap:**
- When a new Club is created (super-admin action or SSO first-login),
  the platform assigns `TENANT_ADMINISTRATION` PRIMARY to that first
  User.
- That User can then invite peers, establish organizational
  positions, and assign further responsibilities.
- **Never inferred from role name.** The current
  `src/lib/pilot/index.ts:97` check for "does any CLUB_ADMIN exist"
  becomes "does any user hold `TENANT_ADMINISTRATION` at this Club".

**Delegation of `TENANT_ADMINISTRATION`:**
- Multiple PRIMARIES allowed (`PRIMARY_AND_BACKUPS` cardinality
  variant, or explicit dual-primary policy).
- Removing the last primary is refused by the assignment UI — a Club
  cannot become orphaned.
- Platform SUPER_ADMIN can always intervene (this is unchanged).

**Not the same as SUPER_ADMIN.** `TENANT_ADMINISTRATION` is per-Club.
Platform SUPER_ADMIN (`UserClubRole.clubId=null`) remains for Spectre
staff.

---

## 20. Invitation lifecycle

Reuses `User` + `UserClubRole` + the proposed `UserClubProfile.status`.

**States:**

| State | Meaning | Written by |
|---|---|---|
| `INVITED` | `UserClubProfile` exists, `User.status="INVITED"`, invite email sent | invitation service (new) |
| `ACTIVE` | User has redeemed and set password / linked SSO; can access admin surface | password-set / SSO handoff |
| `SUSPENDED` | Temporarily disabled by Tenant Super Admin | admin UI |
| `REVOKED` | Membership cancelled; row retained for audit; `UserClubRole` removed | admin UI |

**Invitation table (proposed):** `AdminInvitation` — mirrors
`MemberPortalInvite` (`prisma/schema.prisma:8051-8070`) shape for
consistency. Fields: `id, clubId, email, tokenHash (sha256), status
(PENDING|SENT|OPENED|ACTIVATED|EXPIRED|FAILED), expiresAt,
invitedByUserId, invitedResponsibilities: ResponsibilityKey[],
proposedTitle, proposedDepartmentId, proposedReportsToUserId,
proposedRoleKeys: RoleKey[]`.

**Lifecycle events:**

1. Tenant Super Admin invites `chris@example.com` as Controller,
   assigning `PAYROLL_FINAL_APPROVAL`, `AP_APPROVAL`, `MONTH_END_CLOSE`
   responsibilities, `CONTROLLER` role.
2. `AdminInvitation` row written; email sent; audit logged.
3. Invitee redeems token → password-set flow → `User` created with
   `status: "ACTIVE"`, `UserClubRole` created with `roleKey:
   "CONTROLLER"`, `UserClubProfile` created with the proposed title
   and department, `ResponsibilityAssignment` rows created for the
   three responsibilities.
4. All four writes happen in one transaction; failure rolls back the
   invitation to `PENDING` for retry.

**Resend / revoke:** modeled on
`src/lib/hr/invitations.ts` (`reissueInvitation`, `revokeInvitation`).
Superseding an unredeemed invitation cancels the prior token.

**Existing employee link:** if the invitee's email matches
`Employee.personalEmail` at the same Club, the acceptance flow offers
"link to your Employee record" (setting `Employee.userId`).

---

## 21. Offboarding safety

**Explicit guard:** before deactivating a User's `UserClubProfile` at
a Club, the admin UI enumerates all `ResponsibilityAssignment` rows
where the User is PRIMARY and `effectiveTo IS NULL`.

**If any exist:**
> *"Raelene owns 4 operational responsibilities. Reassign them before
> deactivating her:*
> *• `PAYROLL_ADMINISTRATION`*
> *• `EMPLOYEE_ONBOARDING`*
> *• `AP_PROCESSING`*
> *• `VENDOR_ADMINISTRATION`"*

The UI blocks the deactivation until either every responsibility is
reassigned OR the admin explicitly acknowledges "leave these
unassigned; work will queue for the Tenant Super Admin." The latter
choice writes `ResponsibilityAssignment.effectiveTo = now()` and
emits `responsibility.orphaned.on.offboarding` audit.

**Never silently orphans work.** The `UNASSIGNED` resolver result
(§16) already handles the orphaned state correctly; this guard is
UX to prevent the founder discovering it via a stuck WI.

---

## 22. Audit requirements

Reuse existing `AuditLog` (`prisma/schema.prisma:731-751`) — already
carries `clubId, userId, action, entityType, entityId, before/afterJson,
metaJson, ip, userAgent, createdAt`. Every responsibility mutation
writes one:

| Action | entityType | entityId |
|---|---|---|
| `responsibility.assigned` | `ResponsibilityAssignment` | assignmentId |
| `responsibility.removed` | `ResponsibilityAssignment` | assignmentId |
| `responsibility.reassigned` | `ResponsibilityAssignment` | new assignmentId |
| `responsibility.primary.changed` | `Responsibility` | responsibilityKey |
| `responsibility.backup.added` | `ResponsibilityAssignment` | assignmentId |
| `responsibility.backup.removed` | `ResponsibilityAssignment` | assignmentId |
| `responsibility.delegation.started` | `ResponsibilityDelegation` | delegationId |
| `responsibility.delegation.ended` | `ResponsibilityDelegation` | delegationId |
| `usercubprofile.title.changed` | `UserClubProfile` | profileId |
| `usercubprofile.reportsTo.changed` | `UserClubProfile` | profileId |
| `admin.invitation.sent / redeemed / revoked / expired` | `AdminInvitation` | invitationId |
| `admin.user.suspended / reactivated` | `UserClubProfile` | profileId |
| `responsibility.unassigned` (resolver signal) | `Responsibility` | key |
| `responsibility.ambiguous` (resolver signal) | `Responsibility` | key |
| `responsibility.owner.inactive` (resolver signal) | `ResponsibilityAssignment` | assignmentId |

Every row carries `metaJson` including the resolver purpose (§15),
the requested scope, and (for reassignments) the prior owner.

---

## 23. Payroll migration plan

**Compatibility-first, four phases.**

### Phase P1 — schema-additive (TA-1B/TA-1D)
- Add `Responsibility`, `ResponsibilityAssignment` tables.
- Seed `PAYROLL_ADMINISTRATION`, `PAYROLL_FINAL_APPROVAL`,
  `DEPARTMENT_TIME_APPROVAL` responsibility keys.
- No code path reads the new tables yet.

### Phase P2 — dual-write (TA-1F)
- `upsertPayrollClubConfig` (`src/lib/payroll/club-config.ts:127-207`)
  is extended: writing `payrollAdminUserId` also writes a
  `ResponsibilityAssignment` row for `PAYROLL_ADMINISTRATION`
  (idempotent). Writing `controllerUserId` also writes one for
  `PAYROLL_FINAL_APPROVAL`.
- Existing PayrollClubConfig rows are backfilled by a one-shot idempotent
  script that reads current `payrollAdminUserId` / `controllerUserId`
  and inserts the equivalent `ResponsibilityAssignment` rows.
- Reads still come from `PayrollClubConfig`. No behaviour change.

### Phase P3 — read-through (TA-1F)
- `calculatePayrollBatch` (`src/lib/payroll/calculation-execute.ts:405-420`)
  is refactored to call `resolveResponsibilityOwner({clubId, responsibilityKey: "PAYROLL_FINAL_APPROVAL"})`.
  On `UNASSIGNED`, it falls back to `config.controllerUserId` for the
  compatibility period and emits `payroll.responsibility.fallback.controller` audit.
- `orchestratePayrollAdminHandoff` / `Review` /
  `OpeningBalanceReview` refactored similarly for
  `PAYROLL_ADMINISTRATION`.
- `orchestrateDepartmentApprovalTasks`
  (`src/lib/payroll/orchestration.ts:172-283`) refactored to call
  `resolveResponsibilityOwner({key: "DEPARTMENT_TIME_APPROVAL",
  scope: {departmentId}})`. **The lex-first tiebreak is removed.**
  On `AMBIGUOUS`, the WI is created with `ownerUserId=null` and every
  candidate is surfaced.
- Tests: the existing 381+ Payroll regression suite continues to
  pass; new tests confirm the resolver produces the correct owner
  in RESOLVED / UNASSIGNED / AMBIGUOUS cases.

### Phase P4 — deprecate config columns (TA-2A, later)
- After ≥1 quarter with dual-write and no fallback-audit hits at any
  Club, `PayrollClubConfig.payrollAdminUserId` and `controllerUserId`
  are marked deprecated in the schema comment; setup UI reads
  responsibilities directly; write path stops writing config columns.
- Physical column removal is a separate migration after ≥6 months
  quiet.

**No PayrollClubConfig destructive change in TA-1. No behaviour change
in TA-1.**

---

## 24. AP migration plan (validating cross-module fit)

Applied identically to prove the model is not Payroll-specific.

### Phase A1 — additive
- Seed `AP_PROCESSING`, `AP_APPROVAL`, `VENDOR_ADMINISTRATION` keys.

### Phase A2 — routing (net-new, no legacy to preserve)
- `src/lib/ap-intelligence/materialise.ts:465-483` — the AP invoice
  review materialiser gains a call to `resolveResponsibilityOwner({key:
  "AP_PROCESSING"})`. On RESOLVED, sets `ownerUserId`. On UNASSIGNED,
  keeps current ownerless behaviour + emits gap audit + surfaces to
  Tenant Super Admin via the `RESPONSIBILITY_GAP` WI (§16).
- Same treatment for `ap-statement-intelligence/materialise.ts:230` and
  `vendor-intelligence/materialise.ts:338`.

### Phase A3 — approval-policy adaptation
- `DEFAULT_AP_INVOICE_POLICY` (`src/lib/ap/approvals.ts:32-36`)
  currently declares role literals per dollar band. New shape:
  `[{ maxAmount: 3000, responsibilityKey: "AP_APPROVAL", scope:
  {band:'LOW'} }, ...]`. `AP_APPROVAL` responsibility is
  `DOLLAR_THRESHOLD`-scoped (§13); resolver returns the correct
  primary per band.
- `listPendingForUser` (`approvals.ts:225-242`) filters by "any
  responsibility this user is primary for". Segregation-of-duties
  self-approval block (`approvals.ts:152-154`) is unchanged.

### Phase A4 — deprecate role-literal columns
- `ApprovalRequest.eligibleRoleKeys` becomes advisory metadata;
  resolver output is authoritative. Column removal deferred.

---

## 25. Future org-chart UX architecture

TA-1A does not build UI. Architecture must nevertheless *support*:

**Org chart canvas** (TA-1C):
- Node = `UserClubProfile` row.
- Edge = `UserClubProfile.reportsToUserId` (User → User).
- Node card renders: photo (from `UserClubProfile.photoRef`), display
  name (from `User.name`), title (from `UserClubProfile.title`),
  department (from `Department.name`), responsibility pills (from
  `ResponsibilityAssignment` rows).
- Layout is derived from the reports-to graph; users with no
  reports-to appear at the top; disconnected users appear in an
  "unassigned in hierarchy" tray.

**Responsibility library** (TA-1D):
- Sidebar-catalogued list of `Responsibility` keys grouped by domain.
- Each pill knows its `scopeKind`, `cardinality`, `requiredPermissions`.
- Drag onto a user card → opens assignment modal (choose scope,
  choose PRIMARY / BACKUP, review permission gap, confirm).
- Assignment writes one `ResponsibilityAssignment` row +
  `responsibility.assigned` audit.

**Coverage view** (TA-1D, parallel to org chart):
- Grouped by responsibility, not by user.
- Renders "Payroll Administration — Primary: Raelene · Backup: —"
- Empty backups are visually flagged.
- `UNASSIGNED` responsibilities show as "🔴 Not assigned — configure
  before enabling this workflow."

**Data contracts already satisfied by the proposed model:**
- Node data: `UserClubProfile` + `User` + `Department`.
- Edges: `UserClubProfile.reportsToUserId`.
- Pills: `ResponsibilityAssignment` filtered by user × club.
- Coverage: `ResponsibilityAssignment` grouped by responsibility × scope.

No UI-specific schema changes required beyond §10.

---

## Appendix A — Test strategy (design only; not implemented)

Enumerated so TA-1B / TA-1E can implement them without redesign.

### Unit — responsibility resolver
- RESOLVED with single primary at CLUB scope
- RESOLVED with PRIMARY + BACKUP at CLUB scope (backups returned)
- RESOLVED with delegation active (`provenance="delegation"`)
- RESOLVED with delegation expired (falls back to primary)
- UNASSIGNED (no rows)
- UNASSIGNED (all rows expired via `effectiveTo`)
- AMBIGUOUS (two PRIMARY rows for a SINGLE_PRIMARY responsibility)
- INACTIVE_OWNER (primary user is `status="SUSPENDED"`)
- INSUFFICIENT_PERMISSION (primary lacks `requiredPermissions`)
- SCOPE_INVALID (missing `departmentId` on DEPARTMENT-scoped)
- UNKNOWN_RESPONSIBILITY (unseeded key)
- Cross-tenant leak: user has assignment at Club B; resolver at Club A returns UNASSIGNED

### Integration — Payroll wiring (TA-1F only)
- Payroll batch calculate → resolver returns RESOLVED → WI owner = expected user
- Payroll batch calculate → resolver returns UNASSIGNED → fallback to `config.controllerUserId` + fallback audit emitted
- Payroll batch calculate → resolver returns UNASSIGNED + config also empty → RESPONSIBILITY_GAP card owned by Tenant Super Admin
- Department time approval → resolver returns AMBIGUOUS → WI owner NULL + candidate list surfaced (no lex-first pick)
- Same-user assignment for `PAYROLL_ADMINISTRATION` and `PAYROLL_FINAL_APPROVAL` → SoD warning emitted; if acknowledged, WI still routes correctly

### Integration — offboarding
- Suspending a User who is PRIMARY on 3 responsibilities → UI blocks with reassignment list
- Force-orphan path → all three become UNASSIGNED and Tenant Super Admin sees 3 gap cards

### Integration — invitation lifecycle
- Send invite → PENDING → SENT
- Redeem → creates User + UserClubRole + UserClubProfile + N ResponsibilityAssignment rows in one transaction
- Revoke unredeemed → transitions to REVOKED, token invalidated
- Resend → new token, prior token invalidated (audit trail preserved)

### Cross-tenant regression
- Every read of `ResponsibilityAssignment` uses `tenantWhere(principal, clubId)` from `src/lib/services/tenant.ts:30-35`
- Cross-club assignment attempt rejected with `TenantViolationError`

---

## Appendix B — Security review

Enumerated threats and mitigations. Every mitigation is a design
constraint on the tables and services proposed above; none is
"add validation" hand-waving.

**T1. Cross-tenant responsibility assignment.**
Threat: a compromised or buggy service creates a
`ResponsibilityAssignment` row where `clubId` differs from the user's
`UserClubRole.clubId`.
Mitigation: DB `CHECK` constraint (Postgres) or service-layer
assertion (both) that `ResponsibilityAssignment.clubId ∈
UserClubRole.clubId` for the assigned user. All writes go through a
single `assignResponsibility(principal, clubId, ...)` helper that
calls `tenantWhere` + `assertTenantOwned`.

**T2. Privilege escalation via responsibility assignment.**
Threat: assigning `PAYROLL_FINAL_APPROVAL` silently grants
`payroll:post`.
Mitigation: **assignments never grant permissions.** Recommended
permissions are surfaced in UI, granted via explicit
`grantPermission` action (separate authority: `users:roles:write`),
each granted with its own audit event.

**T3. Responsibility / permission confusion.**
Threat: developer writes `if (userHasResponsibility(u, "PAYROLL_FINAL_APPROVAL"))`
as an authorization check.
Mitigation: `resolveResponsibilityOwner` explicitly returns
`kind: "check"` results distinct from route/audit results. Code
review lint rule: authorization checks must use `hasPermission` /
`requirePermission`, never a responsibility helper.

**T4. Inactive-user routing.**
Threat: Suspended user still receives PAYROLL_FINAL_APPROVAL WIs.
Mitigation: `INACTIVE_OWNER` resolver result (§16).

**T5. Invitation hijacking.**
Threat: attacker intercepts an admin invitation token.
Mitigation: `tokenHash` is SHA-256 (same as
`MemberPortalInvite.tokenHash` pattern); expiration ≤72h; single-use;
one-shot reveal only in the send response. Post-redemption the raw
token cannot be recovered.

**T6. Arbitrary Employee → User linking.**
Threat: a Tenant Super Admin links their own User to a rival
Employee's record to gain SIN reveal.
Mitigation: `Employee.userId` is set only during
onboarding-invitation redemption (`Employee.personalEmail == invitee
email`) or by an explicit `linkEmployeeToUser` action requiring
`hr:employee:write` + audit + Tenant Super Admin notification.

**T7. Self-escalation by Tenant Super Admin.**
Threat: Tenant Super Admin assigns themselves `PAYROLL_FINAL_APPROVAL`
to short-circuit review.
Mitigation: not architecturally blocked (single-Club sovereignty is
by design). SoD warning + audit + platform SUPER_ADMIN visibility
into `responsibility.sod.warning.acknowledged` audit for oversight.

**T8. Platform SUPER_ADMIN lifecycle.**
Threat: SUPER_ADMIN accounts drift, get orphaned, or accumulate.
Mitigation: platform SUPER_ADMIN remains a `UserClubRole` row with
`clubId=null`. Unchanged by TA-1. Separate slice (out of scope) for
platform admin lifecycle.

**T9. Sensitive HR data leakage through org chart UI.**
Threat: rendering a User card exposes their SIN via `Employee`
join.
Mitigation: `UserClubProfile` never denormalizes anything from
`EmployeeSensitiveIdentity` / `EmployeeBankAccount`. Photo, name,
title, department only. Reveal permissions unchanged.

---

## Appendix C — Open founder decisions

Numbered so responses can be terse.

**D1. `TENANT_ADMINISTRATION` cardinality.**
Single primary per Club (safer, forces explicit succession), or
`PRIMARY_AND_BACKUPS` (more resilient)? Recommendation: **PRIMARY_AND_BACKUPS**
with minimum 1 primary required at all times.

**D2. Auto-inheritance of `TENANT_ADMINISTRATION` for first CLUB_ADMIN.**
When a Club is bootstrapped with a CLUB_ADMIN via SSO or seed, do we
auto-assign them `TENANT_ADMINISTRATION`? Recommendation: **yes**,
with a `provenance="bootstrap"` audit tag; the person can reassign
later.

**D3. Payroll `controllerUserId` fallback duration.**
Phase P3 (§23) proposes an indefinite compatibility fallback with an
audit event. How long? Recommendation: **one full quarter (13 weeks)
past every Club being migrated to the new model**, then Phase P4.

**D4. Responsibility keys founder wants to add / rename before we seed.**
The strawman catalogue (§11) is derived from routing inventory. If
the founder wants different names (e.g. `PAYROLL_APPROVER` instead of
`PAYROLL_FINAL_APPROVAL`), decide before TA-1B seeds them —
renaming after seed is a data migration.

**D5. Admin invitation flow — SSO-only or password-set-flow supported?**
Currently new admins can only arrive via SSO JIT or seed. Adding a
password-set invitation flow is a nontrivial security surface.
Recommendation: **build both** — SSO-first for orgs with SSO
configured, password-set flow for smaller Clubs.

**D6. `UserClubProfile` merge with `UserClubRole` vs sidecar.**
§10.2 argues for a sidecar. Any founder preference to fold
organizational fields onto `UserClubRole` instead? Recommendation:
**sidecar** — keeps the RBAC hot-path minimal.

**D7. Founder-accepted example (Coulee Ridge) target configuration.**
The brief §44 names Raelene (Office Manager, Payroll Administration)
and Chris (Controller, Payroll Final Approval). Confirm those are
the concrete assignments we build the fixture against during TA-1F.
Do NOT change staging DB in TA-1A per brief §45.

---

## Appendix D — Proposed implementation slices (roadmap)

Sequenced by dependency. The exact ordering may shift on founder
review; the point is that no slice starts before its predecessor is
accepted.

- **TA-1A — Architecture & Canonical Model (this document).** Read-only. Founder review, no code.
- **TA-1B — Tenant Membership + Super Admin + Invitations.** Adds `UserClubProfile`, `AdminInvitation`. Wires up the "first user becomes Tenant Super Admin" bootstrap. Invitation redemption + password-set flow. No responsibility model yet — invitations gain proposedResponsibilities as forward-compatible payload.
- **TA-1C — Organizational Positions + Reporting Structure + Org Chart.** Adds `UserClubProfile.title, departmentId, reportsToUserId`. First read-only org chart view. Suspend / reactivate UI.
- **TA-1D — Responsibility Library + Assignment UX.** Adds `Responsibility` + `ResponsibilityAssignment` tables. Seeds the initial catalogue. Assignment UI (drag-drop or list) + Coverage view. Still no runtime consumer.
- **TA-1E — Canonical Responsibility Routing Resolver.** Implements `resolveResponsibilityOwner`. No caller wiring yet. Comprehensive unit-test suite (see Appendix A).
- **TA-1F — Payroll Responsibility Integration.** Dual-write on PayrollClubConfig; read-through in calculate + orchestrate; remove the department-manager lex-first tiebreak. Backfill assignment rows from existing config. This is the first slice with production behaviour change.
- **TA-1G — AP Responsibility Integration.** Route AP invoice / statement / vendor review WIs. Adapt approval-policy engine to responsibility keys.
- **TA-1H — Offboarding safety + delegation.** Adds `ResponsibilityDelegation`. Deactivation guard. Reassignment UI.
- **TA-2A onwards — Remaining modules + PayrollClubConfig deprecation.**

Each slice ends with founder acceptance and produces its own staging deploy. TA-1A produces no deploy.

---

## Appendix E — Files audited (traceability)

Every claim in this document traces to files at HEAD `5a2cbd0`. The
five parallel audit agents that produced the underlying evidence
each returned dense cite-heavy reports; those reports are the
source-of-truth for the file:line references throughout. Every
reader should feel free to spot-check a citation before acting on a
recommendation.

**Primary evidence set (files audited):**
- `prisma/schema.prisma` (SQLite dev)
- `prisma-postgres/schema.prisma` (Postgres prod; spot-checked identical for User / Club / UserClubRole / Role / Permission / RolePermission / Employee / HR onboarding cluster / PayrollClubConfig)
- `src/lib/permissions.ts` — role + permission catalogue
- `src/lib/rbac.ts` — canonical Principal + `hasPermission` + `resolveRecipientsByPermission` + `resolveActiveClubId`
- `src/lib/tenant.ts` (legacy) + `src/lib/services/tenant.ts` (canonical)
- `src/lib/services/principal.ts` — session-to-principal loader
- `src/lib/session.ts` — iron-session cookie
- `src/lib/employee-portal-session.ts` + `src/lib/hr/employee-portal-credential.ts` — third identity system
- `src/lib/hr/employee-onboarding-session.ts` + `src/lib/hr/invitations.ts` + `src/lib/hr/onboarding-sessions.ts` + `src/lib/hr/onboarding-approve-activate.ts` — onboarding
- `src/lib/hr/employees.ts` + `src/lib/hr/notify-hr-change.ts` — HR service layer
- `src/lib/member-invites/index.ts` — member portal invites
- `src/lib/sso/index.ts` + `src/lib/sso/oidc.ts` — SSO JIT
- `src/lib/services/applications.ts` — applicant reviewer
- `src/lib/payroll/club-config.ts` — the two-seat config
- `src/lib/payroll/orchestration.ts` — every Payroll WI orchestrator
- `src/lib/payroll/calculation-execute.ts` — Controller final approval materializer
- `src/lib/payroll/department-approval.ts` — department manager resolution (the one dynamic resolver)
- `src/lib/payroll/opening-balance-import.ts` — the ownerless-orphan writer
- `src/app/app/admin/payroll/setup/page.tsx` — role-filtered dropdown source
- `src/app/app/admin/payroll/process/page.tsx` — Controller Approval Queue query (no user filter)
- `src/app/app/admin/payroll/batches/[batchId]/page.tsx` — Payroll Review page permission gate
- `src/app/app/admin/layout.tsx` — the admin shell gate on deprecated `User.role`
- `src/lib/work-intake/actions.ts` — the only cross-user assignment API (`assignToSelf`)
- `src/lib/work-intake/tenant.ts` — mailbox visibility filter
- `src/lib/work-intake/materializer.ts` — the ORCHESTRATION_FIELDS invariant
- `src/lib/mailbox/email-materializer.ts` — email-derived WI (ownerless)
- `src/lib/ap-intelligence/materialise.ts` + `src/lib/ap-statement-intelligence/materialise.ts` + `src/lib/vendor-intelligence/materialise.ts` — three ownerless AP-adjacent WI writers
- `src/lib/intelligence/materialisers/ar-aging.ts` — ownerless AR-aging WI
- `src/lib/intelligence/origins.ts` — origin-only writer
- `src/lib/mission-control/index.ts` + `src/lib/mission-control/email-intake.ts` + `src/lib/mission-control/intelligence-review-intakes.ts` — feed loaders (no owner filter)
- `src/lib/ap/approvals.ts` + `src/lib/ap/invoices.ts` + `src/lib/ap/vendors.ts` + `src/lib/ap/capture.ts` + `src/lib/ap/payment-batches.ts` + `src/lib/ap/exceptions.ts` — AP module
- `src/lib/enterprise/packages.ts` + `src/lib/reporting/monthly-package-lifecycle.ts` + `src/lib/enterprise/workflow.ts` + `src/lib/enterprise/kpi.ts` + `src/lib/enterprise/auditor.ts` — governance / reporting / workflow engine
- `src/lib/incidents/index.ts` + `src/lib/retrospective/index.ts` + `src/lib/pilot-onboarding/index.ts` — secondary manual-assignment modules
- `src/lib/hospitality/surveys.ts` — service-recovery routing table
- `src/lib/mfa/index.ts` + `src/lib/support-access/index.ts` + `src/lib/pilot/index.ts` — role-literal-based platform checks
- `src/lib/posting-guard/index.ts` — financial posting boundary + sensitive-action guard
- `src/lib/hr/sensitive-identity.ts` + `src/lib/hr/bank-account.ts` + `src/lib/hr/tax-profile.ts` — SIN / banking / tax reveal services

If a follow-up slice needs the raw audit reports, they're preserved
in the session's task-output files under
`C:\Users\cturcato\AppData\Local\Temp\claude\c--dev-SpectreAutomation\0024fdd7-1cbc-4a67-8903-1a917d6d43e4\tasks\`.
