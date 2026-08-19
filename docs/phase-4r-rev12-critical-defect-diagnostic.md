# Phase 4R rev-12 — CRITICAL Defect Diagnostic Checkpoint

**Date:** 2026-08-16
**Author:** Claude Opus 4.7 — DIAGNOSTIC-ONLY (no production logic changed)
**Branch:** `work-intake-state-outlook-archive-fix`
**Diagnostic commits:** `89fc085` (debug endpoint timestamps), `95df087` (live-Graph probe)
**Staging web:** v240 → **v241** (diagnostic-only)
**Staging worker:** **v116 unchanged**

---

**Status:** Rev-12 as-deployed is INCORRECT. Three independent defects converge to produce the founder's four observations. This document is the pre-fix diagnostic checkpoint founder brief §20 requires. **No architectural code was changed.** Fixes will follow only after founder review of the evidence below.

---

## 1. All 9 cards — live Graph vs DB vs loader vs rendered

Captured 2026-08-16 (`test-results/phase-4r-rev12-fleet-diagnostic/fleet-state-table.json`) with staging debug endpoint `?probeGraph=1`:

| # | Invoice | Graph.isRead | DB.isRead | Rendered | Border | Mutation | First divergence |
|---|---|---|---|---|---|---|---|
| 0 | **#221007** | **false** | **true** | **read** | 3 px | SUCCEEDED | **GRAPH → DB** |
| 1 | #220824 | true | true | read | 3 px | SUCCEEDED | NONE |
| 2 | #221178 | true | true | read | 3 px | SUCCEEDED | NONE |
| 3 | #B0037FC | true | true | read | 3 px | SUCCEEDED | NONE |
| 4 | #1091559-00 | true | true | read | 3 px | SUCCEEDED | NONE |
| 5 | #1087769-00 | true | true | read | 3 px | SUCCEEDED | NONE |
| 6 | #OXIO-23375874 | true | true | read | 3 px | SUCCEEDED | NONE |
| 7 | #1007565767 | true | true | read | 3 px | SUCCEEDED | NONE |
| 8 | #1007565767 | true | true | read | 3 px | none | NONE |

**Summary**: 1 of 9 diverges. All 8 others: Graph agrees with DB agrees with rendered.

## 2. Exact #221007 identity/linkage

| Field | Value |
|---|---|
| Card title | `Club Support Inc invoice #221007 — $707.17 CAD · Telephone & Internet` |
| WorkIntakeItem ID | `cmsva78pg1yr97lfzpc7m27bx` |
| EmailMessage ID | `cmsva78jt1yr37lfzuf66wvh3` |
| Graph message ID (tail) | `…-YZhwAA` (full: `AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0Ardd-dRWR00WxuT03NOeYXwAAD-YZhwAA`) |
| MailboxConnection | `mc_12ae4f133112f19fa30806c2239da4b6` (status CONNECTED) |
| PRIMARY EmailWorkIntakeOrigin | single row present, role `PRIMARY` |
| Graph subject (via live probe) | matches DB `EmailMessage.subject` |
| Graph receivedDateTime | matches DB `EmailMessage.receivedAt` |

Identity is not the problem — Spectre is tracking the same Outlook message the founder is looking at.

## 3. #221007 live Graph `isRead`

**`isRead: false`** — confirmed via live `GET /v1.0/me/messages/{id}` through the same delegated provider the worker uses. Reading the exact same message the founder is viewing. Outlook says UNREAD.

## 4. #221007 DB mirror `isRead`

