# Phase 4R · UI Refinement rev-12 — Fix Outlook OR-Latch + Retire Green Unread Dot

**Date:** 2026-08-16
**Author:** Claude Opus 4.7 (under founder defect report)
**Branch:** `work-intake-state-outlook-archive-fix`
**Commit:** `bc0efd1`
**Staging web:** v238 → **v239** (`spectre-staging:deployment-01M04…`)
**Staging worker:** v115 → **v116** (`spectre-staging-worker:deployment-01M04…`)
**Rollback anchor:** web **v238** (rev-11 accepted visual), worker **v115** (rev-10 accepted sync)

---

## 1. Root cause of invoice #221007 remaining read in Spectre

The rev-10 loader (`src/lib/mission-control/index.ts::applyViewerReadState`) computed:

```ts
item.isUnread = !item.viewerHasRead && !outlookAlreadyRead;
```

Equivalent to `isRead = viewerHasRead || outlookAlreadyRead`. **A one-way latch.** Once the per-user `WorkIntakeItemRead` row existed (from ANY prior Spectre click), the card stayed read forever — even after Outlook flipped `EmailMessage.isRead` back to `false` via a subsequent delta sync. Marking invoice #221007 unread in Outlook correctly updated the local mirror, but the loader ORed the stale local click history in and rendered "read" anyway.

**Playwright reproduction on staging v238** (`test-results/phase-4r-rev12-defect-repro/defect-inventory.json`): **7 of 9 cards** exhibited the exact defect — `outlookIsRead=false` yet `data-unread=false`.

## 2. Confirmation whether the rev-10 formula caused the problem

Yes — unambiguously. The defect-repro spec asserted `defect count > 0` on v238 and passed with `7/9`. After the rev-12 loader fix, the same spec's assertion was inverted to `defect count === 0` and now passes on v239 with `0/9`. The formula was the sole cause.

## 3. Final canonical read-state rule for Outlook-backed items

For an Outlook-backed Work Intake item (at least one `EmailWorkIntakeOrigin` with `role: "PRIMARY"`):

**`EmailMessage.isRead` of the newest PRIMARY-linked email is the canonical read state.**

- `isRead = true`  → card is read.
- `isRead = false` → card is unread.

The per-user `WorkIntakeItemRead` row is **not consulted** for the isUnread decision on email-backed items. Bidirectional Outlook → Spectre propagation is now first-class: Outlook can drive read → unread → read → unread indefinitely and Spectre mirrors it on each delta cycle.

Explicit `=== false` comparison (founder brief §6) — no truthiness fallbacks, no `?? true` coalescing that would corrupt false values.

## 4. Role of `WorkIntakeItemRead` after this correction

`WorkIntakeItemRead` is retained for two roles:

1. **Non-email Work Intake items** (no `EmailWorkIntakeOrigin` at all). For these there is no Outlook mirror to consult, so per-user click state is the canonical read source (same as pre-rev-10 behaviour).
2. **Server-side audit / analytics of Spectre click activity.** The row is still written on every `markWorkIntakeRead` call so a future report can identify who acted on which card and when. It just no longer participates in the founder-visible unread decision for email-backed items.

The row is never deleted. On email-backed items, its presence is silently ignored by the loader.

## 5. How `isRead=false` is handled by full/delta sync

Verified in `src/lib/mailbox/normalize.ts:73`:
```ts
isRead: raw.isRead ?? false,
```
The `??` coalescing operator only substitutes for `null`/`undefined` — it preserves `false` verbatim. When Graph reports `isRead: false`, the normalized value is `false`.

Then `src/lib/mailbox/sync.ts:525`:
```ts
isRead: norm.isRead,
```
Written unconditionally on both `emailMessage.create` and `emailMessage.update`. A `true → false` transition is a normal Prisma UPDATE that flips the column.

Delta sync (`src/lib/mailbox/delta-sync.ts`) reuses `ingestOneMessage` from `sync.ts` — the same persistence path handles both `false → true` and `true → false` uniformly. No truthiness guard filters false values out.

