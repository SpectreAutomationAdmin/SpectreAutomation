# Phase 4R rev-12 — Live #221007 Round-Trip Verification

**Date:** 2026-08-16
**Author:** Claude Opus 4.7 (verification-only pass — no architectural code changes)
**Branch:** `work-intake-state-outlook-archive-fix`
**Verification commit:** `89fc085` (diagnostic-only: extended debug endpoint + live-verification Playwright spec)
**Staging web:** v239 → **v240** (diagnostic-only redeploy — same rev-12 loader/component/worker)
**Staging worker:** **v116 unchanged**

---

## 1. Exact Outlook/Graph message tied to #221007

| Field | Value |
|---|---|
| Card title | `Club Support Inc invoice #221007 — $707.17 CAD · Telephone & Internet` |
| Work Intake item ID (tail) | `pc7m27bx` (full: `cmsva78pg1yr97lfzpc7m27bx`) |
| EmailMessage row ID (tail) | `uf66wvh3` (full: `cmsva78jt1yr37lfzuf66wvh3`) |
| `EmailMessage.graphMessageId` | `AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0Ardd-dRWR00WxuT03NOeYXwAAD-YZhwAA` |
| `MailboxConnection.id` | `mc_12ae4f133112f19fa30806c2239da4b6` |
| `MailboxConnection.status` | `CONNECTED` |
| `PRIMARY EmailWorkIntakeOrigin` role | Confirmed present (single origin, role: `PRIMARY`) |

The card renders as **read** at test time (`data-unread="false"`).

## 2. Initial Graph `isRead` value

Reading the local mirror (which delta sync keeps synchronized with Graph on a ~60 s cycle):

```
email.isRead                       = true
email.lastSyncedAt                 = 2026-08-16T04:05:00.808Z
email.updatedAt                    = 2026-08-16T14:01:35.355Z
mailboxSync.lastSuccessfulSyncAt   = 2026-08-16T14:53:34.230Z  (37 s before this test ran)
mailboxSync.lastAttemptedSyncAt    = 2026-08-16T14:53:33.805Z
mailboxSync.hasDeltaLink           = true
```

**Interpretation**: the local mirror reports `isRead=true`. The most recent successful mailbox sync ran 37 s before the verification, and would have re-flipped the mirror to `false` if Graph reported `isRead=false` at that moment. It reported `true`. **Outlook's Graph state for #221007 is currently `isRead=true`.**

This is exactly the scenario founder brief §4 addresses:

> "If Outlook currently reports `isRead=true`, then the founder's prior manual unread action may either: not have persisted; have been superseded; not yet reached Graph; have subsequently been changed back. Do not claim success from the generic test alone. Report that exact finding…"

## 3. Initial Spectre mirror value

`EmailMessage.isRead = true` (matches Outlook — the delta sync at 14:53:34 either confirmed or re-set this value). Mission Control renders the card as read (`data-unread="false"`, `border-left-width: 3px`, `padding-left: 20px`, `h3 { font-weight: 600 }`, no `::after` dot). Rev-12 loader is consistent with the local mirror.

## 4. Evidence of Stage A: Outlook unread → Spectre unread

**Not observable on #221007 in the current mirror state** (Outlook currently reports `isRead=true`).

**Observable on other cards on the same feed (v239 general acceptance, run at 04:41 UTC):**
- 7 of 9 cards on the founder fleet had `outlookIsRead=false` (via debug endpoint) AND `data-unread=true` (Spectre rendered unread with the 6 px accent + bold title).
- Pre-fix on v238 the same 7 cards rendered `data-unread=false` — the rev-10 OR-latch bug.

These 7 currently-unread cards live-prove Stage A works on v239. #221007-specific Stage A confirmation requires the founder to make Outlook report `isRead=false` for #221007, wait ≤ 60 s for delta sync, and observe the card's data-unread flip.

## 5. Evidence of Stage B: Spectre click → Outlook read

**Historical record present** in the OutlookMarkReadMutation table for #221007:

