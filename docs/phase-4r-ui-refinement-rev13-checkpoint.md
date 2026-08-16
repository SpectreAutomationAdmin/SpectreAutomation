# Phase 4R rev-13 — Outlook Read/Unread Sync Fixes (LIVE ROUND-TRIP PASSED)

**Date:** 2026-08-16
**Author:** Claude Opus 4.7 (implementation of rev-12 diagnostic + two live-discovered fixes)
**Branch:** `work-intake-state-outlook-archive-fix`
**Commits:** `5152433` (rev-13 core), `33c61b3` (INITIAL_SYNC on manual refresh), `a86eada` (per-message re-verify)
**Staging web:** v240 → v241 → v242 → v243 → **v244**
**Staging worker:** v116 → **v117**
**Rollback anchors:** web **v240** (pre-rev-13), worker **v116**

---

## 1. Exact implementation of Fix A — manual Feed Sync barrier

Three components:

**NEW POST endpoint** `src/app/api/mission-control/refresh-mailbox/route.ts`
- Enumerates the caller's non-terminal MailboxConnections (access-list scoped).
- Enqueues `MAILBOX_INITIAL_SYNC` per connection (see §6 for why not delta). `idempotencyKey: mailbox:manual-refresh:{id}:{5s-bucket}` — rapid clicks collapse, distinct clicks re-enqueue.
- **INLINE per-message re-verify** (see §4) — for open Work Intake items with a PRIMARY email origin, calls Graph `GET /me/messages/{id}?$select=isRead` directly and updates the local mirror. This covers messages that have moved out of the inbox.
- Returns `202 { jobIds, mailboxConnectionIds, enqueuedAt, reverifiedCount, reverifyErrors }`.