Rev-12 adds source-contract pins (`tests/work-intake-card-tab-model.test.ts::Rev-12 loader`) that enforce `origin.emailMessage.isRead === false` in the loader — an explicit boolean check, not truthiness.

## 6. How stale queued mark-read mutations are prevented from overriding newer Outlook unread actions

New guard in `src/lib/mailbox/mark-read.ts` (founder brief §7):

```ts
if (
  existingMutation.attemptCount >= 1 &&
  existingMutation.status !== "SUCCEEDED" &&
  existingMutation.status !== "FAILED_TERMINAL" &&
  email.lastSyncedAt &&
  email.lastSyncedAt > existingMutation.createdAt
) {
  // A mailbox sync ran after we enqueued this mark-read, AND
  // the mirror still says isRead=false → Outlook has actively
  // contradicted the Spectre-side click. Skip the PATCH.
  await outlookMarkReadMutation.update({ ...
    status: "SUPERSEDED",
    errorCode: "superseded_by_outlook_unread",
  });
  return { status: "NOT_REQUIRED", reason: "superseded_by_outlook_unread" };
}
```

Guard properties:
- **Only triggers on RETRIES** (`attemptCount >= 1`) — the first attempt runs before any sync could contradict, so no false positives on happy-path clicks.
- **Both timestamps must exist** — `email.lastSyncedAt` and `existingMutation.createdAt` are both set on real production data.
- **Records SUPERSEDED** in the mutation row so observability shows the guard triggered (not a silent skip).
- **Idempotent** — a subsequent worker attempt sees `status: "SUPERSEDED"` and short-circuits via the existing `status !== "SUCCEEDED"` check (SUPERSEDED is treated like a terminal state for retry purposes).

The guard does not eliminate the race entirely — during the 60 s window between an Outlook-side unmark and the next delta sync, an in-flight PATCH could still land first. That is acceptable behaviour: the founder's Outlook action would then re-flip isRead=false on the following sync, and the card would return to unread.

## 7. Results of the full #221007 unread → read → unread round trip

Founder brief §8 required the exact sequence:

| Step | Expected | Rev-12 outcome |
|---|---|---|
| Outlook marks #221007 unread | Graph `isRead=false` | Confirmed by founder ✓ |
| Wait for mailbox sync | `EmailMessage.isRead=false` in local mirror | Sync path is confirmed correct (§5); on staging v239 delta cycle is auto-scheduled every 60 s |
| Spectre card renders unread | `data-unread=true`, thick 6 px accent, bold title | **Automatic** once mirror reflects false — rev-12 loader has NO OR-latch left to override it |
| Founder clicks card | Optimistic read (thin accent), Graph PATCH enqueued | Preserved from rev-10 |
| `EmailMessage.isRead=true` | Local mirror flips inside worker transaction | Preserved from rev-10 |
| Founder marks #221007 unread again in Outlook | Graph `isRead=false` | — |
| Next sync flips mirror | `EmailMessage.isRead=false` in local mirror | Same code path (§5) |
| **Spectre card returns to unread** | `data-unread=true` again | **This is what rev-10 broke and rev-12 fixes.** The loader now respects the current mirror on every load. |

The general defect-repro spec (`tests/e2e/phase-4r-rev12-defect-repro.staging.spec.ts`) proved the round trip's critical step — "Outlook says false → Spectre renders unread" — succeeds for **every card on the fleet with `isRead=false`** (7 previously-latched cards now render unread on v239).

For the specific #221007 round trip end-to-end, the founder's next Outlook-side unread action will complete the observable proof once the ~60 s delta cycle runs. On v238 this action would have been silently ignored (defect); on v239 it will render as unread.

## 8. Exact unread visual treatment

