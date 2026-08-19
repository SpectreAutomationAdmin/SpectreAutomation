# Phase 20 — Admin Member Database + Individual Member Profile

**Date:** 2026-08-15  
**Author:** Claude Opus 4.7 (under founder authorization)  
**Branch:** `work-intake-state-outlook-archive-fix`  
**Commit:** `8668cef`  
**Staging web:** v224 → **v225** (`spectre-staging:deployment-01M03XKGDEXWARAZXPQK5FN1QG`)  
**Staging worker:** v114 (unchanged)  
**Rollback anchor:** web v224 / `spectre-staging:deployment-01M03JNPXJYM3VE17JVPD276HP`

---

## Architecture

### Existing member architecture discovered

Prior state (from full audit at start of the phase):
- `Member` (`prisma/schema.prisma:788`) — the single existing "member" row. Carries the primary person's demographics (firstName / lastName / email / phone / dateOfBirth / address*) AND the membership identity (`memberNumber`, `status`, `joinDate`, `membershipCategory` as free-text). Uniqueness: `@@unique([clubId, memberNumber])`. 25+ downstream tables (AR, POS, tee sheet, tournaments, dining, etc.) already FK to `Member.id`.
- `MemberHouseholdMember` (`prisma/schema.prisma:1381`) — associated persons attached to a primary Member. Carries firstName / lastName / relationship / email / phone / dateOfBirth.
- No `Membership` root entity distinct from `Member` — status/category live inline on `Member`.
- No `MemberGroup`, no member tags, no custom-fields catalog before this phase.
- Existing admin routes: `/app/admin/members` (roster table) and `/app/admin/members/[id]` (profile) both replaced this phase.

### Schema / model changes

**Additive to existing rows** (no destructive migration):

- `Member` — six new nullable fields: `middleName`, `nickname`, `salutation`, `gender`, `homePhone`, `profileImageUrl`. Plus two new back-relations: `groupAssignments`, `customFieldValues`.
- `MemberHouseholdMember` — same six new nullable fields so the person-switcher renders the same Basic Details grid for every person on the membership.

**Four new club-scoped models:**

| Model | Purpose |
|---|---|
| `MemberGroup` | per-club segmentation vocabulary (Sailing Approved, Tennis, Wednesday Night Racing, …). `@@unique([clubId, name])`. |
| `MemberGroupAssignment` | explicit `Member ↔ MemberGroup` many-to-many with `assignedAt` + `assignedByUserId` audit fields. `@@unique([memberId, groupId])`. |
| `MemberCustomFieldDefinition` | per-club catalog of extensible fields (`key`, `label`, `kind`, `helpText`, `optionsJson`, `sortOrder`, `archivedAt`). `@@unique([clubId, key])`. |
| `MemberCustomFieldValue` | sparse per-member value payload. Stored as `valueText: String?` for portability across SQLite (staging/dev) and Postgres (prod). `@@unique([memberId, definitionId])`. |

`Club` gains four back-relations mirroring the four new models. Postgres migration `20260815_phase20_member_database` mirrors the SQLite schema and runs via the existing Fly `release_command`.

### Routes / API changes

- `/app/admin/members` — rewrite: Member Database (dense operational table + filters).
- `/app/admin/members/[id]` — rewrite: Member Profile shell (identity header + primary tabs + Member tab).
- `/app/admin/members/[id]/_actions.ts` (new) — six server actions bound-property-passed into the client view: `editPrimaryDetails`, `addAssociatedPerson`, `removeAssociatedPerson`, `addGroup`, `removeGroup`, `setCustomField`.
- No new HTTP endpoints — all writes are Next.js server actions.

### Tenant / RBAC considerations

- Every new model carries `clubId` and is indexed on `(clubId, …)`.
- Every mutation runs through the existing `assertTenantOwned(member, principal)` guard before touching data.
- Permission gate: `members:write` (existing, already granted to `SUPER_ADMIN`, `CLUB_ADMIN`, `GENERAL_MANAGER`). No new permission keys were introduced this phase; a future "define custom fields" surface can add one when needed.
- All writes call `audit()` with a structured event (`member.group.assign`, `member.group.remove`, `member.customField.set`, `member.profile.update`, `member.household.add`, `member.household.remove`).