**NEW GET status endpoint** `src/app/api/mission-control/refresh-mailbox/status/route.ts`
- Query param `?jobIds=a,b,c`. Returns `{ jobs, allTerminal, anyFailed, summarizedAt }`.
- Terminal statuses: `COMPLETED | DEAD_LETTER | CANCELLED` (matches the queue's actual DB states).
- Tenant-scoped by caller's active clubId.

**Rewired client** `src/components/mission-control/LiveRefreshContext.tsx`
- `doManualRefresh` now:
  1. POST `/refresh-mailbox` → get jobIds.
  2. Poll `/refresh-mailbox/status` every 1 s (30 s wall-clock timeout).
  3. On `allTerminal && !anyFailed` → fetch snapshot-summary + router.refresh + `FEED SYNCED`.
  4. On failure / timeout → set restrained error state (`sync_failed` / `sync_timeout` / `no_mailbox` / `network` / `unauthenticated` / `server`). Pill reads REFRESH FAILED via the existing rev-6 amber tone.
- `doBackgroundRefresh` UNCHANGED — silent, hits snapshot-summary only, never enqueues a sync (founder brief §13 preserved).

## 2. Exact implementation of Fix B — retire permanent mutation latch

**Prisma migration** `20260816_phase4r_rev13_mark_read_generations`:
- Drops `@@unique([mailboxConnectionId, emailMessageId])` on `OutlookMarkReadMutation`.
- Adds `generationCursor String?` audit column.
- Adds `@@index([mailboxConnectionId, emailMessageId, status])` for active-intent dedupe query.
- Historical rows preserved verbatim.

**Enqueue site** `src/lib/work-intake/actions.ts::enqueueOutlookMarkReadForLinkedEmails`:
- Queries for existing ACTIVE mutation row (status IN `['PENDING','RUNNING','RETRYABLE']`) — historical statuses (SUCCEEDED, FAILED_TERMINAL, NOT_REQUIRED, SUPERSEDED) DO NOT block a new intent.
- If active exists → skip enqueue with `active-intent-dedupe` log; else CREATE a new mutation row (status=PENDING, generationCursor=email.updatedAt.toISOString()).
- Passes `markReadMutationId` in the payload so worker + enqueue agree on which row this intent owns.
- `idempotencyKey` includes the mutation ID so each generation has its own key.

**Worker** `src/lib/mailbox/mark-read.ts`:
- Loads mutation by ID (backward-compat fallback: creates a fresh row if payload lacks the ID during a rolling deploy).
- **REMOVED** the `mutation.status === "SUCCEEDED"` and `=== "FAILED_TERMINAL"` short-circuits that permanently latched.
- Executes Graph PATCH, updates the specific row through its own lifecycle.
- SUPERSEDED guard scopes to THIS row's createdAt (attemptCount ≥ 2 AND email.lastSyncedAt > mutationRow.createdAt).

## 3. Mutation-generation / deduplication invariant

- Each Spectre-initiated read intent is a separate `OutlookMarkReadMutation` row (a "generation").
- Historical rows (SUCCEEDED, FAILED_TERMINAL, NOT_REQUIRED, SUPERSEDED) are immutable audit and do NOT block a new intent.
- **Active dedupe**: a click while another mutation for the same `(mailboxConnectionId, emailMessageId)` is still PENDING / RUNNING / RETRYABLE returns without enqueueing (`active-intent-dedupe` log entry).
- **Live evidence** (`test-results/phase-4r-rev13-round-trip/round-trip-evidence.json`): after Stage B click, `historyLengthBefore=1` (the pre-existing rev-12 SUCCEEDED from 04:25:17), `historyLengthAfter=2` — Mutation A `cmsvaxagp01k0143cbb6v4i4z` retained + Mutation B `cmsw15qlp000o8ucxzd7zza9f` newly created (SUCCEEDED at 16:39:41.717).

## 4. Exact implementation of Fix C — tri-state ingestion

**`src/lib/mailbox/normalize.ts`**: `NormalizedEmail.isRead` and `.hasAttachments` now `boolean | undefined`. Replaced `raw.isRead ?? false` (which corrupted `undefined` → `false`) with `typeof raw.isRead === "boolean" ? raw.isRead : undefined`. Same for `hasAttachments`.

**`src/lib/mailbox/sync.ts`**: Split into `updateData` (only sets tri-state fields when a boolean was asserted) vs `createData` (supplies `false` default for first-seen records). This preserves the mirror value when Graph doesn't assert a partial-update record's isRead flag.

**`src/lib/mailbox/classifier.ts`**: Consumers updated to use `=== true` explicit checks so `undefined` doesn't falsely count as "has attachments" or "unread".

## 5. Whether a Prisma migration was required

**Yes** — `20260816_phase4r_rev13_mark_read_generations`:
- SQL: `ALTER TABLE OutlookMarkReadMutation ADD COLUMN generationCursor TEXT; DROP INDEX IF EXISTS OutlookMarkReadMutation_conn_msg_uniq; CREATE INDEX OutlookMarkReadMutation_conn_msg_status_idx ON OutlookMarkReadMutation(mailboxConnectionId, emailMessageId, status);`
- Additive change (new column + new index) + one DROP INDEX.
- **Existing rows preserved verbatim.** Historical SUCCEEDED entries have `generationCursor = NULL` and remain queryable as immutable audit.
- **Rollback caveat**: re-adding the `@@unique` after rollback would fail if any `(mailbox, message)` now has more than one row. Data cleanup step required first. Documented in the migration SQL.

## 6. Manual Feed Sync success/failure semantics

**Success path**:
- Founder clicks refresh → pill flips to REFRESHING…
- POST /refresh-mailbox enqueues `MAILBOX_INITIAL_SYNC` + performs INLINE per-message re-verify.
- Client polls status every 1 s until `allTerminal && !anyFailed`.
- Client fetches snapshot-summary + router.refresh.
- Pill returns to FEED SYNCED.

**Failure paths (restrained UI — pill reads REFRESH FAILED via existing rev-6 amber tone, no toast):**
- `unauthenticated` — 401 from either endpoint.
- `no_mailbox` — 409 from POST (no non-terminal mailbox for this founder).
- `server` — non-401/409 error from POST or GET.
- `sync_failed` — poll reported `anyFailed=true`.
- `sync_timeout` — 30 s wall-clock timeout without `allTerminal`.
- `network` — fetch throw.

**Background auto-refresh UNCHANGED** — still hits snapshot-summary only, no visible state (founder brief §13 preserved).

## 7. Files changed

Code (production):
- **NEW** `src/app/api/mission-control/refresh-mailbox/route.ts` — POST enqueue + inline per-message re-verify.
- **NEW** `src/app/api/mission-control/refresh-mailbox/status/route.ts` — GET job status.
- `src/components/mission-control/LiveRefreshContext.tsx` — split manual vs background paths; manual POSTs + polls + gates completion; new error types.
- `src/lib/mailbox/mark-read.ts` — retire SUCCEEDED short-circuit; take mutation ID from payload; per-generation lifecycle.
- `src/lib/work-intake/actions.ts::enqueueOutlookMarkReadForLinkedEmails` — active-intent dedupe; create new mutation row per generation.
- `src/lib/mailbox/normalize.ts` — tri-state isRead + hasAttachments.
- `src/lib/mailbox/sync.ts` — split updateData vs createData; conditional writes.
- `src/lib/mailbox/classifier.ts` — explicit `=== true` on consumers.
- `prisma-postgres/schema.prisma` + `prisma/schema.prisma` — retire `@@unique`; add `generationCursor` + composite index.

Tests:
- `tests/work-intake-card-tab-model.test.ts` — 12 new rev-13 pins (mutation-generation, tri-state, refresh barrier, per-message re-verify).
- `tests/phase-4r-rev10-outlook-mark-read.test.ts` — rev-10 pins updated to expect rev-13 shape.
- **NEW** `tests/e2e/phase-4r-rev13-round-trip.staging.spec.ts` — live acceptance for #221007 Stage A + B + fleet consistency.
- **NEW** `tests/e2e/phase-4r-rev13-debug-sync.staging.spec.ts` — diagnostic used to identify the "message out of inbox" finding.

Migration:
- **NEW** `prisma-postgres/migrations/20260816_phase4r_rev13_mark_read_generations/migration.sql`
- **NEW** `prisma/migrations/20260816_phase4r_rev13_mark_read_generations/migration.sql`

Docs:
- **NEW** `docs/phase-4r-ui-refinement-rev13-checkpoint.md` (this file).

## 8. Tests run and exact results

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| `tests/work-intake-card-tab-model.test.ts` (rev-7 through rev-13, 62 pins) | **62/62 pass** |
| `tests/phase-4r-rev10-outlook-mark-read.test.ts` (source-contract) | **8/8 pass**, 7 behavioural auto-skip locally (Windows Prisma DLL lock) |
| Playwright `phase-4r-rev13-round-trip` on v244 | **PASS** — see §14 |
| Rev-11 + rev-12 pins still enforced | Yes (updated where shape changed) |

## 9. Web staging version

**v244** (`spectre-staging:deployment-01M04…`) — `/api/health` HTTP 200.

## 10. Worker staging version

**v117** (`spectre-staging-worker:deployment-01M04…`) — rolling 2-machine deploy.

## 11. Rollback anchors

- Web **v240** (pre-rev-13, includes rev-12 architecture with permanent SUCCEEDED latch).
- Worker **v116** (rev-12 mark-read handler).
- Or `git revert a86eada 33c61b3 5152433` on the branch.
- Migration rollback caveat: if any `(mailboxConnectionId, emailMessageId)` now has more than one row, re-adding `@@unique` requires a data cleanup step first.

## 12. #221007 live Graph → DB → UI → Graph round-trip evidence

`test-results/phase-4r-rev13-round-trip/round-trip-evidence.json`:

```
STARTING STATE:
  graph.isRead      = false   (Outlook says UNREAD)
  db.isRead         = true    (STALE — 12h old mirror)
  ui.dataUnread     = "false" (Spectre wrongly shows read)
  ui.borderLeftWidth = 3px
  history           = 1 mutation (Rev-12 SUCCEEDED from 04:25:17)

STAGE A — Manual refresh POST /refresh-mailbox:
  enqueued 1 job (INITIAL_SYNC + inline per-message re-verify)
  Poll to terminal: 1.84s total
  POST-SYNC STATE:
    graph.isRead      = false
    db.isRead         = false   ← MIRROR FLIPPED
    ui.dataUnread     = "true"  ← CARD RENDERS UNREAD
    ui.borderLeftWidth = 6px    ← THICK ACCENT ✓
    ui.h3FontWeight   = 700     ← BOLD TITLE ✓
  Screenshot: 01-stage-A-unread-after-manual-refresh.png

STAGE B — Interaction:
  Click Conversation tab on #221007
  60s poll for new SUCCEEDED mutation:
    NEW mutation cmsw15qlp000o8ucxzd7zza9f
      status: SUCCEEDED
      attemptCount: 1
      createdAt:  2026-08-16T16:39:40.525Z
      completedAt:2026-08-16T16:39:41.717Z  (Graph latency: 1.19s)
    Graph now: isRead=true
    DB now:    isRead=true
    history:   2 mutations (both SUCCEEDED)
  Screenshot: 02-stage-B-read-after-click.png
```

## 13. Mutation A + Mutation B evidence proving repeated cycles

From `round-trip-evidence.json.stageB.allMutations` — both preserved as immutable audit:

```
MUTATION B (rev-13, this run):
  id:          cmsw15qlp000o8ucxzd7zza9f
  status:      SUCCEEDED
  createdAt:   2026-08-16T16:39:40.525Z
  completedAt: 2026-08-16T16:39:41.717Z

MUTATION A (rev-12 historical):
  id:          cmsvaxagp01k0143cbb6v4i4z
  status:      SUCCEEDED
  createdAt:   2026-08-16T04:25:16.345Z
  completedAt: 2026-08-16T04:25:17.007Z
```

`A.id !== B.id`. Both are `SUCCEEDED`. Both remain in history. This is the exact invariant founder brief §7 required. The pre-rev-13 `@@unique([mailboxConnectionId, emailMessageId])` would have made this impossible; rev-13's generation model produces it.

## 14. Fleet-wide Graph/DB/UI comparison after the test

From `round-trip-evidence.json.fleetConsistency`:

```
total: 10
agreeCount: 10
disagreeCount: 0
```

**Every Outlook-backed Work Intake card on the founder fleet now has Graph.isRead === DB.isRead === (rendered as read iff not-unread).** This is the founder brief §23 requirement met.

Full fleet screenshot: `03-mission-control-full-fleet.png`.

## 15. Screenshot evidence of #221007 unread and read states

- `test-results/phase-4r-rev13-round-trip/01-stage-A-unread-after-manual-refresh.png` — #221007 in UNREAD state after refresh restored Graph agreement. Thick 6 px AP-orange accent + bold title.
- `test-results/phase-4r-rev13-round-trip/02-stage-B-read-after-click.png` — Same card after Stage B click. Thin 3 px accent + normal-weight title. No green dot. Identical geometry.

## 16. Unexpected findings

- **Founder-reported "Outlook unmark didn't reach Spectre" turned out to be TWO defects**, not one:
  1. Feed Refresh didn't enqueue a mailbox sync (Defect A from the rev-12 diagnostic).
  2. Even with a mailbox sync enqueued, Microsoft Graph's inbox delta stream returns `messagesExamined=0` for messages Outlook moved out of the inbox (e.g. archived by Spectre's rev-16H post-completion archive worker, or moved manually). Live evidence on staging: three separate delta polls of the Coulee Ridge mailbox after founder unmarked #221007 returned zero messages, despite `graphProbe.isRead=false` for #221007 on a direct GET. Same behaviour on `MAILBOX_INITIAL_SYNC` (inbox-scoped).
  
  Fix: manual refresh does NOT rely on inbox sync alone. It ALSO performs an INLINE per-message Graph GET for every open Work Intake item's PRIMARY email, regardless of folder. Bounded to ≤50 items per club per refresh. This was the second live-discovered fix in rev-13.