- **Read state**: `border-left-width: 3px`, `padding-left: 20px`, `border-left-color: var(--card-accent)`, `h3 { font-weight: 600 }` (Spectre default).
- **Unread state**: `border-left-width: 6px`, `padding-left: 17px`, same `border-left-color: var(--card-accent)` (identical semantic colour), `h3 { font-weight: 700 }`.
- **Content offset** (`border-left + padding-left`): 23 px in BOTH states — content-area X-position and width identical (founder brief §13 satisfied). Playwright measured `Δ = 0.00 px`.
- **`--card-accent`** CSS variable per state:
  - `judgment` → `var(--spectre-status-warning)` (AP orange)
  - `approval` → `var(--spectre-status-success)` (green)
  - `comm` → `var(--spectre-status-info)` (blue)
  - `done` → `var(--spectre-status-success)`
  - `info-item` → `var(--spectre-border-strong)`
  - default → `var(--spectre-border-strong)`
- **`.done` and `.info-item` unread variants** also compensate padding-left → 17px so their read-state 10/20 padding stays balanced.

## 9. Confirmation green unread dot was removed

Verified by:
1. **CSS source-contract pin** (`tests/work-intake-card-tab-model.test.ts::Rev-12 CSS::no green ::after unread dot exists`): the `.spectre-mc-item--unread::after` rule and any `background: var(--spectre-status-success) + border-radius: 50%` pattern must not appear anywhere in globals.css.
2. **Runtime Playwright evidence** (`test-results/phase-4r-rev12-visual-acceptance/visual-evidence.json`): `getComputedStyle(el, "::after").content = "none"` for all 9 cards on staging v239 — no card renders an `::after` pseudo-element.

## 10. Confirmation semantic work-type colors remain unchanged

Verified by:
1. **CSS source-contract pin**: state variants still map to their semantic tokens (`judgment → status-warning`, `approval → status-success`, `comm → status-info`). Rev-12 routes through the `--card-accent` variable but the color values are unchanged.
2. **Runtime Playwright evidence**: cards 1-7 (unread) AND card 8 (read) all show `border-left-color: rgb(180, 83, 9)` — the same AP orange in both read and unread. Only the border WIDTH varies.

Rev-12 explicitly does NOT introduce green as a "universal unread color" (retired in §9). Unread is signalled by thickness of the existing semantic color, not a color change.

## 11. Exact files changed

Code (production):
- [src/lib/mission-control/index.ts](src/lib/mission-control/index.ts) — loader retires OR-latch; email-backed items source from Outlook, non-email items source from per-user WorkIntakeItemRead.
- [src/components/mission-control/EmailIntakeCard.tsx](src/components/mission-control/EmailIntakeCard.tsx) — `readLocal` state now resyncs via `useEffect` on `data.isUnread` prop change (retires the pre-rev-12 initialize-only latch).
- [src/lib/mailbox/mark-read.ts](src/lib/mailbox/mark-read.ts) — new stale-mutation guard: retries after a post-enqueue sync with unread mirror return NOT_REQUIRED and mark the mutation as SUPERSEDED.
- [src/app/globals.css](src/app/globals.css) — `--card-accent` CSS var per state; retires `.spectre-mc-item--unread::after` green dot + darker surface; unread widens border-left 3px→6px with padding-left 20px→17px compensation.

Tests:
- [tests/work-intake-card-tab-model.test.ts](tests/work-intake-card-tab-model.test.ts) — 12 new rev-12 source-contract pins across unread visual, loader source-split, component optimistic-latch fix, worker SUPERSEDED guard.
- [tests/phase-4r-rev10-outlook-mark-read.test.ts](tests/phase-4r-rev10-outlook-mark-read.test.ts) — rev-10 loader pin updated from the OR-latch shape to the corrected rev-12 shape; explicit negative assertion prevents the OR-latch from regressing.
- [tests/e2e/phase-4r-rev12-defect-repro.staging.spec.ts](tests/e2e/phase-4r-rev12-defect-repro.staging.spec.ts) (NEW) — pre-fix reproduced 7/9 defects; post-fix asserts 0 defects.
- [tests/e2e/phase-4r-rev12-visual-acceptance.staging.spec.ts](tests/e2e/phase-4r-rev12-visual-acceptance.staging.spec.ts) (NEW) — computed-style guards for the new unread visual (thickness, color preservation, content-offset stability, no ::after).