**`isRead: true`** — `EmailMessage.isRead` in the local mirror still reports READ. Last time this row was ingested from a delta stream: `2026-08-16T04:05:00.808Z` — approximately 11 hours ago. `EmailMessage.updatedAt: 2026-08-16T14:01:35.355Z` (a later write bumped Prisma's timestamp but did not change `isRead`).

Meanwhile the mailbox as a whole has synced repeatedly since — `MailboxConnection.lastSuccessfulSyncAt: 2026-08-16T14:53:34.230Z` (37 s before the diagnostic ran). **The delta stream since the founder's Outlook unmark has NOT included #221007 as a changed record.**

## 5. #221007 loader `isUnread`

The rev-12 loader is functioning correctly given its inputs — it reads `EmailMessage.isRead=true` and projects `item.isUnread=false`. The loader itself is not the bug. The bug is that its input is stale.

## 6. #221007 rendered state

Rendered as READ: `data-unread="false"`, `border-left-width: 3px`, `padding-left: 20px`, `h3 font-weight: 600`, no `::after` dot. Rendered state is consistent with the loader's `isUnread=false`. The CSS + component are not the bug.

## 7. Exact sequence triggered by manual Feed Refresh

Traced end-to-end (`src/components/mission-control/FeedSyncedStatusPill.tsx` + `LiveRefreshContext.tsx`):

```
[UI] Founder clicks refresh icon
   ↓
[state] setManualRefreshing(true) — pill shows REFRESHING
   ↓
[HTTP] GET /api/mission-control/snapshot-summary
   ↓
[server] loadMissionControlSnapshot(principal, clubId)   ← PURE PRISMA READ
                                                            of already-persisted rows
   ↓
[HTTP] 200 OK, returns snapshot IDs + counts
   ↓
[client] router.refresh()  — Next.js re-fetches the RSC route
   ↓
[state] setManualRefreshing(false) — pill returns to FEED SYNCED
```

**No POST is ever fired.** No mailbox sync endpoint is called. No `MAILBOX_DELTA_SYNC` is enqueued. No Microsoft Graph request goes out. The pill flips back to FEED SYNCED strictly because `snapshot-summary` GET returned — nothing about mailbox reconciliation is awaited or verified.

The actual mailbox delta polling happens **completely decoupled** in `bin/worker.ts` via `src/lib/mailbox/auto-sync-scheduler.ts::tickAutoSync` (default 60 s interval, min-gap 30 s). The UI has no awareness of when — or whether — that worker-side scheduler last ran.

## 8. Whether Feed Refresh waits for mailbox synchronization

**No.** Feed Refresh performs a DB re-read only. It does not enqueue a mailbox sync, does not wait for one, and has no completion contract tied to a Graph delta call. This is the founder's Observation #4 root cause.

## 9. Whether FEED SYNCED can currently appear before mailbox sync completes

**Yes — always.** FEED SYNCED currently means "the snapshot-summary GET returned and we called router.refresh." It does not carry any signal that a Graph delta has landed. A founder who marks #221007 unread in Outlook and immediately clicks refresh will always see FEED SYNCED restored ≤ 1 s later, even if the next delta poll won't run for another 55 s.

## 10. Whether missing Graph `isRead` is coerced to false

**Confirmed as a latent defect** in `src/lib/mailbox/normalize.ts:73`:

```ts
isRead: raw.isRead ?? false
```

The `??` operator preserves explicit `false` but **collapses `undefined` into `false`**. Microsoft Graph delta responses can return records where a specific property is omitted (partial changes, edge cases, tombstones, or `$select` interactions). Because `sync.ts:525` writes `isRead: norm.isRead` unconditionally on every ingest — inside a Prisma UPDATE that runs for both create and update — an incoming delta record that omits `isRead` **silently overwrites a previously-true mirror to false**. Same shape bug on line 74 for `hasAttachments`.

## 11. Whether delta payloads actually omit `isRead`

**Not observable in the current codebase — no per-message Graph payload logging exists.** `src/lib/mailbox/delta-sync.ts` logs only counts + outcomes. The theoretical hazard is real (see §10) but I cannot confirm from static evidence alone which specific delta records historically omitted `isRead`. The current 9-card snapshot shows 8/9 with `graph.isRead=true` AND `db.isRead=true` — so if past corruption occurred, later syncs have re-consistented most cards. #221007's specific defect is a different failure mode (delta stream not carrying the change; see §4) — not this coercion path.

**Recommended follow-up (post-fix):** add structured per-message Graph payload logging (redacted) in delta-sync so future corruption is diagnosable, and prove the mirror re-consistents when the ingest fix lands.

## 12. Whether #221007 founder interaction attempted a new mark-read mutation

**Currently the mutation table shows exactly ONE row** for `(mailboxConnectionId, emailMessageId) = (mc_12ae4f13..., uf66wvh3)`:

```
status:        SUCCEEDED
attemptCount:  1
createdAt:     2026-08-16T04:25:16.345Z
completedAt:   2026-08-16T04:25:17.007Z
```

No later mutation attempts appear even though the founder reported clicking the card after Outlook was unread. **Because the DB mirror was stale (isRead=true), the `enqueueOutlookMarkReadForLinkedEmails` helper at `actions.ts:348` short-circuited at `if (email.isRead) continue`** — no MAILBOX_MARK_READ job was ever enqueued for the founder's second click. From the founder's perspective the click did nothing.

## 13. Whether the historical SUCCEEDED mutation prevented another

**Confirmed as a permanent latch — separate from §12.** Even in the alternative scenario where the DB mirror correctly reflected `isRead=false` at click time, the click would enqueue a fresh `MAILBOX_MARK_READ` job — but `runMailboxMarkRead` (`src/lib/mailbox/mark-read.ts`) has TWO short-circuit paths that block it from ever running the PATCH twice:

- Line 90-97: `upsertMutation` finds the existing row keyed on `@@unique([mailboxConnectionId, emailMessageId])`, sees `status === "SUCCEEDED"`, and returns it verbatim — attemptCount is NOT incremented, status is NOT reset to RUNNING.
- Line 151-153: `if (mutation.status === "SUCCEEDED") return { status: "SUCCEEDED", ... }` — no Graph PATCH, no log, no observable action.

Consequence: **once the very first click on a given `(mailbox, message)` succeeded, no future click can ever mark that message read in Outlook again.** For life. This is the founder's Observation #2 root cause. Even in the fresh Outlook-unread scenario, the founder's click is a silent no-op.

The v116 SUPERSEDED guard (line 87-124) does not help because the AND-clause excludes SUCCEEDED mutations from consideration (line 99). SUPERSEDED was designed to protect against a fresh Outlook unmark contradicting a queued-but-not-yet-executed PATCH; it does nothing about the historical-SUCCEEDED case.

## 14. Whether stale props/client state contributed

**Not the primary cause.** Rev-12's `useEffect(() => setReadLocal(!data.isUnread), [data.isUnread])` correctly resyncs client state on prop change. But the prop `data.isUnread` never becomes `true` because the loader reads `db.isRead=true` (§4). Client state simply mirrors the loader output. If the loader saw `false`, the useEffect would fire and the card would render unread. Client-side is downstream of the loader; loader is downstream of DB; DB is stale.

## 15. Confirmed root causes ranked by evidence

Three independent defects — each individually reproducible — combine to produce the four founder observations:

### Defect A — Feed Refresh does not trigger mailbox sync ★★★ (LIVE-CONFIRMED)

- Source: `snapshot-summary` route is a pure DB read; `LiveRefreshContext.doRefresh` does not enqueue `MAILBOX_DELTA_SYNC`; pill flips back on GET return.
- Live evidence: #221007's DB mirror `lastSyncedAt=04:05` while mailbox `lastSuccessfulSyncAt=14:53`. The founder's refresh clicks returned FEED SYNCED but no mailbox sync was requested.
- Founder observations explained: **#1 + #4**.

### Defect B — Permanent mark-read latch (SUCCEEDED = never again) ★★★ (SOURCE-CONFIRMED, will manifest on next click)

- Source: `mark-read.ts:151-153` short-circuits on SUCCEEDED; `upsertMutation:265-268` returns the historical row without resetting; queue-layer idempotency does not block (COMPLETED jobs allow fresh enqueue) but the mutation-row layer permanently latches.
- Live evidence: single SUCCEEDED row from 04:25; no subsequent attempt was made because `actions.ts:348` `if (email.isRead) continue` short-circuited at the enqueue site (DB was stale-true).
- Founder observation explained: **#2** — and would explain every future click on #221007 after the DB catches up.

### Defect C — Delta ingestion coerces missing `isRead` to false ★★ (SOURCE-CONFIRMED, latent hazard)

- Source: `normalize.ts:73` `isRead: raw.isRead ?? false` collides "absent" with "false"; `sync.ts:525` writes unconditionally.
- Live evidence: not currently visible on this snapshot (all 8 non-#221007 cards agree). But the code path exists and would corrupt any card whose next delta record omits `isRead`. The founder previously reported "cards marked unread even though Outlook said read" — that's exactly this failure mode. It may have subsequently self-repaired via a later full-property delta.
- Founder observation explained: **#3** (historically; not currently reproducible on this specific fleet snapshot).

### What does NOT need fixing

- Loader source-split logic (rev-12 §3) — correct given accurate inputs.
- Component `useEffect` prop resync (rev-12 §14) — correct given accurate prop.
- Unread visual treatment (thick left rail, no green dot) — accepted per founder brief §19; unchanged.
- Rev-11 single-card visual — untouched.
- Mission Control shell — untouched.

---

## What happens next

Founder brief §20 says: "Then implement only the fixes supported by that evidence." The evidence supports three surgical fixes:

**Fix A** — `LiveRefreshContext.doRefresh("manual")` must enqueue `MAILBOX_DELTA_SYNC` (or a new `MAILBOX_SYNC_NOW` endpoint) and await/poll its completion before flipping FEED SYNCED back. Background auto-refresh remains silent (unchanged). Preserves brief §13.

**Fix B** — retire the permanent (mailbox, message)-level mutation latch. Model the mutation as an intent per read/unread generation: either (i) drop the `@@unique` and let each click create a new mutation row, keying idempotency on some generation cursor (e.g. `email.updatedAt` at enqueue time), OR (ii) treat SUCCEEDED as terminal for THIS generation and detect a subsequent Outlook-side `isRead=false` transition as opening a new generation. Preserves brief §16 + §17.

**Fix C** — normalize `isRead` as `boolean | undefined` and either omit it from `emailData` on unconditional partial updates, or build a separate update DTO that includes `isRead` only when the raw payload asserted a value. Same treatment for `hasAttachments`. Preserves brief §8 + §9 semantics: `true → READ, false → UNREAD, undefined → NO CHANGE`.

Plus tests per brief §21 (delta tri-state, repeated read cycle, manual Feed Refresh completion contract, background silent).

I have not implemented any of these. Awaiting founder review of this diagnostic checkpoint before touching production code.

**Rollback anchor if any future fix breaks worse**: web **v238**, worker **v115** (last founder-visually-approved state before rev-12).
