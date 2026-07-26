# Lounge POS — Cleanup Plan

Companion to [pos-audit.md](docs/pos-audit.md). One actionable item per row.
Priority is by *what blocks the golden workflow being clean and usable*,
not by code size.

Rules of the road while this list is active (`feedback-lounge-pos-feature-freeze`):
- No new Lounge POS features. Every item below is stabilisation.
- Each item is one decision + one implementation pass. If a row says "decide",
  it needs user input before implementation; do not infer.
- After every item that ships, re-run `npm run workflow:audit` +
  `npm run ui:audit` and quote the bucket counts before/after.

---

## P0 — Blocks the golden workflow

These items mean a server using the golden path will either get lost,
do the wrong thing, or land on a screen that contradicts the intended flow.

| # | Item | Where | Decision needed |
|---:|---|---|---|
| ~~P0-1~~ | **RESOLVED 2026-05-24.** Decision: sidebar "Point of Sale" now routes to `/admin/hospitality/reservations/floor` (the floor map). Legacy LoungePOS is kept as the secondary "Quick Sale / Bar" entry for bar / to-go / no-table transactions. AdminShell POS-mode header relabels "Floor" pill → "Quick sale" and adds a Floor Map POS link. Operations hub + POS sales-history hub both surface primary + secondary entry cards. | [Sidebar.tsx](src/components/Sidebar.tsx), [AdminShell.tsx](src/components/admin/AdminShell.tsx), [ops/page.tsx](src/app/app/admin/ops/page.tsx), [ops/pos/page.tsx](src/app/app/admin/ops/pos/page.tsx) | — |
| P0-2 | **Resolve duplicate `openCheckAction` names.** Rename lounge one → `openLoungeCheckAction`. Rename hospitality one → `openReservationCheckAction`. Update all 3 call sites (LoungePOS, ReservationActions, FloorMap SeatViewCTA). | [lounge/_actions.ts](src/app/app/admin/ops/pos/lounge/_actions.ts), [hospitality/reservations/_actions.ts](src/app/app/admin/hospitality/reservations/_actions.ts) | No — just rename. |
| P0-3 | **Refresh `docs/workflow-audit.md` POS sales row.** Current text describes a system that no longer exists. Rewrite to describe: floor map → seat-table → SeatPOS → chits → ready/served → split-bill settle → receipt → member dining → survey. Date 2026-05-24. Downgrade to GREEN if all 12 phases pass; PARTIAL with named gaps otherwise. This is the literal "passes workflow audit" target the freeze gates against. **Partially done 2026-05-24:** row rewritten and re-dated. Still PARTIAL pending the named UI gaps (modifiers in SeatPOS, StationView rollback, empty-state pass, error-cookie pass, QR_PAY-per-group UI). | [docs/workflow-audit.md](docs/workflow-audit.md) line 32 + counts table | No — clerical. |
| ~~P0-4~~ | **RESOLVED 2026-05-24.** Decision: KEEP LoungePOS, do NOT delete. Relabel everywhere as "Quick Sale / Bar" — for bar / to-go / no-table transactions only. Sidebar entry renamed, AdminShell pill renamed, not-provisioned page heading renamed, POS hub describes it as the secondary entry. | [LoungePOS.tsx](src/app/app/admin/ops/pos/lounge/LoungePOS.tsx), [page.tsx](src/app/app/admin/ops/pos/lounge/page.tsx), [Sidebar.tsx](src/components/Sidebar.tsx), [AdminShell.tsx](src/components/admin/AdminShell.tsx) | — |
| P0-5 | **Empty-state pass on POS-surface tables (8 routes).** Add `<tr><td colSpan=N>No rows yet — …</td></tr>` fallback for each. Routes: /admin/ops/pos/lounge/history, /admin/ops/pos, /admin/hospitality/reservations, /admin/hospitality/reservations/analytics, /admin/hospitality/feedback, /admin/analytics/hospitality/prep-times + [station], /admin/settings/pos-printers, /member/reservations. | per ui-audit | No — copy. |
| P0-6 | **Server-action error-handling pass (6 pages).** Wire each page's inline server actions to set `spectre_*_error` cookie + read on next render. Pages: /admin/ops/pos, /admin/pos-mapping, /admin/hospitality/feedback, /member/reservations/new, /member/reservations/[id], /survey/hospitality/[token]. | per ui-audit | No — mechanical. |
| ~~P0-7~~ | **RESOLVED 2026-05-24.** Modifiers ship in SeatPOS via the new SeatModifierModal (touch-friendly chip picker for remove/add/substitute, allergen multi-select, free-text note, live price-delta preview). `setSeatLineModifiersAction` reuses the existing `setLineModifiers` service — no second engine. **Settlement also resolved (step 4):** `settleCheckBySeats` now folds modifier `priceDelta` into the line `unitPrice`, includes it in the tax base, snapshots POSCheckLineModifier rows onto POSSaleLineModifier, routes revenue through `4200 F&B Revenue` (aligned with legacy `settleCheck`), and the member dining detail page renders the snapshot. Catalog edits after settle do not mutate historical receipts. | [SeatPOS.tsx](src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx), [seat-checks.ts](src/lib/pos/seat-checks.ts), [checks.ts](src/lib/pos/checks.ts) | — |
| P0-8 | **StationView optimistic-update rollback.** If `acknowledgeChitAction` or `markChitReadyAction` rejects, today the card stays in the new state. Wrap the optimistic mutation in a try/catch; on error, revert local state + show inline banner. Kitchen/bar trust in the board is load-bearing. | [StationView.tsx](src/app/app/admin/ops/pos/lounge/StationView.tsx) | No — bug fix. |