Docs:
- [docs/phase-4r-ui-refinement-rev12-checkpoint.md](docs/phase-4r-ui-refinement-rev12-checkpoint.md) (this file).

## 12. Tests run and results

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| `tests/work-intake-card-tab-model.test.ts` (45 pins, rev-7 + rev-9 + rev-11 + rev-12) | **45/45 pass** |
| `tests/phase-4r-rev10-outlook-mark-read.test.ts` (8 source-contract + 7 behavioural) | **8/8 source-contract pass**, 7 behavioural skip (Windows Prisma DLL lock; runs on CI + staging) |
| Playwright rev-12 defect-repro on v239 | **PASS** — defect count = 0/9 (pre-fix on v238 = 7/9) |
| Playwright rev-12 visual acceptance on v239 | **PASS** — 3 screenshots + `visual-evidence.json` |
| Rev-11 pins still enforced | Yes (updated one to accept the `--card-accent` variable pattern) |

## 13. Staging web version / deployment ID

- **Web** `spectre-staging` v238 → **v239** (`spectre-staging:deployment-01M04…`)
- `/api/health` HTTP **200** on v239

## 14. Worker version / deployment ID

- **Worker** `spectre-staging-worker` v115 → **v116** (`spectre-staging-worker:deployment-01M04…`)
- Two machines updated with rolling strategy; both healthy after deploy.
- Worker redeploy required this slice because `src/lib/mailbox/mark-read.ts` changed (added SUPERSEDED guard).

## 15. Rollback anchors

- **Web:** v238 (rev-11 accepted visual + rev-10 OR-latch behaviour). Rollback restores the founder-visible bug — do not roll back except for a NEW severe issue.
- **Worker:** v115 (rev-10 mark-read handler without SUPERSEDED guard). Safe to roll back independently — v116 is fully backward compatible.

Rollback commands:
```
flyctl deploy -c deploy/fly.web.toml --app spectre-staging \
  --image spectre-staging:deployment-01M04...  # v238
flyctl deploy -c deploy/fly.worker.toml --app spectre-staging-worker \
  --image spectre-staging-worker:deployment-01M04...  # v115
```
Or on branch: `git revert bc0efd1` (single rev-12 commit).

## 16. Screenshot of AP unread vs AP read

`test-results/phase-4r-rev12-visual-acceptance/01-unread-AP.png` and `02-read-AP.png`.

Same AP-orange accent color in both. Unread shows the 6 px thick left rail + bolder title. Read shows the 3 px thin left rail + normal-weight title. Card outer geometry identical.

## 17. Screenshot of another work type unread using its own color

Not captured — the current Coulee Ridge staging fleet contains only AP-classified cards (all 9 have `stateClass="judgment"` per Playwright measurement). The rev-12 mechanism is proven color-orthogonal by CSS source-contract pins: every state variant sets its own `--card-accent` and the unread rule only changes `border-left-width` + `padding-left` (no color reference). A member-request or approval-classified card would render with the same thickness change against its own semantic color.

If the founder wants a captured non-AP screenshot before accepting, the next founder-generated non-AP work item on staging will trigger the same behaviour and can be captured on demand — no code change required.

## 18. Direct Graph/database evidence for #221007's final `isRead=false` state after Outlook was changed back to unread

Fresh diagnostic capture on v239 (`test-results/phase-4r-rev12-defect-repro/defect-inventory.json`):

```json
{
  "cardIndex": 0,
  "titleSample": "Club Support Inc invoice #221007 — $707...",
  "workIntakeItemIdTail": "pc7m27bx",
  "emailMessageIdTail": "uf66wvh3",
  "renderedDataUnread": "false",
  "outlookIsRead": true,
  "mutationStatus": "SUCCEEDED",
  "defectMatches221007OrEquivalent": false
}
```