```
{
  "id": "cmsvaxagp01k0143cbb6v4i4z",
  "status": "SUCCEEDED",
  "attemptCount": 1,
  "createdAt":     "2026-08-16T04:25:16.345Z",
  "lastAttemptAt": "2026-08-16T04:25:16.344Z",
  "completedAt":   "2026-08-16T04:25:17.007Z",
  "errorCode": null,
  "triggeredByUserId": "cmrvdenz700034437agp7gqs5"
}
```

**Interpretation**: the founder (or an earlier verification click) queued a mark-read at 04:25:16, the worker consumed it 1 attempt later, and Graph accepted the `PATCH { isRead: true }` at 04:25:17 (0.67 s round-trip). Local mirror flipped in the same transaction. This is documented, verified Stage B evidence — Spectre → Outlook works.

The current verification also performed a Stage B "no-op click" against the already-read card (`data-unread="false"` → tab click → still `data-unread="false"`, mirror unchanged). Since the mirror already reports `isRead=true`, the enqueue helper's `if (email.isRead) continue` guard correctly short-circuited — no duplicate mark-read job appeared in `recentJobs` (only the historical SUCCEEDED one exists).

## 6. Evidence of Stage C: Outlook changed back to unread

**Not yet observed for #221007** since the last mailbox sync at 14:53:34 UTC.

The founder's prior Outlook-side unread action either (a) never persisted in Graph, (b) was subsequently undone (someone opened the message on phone / Outlook Web / desktop client, re-reading it), (c) has not yet reached Graph, or (d) was reverted after sync. The local mirror is not stale — the 14:53:34 delta sync ran 37 s before the verification and would have caught any current `isRead=false` state.

**Founder next step**: mark #221007 unread in Outlook again (phone / Outlook Web / desktop client). Verify in the same client that it stays unread (some Outlook clients silently re-flag on close or preview). Wait ≥ 60 s for the delta sync cycle. Then either refresh Mission Control or rerun `tests/e2e/phase-4r-rev12-221007-round-trip.staging.spec.ts` — the spec's branch-A code path will exercise Stage A + B live for #221007.

## 7. Evidence of Stage D: Spectre returned to unread

**Not yet observable** — depends on Stage C completing first.

**Preserving assurance**: rev-12's loader change is deployed on v239. Playwright measured the general defect fixed (0 cards latched vs 7 pre-fix). When the founder-driven Stage C completes and the next delta sync flips #221007's mirror to `isRead=false`, the rev-12 loader will render the card as unread on the very next Mission Control feed load — no click required, no manual reload of the app needed for a full navigation-based refresh (`router.refresh()` or a fresh navigation to `/app/admin`). The component's rev-12 `useEffect` on `data.isUnread` will additionally resync any mounted card whose parent triggers a data re-projection.

For strictly *keeping Mission Control open* without any interaction (§6 — "verify mounted-client resync"), the loader-side change is sufficient once a Spectre-side re-fetch happens (a tab click within any card triggers a router.refresh on the response of the mark-read POST; the auto-sync polling adds another cadence — see `src/lib/mission-control/index.ts`). If the founder wants a specific live-tab resync test, that's a follow-up.

## 8. Sync timestamps for each transition

| Event | Timestamp (UTC) | Delta from prior |
|---|---|---|
| #221007 email received in Outlook | `2026-08-16T04:04:45.000Z` | — |
| First delta sync ingested #221007 | `2026-08-16T04:05:00.808Z` (`email.lastSyncedAt`) | +16 s from receipt |
| Founder Spectre-click enqueued mark-read | `2026-08-16T04:25:16.345Z` (`mutation.createdAt`) | +20 min 15 s |
| Worker consumed job, PATCHed Graph | `2026-08-16T04:25:17.007Z` (`mutation.completedAt`) | +0.67 s (Graph latency) |
| Later delta sync (no content change) touched row | `2026-08-16T14:01:35.355Z` (`email.updatedAt`) | +9 h 36 min (delta returned `isRead=true`, no field flipped) |
| Most recent successful mailbox sync (test-time) | `2026-08-16T14:53:34.230Z` | +52 min |
| Live verification ran | `2026-08-16T14:54:11.856Z` | +37 s after sync |

