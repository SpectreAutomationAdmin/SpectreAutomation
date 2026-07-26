# Lounge POS — Honest Audit

Snapshot: 2026-05-24. Read-only audit. No code changed.

Scope: every screen, component, service, route, and data path involved in the
golden workflow — *server logs in → floor map → seat table → start check →
seat view → assign diners → add items → send chits → mark ready/served →
settle → email receipt → member sees dining history*. Adjacent surfaces
(reservations, member portal dining, survey escalation) are included because
the golden workflow depends on them.

---

## 1. Current routes

### Admin POS surface (`/admin/ops/pos/**`)

| Route | File | Purpose | Auth |
|---|---|---|---|
| `/admin/ops/pos` | [page.tsx](src/app/app/admin/ops/pos/page.tsx) | Sales-history viewer + refund. NOT a ringup screen. | `inventory:read`, refund `inventory:write` |
| `/admin/ops/pos/lounge` | [page.tsx](src/app/app/admin/ops/pos/lounge/page.tsx) → [LoungePOS.tsx](src/app/app/admin/ops/pos/lounge/LoungePOS.tsx) | **Legacy tableless ringup.** Pick member, build cart, settle. No table, no seat, no chit-server context. Predates seated dining. | `inventory:read` |
| `/admin/ops/pos/lounge/table/[checkId]` | [page.tsx](src/app/app/admin/ops/pos/lounge/table/[checkId]/page.tsx) → [SeatPOS.tsx](src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx) | **Seat-level POS** — the modern workflow. Per-seat assignment, per-seat ordering, split-bill settle. | `inventory:write` |
| `/admin/ops/pos/lounge/kitchen` | [page.tsx](src/app/app/admin/ops/pos/lounge/kitchen/page.tsx) → [StationView.tsx](src/app/app/admin/ops/pos/lounge/StationView.tsx) | Kitchen prep board (chits in QUEUED/PRINTED/ACK/READY). | `inventory:read` |
| `/admin/ops/pos/lounge/bar` | [page.tsx](src/app/app/admin/ops/pos/lounge/bar/page.tsx) → [StationView.tsx](src/app/app/admin/ops/pos/lounge/StationView.tsx) | Bar prep board, same shape. | `inventory:read` |
| `/admin/ops/pos/lounge/history` | [page.tsx](src/app/app/admin/ops/pos/lounge/history/page.tsx) | Closed checks with filters, resend receipt. | `inventory:read`; resend `inventory:write` |

### Admin hospitality surface (`/admin/hospitality/**`)

| Route | File | Purpose | Auth |
|---|---|---|---|
| `/admin/hospitality` | [page.tsx](src/app/app/admin/hospitality/page.tsx) | Hub with 4 cards. | `reservations:read` |
| `/admin/hospitality/reservations` | [page.tsx](src/app/app/admin/hospitality/reservations/page.tsx) | Today's reservations + walk-ins. Quick-add. | `reservations:read`; manage `reservations:manage` |
| `/admin/hospitality/reservations/[id]` | [page.tsx](src/app/app/admin/hospitality/reservations/[id]/page.tsx) | Detail + [ReservationActions.tsx](src/app/app/admin/hospitality/reservations/[id]/ReservationActions.tsx) (confirm, seat, depart, no-show, cancel, assign table, open check). | `reservations:read` |
| `/admin/hospitality/reservations/floor` | [page.tsx](src/app/app/admin/hospitality/reservations/floor/page.tsx) → [FloorMap.tsx](src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx) | **Visual floor map** — Excel-style area tabs, SVG canvas, side panel. Two seating paths (reservation seat / walk-in self-seat). | `reservations:read` |
| `/admin/hospitality/reservations/analytics` | [page.tsx](src/app/app/admin/hospitality/reservations/analytics/page.tsx) | KPIs vs prior window. | `reservations:read` |
| `/admin/hospitality/feedback` | [page.tsx](src/app/app/admin/hospitality/feedback/page.tsx) | Survey responses + service-recovery queue. | `settings:read`/`settings:write` |

### Member portal surface (`/member/**`)