---

## P1 — Confusing / bad UI

These items make a server hesitate, misread the screen, or build the
wrong mental model. Not blocking, but every one costs trust.

| # | Item | Where |
|---:|---|---|
| P1-1 | Replace browser `confirm()` for no-show / cancel with a custom modal matching the LoungePOS pattern (reason chip picker + textarea + Confirm/Cancel buttons). | [ReservationActions.tsx](src/app/app/admin/hospitality/reservations/[id]/ReservationActions.tsx) lines 151, 183 |
| P1-2 | Table-assign dropdown: highlight the *current* table on render (not just on user interaction). Auto-submit on change OR show "unsaved" badge with explicit Save. | [ReservationActions.tsx](src/app/app/admin/hospitality/reservations/[id]/ReservationActions.tsx) |
| P1-3 | `ResendReceiptButton` should map raw statuses to member-facing strings ("DEV_LOGGED" → "Logged in dev mode (not sent)") and surface failures in a coloured banner, not gray text. | [ResendReceiptButton.tsx](src/app/app/admin/ops/pos/lounge/history/ResendReceiptButton.tsx) |
| P1-4 | Remove the duplicate empty-state copy in SeatPOS (banner AND card). Keep only the card-level one. | [SeatPOS.tsx](src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx) |
| P1-5 | Split & Settle modal: prevent empty groups in the UI (gray-out save until every group has ≥1 seat). Today it filters at save and the user sees a permanently-empty group. | [SeatPOS.tsx](src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx) `SplitSettleButton` |
| P1-6 | Surface "QR_PAY not supported per group" in the Split & Settle UI as a disabled option with a tooltip, not a server-action rejection. | [SeatPOS.tsx](src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx) `SplitSettleButton` + [seat-checks.ts](src/lib/pos/seat-checks.ts) line 372 |
| P1-7 | `ReservationQuickAdd`: clear field errors when the user toggles Reservation ↔ Walk-in. | [ReservationQuickAdd.tsx](src/app/app/admin/hospitality/reservations/ReservationQuickAdd.tsx) |
| P1-8 | `ReservationQuickAdd`: re-evaluate date/time defaults on each open instead of using `defaultValue` from initial render. | [ReservationQuickAdd.tsx](src/app/app/admin/hospitality/reservations/ReservationQuickAdd.tsx) |
| P1-9 | Auto-dismiss info/error messages in FloorMap `DetailPanel` after ~6s, OR add a close-X. Today they look like permanent state. | [FloorMap.tsx](src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx) |
| P1-10 | Modifier modal note field: drop `readOnly` so device keyboards / paste / voice input work. Keep the on-screen touch keyboard as an option, not the only path. | [LoungePOS.tsx](src/app/app/admin/ops/pos/lounge/LoungePOS.tsx) modifier modal |
| P1-11 | LoungePOS member-search modal: dismiss on Escape. Today only backdrop click closes. | [LoungePOS.tsx](src/app/app/admin/ops/pos/lounge/LoungePOS.tsx) |
| P1-12 | Pending state on Send buttons across SeatPOS + LoungePOS — verify `disabled={pending}` actually disables; one site uses a string check. | [SeatPOS.tsx](src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx) |
| P1-13 | Add visible keyboard focus ring to SVG seat circles and SVG table shapes (they have `role="button"` but no focus style). | [SeatPOS.tsx](src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx), [FloorMap.tsx](src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx) |
| P1-14 | LoungePOS settlement success screen: 10-second auto-return countdown should be pausable (or have a Skip button), so a server reviewing the receipt isn't bounced mid-glance. | [LoungePOS.tsx](src/app/app/admin/ops/pos/lounge/LoungePOS.tsx) |

---

## P2 — Polish

Small visual / consistency items. Cumulatively useful, individually low-risk.