Sync ordering is coherent. No stale-cursor or missed-delta anomaly is visible.

## 9. Relevant OutlookMarkReadMutation status/history

Full history for `(mailboxConnectionId, emailMessageId) = (mc_12ae4f13…, uf66wvh3)`:

```json
[
  {
    "id": "cmsvaxagp01k0143cbb6v4i4z",
    "status": "SUCCEEDED",
    "attemptCount": 1,
    "createdAt":     "2026-08-16T04:25:16.345Z",
    "updatedAt":     "2026-08-16T04:25:17.009Z",
    "lastAttemptAt": "2026-08-16T04:25:16.344Z",
    "completedAt":   "2026-08-16T04:25:17.007Z",
    "errorCode": null
  }
]
```

One row. Status `SUCCEEDED`. No retries. No `SUPERSEDED` row (the worker's v116 SUPERSEDED guard was not exercised for this email — none has fired anywhere on the fleet yet since there's no post-enqueue Outlook contradiction to guard against). Recent `MAILBOX_MARK_READ` `BackgroundJob` rows show one `COMPLETED` job at `04:25:15.455` (the enqueue that produced the SUCCEEDED mutation) — no pending retries capable of overriding a future founder Outlook unmark.

## 10. Read and unread screenshots of the same #221007 card

Saved under `test-results/phase-4r-rev12-221007-round-trip/`:

| File | Content |
|---|---|
| `01-initial-read.png` | **#221007 in the READ state** (current). Thin 3 px left accent, normal-weight title, no green dot. Card outer geometry: standard. |
| `02-current-state-read.png` | Same card after a tab click round-trip (Conversation → Spectre Summary). Still read; nothing changed because Outlook already reported `isRead=true`. Confirms clicks are safely idempotent when the mirror is already true. |
| `10-unread-visual-reference-not-221007.png` | **Visual reference for the rev-12 unread treatment on a currently-unread AP card** (`Club Support Inc invoice #220824` — the second card on the fleet). Same semantic AP orange accent, thickened to 6 px, bolder title, no green dot. #221007's future unread state will render identically because the CSS mechanism is shared. |

**#221007 unread screenshot not yet captured** — the mirror currently reports `isRead=true`. Once founder Stage C completes, rerunning the spec will produce the exact #221007 unread screenshot in the same file structure.

## 11. Confirmation that no code changes were necessary

**No architectural code changes were made this pass.** The rev-12 loader (`src/lib/mission-control/index.ts`), component (`src/components/mission-control/EmailIntakeCard.tsx`), worker (`src/lib/mailbox/mark-read.ts`), and CSS (`src/app/globals.css`) are unchanged from commit `bc0efd1` deployed as v239/worker-v116.

The one file modified this pass was the **staging-only diagnostic endpoint** `src/app/api/staging/outlook-mark-read-status/route.ts` — extended with `lastSyncedAt`, `updatedAt`, full `mutationHistory`, and `mailboxSync` timestamps so the verification could reconstruct the timeline. That endpoint is hard-gated (`STAGING_DEBUG_ENDPOINTS_ENABLED=true` on staging only; 404 in production) and does not touch any read-state logic. Deployed as web v240 (worker unchanged at v116).

The verification confirmed:
- Loader change is deployed and working (0/9 defects vs 7/9 pre-fix; #221007 correctly reads mirror state).
- Worker path is functional (historical SUCCEEDED mutation with real Graph acceptance).
- Sync path is coherent (timestamps consistent, no stale-cursor anomaly).
- Rev-12 unread visual treatment renders correctly (visual reference from card 1).
- No pending stale mutation exists that could override a future founder Outlook unmark of #221007.

**Blocker for full 4-stage acceptance**: Stage C requires founder-side Outlook action on #221007. Once that action propagates through Graph and the next delta sync, rerunning the verification spec will observe Stages A + B + D live for #221007 specifically. No code change is required for that observation — the rev-12 architecture is already in place.

---

Stopping here for founder review. No further phase started. If Stage C completes and the rerun exposes a defect, this doc will be updated with the failing boundary before any code is touched.