| Route | File | Purpose |
|---|---|---|
| `/member/reservations` | [page.tsx](src/app/app/member/reservations/page.tsx) | Upcoming + recent visits. |
| `/member/reservations/new` | [page.tsx](src/app/app/member/reservations/new/page.tsx) | Book reservation. |
| `/member/reservations/[id]` | [page.tsx](src/app/app/member/reservations/[id]/page.tsx) | Detail, cancel-within-cutoff. |
| `/member/dining` | [page.tsx](src/app/app/member/dining/page.tsx) | Charges from settled lounge sales. |
| `/member/dining/[id]` | [page.tsx](src/app/app/member/dining/[id]/page.tsx) | Itemized receipt. |
| `/survey/hospitality/[token]` | (token-gated, not behind member auth) | Survey landing for receipt-email link. |

### HTTP endpoints (`/api/pos/**`)

| Route | File | Purpose | Auth |
|---|---|---|---|
| POST `/api/pos/pay/[saleId]/confirm` | [route.ts](src/app/api/pos/pay/[saleId]/confirm/route.ts) | QR-pay simulator: confirm. **Dev-only** (403 in prod). |
| POST `/api/pos/pay/[saleId]/decline` | [route.ts](src/app/api/pos/pay/[saleId]/decline/route.ts) | QR-pay simulator: decline. Dev-only. |
| POST `/api/pos/pay/[saleId]/expire` | [route.ts](src/app/api/pos/pay/[saleId]/expire/route.ts) | QR-pay simulator: expire. Dev-only. |
| GET `/api/admin/pos/lounge/sales/[id]/chit/[type]` | (not under /api/pos) | Render chit PDF (KITCHEN/BAR/SIGNATURE). | `inventory:read` |

### Server-action files

| File | Action count | Notable actions |
|---|---:|---|
| [lounge/_actions.ts](src/app/app/admin/ops/pos/lounge/_actions.ts) | 28 | `openCheckAction({memberId})`, `addItemsAction`, `sendChitsAction`, `settleCheckAction`, QR confirm/decline/expire, `resendReceiptEmailAction`. |
| [lounge/table/_actions.ts](src/app/app/admin/ops/pos/lounge/table/_actions.ts) | 5 | `seatTableAction`, `assignSeatAction`, `addSeatItemAction`, `sendSeatItemsAction`, `settleBySeatsAction`. |
| [hospitality/reservations/_actions.ts](src/app/app/admin/hospitality/reservations/_actions.ts) | 11 | `seatReservationAction`, `openCheckAction(reservationId)`, `noShowReservationAction`, `setTableStatusAction`. |

---

## 2. Current components

| Component | What it does | State machine highlights |
|---|---|---|
| [LoungePOS.tsx](src/app/app/admin/ops/pos/lounge/LoungePOS.tsx) | Tableless ringup. Two-panel: menu | check. Open-checks list, member search, modifier modal, void modals, QR-pay poll, success screen with 10s auto-return. | `activeCheckId`, `pendingPayment` (polls every 2s), `success` (10s countdown), `voidLineModal`, `voidCheckModal`, `modifierModal`. |
| [SeatPOS.tsx](src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx) | Seat-level POS. Shape-aware SVG seat strip, per-seat assignment popup, menu picker, split & settle modal. | `activeSeat` (null \| number \| "TABLE"), `SeatAssignmentRow` auto-opens for unassigned non-primary, scroll-into-view on active. |
| [StationView.tsx](src/app/app/admin/ops/pos/lounge/StationView.tsx) | Kitchen/bar prep board. Active chits grid + "Up next" held strip with live fire countdown. Print button per chit. | Optimistic update, no rollback on error. `router.refresh()` when held chit countdown reaches zero. |
| [FloorMap.tsx](src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx) | Excel-tab floor map. SVG canvas, table click → side panel, `SelfSeatingForm` (two-step), `SeatViewCTA` (links or opens check on demand). | `activeAreaId` (?area= query), `selectedTableId`, `now` (1-min tick), `SelfSeatingForm.step` (idle \| prompt). |
| [ReservationActions.tsx](src/app/app/admin/hospitality/reservations/[id]/ReservationActions.tsx) | Action buttons for a reservation. Table assign dropdown + Save, browser `confirm()` for no-show/cancel. | `selectedTable`, `noShowReason`, `cancelReason`. |
| [ReservationQuickAdd.tsx](src/app/app/admin/hospitality/reservations/ReservationQuickAdd.tsx) | Toggle reservation \| walk-in. Shared field set. | `mode` (hidden \| reservation \| walkin). Field errors persist across mode toggle. |
| [ResendReceiptButton.tsx](src/app/app/admin/ops/pos/lounge/history/ResendReceiptButton.tsx) | One button + inline status. | `pending`, `inline`. No error banner. |