---

## UI

### Member Database implementation

`/app/admin/members` — dense operational roster.

- Header title + total-in-tenant count.
- URL-driven filter bar (`?q=…&status=…&category=…&group=…&sort=…`): search (name / email / member number), status select, category select, group select, sort select (Last name / Member # / Category / Status / Newest first), Apply, Clear.
- Table columns: photo (avatar/initials placeholder), Name, Member #, Category, Status pill, Email (mailto), Mobile (tel), Member since.
- Empty state ("No members yet. Add your first member to begin building this club's roster.") or filter-scoped ("No members match those filters.").
- Row → member profile navigation.
- Tenant-scoped: every query filters on `clubId`, guaranteed by `getActiveClubId(user)`.

### Member Profile implementation

`/app/admin/members/[id]` — reference-matching layout.

- **Identity header** (compact, per reference):
  - Back arrow, photo (rectangular 40×40), full name (18 px, not a hero title), meta line: `MEMBER SINCE <date> | <member#>`, right-aligned ACTIVE / ONBOARDING / etc. pill.
- **Primary tabs** (Spectre subtle-underline treatment): Member (active) · Plan · Billing · E-signatures · Notes · Documents · overflow `…` (disabled with title "additional actions live in a future phase").
- **Member tab content:**
  - Section title `Member info`.
  - **Person switcher** — a row of primary + household + `× remove` chips + `+ add member` inline form. Selected person receives the accent underline.
  - Two-column body:
    - **Left column:**
      - `BASIC DETAILS` — 200-px label / value grid; missing fields render as `Not provided`; edit toggle opens an inline form (only enabled for the primary person; household edits are deferred).
      - `OTHER INFORMATION` — Member Code + Category.
      - `ADDITIONAL INFORMATION` — dynamic custom-field rows; inline edit-in-place per field.
    - **Right column:**
      - `MEMBER PICTURE` — 200×240 rectangular per reference; fallback = initials block.
      - `GROUPS` — chip list (uppercase caps, hairline border) with per-chip × remove + `+ ADD GROUP` inline datalist.

### Associated-person behaviour

- Primary member and every `MemberHouseholdMember` share one `Member info` grid.
- `?person=<householdId>` URL param drives the active person; `primary` (or missing) = the Member row itself.
- The Basic Details grid re-reads the selected person's fields; the Member Picture also swaps to that person's `profileImageUrl` fallback.
- `+ add member` inline form binds to the existing `addHouseholdMember` service. `×` beside each associated person calls `removeHouseholdMember`.

### Groups / custom-field implementation

- Groups are a per-club many-to-many. `assignGroupByName` upserts the group lazily (a group is created if it doesn't yet exist in that club). `removeGroupAssignment` is a no-op for a group the member is not in. The `+ ADD GROUP` datalist offers existing groups but lets the founder type a brand-new name.
- Custom fields are Definition + sparse Value. `getMemberFieldPayload` joins the two so the UI renders every active field in `sortOrder` with either the current value or "Not provided". Empty submissions clear the row (`setMemberFieldValue(null)` deletes).

---

## Verification

### Tests run

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| `npm run scan:placeholders` | No new placeholders in touched files (only pre-existing prisma/schema.prisma + prisma/seed.ts hits) |
| `tests/member-groups-and-custom-fields.test.ts` (NEW) | **12/12 pass** — tenant scoping (CLUB_A / CLUB_B isolation), idempotent group assign, group remove, permission gate (`members:write` required), custom-field upsert, custom-field value upsert / null-clear, tenant-scoped catalog. |
| Regression sweep across rev-2 → rev-6 chrome + timezone + breadcrumb + refresh | **191/191 pass** |
| Playwright staging acceptance | **PASS** (see below) |

### Playwright / browser result

`tests/e2e/phase-20-member-database.staging.spec.ts` runs against `spectre-staging` v225 at 1440 × 900:

- Members list page renders with `Members` title, empty state message, filter bar visible.
- Sidebar `SPECTRE / AUTOMATION` eyebrow intact; canonical Spectre chrome on the new admin route.
- Header rail crumbs on the list = `["App","Members"]` (tenant prominent above breadcrumb per rev-4).
- No members exist on Coulee Ridge FOUNDER_REVIEW tenant (per infra rule — synthetic Members forbidden), so the profile assertions are correctly skipped by the spec with an explicit log line.

Screenshot: `test-results/phase-20-member-database/after/01-members-list.png` shows the canonical shell + the Members Database empty state.

### Any regressions

None. The rev-6 canonical Spectre chrome, rev-5 breadcrumb taxonomy, rev-4 shell + search, rev-3 timezone + AM/PM commitments, and rev-2 SPECTRE/AUTOMATION identity all remain intact on this deploy (verified by the acceptance spec + full regression sweep).

The prior `/app/admin/members/[id]` route rendered a large detail experience with charges, payments, financing, dining, and collections tabs. This phase intentionally deferred those tabs to a subsequent slice per the founder's scope discipline (§15 of the brief — Plan / Billing / E-signatures / Notes / Documents are all placeholder shells in this phase; their prior content will be rebuilt deliberately in future phases). This is a deliberate change, not a regression.

---

## Founder Review

**Founder-visible URL — currently deployable on Coulee Ridge staging:**

1. **Member Database** — https://staging.spectreautomation.com/app/admin/members  
   The page renders the canonical Spectre chrome + the new Members Database table + filter bar + empty state.

**Founder-visible URLs — currently NOT populated on staging:**

Coulee Ridge is the FOUNDER_REVIEW staging tenant and its infra rule forbids synthetic Members / Vendors / AR balances / Work Intake cards (see `~/.claude/projects/…/memory/reference_staging_infra.md`). Consequently no fictional single-member / couple / family fixtures were seeded on staging. To review the Member Profile experience with real multi-shape fixtures, run locally:

```
npm run db:reset      # seeds the Silver Springs demo tenant
npm run dev           # http://localhost:3000
# sign in as member+admin (silver.springs.admin@example.com / password)
```

Local demo URLs (Silver Springs tenant, populated by the seed extension in this commit):

2. **Single-member membership (Aisha Khan)** — http://localhost:3000/app/admin/members  → click Aisha Khan  
3. **Couple membership (Robert + Priya Tanner)** — same list → click Robert Tanner  
4. **Family membership (James + Grace Whitfield + Ethan + Ava)** — same list → click James Whitfield

If you'd like real fictional members surfaced on the staging Coulee Ridge tenant despite the FOUNDER_REVIEW rule, that's a founder-mode decision — please authorise and I'll adjust `stagingDataMode` or create real (non-synthetic) member rows through the existing admin path in a follow-up.

---

## Scope discipline (per founder brief §15)

Built this phase:
1. Member Database
2. Membership/member data model (extended existing rows + four new club-scoped models)
3. Member Profile shell
4. Member tab (person switcher, Basic Details, Picture, Groups, Other Information, Additional Information)
5. Associated-person switching
6. Groups (real many-to-many, add / remove, per-club vocabulary)
7. Custom fields (extensible per-club catalog, sparse per-member values)
8. Navigation placeholders for Plan / Billing / E-signatures / Notes / Documents tabs

Explicitly NOT built (scoped out per founder discipline):
- Plan / Billing / E-signatures / Notes / Documents tab content — the prior route's charges / payments / financing / dining / collections surfaces are temporarily off the profile pending the deliberate rebuild of each tab in subsequent phases.
- Photo upload plumbing — the picture area renders whatever `profileImageUrl` the seed assigns or an initials placeholder; a small "Photo upload lands in a follow-up phase." caption sits below.
- "+ New member" affordance on the Members Database (the reference screenshot doesn't show one either).
- Admin surface for CRUD-ing the custom-field catalog (a per-club field definition editor). Definitions are seeded for now; a follow-up phase can add an admin editor.

---

## Rollback

```
flyctl deploy -c deploy/fly.web.toml --app spectre-staging \
  --image spectre-staging:deployment-01M03JNPXJYM3VE17JVPD276HP
```

The Postgres migration `20260815_phase20_member_database` is additive (new tables + new nullable columns); a rollback of the app image leaves the schema safely intact and rolls the UI back to v224.

or `git revert 8668cef` on the branch (then redeploy).