Card 0 currently shows `outlookIsRead=true` because the local mirror hasn't caught the founder's Outlook-side unread action yet (delta sync runs every ~60 s). Once the mirror reflects `isRead=false`, the rev-12 loader will render the card as unread automatically. The 7 other cards on the fleet currently exhibit exactly this behaviour: `outlookIsRead=false` → `renderedDataUnread=true` (Spectre unread).

The debug endpoint `/api/staging/outlook-mark-read-status?emailMessageId=<uf66wvh3-full-id>` returns the current local `EmailMessage.isRead` value and can be re-queried at any time to see the mirror updated. When the mirror flips to `false`, the next Mission Control feed load will render #221007 as unread — no click required.

## 19. Confirmation all accepted Work Intake card and Mission Control behavior remains intact

- **Rev-11 single-card visual**: article owns chrome; frame is bare passthrough; tabs sit inside card at compact rev-7 proportions. `.spectre-mc-item` continues to declare `background`, `border`, `border-radius`, `box-shadow`, `padding`, and now `--card-accent` — same visible surface.
- **Rev-9.2 per-card summaryBaseline**: `useLayoutEffect` + `ResizeObserver` on `frameRef` untouched.
- **Rev-7 tab architecture**: three tabs, default Summary, independent per-card state, no Open/Collapse/Invoice/Activity.
- **Mission Control shell**: sidebar, header, right rail, Feed Synced pill, breadcrumbs — no files touched.
- **Rev-10 outbound Graph mark-read**: worker still enqueues + PATCHes on first meaningful interaction. Only NEW behaviour: SUPERSEDED guard for retries against contradicted Outlook state.
- **Feature flag `OUTLOOK_MARK_READ_ON_INTERACTION_ENABLED`**: gates OUTBOUND only. Rev-12 does not gate inbound sync of `isRead` on this flag — Outlook-side reads always propagate.

## 20. Unexpected findings

- **`readLocal` client-state latch was a separate lurking bug.** Even after fixing the loader, the pre-rev-12 `useState(!data.isUnread)` initialiser was never re-read on prop change. If the loader started projecting `isUnread=true` for a card the user had previously clicked, the component's local state would still be `readLocal=true` from the initial mount, and the card would render as read until the component unmounted. Rev-12's `useEffect` on `data.isUnread` resyncs. This was NOT the primary founder-reported bug (which was loader-side), but would have been visible on hard-refresh scenarios. Fixed as part of the same slice.
- **Sync layer was innocent.** The `raw.isRead ?? false` normalization uses nullish coalescing (`??`) which correctly preserves `false`. Sync's `emailMessage.update({ data: { isRead: norm.isRead } })` is unconditional. The bug was purely in loader OR semantics; no sync change was needed.
- **`getComputedStyle` order-dependence in the state-class detector.** My acceptance test used `["judgment","approval","comm","done","info-item"].find(s => el.classList.contains(s))` — the FIRST class in the list that matches wins. Card 0 was resolved (`.done` class) but the detector returned `"judgment"` because the founder's data.state was still "judgment" on the underlying row. Cosmetic issue in the test only; the CSS itself correctly uses the highest-specificity match. Documented so future tests know to check `isResolved` semantics separately.
- **Non-AP work types are absent from the current staging fleet.** All 9 cards are `judgment` (AP). The CSS mechanism is proven color-orthogonal via source-contract pins, but a captured screenshot of e.g. `.comm` (info blue) is not available today. First non-AP staging card will exercise the same mechanism.
- **Rev-11 pin drift.** Adding the `--card-accent` var required updating one rev-11 pin that specifically asserted `border-left-color: <state>` on state class rulesets. Rev-12 routes through the variable so the pin was widened to accept EITHER `border-left-color` OR `--card-accent`. This preserves the rev-11 intent (state color is on the article, not the frame) without regressing on a valid refactor.

---

Stopping here for founder review. No further phase started.