- **#221007's `parentFolderId` proved the "message moved out of inbox" hypothesis on staging.** The Graph probe returned `parentFolderId: AQMkADI5...` (an Outlook folder ID that is NOT the inbox). Consistent with Spectre's rev-16H archive-on-completion behaviour.

- **Historical rev-12 SUCCEEDED row was preserved verbatim through the rev-13 migration.** No data loss. The generation model treats it as one entry in the audit history and does not block a new intent.

- **62 source-contract pins now cover rev-7 through rev-13** including the retirements (no green dot, no OR-latch, no permanent SUCCEEDED short-circuit, no inbox-only manual refresh) and the additions (thick unread accent, tri-state normalize, active-intent dedupe, per-message re-verify).

---

## What still requires founder-driven Outlook action

Stages C + D (founder marks #221007 unread in Outlook again → manual refresh → Spectre unread again → click → Graph read → new Mutation C created) are **architecturally proven** by:

- Fix A (manual refresh → inline per-message re-verify) — same code path that produced Stage A's DB flip will produce Stage C's flip.
- Fix B (generation model, live evidence: 2 mutations coexist) — a third click will create Mutation C.

The live sequence can be observed by the founder any time they perform the Outlook-side unmark and re-click. Rerunning `tests/e2e/phase-4r-rev13-round-trip.staging.spec.ts` from a state where #221007 is currently unread in Outlook will exercise it.

---

Stopping here for founder review. No further phase started.