---

## 3. Current data flow (golden workflow per phase)

| Phase | Models written | Models read |
|---:|---|---|
| 1. Server logs in | — | `User`, `Principal` |
| 2. Floor map | — | `DiningArea`, `DiningTable`, `DiningReservation`, `POSCheck` (for openCheckId badge) |
| 3. Click AVAILABLE table → seat + start check | `POSCheck`, `POSCheckSeat` (primary, seatNumber=1), `DiningTable.status` flips AVAILABLE→SEATED | `Member` (resolve memberNumber), `DiningTable` |
| 4. Open seat view | — | `POSCheck`, `POSCheckSeat`, `POSCheckLine`, `POSMenuItem` |
| 5. Assign diners | `POSCheckSeat` (upsert) | `Member` |
| 6. Add items | `POSCheckLine` (seatNumber/tableLevel), `POSCheckLineModifier`, `POSCheckEvent` ITEM_ADDED | `POSMenuItem`, `POSModifierGroup`, `POSModifierOption` |
| 7. Send chits | `POSChit` (HELD if course>1 else QUEUED), `POSChitLine` (displaySeatNumber snapshot), `POSCheckLine.status` DRAFT→SENT, `POSCheckEvent` CHIT_SENT | — |
| 8. Mark ready/served | `POSChit.status` ACK→READY, `POSCheckLine.readyAt`/`servedAt`, `POSCheckEvent` CHIT_READY | — |
| 9. Settle | `POSSettlementGroup` (one per payment group), `POSSale`+`POSSaleLine`+`POSSaleLineModifier`+`POSTaxLine`+`POSDiscount`+`POSPayment`, `Charge` (if MEMBER_ACCOUNT), `MemberAccount` (recompute), `JournalEntry`, `POSCheck.status` CLOSED (or PARTIALLY_SETTLED), `POSCheckEvent` SETTLED | — |
| 10. Email receipt | `POSSaleChit` (SIGNATURE PDF bytes), `POSCheck.receiptEmailStatus`, `EmailDeliveryEvent`, `HospitalitySurveyInvitation` (one per check, idempotent) | `POSSale`, `Member` (fresh email), `EmailSuppression` |
| 11. Member dining history | — | `POSSale` (status=COMPLETED, memberId=self), `DiningReservation` (joined timeline) |

Receipt PDF and chit PDF go through `getChitTransport()` which is hardcoded
to `{kind: "pdf"}` — no live printer routing. See section 7.

---

## 4. Duplicate / competing flows

### 4.1 Two server actions both named `openCheckAction` with different signatures

- [lounge/_actions.ts](src/app/app/admin/ops/pos/lounge/_actions.ts) — `openCheckAction({ memberId, … })` opens a tableless lounge check.
- [hospitality/reservations/_actions.ts](src/app/app/admin/hospitality/reservations/_actions.ts) — `openCheckAction(reservationId)` opens a reservation-linked check via `ensureCheckForReservation`.

Same name, different files, different signatures, different semantics. Picked up by callers based on import path; trivially confusable. Three call sites today: LoungePOS uses the lounge one, ReservationActions and FloorMap SeatViewCTA use the reservation one.

### 4.2 Two front doors for working a check

- **Tableless ringup** at `/admin/ops/pos/lounge` (LoungePOS) — no table/seat awareness, single-member ringup, single-payment settle.
- **Seated POS** at `/admin/ops/pos/lounge/table/[checkId]` (SeatPOS) — table + seat awareness, multi-member, split-bill.

Both edit the same `POSCheck` rows. There is no UI guidance about which to use; the sidebar entry "Point of Sale" lands on LoungePOS, but the golden workflow wants the floor map. A server who lands on LoungePOS and starts a check there bypasses every seated-dining concept.

### 4.3 Two settlement code paths