| # | Item | Where |
|---:|---|---|
| P2-1 | Replace inline-style histogram bar on /admin/hospitality/feedback with Tailwind classes (ui:audit finding). | [feedback/page.tsx](src/app/app/admin/hospitality/feedback/page.tsx) |
| P2-2 | Hospitality hub counters: use `formatCurrency` instead of `.toFixed(2)` (ui:audit finding). | [page.tsx](src/app/app/admin/hospitality/page.tsx) |
| P2-3 | `FloorMap` tab strip: add `aria-selected` to the active tab. | [FloorMap.tsx](src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx) |
| P2-4 | Memoize `minutesBetween()` calls per table-card render in FloorMap; today it recomputes every parent refresh. | [FloorMap.tsx](src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx) |
| P2-5 | `SelfSeatingForm` required indicator: use the standard `*` styling consistent with the rest of the app (not bare red). | [FloorMap.tsx](src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx) `SelfSeatingForm` |
| P2-6 | `FloorMap` mobile detail panel: bigger close-X target, add swipe-to-close. | [FloorMap.tsx](src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx) |
| P2-7 | Chit cards: visible "print pending" indicator while browser print() dialog is up (today the button doesn't change state). | [StationView.tsx](src/app/app/admin/ops/pos/lounge/StationView.tsx) |
| P2-8 | Move POS sales-history link off /admin/ops/pos (which is the redundant generic hub) onto the lounge history page as the canonical view. Soft-deprecate /admin/ops/pos. | [page.tsx](src/app/app/admin/ops/pos/page.tsx) |
| P2-9 | Add `aria-label` to icon-only buttons in StationView, FloorMap detail panel, SeatPOS seat strip. | multiple |
| P2-10 | Cover MFA enrolment UI test (UNTESTED row in workflow-audit). Not POS, but on the standing remediation list. | tests + [/admin/mfa](src/app/app/admin/mfa) |

---

## P3 — Future features (NOT to be touched under the freeze)

Listed for visibility only. Each requires the freeze to be explicitly
lifted before work begins.

| # | Item | Where |
|---:|---|---|
| P3-1 | QR_PAY per settlement group. Currently rejected in [seat-checks.ts:372](src/lib/pos/seat-checks.ts#L372). |
| P3-2 | Guest-only reservations can open POS checks. Currently blocked in [reservations.ts:534](src/lib/hospitality/reservations.ts#L534). |
| P3-3 | Real printer adapter. Today [getChitTransport()](src/lib/pos/chit.ts) is hardcoded to PDF; the function body has a long comment describing the future hook. |
| P3-4 | Clover live REST callback. Today the adapter records a $0 placeholder sale ([webhooks/index.ts:211](src/lib/pos/webhooks/index.ts#L211)). |
| P3-5 | Square POSMapping for item-level mapping. Today the adapter uses a "minimal Square shape" ([webhooks/index.ts:64](src/lib/pos/webhooks/index.ts#L64)). |
| P3-6 | Pro-shop POS UI. LoungePOS is currently the only POS UI in the codebase. |
| P3-7 | Dining-room POS UI (non-lounge). Same. |
| P3-8 | Live ops alerts on overdue chits (kitchen escalation). Analytics exist, but no live banner. |
| P3-9 | Course timer escalation: visible color change on station view when a chit crosses the red threshold. (Today the analytics page knows about late chits; the live station view doesn't.) |
| P3-10 | Exact even-split of table-level lines across settlement groups (today is "clean enough for the slice" — see [seat-checks.ts:425](src/lib/pos/seat-checks.ts#L425)). |
| P3-11 | Server clock-in / shift tracking integrated with `POSSession.openedByUserId` / `closedByUserId`. |
| P3-12 | Tip pool / gratuity allocation across servers. |

---

## Schema cleanup (separate from UI; defer until UI is settled)

Each requires a migration. Don't run during the freeze; queue for the next
clean window.

| # | Item | Where |
|---:|---|---|
| S-1 | Tighten `POSCheck.posSaleId` constraint: enforce non-null when `status=CLOSED`. Either schema-level CHECK or application invariant + test. |
| S-2 | `POSCheckLine`: require either `menuItemId` OR a non-empty `description`. Migration to backfill any orphans first. |
| S-3 | `DiningReservation`: enforce `tableId` is non-null when `status=SEATED`. |
| S-4 | `HospitalitySurveyInvitation`: change `@@unique([clubId, posCheckId])` to use `posSaleId` as the true anchor (or add app-layer guard). |
| S-5 | `POSChit.fireAt`: add `CHECK(fireAt >= sentAt)` or app-layer guard. |
| S-6 | `POSCheckLineModifier`: validate `optionId=null` only when `modifierType IN (ALLERGY, NOTE)`. |
| S-7 | Verify `POSSyncRun` is actually written anywhere; if not, drop the model. |

---

## How this list gets executed

1. User reviews `docs/pos-audit.md`, picks decisions on P0-1 and P0-4.
2. User says go on one item at a time, or batches that share a touch surface.
3. Each item ends with: workflow:audit + ui:audit bucket counts quoted; founder-test report block (STACK STATUS / TEST URLS / HOW TO TEST / KNOWN LIMITATIONS).
4. When all P0 items are closed and the POS sales row in workflow-audit reads GREEN, the freeze can be lifted at the user's discretion.