- `settleCheck()` in [checks.ts](src/lib/pos/checks.ts) — single member, single payment, supports QR_PAY.
- `settleCheckBySeats()` in [seat-checks.ts](src/lib/pos/seat-checks.ts) — N groups, one `createSale + completeSale` per group, MEMBER_ACCOUNT-only ([line 372 explicitly rejects QR_PAY](src/lib/pos/seat-checks.ts#L372)).

Both legitimate, but the seat path is the strict subset of capability + the modern entry point. Coexisting indefinitely is fine; the gap is that QR_PAY-per-group is silently unavailable in the split flow.

### 4.4 Two POS history surfaces

- `/admin/ops/pos` — generic sales list, refund action.
- `/admin/ops/pos/lounge/history` — closed-check list with filters + resend receipt.

Lounge history is richer. Generic sales-history view is largely redundant for lounge, and the "Open Lounge POS →" button on the generic page points at LoungePOS (legacy), not the floor map.

### 4.5 Three ways to start a check from a table

| Path | Entry | Action |
|---|---|---|
| AVAILABLE table on floor map → SelfSeatingForm | floor | `seatTableAction` (creates check + primary seat) |
| Reservation detail page → "Open POS check" | reservation/[id] | `openCheckAction(reservationId)` (hospitality version) |
| Floor map SeatViewCTA on SEATED reservation without check | floor | `openCheckAction(liveReservationId)` (hospitality version) |

These have legitimately different starting contexts. The collision is the name on the button ("Open POS check") and the duplicate action name (4.1).

### 4.6 Three external POS adapters in `webhooks/index.ts` with duplicated import logic

`squareAdapter`, `lightspeedAdapter`, `cloverAdapter` each independently implement `createSale/completeSale` import. None are exercised by any current shipping workflow. See section 7 for placeholder annotations.

---

## 5. Broken UI

Items here mean: the path produces an incorrect outcome, a silent failure, or a state the system can reach but cannot represent.

| Item | Where | Symptom |
|---|---|---|
| StationView optimistic update has no rollback | [StationView.tsx](src/app/app/admin/ops/pos/lounge/StationView.tsx) | If `acknowledgeChitAction` or `markChitReadyAction` rejects, the local card stays in the new state until next refresh. No toast, no banner. Server truth diverges from UI. |
| `ReservationQuickAdd` defaultValues stale after reset | [ReservationQuickAdd.tsx](src/app/app/admin/hospitality/reservations/ReservationQuickAdd.tsx) | `form.reset()` after submit, but date/time inputs read defaultValue at render time. Next open shows the OLD date/time. |
| `ReservationQuickAdd` error persists across mode toggle | same | Submit Reservation with an error, switch to Walk-in — old error is still visible. |
| Workflow audit doc is stale | [docs/workflow-audit.md](docs/workflow-audit.md) line 32 | "POS sales" row dated 2026-05-17 reads "single-line quick-sale form. No multi-line cart UI, no terminal/session UI, no in-browser receipt." Every clause is false today. This is the literal `passes workflow audit` target the freeze gates against — it cannot pass while it describes a system that no longer exists. |
| 8 POS-surface tables missing "No rows" empty-state | per ui-audit | history, pos hub, reservations, analytics, feedback, prep-times, [station], pos-printers, member/reservations. Table renders an empty `<tbody>` with no fallback. |
| 6 pages missing `spectre_*_error` cookie pattern | per ui-audit | Server-action errors silently swallowed without a banner. /admin/ops/pos, /admin/pos-mapping, /admin/hospitality/feedback, /member/reservations/new, /member/reservations/[id], /survey/hospitality/[token]. |

---

## 6. Confusing UI

Not broken, but requires a server to know something they shouldn't have to know.

| Item | Where | Why confusing |
|---|---|---|
| Sidebar "Point of Sale" → LoungePOS, not floor map | [Sidebar.tsx](src/components/Sidebar.tsx) | Golden workflow starts at the floor map. The default POS entry sends servers to the legacy tableless ringup. |
| "Open Lounge POS →" on /admin/ops/pos hub | [page.tsx](src/app/app/admin/ops/pos/page.tsx) line 64 | Same — points at LoungePOS, not floor map. |
| LoungePOS is tableless | [LoungePOS.tsx](src/app/app/admin/ops/pos/lounge/LoungePOS.tsx) | A check started here has no table assignment. If the server then opens the floor map, the table is still AVAILABLE; the check is invisible there. |
| Two `openCheckAction`s with same name | see 4.1 | A search for "openCheckAction" returns two unrelated entry points. |
| Browser `confirm()` for no-show/cancel | [ReservationActions.tsx](src/app/app/admin/hospitality/reservations/[id]/ReservationActions.tsx) lines 151, 183 | Inconsistent with LoungePOS's custom modal + reason chip picker. Native browser dialog can be missed on touch devices. |
| ReservationActions table-assign dropdown + separate Save | same | User selects a table, nothing happens until they hit "Save table". No visual cue the change is unsaved. |
| Table assignment current value invisible | same | `value={selectedTable}` on the dropdown does not highlight the *initial* table until the user interacts. |
| ResendReceiptButton statuses leak adapter names | [ResendReceiptButton.tsx](src/app/app/admin/ops/pos/lounge/history/ResendReceiptButton.tsx) | "DEV_LOGGED" shown raw. Member-facing language would be better. |
| Modifier modal note field is `readOnly` + touch keyboard | [LoungePOS.tsx](src/app/app/admin/ops/pos/lounge/LoungePOS.tsx) modifier modal | No copy-paste, no voice input, no soft-keyboard from the device. |
| SeatPOS empty state appears twice | [SeatPOS.tsx](src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx) | "Select a seat to begin adding items" in the top banner AND inside the card. |
| Split & Settle can leave an empty group | [SeatPOS.tsx](src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx) `SplitSettleButton` | Moving all seats out of a group leaves it empty; only filtered at save. Visible empty group is alarming. |
| FloorMap detail panel info/error messages never auto-dismiss | [FloorMap.tsx](src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx) `DetailPanel` | They stay until the user navigates. Looks like a permanent state. |
| SeatPOS items have no per-line modifier UI | [SeatPOS.tsx](src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx) | Modifiers only exist in LoungePOS. A server seating diners and ordering through SeatPOS cannot apply allergies, removes, substitutions. |
| QR_PAY not available in split-bill | [seat-checks.ts](src/lib/pos/seat-checks.ts) line 372 | UI doesn't surface this. A server building a split assumes payment options are uniform; clicking QR_PAY on a group fails late. |

---

## 7. Placeholder behavior

| Item | File | Note |
|---|---|---|
| `getChitTransport()` returns hardcoded `{kind: "pdf"}` | [chit.ts](src/lib/pos/chit.ts) lines 515–531 | Long comment block describes the future printer-adapter hook. Today no chit ever goes to a real printer. |
| Square adapter import is "minimal shape" | [webhooks/index.ts](src/lib/pos/webhooks/index.ts) line 64 | "production code would map order line items through POSMapping to InventoryItem.id". |
| Clover adapter writes a $0 placeholder sale | [webhooks/index.ts](src/lib/pos/webhooks/index.ts) lines 206, 211 | "Without a live REST callback we can only record a placeholder sale." |
| QR_PAY per settlement group blocked | [seat-checks.ts](src/lib/pos/seat-checks.ts) line 372 | "QR_PAY per group ... isn't supported yet. Use Charge to Member Account on each group." |
| Even-split table-level line distribution is approximate | [seat-checks.ts](src/lib/pos/seat-checks.ts) lines 425–426 | "clean enough for the slice"; exact even-split needs a sale-line splitter. |
| Guest-only reservations cannot open POS checks | [reservations.ts](src/lib/hospitality/reservations.ts) line 534 | "Guest-only reservations don't yet support POS checks." |
| Workflow audit doc POS sales row is fiction | [docs/workflow-audit.md](docs/workflow-audit.md) line 32 | Describes a system that no longer exists. |

No `TODO` / `FIXME` strings found in any of the POS UI components themselves.

---

## 8. What should be deleted

> Deletion candidates only. Do NOT delete without the user's explicit go-ahead.

| Candidate | Reason |
|---|---|
| `/admin/ops/pos/lounge` route + [LoungePOS.tsx](src/app/app/admin/ops/pos/lounge/LoungePOS.tsx) **OR** repurpose | The legacy tableless ringup is the dominant entry point in the sidebar but is the wrong start for the golden workflow. Either delete entirely or relabel as "Bar / to-go quick sale" with no table option and keep only for non-dining ringups. |
| The duplicate `openCheckAction` name | Pick one canonical name. Suggested: `openLoungeCheckAction` (tableless) and `openReservationCheckAction` (table-linked). |
| `/admin/ops/pos` sales-history hub | Functionally replaced by `/admin/ops/pos/lounge/history` (richer filters, resend receipt). If kept, the "Open Lounge POS →" link should target the floor map. |
| Square / Lightspeed / Clover adapter scaffolding in [webhooks/index.ts](src/lib/pos/webhooks/index.ts) | None of these are connected to a real provider in any shipping workflow. The Clover placeholder sale is actively misleading. Either delete or fence behind a feature flag with clear "scaffold only" labelling. |
| `POSSyncRun` model | Has no writer in the current codebase as far as the inventory found. Verify before deletion. |
| Stale POS-sales row from workflow-audit.md | Rewrite, don't delete the doc. |

---

## 9. What should be kept

| Surface | Why |
|---|---|
| [FloorMap.tsx](src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx) | The golden-workflow entry point. Excel-tab + SVG canvas is the right shape. |
| [SeatPOS.tsx](src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx) | The modern seat-level POS. Wire it up properly as the only POS workflow for dining. |
| [seat-checks.ts](src/lib/pos/seat-checks.ts) (`seatTable`, `assignCheckSeat`, `seatSummary`, `settleCheckBySeats`) | Core of the seated workflow. |
| [checks.ts](src/lib/pos/checks.ts) (open/add/send/fire/markServed/settle/void) | Underlying check lifecycle — every workflow depends on it. |
| [StationView.tsx](src/app/app/admin/ops/pos/lounge/StationView.tsx) | Kitchen + bar prep boards. Solid; needs rollback on optimistic update. |
| [reservations.ts](src/lib/hospitality/reservations.ts) | Reservation lifecycle, walk-ins, settings, ensureCheckForReservation. |
| [receipts.ts](src/lib/pos/receipts.ts), [chit.ts](src/lib/pos/chit.ts), `POSSaleChit` PDFs | Receipt + chit rendering. Keep the PDF path; the printer hook is the deferred part. |
| [modifiers.ts](src/lib/pos/modifiers.ts) + `POSCheckLineModifier` / `POSSaleLineModifier` | Modifier system. Currently only wired in LoungePOS — needs to land in SeatPOS too. |
| [surveys.ts](src/lib/hospitality/surveys.ts) | Receipt-driven survey escalation. |
| [/member/reservations](src/app/app/member/reservations) and [/member/dining](src/app/app/member/dining) | Member-facing closure of the loop. |
| [_actions.ts](src/app/app/admin/ops/pos/lounge/table/_actions.ts) (seat-table actions) | Already thin, focused. Keep. |
| Test suites `tests/pos-checks`, `pos-seat-workflow`, `pos-seat-drilldown`, `pos-receipt-email`, `floor-map`, `reservations`, `hospitality-survey` | All 12 golden-workflow phases are exercised somewhere across these. Coverage is real; don't lose it during cleanup. |

---

## 10. Recommended single golden workflow

One canonical path. Every other entry is either deleted or relabelled as
non-dining.

```
Server logs in
        │
        ▼
/admin/hospitality/reservations/floor   ← default landing for any server with reservations:read
        │
        ├─ Sees floor map (Excel-tab areas, SVG canvas, side panel)
        │
        ▼
Click AVAILABLE table
        │
        ▼
SelfSeatingForm prompt
   • Primary member # (required)  → resolves to Member
   • Party size (required, ≤ table.maxPartySize)
   • Submit → seatTableAction
        │
        ├─ Creates POSCheck { tableId, memberId, partySize }
        ├─ Creates POSCheckSeat { seatNumber:1, isPrimary:true, memberId }
        ├─ DiningTable.status: AVAILABLE → SEATED
        │
        ▼
Auto-navigate to /admin/ops/pos/lounge/table/[checkId]   ← SeatPOS
        │
        ▼
Server clicks each seat to assign diners
   • Member # → assignCheckSeat → POSCheckSeat upsert
   • Or guest name → POSCheckSeat upsert with guestName
        │
        ▼
Server clicks a seat → picks menu items
   • addSeatItemAction → POSCheckLine { seatNumber, menuItemId, course }
   • Apply modifiers if needed → POSCheckLineModifier
        │
        ▼
Server clicks "Send to kitchen/bar"
   • sendSeatItemsAction → POSChit per (station, course)
   • POSChitLine snapshots displaySeatNumber
   • POSCheckLine.status: DRAFT → SENT
   • Course 1 fires immediately; course 2+ HELD with fireAt
        │
        ▼
Kitchen / bar acknowledges chit → marks READY
   • acknowledgeChitAction → POSChit.status: QUEUED/PRINTED → ACKNOWLEDGED
   • markChitReadyAction → POSChit.status → READY
        │
        ▼
Server runs food → marks SERVED
   • markChitServedAction (whole chit) OR markLineServedAction (single line)
   • POSChit.status → SERVED; POSCheckLine.servedAt set
        │
        ▼
Server clicks "Split & Settle"
   • Group seats (or "All to host")
   • Per group: select payment (MEMBER_ACCOUNT; QR_PAY not supported per group today)
   • settleBySeatsAction:
       ├─ POSSettlementGroup per group
       ├─ createSale + completeSale per group → POSSale + POSSaleLine + POSPayment
       ├─ Charge per group (MEMBER_ACCOUNT) → MemberAccount recompute
       ├─ JournalEntry per group
       └─ POSCheck.status: → CLOSED (or PARTIALLY_SETTLED if some seats remain)
        │
        ▼
Receipt email queued per settled group
   • sendAndRecordReceiptEmail → POSCheck.receiptEmailStatus
   • EmailDeliveryEvent recorded
   • HospitalitySurveyInvitation created (idempotent per check)
        │
        ▼
Member sees charge in /member/dining
   • Itemized receipt at /member/dining/[id]
   • Survey link in receipt email → /survey/hospitality/[token]
```

**Non-dining sales** (to-go drink at the bar, single-item retail) take a
separate, deliberately simpler path — either deleted, or surfaced behind a
clearly-labelled "Quick sale" button that does NOT involve the floor map and
does NOT assign a table.

**Reservations** feed the same workflow: a CONFIRMED reservation appears on
the floor map; clicking the reserved table seats the party via
`seatReservationAction` instead of `seatTableAction`, but the downstream
SeatPOS experience is identical.

---

## Schema smells worth knowing

Not blocking the workflow, but worth flagging before cleanup work touches
any of these:

- `POSCheck.posSaleId` nullable, but on `status=CLOSED` there should always be a sale. No constraint enforces it.
- `POSCheckLine.menuItemId` nullable + no constraint that `description` is non-null. A line where both are empty is unrenderable.
- `POSChitLine.checkLineId` is `onDelete: Cascade` — deleting a check line silently shrinks the historical chit, leaving the chit referencing fewer items than were physically prepared.
- `DiningReservation.tableId` nullable + `status=SEATED` is a reachable contradiction.
- `HospitalitySurveyInvitation @@unique([clubId, posCheckId])` with nullable `posCheckId` — multiple null rows allowed.
- `POSCheckLineModifier.optionId` nullable + free-text `label` — no validation that ALLERGY/NOTE types pair with `optionId=null`.
- `POSSale.chargeMode` vs `POSPayment.method` are independent — a CASH sale with a GIFT_CARD payment row is reachable.
- `POSChit.fireAt` nullable, no `CHECK(fireAt >= sentAt)` — a held chit can be scheduled in the past.

---

## Coverage snapshot

All 12 golden-workflow phases are exercised somewhere across
`tests/pos-checks`, `tests/pos-workflow`, `tests/pos-seat-workflow`,
`tests/pos-seat-drilldown`, `tests/pos-receipt-email`, `tests/floor-map`,
`tests/reservations`, `tests/hospitality-survey`. Code-level coverage is
not the gap — UI clarity and the duplicate-entry problem are.

What the existing scripts say (read-only, not re-run for this audit):

- `workflow:audit` (prior run): 19 GREEN / 8 PARTIAL / 3 PLACEHOLDER / 0 BROKEN / 1 UNTESTED — but the POS sales row inside it is the stale one above.
- `ui:audit` (prior run): 104 total findings, 19 of which sit on the Lounge POS surface.
- `nav:audit`: 0 URL-only orphans.
- `dev:health`: 12/12 probes green.
