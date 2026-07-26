"use client";

// Lounge POS — open-check workflow.
//
// Operating model:
//   1. Server taps "New check" → searches member → check opens
//   2. Tapping menu items adds DRAFT lines to the open check
//   3. "Send to Kitchen/Bar" creates POSChits routed by prep station;
//      DRAFT lines transition to SENT. The check stays OPEN.
//   4. More items can be added in subsequent rounds; "Send" only
//      pushes the new DRAFT lines.
//   5. "Settle to Member Account" / "Pay by Phone" closes the check —
//      that's when AR Charge + GL JE are posted via the existing engine.
//
// State management:
//   The active check lives on the server (POSCheck row). The client
//   keeps a cached snapshot in `check` and refetches via
//   `getCheckAction` after every mutation. No optimistic UI — POS
//   correctness wins over ms-level latency.

import { useEffect, useRef, useState, useTransition } from "react";
import { Badge } from "@/components/Badge";
import { formatCurrency } from "@/lib/finance";
import {
  searchMembersAction,
  listOpenChecksAction,
  openCheckAction,
  getCheckAction,
  addItemsAction,
  removeLineAction,
  updateLineAction,
  voidLineAction,
  setDiningModeAction,
  setDiscountAction,
  sendChitsAction,
  settleCheckAction,
  voidCheckAction,
  setAutoPaceAction,
  fireNextCourseAction,
  listLineModifiersAction,
  setLineModifiersAction,
  markLineServedAction,
  getQRPaymentStatusAction,
  confirmQRPaymentAction,
  declineQRPaymentAction,
  type SearchedMember,
  type SettleSuccess,
} from "./_actions";

const GST_RATE = 0.05;

// What the modifier modal collects and the parent submits. Mirrors
// ModifierInput in the service but is duplicated here so the client
// component doesn't reach into the service layer.
type ModifierInputUI = {
  optionId: string | null;
  modifierType: "REMOVE" | "ADD" | "SUBSTITUTE" | "ALLERGY" | "NOTE";
  label: string;
  printLabel?: string | null;
  priceDelta: number;
};

// ---------- Static types from server ----------
type MenuItem = { id: string; name: string; description: string | null; price: number; taxable: boolean };
type MenuCategory = { id: string; name: string; chitDestination: "KITCHEN" | "BAR"; items: MenuItem[] };
type DiningMode = "STAY" | "TO_GO";
type LoungePaymentMethod = "MEMBER_ACCOUNT" | "QR_PAY";

// ---------- Sub-groups (Soups & Salads → Power Up) ----------
const SUB_GROUPS: Record<string, Array<{ label: string; prefix: string }>> = {
  "Soups & Salads": [{ label: "Power Up", prefix: "Power Up:" }],
};
function subGroupsForCategory(c: MenuCategory) {
  const groups = SUB_GROUPS[c.name] ?? [];
  return groups
    .map((g) => ({ label: g.label, prefix: g.prefix, items: c.items.filter((i) => i.name.startsWith(g.prefix)) }))
    .filter((g) => g.items.length > 0);
}

// ---------- Discount presets ----------
type DiscountPresetKey = "STAFF" | "MGMT" | "COMP";
const DISCOUNT_PRESETS: readonly { key: DiscountPresetKey; label: string; pct: number }[] = [
  { key: "STAFF", label: "Staff", pct: 50 },
  { key: "MGMT", label: "Mgmt", pct: 67 },
  { key: "COMP", label: "Comp", pct: 100 },
];

// ---------- Coursing ----------
// Course numbers the server can pick on each line. Keep this in sync
// with MIN_COURSE / MAX_COURSE in src/lib/pos/checks.ts.
const COURSES: readonly number[] = [1, 2, 3, 4];
// Auto-pace minute presets. 0 = manual fire only. Keep in sync with
// AUTO_PACE_OPTIONS in src/lib/pos/checks.ts.
const AUTO_PACE_OPTIONS: readonly number[] = [0, 5, 10, 15, 20];

// Predefined reasons the staff can pick when voiding a whole check.
// One or more must be selected before the Void button enables. They
// concatenate into the audit string saved on `POSCheck.voidedReason`
// (and propagated to cancelled chits' `cancelledReason`).
const VOID_CHECK_REASONS: readonly string[] = [
  "Walk-out",
  "Server error",
  "Duplicate check",
  "Guest cancelled",
  "Manager comp",
  "Kitchen unavailable",
  "Training / test",
];

// ---------- Server-returned types (loose — `getCheckAction` returns
// the deep Prisma row; we use `any` for the parts we don't dereference
// to keep this file independent of the Prisma client surface) ----------
// One modifier instance attached to a check line — comes back from
// getCheckAction with the Decimal priceDelta serialised as a string.
type LineModifier = {
  id: string;
  optionId: string | null;
  modifierType: "REMOVE" | "ADD" | "SUBSTITUTE" | "ALLERGY" | "NOTE";
  label: string;
  printLabel: string | null;
  priceDelta: number | string;
  sortOrder: number;
};
type CheckLine = {
  id: string;
  description: string;
  // Decimals come back as strings or numbers depending on serialiser
  quantity: number | string;
  unitPrice: number | string;
  discountPct: number | string;
  taxable: boolean;
  prepStation: string;
  course: number;
  note: string | null;
  status: string;
  menuItemId: string | null;
  hasAllergy: boolean;
  modifiers: LineModifier[];
};
type Check = {
  id: string;
  checkNumber: string;
  status: string;
  diningMode: string;
  chitDiscountPct: number | string;
  autoFireGapMinutes: number | null;
  notes: string | null;
  tableNumber: string | null;
  // Set after settleCheck for QR_PAY (deferred) or MEMBER_ACCOUNT
  // (immediate). Needed so the active-check view can resume a
  // pending payment session.
  posSaleId: string | null;
  member: {
    id: string; firstName: string; lastName: string; memberNumber: string;
    status: string; accessStatus: string; paymentMethodStatus: string;
  } | null;
  lines: CheckLine[];
  chits: Array<{ id: string; station: string; status: string; course: number; sentAt: Date | string; fireAt: Date | string | null; firedAt: Date | string | null; lines: Array<unknown> }>;
};

export function LoungePOS({ menu, canPost }: { menu: MenuCategory[]; canPost: boolean }) {
  // ---------- Active check ----------
  const [activeCheckId, setActiveCheckId] = useState<string | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  // The chit list lets the open-checks queue surface kitchen / bar
  // progress ("Preparing", "Kitchen ready", "Ready for pickup") instead
  // of just the check's own bookkeeping status. Plus the latest QR
  // payment row so the badge can show "Payment in progress" /
  // "Payment declined" / "Payment timed out".
  const [openChecks, setOpenChecks] = useState<Array<{
    id: string;
    checkNumber: string;
    status: string;
    member: { firstName: string; lastName: string; memberNumber: string } | null;
    lines: Array<{ status: string }>;
    chits: Array<{ id: string; status: string; station: string }>;
    posSale: { id: string; payments: Array<{ externalPaymentStatus: string | null; failureReason: string | null }> } | null;
  }>>([]);

  // ---------- Member search (when opening a new check) ----------
  const [showNewCheck, setShowNewCheck] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");
  const [memberResults, setMemberResults] = useState<SearchedMember[]>([]);
  const [searching, setSearching] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const memberInputRef = useRef<HTMLInputElement>(null);
  const memberKeyboardRef = useRef<HTMLDivElement>(null);
  // Exempt the results dropdown from the keyboard's outside-click
  // dismiss handler. Without this, mousedown on a result both
  // dismisses the keyboard AND races the click — sometimes the click
  // gets lost mid-typing.
  const memberResultsRef = useRef<HTMLDivElement>(null);

  // ---------- Menu navigation ----------
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [activeSubGroupKey, setActiveSubGroupKey] = useState<string | null>(null);

  // ---------- Action state ----------
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SettleSuccess | null>(null);
  // QR-pay deferred state — set when the operator chooses Pay by
  // Phone but the gateway hasn't confirmed payment yet. The pending
  // screen polls `getQRPaymentStatusAction`; on CONFIRMED it
  // transitions to `success`; on DECLINED/EXPIRED it shows a failed
  // banner and leaves the check active.
  const [pendingPayment, setPendingPayment] = useState<{
    saleId: string;
    saleNumber: string;
    grandTotal: number;
    checkId: string;
    failureReason: string | null;
  } | null>(null);

  // ---------- Modals ----------
  const [confirmSettleOpen, setConfirmSettleOpen] = useState(false);
  const [pendingPaymentMethod, setPendingPaymentMethod] = useState<LoungePaymentMethod>("MEMBER_ACCOUNT");
  const [voidLineModal, setVoidLineModal] = useState<{ lineId: string; description: string } | null>(null);
  const [voidCheckModal, setVoidCheckModal] = useState<{ checkId: string; checkNumber: string } | null>(null);
  const [voidReason, setVoidReason] = useState("");
  // Modifier modal state — null when closed. Holds the line being
  // modified so the panel knows what to fetch + persist.
  const [modifierModal, setModifierModal] = useState<{ line: CheckLine } | null>(null);
  // Whole-check voids use a multi-select chip picker instead of free text:
  // common reasons are predefined, ≥1 must be chosen before the Void
  // button enables. The selected labels are joined into the audit string.
  const [selectedVoidReasons, setSelectedVoidReasons] = useState<string[]>([]);

  // -------------------------------------------------------------------------
  // Fetch helpers
  // -------------------------------------------------------------------------
  async function refreshCheck() {
    if (!activeCheckId) return;
    const r = await getCheckAction(activeCheckId);
    if (r.ok) setCheck(r.data as unknown as Check);
  }
  async function refreshOpenChecks() {
    const r = await listOpenChecksAction();
    if (r.ok) setOpenChecks(r.data as unknown as typeof openChecks);
  }
  useEffect(() => { refreshOpenChecks(); }, []);
  useEffect(() => { refreshCheck(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [activeCheckId]);

  // Poll the QR payment status while the operator is on the pending
  // screen. As soon as the gateway flips to CONFIRMED we transition
  // to success; DECLINED / EXPIRED show the failure banner without
  // dropping the check from the active list.
  useEffect(() => {
    if (!pendingPayment) return;
    let cancelled = false;
    async function tick() {
      if (!pendingPayment || cancelled) return;
      const r = await getQRPaymentStatusAction(pendingPayment.saleId);
      if (cancelled || !r.ok) return;
      const status = r.data.paymentStatus;
      if (status === "CONFIRMED") {
        setPendingPayment(null);
        setSuccess({
          saleId: pendingPayment.saleId,
          saleNumber: pendingPayment.saleNumber,
          grandTotal: pendingPayment.grandTotal,
          chargeMode: "QR_PAY",
        });
      } else if (status === "DECLINED" || status === "EXPIRED") {
        // Keep the pending screen visible but switch into the
        // failure banner so the operator sees the reason and can
        // retry or pick another method.
        setPendingPayment((prev) =>
          prev ? { ...prev, failureReason: r.data.failureReason ?? status } : prev
        );
      }
    }
    const id = setInterval(tick, 2000);
    void tick(); // fire once immediately
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPayment?.saleId]);

  // Poll the open-checks queue every 10s while the server is on the
  // landing page so kitchen / bar status updates (Acknowledged →
  // Preparing → Ready for pickup) flow back without a manual refresh.
  // Disabled while a specific check is open — that view reads its own
  // check via refreshCheck() after each mutation.
  useEffect(() => {
    if (activeCheckId !== null) return;
    const t = setInterval(() => {
      refreshOpenChecks();
    }, 10000);
    // Refresh immediately when the window regains focus too — covers
    // the "server flipped to the kitchen tab and came back" case.
    function onFocus() { refreshOpenChecks(); }
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCheckId]);

  // ---------- Debounced member search + 4-digit auto-select ----------
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = memberQuery.trim();
    if (q.length < 1) { setMemberResults([]); setSearching(false); return; }
    const isFullMemberNumber = /^\d{4}$/.test(q);
    const delay = isFullMemberNumber ? 0 : 200;
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      const r = await searchMembersAction(q);
      if (r.ok) {
        setMemberResults(r.data);
        if (isFullMemberNumber) {
          const exact = r.data.filter((m) => stripMemberPrefix(m.memberNumber) === q);
          if (exact.length === 1) {
            void confirmMemberOpenCheck(exact[0]);
          }
        }
      } else { setMemberResults([]); }
      setSearching(false);
    }, delay);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [memberQuery]);

  // ---------- Keyboard outside-click ----------
  useEffect(() => {
    if (!keyboardOpen) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node | null; if (!t) return;
      if (memberKeyboardRef.current?.contains(t)) return;
      if (memberInputRef.current?.contains(t)) return;
      // Clicking a member result must not race the keyboard dismiss
      // — confirmMemberOpenCheck closes the keyboard itself.
      if (memberResultsRef.current?.contains(t)) return;
      setKeyboardOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [keyboardOpen]);

  function appendChar(c: string) { setMemberQuery((p) => p + c); }
  function deleteLastChar() { setMemberQuery((p) => p.slice(0, -1)); }
  function clearQuery() { setMemberQuery(""); }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------
  function startNewCheck() {
    setShowNewCheck(true);
    setMemberQuery("");
    setMemberResults([]);
    setError(null);
  }

  async function confirmMemberOpenCheck(m: SearchedMember) {
    setShowNewCheck(false);
    setMemberQuery("");
    setMemberResults([]);
    setKeyboardOpen(false);
    setError(null);
    startTransition(async () => {
      const r = await openCheckAction({ memberId: m.id });
      if (r.ok) {
        setActiveCheckId(r.data.checkId);
        refreshOpenChecks();
      } else {
        setError(r.error);
      }
    });
  }

  async function resumeCheck(id: string) {
    setActiveCheckId(id);
    setError(null);
  }

  function closeActiveCheckView() {
    setActiveCheckId(null);
    setCheck(null);
    setActiveCategoryId(null);
    setActiveSubGroupKey(null);
    refreshOpenChecks();
  }

  async function addItem(item: MenuItem) {
    if (!activeCheckId) return;
    setError(null);
    startTransition(async () => {
      const r = await addItemsAction({ checkId: activeCheckId, items: [{ menuItemId: item.id, quantity: 1 }] });
      if (r.ok) await refreshCheck();
      else setError(r.error);
    });
  }

  async function changeLineQty(line: CheckLine, delta: number) {
    const next = Math.max(0, Number(String(line.quantity)) + delta);
    if (next === 0) { return removeLine(line); }
    setError(null);
    startTransition(async () => {
      const r = await updateLineAction(line.id, { quantity: next });
      if (r.ok) await refreshCheck();
      else setError(r.error);
    });
  }

  async function setLineDiscount(line: CheckLine, pct: number) {
    setError(null);
    startTransition(async () => {
      const r = await updateLineAction(line.id, { discountPct: pct });
      if (r.ok) await refreshCheck();
      else setError(r.error);
    });
  }

  async function setLineCourse(line: CheckLine, course: number) {
    if (line.course === course) return;
    setError(null);
    startTransition(async () => {
      const r = await updateLineAction(line.id, { course });
      if (r.ok) await refreshCheck();
      else setError(r.error);
    });
  }

  async function changeAutoPace(gap: number) {
    if (!activeCheckId) return;
    setError(null);
    startTransition(async () => {
      const r = await setAutoPaceAction(activeCheckId, gap > 0 ? gap : null);
      if (r.ok) await refreshCheck();
      else setError(r.error);
    });
  }

  async function fireNextCourse() {
    if (!activeCheckId) return;
    setError(null);
    startTransition(async () => {
      const r = await fireNextCourseAction(activeCheckId);
      if (r.ok) await refreshCheck();
      else setError(r.error);
    });
  }

  async function setLineNote(line: CheckLine, note: string) {
    setError(null);
    startTransition(async () => {
      const r = await updateLineAction(line.id, { note: note.trim() || null });
      if (r.ok) await refreshCheck();
      else setError(r.error);
    });
  }

  async function removeLine(line: CheckLine) {
    setError(null);
    startTransition(async () => {
      const r = await removeLineAction(line.id);
      if (r.ok) await refreshCheck();
      else setError(r.error);
    });
  }

  // READY → SERVED. The server / expo taps this after delivering the
  // item to the table. Once SERVED the line stays visible with a
  // green status badge; settlement still works whether items are
  // READY or SERVED.
  async function markLineServed(line: CheckLine) {
    setError(null);
    startTransition(async () => {
      const r = await markLineServedAction(line.id);
      if (r.ok) await refreshCheck();
      else setError(r.error);
    });
  }

  function openModifierModal(line: CheckLine) {
    setModifierModal({ line });
  }
  async function saveModifiers(modifiers: ModifierInputUI[]) {
    if (!modifierModal) return;
    setError(null);
    const lineId = modifierModal.line.id;
    startTransition(async () => {
      const r = await setLineModifiersAction(
        lineId,
        modifiers.map((m, i) => ({
          optionId: m.optionId,
          modifierType: m.modifierType,
          label: m.label,
          printLabel: m.printLabel ?? null,
          priceDelta: m.priceDelta,
          sortOrder: i,
        }))
      );
      if (r.ok) {
        setModifierModal(null);
        await refreshCheck();
      } else {
        setError(r.error);
      }
    });
  }

  function openVoidPrompt(line: CheckLine) {
    setVoidLineModal({ lineId: line.id, description: line.description });
    setVoidReason("");
  }
  async function confirmVoid() {
    if (!voidLineModal) return;
    setError(null);
    startTransition(async () => {
      const r = await voidLineAction(voidLineModal.lineId, voidReason);
      if (r.ok) { setVoidLineModal(null); await refreshCheck(); }
      else setError(r.error);
    });
  }

  function openVoidCheckPrompt(check: { id: string; checkNumber: string }) {
    setVoidCheckModal({ checkId: check.id, checkNumber: check.checkNumber });
    setSelectedVoidReasons([]);
  }
  function toggleVoidReason(reason: string) {
    setSelectedVoidReasons((prev) =>
      prev.includes(reason) ? prev.filter((r) => r !== reason) : [...prev, reason]
    );
  }
  function closeVoidCheckPrompt() {
    setVoidCheckModal(null);
    setSelectedVoidReasons([]);
  }
  async function confirmVoidCheck() {
    if (!voidCheckModal || selectedVoidReasons.length === 0) return;
    setError(null);
    const reason = selectedVoidReasons.join(", ");
    const wasActive = voidCheckModal.checkId === activeCheckId;
    startTransition(async () => {
      const r = await voidCheckAction(voidCheckModal.checkId, reason);
      if (r.ok) {
        setVoidCheckModal(null);
        setSelectedVoidReasons([]);
        if (wasActive) {
          // Voiding the check we're currently in — pop back to the
          // open-checks list so we don't keep working on a voided row.
          closeActiveCheckView();
        } else {
          await refreshOpenChecks();
        }
      } else {
        setError(r.error);
      }
    });
  }

  async function changeDiningMode(mode: DiningMode) {
    if (!activeCheckId) return;
    startTransition(async () => {
      const r = await setDiningModeAction(activeCheckId, mode);
      if (r.ok) await refreshCheck();
      else setError(r.error);
    });
  }
  async function changeChitDiscount(pct: number) {
    if (!activeCheckId) return;
    startTransition(async () => {
      const r = await setDiscountAction(activeCheckId, pct);
      if (r.ok) await refreshCheck();
      else setError(r.error);
    });
  }

  async function sendChits() {
    if (!activeCheckId) return;
    setError(null);
    startTransition(async () => {
      const r = await sendChitsAction(activeCheckId);
      if (r.ok) await refreshCheck();
      else setError(r.error);
    });
  }

  function openSettleConfirm(method: LoungePaymentMethod) {
    setPendingPaymentMethod(method);
    setConfirmSettleOpen(true);
  }
  async function confirmSettle(allowUnsent: boolean) {
    if (!activeCheckId) return;
    setError(null);
    const checkIdAtRequest = activeCheckId;
    startTransition(async () => {
      const r = await settleCheckAction({
        checkId: checkIdAtRequest,
        paymentMethod: pendingPaymentMethod,
        allowUnsentLines: allowUnsent,
      });
      if (r.ok) {
        setConfirmSettleOpen(false);
        if (pendingPaymentMethod === "QR_PAY") {
          // Settlement is DEFERRED — sale is DRAFT, check is now
          // PAYMENT_PENDING. Show the pending screen instead of
          // success; it polls for the gateway's confirmation.
          setPendingPayment({
            saleId: r.data.saleId,
            saleNumber: r.data.saleNumber,
            grandTotal: r.data.grandTotal,
            checkId: checkIdAtRequest,
            failureReason: null,
          });
        } else {
          // Charge-to-member: AR + GL already posted, chit
          // snapshotted, email sent. Show success.
          setSuccess(r.data);
        }
      } else {
        setError(r.error);
        setConfirmSettleOpen(false);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Derived UI helpers
  // -------------------------------------------------------------------------
  const chargeAccountBlocked = !!check?.member && (
    check.member.accessStatus === "CHARGE_ACCOUNT_SUSPENDED" ||
    check.member.accessStatus === "FULL_SUSPENSION"
  );
  const billableLines = check?.lines.filter((l) => l.status !== "VOIDED") ?? [];
  const draftLineCount = billableLines.filter((l) => l.status === "DRAFT").length;
  const sentLineCount = billableLines.filter((l) => l.status === "SENT" || l.status === "READY" || l.status === "FIRED" || l.status === "PREPARING").length;
  const totals = priceCheck(billableLines, Number(String(check?.chitDiscountPct ?? 0)));
  const canSend = !!check && draftLineCount > 0 && canPost;
  // A check in PAYMENT_PENDING has a deferred QR sale on the line — no
  // settle action should fire until the gateway resolves it. We also
  // surface PAYMENT_FAILED so the operator can either retry QR or
  // switch to member-account; both buttons are enabled in that case.
  const qrInProgress = check?.status === "PAYMENT_PENDING";
  const qrFailed = check?.status === "PAYMENT_FAILED";
  const canSettleMember = !!check && billableLines.length > 0 && canPost && !chargeAccountBlocked && !qrInProgress;
  const canSettleQr = !!check && billableLines.length > 0 && canPost && !qrInProgress;

  // Coursing — derived state for the Fire-next-course button and the
  // "courses pending" hint near auto-pace.
  const heldChits = check?.chits.filter((c) => c.status === "HELD") ?? [];
  const nextHeldCourse = heldChits.length > 0
    ? Math.min(...heldChits.map((c) => c.course))
    : null;
  const autoFireGap = check?.autoFireGapMinutes ?? 0;

  // Shared void-check modal — same content whether triggered from the
  // open-checks list (no active check) or from inside an active check.
  // Voiding cancels active AND held prep chits server-side.
  const voidCheckModalNode = voidCheckModal ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-xl shadow-elevated w-full max-w-md p-6">
        <h2 className="font-serif text-xl text-club-ink">Void check {voidCheckModal.checkNumber}?</h2>
        <p className="mt-2 text-sm text-stone-600">
          Voiding removes the check from the open-checks list and cancels any prep tickets still active at the kitchen or bar.
        </p>
        <p className="mt-3 text-xs uppercase tracking-wide text-stone-500">
          Reason <span className="text-stone-400 normal-case tracking-normal">(select one or more)</span>
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {VOID_CHECK_REASONS.map((r) => {
            const active = selectedVoidReasons.includes(r);
            return (
              <button
                key={r}
                type="button"
                onClick={() => toggleVoidReason(r)}
                disabled={pending}
                aria-pressed={active}
                className={`px-3 py-2 rounded-md text-sm border min-h-[2.5rem] transition-colors ${
                  active
                    ? "bg-club-green-700 text-white border-club-green-700"
                    : "bg-white text-stone-700 border-stone-200 hover:border-club-green-400 hover:bg-club-green-50/30"
                }`}
              >
                {r}
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={closeVoidCheckPrompt}>Cancel</button>
          <button
            type="button"
            className="btn btn-sm border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-60 disabled:cursor-not-allowed"
            disabled={pending || selectedVoidReasons.length === 0}
            onClick={confirmVoidCheck}
          >
            Void check
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const activeCategory = menu.find((c) => c.id === activeCategoryId) ?? menu[0] ?? null;

  // -------------------------------------------------------------------------
  // QR Pay pending state — gateway hasn't confirmed yet.
  // -------------------------------------------------------------------------
  if (pendingPayment) {
    const failed = !!pendingPayment.failureReason;
    const qrLandingUrl =
      typeof window !== "undefined"
        ? `${window.location.origin}/pos/pay/${pendingPayment.saleId}`
        : `/pos/pay/${pendingPayment.saleId}`;
    return (
      <PendingPaymentScreen
        sale={pendingPayment}
        qrLandingUrl={qrLandingUrl}
        failureReason={pendingPayment.failureReason}
        onDecline={async () => {
          // Bail all the way out to the open-checks landing.
          setPendingPayment(null);
          await refreshOpenChecks();
          closeActiveCheckView();
        }}
        onRetry={async () => {
          // Stay on the active check so the operator can retry by
          // phone or switch to Charge to Member. The check itself
          // is now PAYMENT_FAILED on the server — the in-progress
          // banner in the check panel reflects that, and the Retry
          // / Charge buttons re-enable.
          setPendingPayment(null);
          await refreshCheck();
        }}
      />
    );
  }

  // -------------------------------------------------------------------------
  // Success state — settlement confirmed
  // -------------------------------------------------------------------------
  if (success) {
    return (
      <SettlementSuccessScreen
        success={success}
        check={check}
        onDone={() => {
          setSuccess(null);
          closeActiveCheckView();
        }}
      />
    );
  }

  // -------------------------------------------------------------------------
  // No active check: show start screen with open-checks list
  // -------------------------------------------------------------------------
  if (!activeCheckId) {
    return (
      // Non-active-check landing scrolls internally — the AdminShell
      // `<main>` clips its own overflow, so this view needs to be
      // scrollable on its own to keep the open-checks list reachable
      // when it gets long.
      <div className="space-y-6 flex-1 min-h-0 overflow-y-auto pr-1">
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        <div className="card card-body text-center">
          <h2 className="font-serif text-2xl text-club-ink">Open a new lounge check</h2>
          <p className="mt-2 text-sm text-stone-500 max-w-md mx-auto">
            Start a check for the table, add food and drink items, send them to the kitchen and bar, and settle when the guest is ready.
          </p>
          <div className="mt-6">
            <button type="button" className="btn btn-primary" onClick={startNewCheck} disabled={pending}>
              New check
            </button>
          </div>
        </div>

        {/* Member search modal */}
        {showNewCheck && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4"
            role="dialog" aria-modal="true"
            onClick={(e) => { if (e.target === e.currentTarget) { setShowNewCheck(false); setKeyboardOpen(false); } }}
          >
            {/* max-w-lg so the 10-column touch keyboard fits without
                horizontal clipping; max-h-[90vh] + overflow-y-auto so
                short screens scroll instead of letting the keyboard
                spill off the bottom. */}
            <div className="bg-white rounded-xl shadow-elevated w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
              <h3 className="font-serif text-xl text-club-ink">Select member</h3>
              <p className="mt-1 text-xs text-stone-500">Search by name or 4-digit member number.</p>
              <input
                ref={memberInputRef}
                type="text"
                inputMode="none"
                className="input mt-3"
                placeholder="Search…"
                value={memberQuery}
                onChange={(e) => setMemberQuery(e.target.value)}
                onFocus={() => setKeyboardOpen(true)}
                autoComplete="off"
              />
              {memberQuery && (
                <div ref={memberResultsRef} className="mt-2 max-h-60 overflow-y-auto rounded-md border border-stone-200 bg-white">
                  {searching && <div className="px-3 py-2 text-xs text-stone-500">Searching…</div>}
                  {!searching && memberResults.length === 0 && (
                    <div className="px-3 py-2 text-xs text-stone-500">No matches.</div>
                  )}
                  {memberResults.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm border-t border-stone-100 first:border-t-0 hover:bg-stone-50"
                      onClick={() => confirmMemberOpenCheck(m)}
                    >
                      <div className="font-medium text-club-ink">{m.firstName} {m.lastName}</div>
                      <div className="text-xs text-stone-500">
                        Member {stripMemberPrefix(m.memberNumber)} ·{" "}
                        {m.accessStatus !== "FULL_ACCESS" ? <span className="text-red-700">{humaniseAccess(m.accessStatus)}</span> : "Full access"}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {keyboardOpen && (
                <div ref={memberKeyboardRef}>
                  <TouchKeyboard onKey={appendChar} onBackspace={deleteLastChar} onClear={clearQuery} onClose={() => setKeyboardOpen(false)} />
                </div>
              )}
              <div className="mt-4 flex justify-end">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setShowNewCheck(false); setKeyboardOpen(false); }}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-stone-200 font-medium">Open checks ({openChecks.length})</div>
          <table className="table-base">
            <thead>
              <tr>
                <th>Check #</th>
                <th>Member</th>
                <th>Items</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {openChecks.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-stone-500">No open checks. Tap &ldquo;New check&rdquo; above to start one.</td></tr>
              )}
              {openChecks.map((c) => (
                <tr key={c.id}>
                  <td className="text-xs font-mono">{c.checkNumber}</td>
                  <td className="text-sm">{c.member ? `${c.member.firstName} ${c.member.lastName}` : "—"}</td>
                  <td className="text-xs text-stone-500">{c.lines.length} item{c.lines.length === 1 ? "" : "s"}</td>
                  <td>
                    <ServiceStatusBadge
                      chits={c.chits}
                      hasDrafts={c.lines.some((l) => l.status === "DRAFT")}
                      checkStatus={c.status}
                      paymentFailureReason={c.posSale?.payments[0]?.failureReason ?? null}
                    />
                  </td>
                  <td className="text-right">
                    <div className="inline-flex gap-2">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => resumeCheck(c.id)}>Resume</button>
                      <button
                        type="button"
                        className="btn btn-sm border border-red-200 bg-white text-red-700 hover:bg-red-50"
                        onClick={() => openVoidCheckPrompt({ id: c.id, checkNumber: c.checkNumber })}
                      >
                        Void
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {voidCheckModalNode}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Active check view: menu (left) + check panel (right)
  // -------------------------------------------------------------------------
  if (!check) {
    return <div className="card card-body text-center text-sm text-stone-500">Loading check…</div>;
  }

  const diningMode = check.diningMode === "TO_GO" ? "TO_GO" : "STAY";
  const chitDiscountPct = Number(String(check.chitDiscountPct ?? 0));

  return (
    // Viewport-fit layout. AdminShell main is a flex column with
    // overflow-hidden, so this wrapper takes flex-1 of the remaining
    // height. The grid inside also flex-1's so it fills the wrapper.
    // Modals live as siblings of the grid (outside it) so they can't
    // accidentally become grid cells and push the tile rows down.
    <div className="flex flex-col flex-1 min-h-0">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_24rem] lg:grid-rows-1 gap-4 flex-1 min-h-0 overflow-hidden">
      {/* ---------------- LEFT: header + menu ---------------- */}
      <div className="flex flex-col gap-3 min-w-0 min-h-0">
        <div className="card card-body shrink-0">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide text-stone-500">Check {check.checkNumber}</div>
              {check.member ? (
                <>
                  <div className="mt-0.5 font-serif text-lg text-club-ink truncate">{check.member.firstName} {check.member.lastName}</div>
                  <div className="mt-0.5 text-xs text-stone-500">
                    Member {stripMemberPrefix(check.member.memberNumber)} · <Badge status={check.member.status} />
                  </div>
                </>
              ) : (
                <div className="mt-0.5 text-sm text-stone-500">No member attached</div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className="btn btn-sm border border-red-200 bg-white text-red-700 hover:bg-red-50"
                onClick={() => openVoidCheckPrompt({ id: check.id, checkNumber: check.checkNumber })}
                disabled={pending}
              >
                Void check
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={closeActiveCheckView}>
                ← Open checks
              </button>
            </div>
          </div>
          {chargeAccountBlocked && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
              <strong>{check.member?.firstName} {check.member?.lastName}</strong>&rsquo;s charge account is suspended. Use Pay by Phone to settle.
            </div>
          )}
        </div>

        {/* Menu (category grid or item view) — flex-grows into the
            remaining vertical space and clips at the bottom so the
            whole category fits the viewport. */}
        {activeCategoryId === null ? (
          <div className="card card-body flex-1 min-h-0 overflow-hidden">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 auto-rows-fr gap-3 h-full">
              {menu.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setActiveCategoryId(c.id)}
                  className="flex items-center justify-center text-center rounded-lg border border-stone-200 bg-white p-3 font-medium text-club-ink leading-tight hover:border-club-green-400 hover:bg-club-green-50/30 active:bg-club-green-50 transition-colors h-full min-h-[4rem]"
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        ) : (() => {
          const subGroups = activeCategory ? subGroupsForCategory(activeCategory) : [];
          const subPrefixes = subGroups.map((g) => g.prefix);
          const mainItems = activeCategory ? activeCategory.items.filter((it) => !subPrefixes.some((p) => it.name.startsWith(p))) : [];
          const activeSub = subGroups.find((g) => g.label === activeSubGroupKey) ?? null;
          const goBack = () => { if (activeSubGroupKey) setActiveSubGroupKey(null); else setActiveCategoryId(null); };
          // Compute the visible-item count once so we can pick a column
          // count that keeps tiles a comfortable size. Big categories
          // (e.g. Beer · Draught with 21 items) get 5–6 columns so all
          // tiles fit; small categories (e.g. Desserts with 5) stay at
          // 3–4 columns so tiles don't look stranded.
          const visibleCount = activeSub
            ? activeSub.items.length
            : mainItems.length + subGroups.length;
          const denseGridCols =
            visibleCount > 18
              ? "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6"
              : visibleCount > 12
              ? "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-5"
              : visibleCount > 6
              ? "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4"
              : "grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-3";
          // Row sizing rule:
          //   • Sparse categories (≤ 12 items) — use a fixed 8rem row
          //     so the tiles look the same size as the natural row in
          //     a dense category. A 5-item Kids Menu doesn't render
          //     giant cards; it shows 5 standard-sized cards with
          //     empty space below.
          //   • Dense categories (> 12) — auto-rows-fr divides the
          //     viewport so every tile stays on screen. The fr share
          //     for the densest cases (21 items / 6 cols / 4 rows)
          //     lands near 8rem, so visual consistency is preserved.
          const autoRowsCls = visibleCount > 12 ? "auto-rows-fr" : "auto-rows-[8rem]";
          return (
            <div className="card overflow-hidden flex-1 min-h-0 flex flex-col">
              <div className="px-4 py-3 border-b border-stone-200 flex items-center gap-3 shrink-0">
                <button type="button" onClick={goBack} aria-label="Back" className="inline-flex items-center justify-center h-9 w-9 rounded-md border border-stone-200 text-stone-600 hover:bg-stone-50">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
                </button>
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wide text-stone-500">Category</div>
                  <div className="font-medium text-club-ink truncate">
                    {activeCategory?.name}{activeSub && <span className="text-stone-400"> · </span>}
                    {activeSub && <span className="text-club-green-700">{activeSub.label}</span>}
                  </div>
                </div>
                <button type="button" className="ml-auto text-xs text-club-green-700 hover:underline" onClick={() => { setActiveCategoryId(null); setActiveSubGroupKey(null); }}>All categories</button>
              </div>
              <div className="flex-1 min-h-0 p-3 overflow-hidden">
                {activeSub ? (
                  <div className={`grid ${denseGridCols} ${autoRowsCls} gap-2 h-full content-start`}>
                    {activeSub.items.map((it) => (
                      <MenuItemTile
                        key={it.id}
                        displayName={it.name.replace(activeSub.prefix, "").trim()}
                        description={it.description}
                        price={it.price}
                        onClick={() => addItem(it)}
                        disabled={pending}
                      />
                    ))}
                  </div>
                ) : (
                  <div className={`grid ${denseGridCols} ${autoRowsCls} gap-2 h-full content-start`}>
                    {mainItems.map((it) => (
                      <MenuItemTile
                        key={it.id}
                        displayName={it.name}
                        description={it.description}
                        price={it.price}
                        onClick={() => addItem(it)}
                        disabled={pending}
                      />
                    ))}
                    {subGroups.map((sg) => (
                      <button key={sg.label} type="button" onClick={() => setActiveSubGroupKey(sg.label)} className="text-left rounded-lg border border-stone-300 bg-stone-50 hover:border-club-green-400 hover:bg-club-green-50/30 transition-colors px-3 py-2 h-full flex flex-col justify-between overflow-hidden">
                        <div className="min-w-0">
                          <div className="font-medium text-sm text-club-ink leading-tight truncate">{sg.label}</div>
                          <div className="mt-0.5 text-[11px] text-stone-500">Add-ons</div>
                        </div>
                        <div className="mt-1 text-[11px] text-club-green-700 inline-flex items-center gap-1">
                          <span>{sg.items.length} options</span>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="M12 5l7 7-7 7" /></svg>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      {/* ---------------- RIGHT: check panel ---------------- */}
      <div className="card flex flex-col min-h-0 lg:h-full overflow-hidden">
        <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between gap-3">
          <div className="font-medium text-club-ink">Check</div>
          <div className="inline-flex items-center rounded-md border border-stone-200 overflow-hidden text-xs">
            {(["STAY", "TO_GO"] as const).map((mode) => {
              const active = diningMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => changeDiningMode(mode)}
                  disabled={pending}
                  className={`px-3 py-1 border-r border-stone-200 last:border-r-0 ${active ? "bg-club-green-700 text-white font-medium" : "bg-white text-stone-600 hover:bg-stone-50"}`}
                  aria-pressed={active}
                >
                  {mode === "STAY" ? "Stay" : "To Go"}
                </button>
              );
            })}
          </div>
        </div>

        {/* Lines grouped by status */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {check.lines.length === 0 && (
            <div className="text-sm text-stone-500 py-12 text-center">Tap a menu item to add it.</div>
          )}
          {/* DRAFT */}
          {draftLineCount > 0 && (
            <div className="text-[10px] uppercase tracking-wide text-stone-500 mt-1">Not sent</div>
          )}
          {check.lines.filter((l) => l.status === "DRAFT").map((l) => (
            <CheckLineRow
              key={l.id}
              line={l}
              onQty={(d) => changeLineQty(l, d)}
              onDiscount={(p) => setLineDiscount(l, p)}
              onCourse={(c) => setLineCourse(l, c)}
              onNote={(n) => setLineNote(l, n)}
              onRemove={() => removeLine(l)}
              onModify={() => openModifierModal(l)}
              pending={pending}
              chitOverridesLine={chitDiscountPct > 0}
            />
          ))}
          {/* SENT */}
          {sentLineCount > 0 && (
            <div className="text-[10px] uppercase tracking-wide text-stone-500 mt-3">Sent to prep</div>
          )}
          {check.lines.filter((l) => ["SENT","FIRED","PREPARING","READY","SERVED"].includes(l.status)).map((l) => (
            <SentLineRow
              key={l.id}
              line={l}
              onVoid={() => openVoidPrompt(l)}
              onServed={() => markLineServed(l)}
              pending={pending}
            />
          ))}
          {/* VOIDED / COMPED */}
          {check.lines.filter((l) => l.status === "VOIDED" || l.status === "COMPED").map((l) => (
            <VoidedLineRow key={l.id} line={l} />
          ))}
        </div>

        {/* Totals + chit discount */}
        <div className="border-t border-stone-200 px-4 py-2 flex items-center gap-2 text-xs">
          <span className="text-stone-500 shrink-0">Check discount</span>
          <CompactDiscountPicker value={chitDiscountPct} onChange={changeChitDiscount} />
        </div>
        {/* Coursing — auto-pace timer (off / 5 / 10 / 15 / 20 min) */}
        <div className="border-t border-stone-200 px-4 py-2 flex items-center gap-2 text-xs">
          <span className="text-stone-500 shrink-0">Auto-pace</span>
          <AutoPacePicker value={autoFireGap} onChange={changeAutoPace} disabled={pending} />
          {heldChits.length > 0 && (
            <span className="ml-auto text-[10px] text-stone-500 whitespace-nowrap">
              {heldChits.length} held
            </span>
          )}
        </div>
        <div className="border-t border-stone-200 px-4 py-3 space-y-1">
          <Row label="Subtotal" value={formatCurrency(totals.subtotal)} />
          {totals.compTotal > 0 && <Row label="Comps" value={`(${formatCurrency(totals.compTotal)})`} green />}
          {totals.regularLineTotal > 0 && <Row label="Line discounts" value={`(${formatCurrency(totals.regularLineTotal)})`} green />}
          {totals.chitAppliedTotal > 0 && <Row label={`Check discount ${chitDiscountPct}%`} value={`(${formatCurrency(totals.chitAppliedTotal)})`} green />}
          <Row label="GST 5%" value={formatCurrency(totals.taxTotal)} />
          <div className="flex justify-between text-base font-medium border-t border-stone-100 pt-2 mt-1">
            <span>Total</span><span className="tabular-nums">{formatCurrency(totals.grandTotal)}</span>
          </div>
        </div>

        {/* Action buttons */}
        <div className="p-3 border-t border-stone-200 space-y-2">
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">{error}</div>
          )}
          {nextHeldCourse !== null && (
            <button
              type="button"
              disabled={pending}
              onClick={fireNextCourse}
              className="btn w-full bg-amber-100 border border-amber-300 text-amber-900 hover:bg-amber-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Fire course {nextHeldCourse}
            </button>
          )}
          <button type="button" disabled={!canSend || pending} onClick={sendChits} className="btn btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed">
            {draftLineCount > 0 ? `Send ${draftLineCount} item${draftLineCount === 1 ? "" : "s"} to prep` : "Send to Kitchen/Bar"}
          </button>
          {/* QR-pay state banner. When a sale's in flight, both settle
              buttons go disabled — the operator can only watch the
              payment resolve. After a failure they're re-enabled so
              another method can be chosen. */}
          {qrInProgress && check?.posSaleId && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <div className="font-medium">Pay-by-phone in progress</div>
              <div className="mt-0.5">Waiting on gateway confirmation. Both settle buttons are paused until it resolves.</div>
              <button
                type="button"
                onClick={() => {
                  // Re-open the pending screen so the operator can
                  // watch the status / decline manually.
                  if (!check?.posSaleId) return;
                  setPendingPayment({
                    saleId: check.posSaleId,
                    saleNumber: check.checkNumber,
                    grandTotal: totals.grandTotal,
                    checkId: check.id,
                    failureReason: null,
                  });
                }}
                className="mt-1.5 text-amber-900 underline text-xs"
              >
                View payment status
              </button>
            </div>
          )}
          {qrFailed && (
            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
              <div className="font-medium">Last QR payment failed</div>
              <div className="mt-0.5">Retry by phone, or charge to the member account instead.</div>
            </div>
          )}
          <button
            type="button"
            disabled={!canSettleMember || pending}
            onClick={() => openSettleConfirm("MEMBER_ACCOUNT")}
            className="btn btn-secondary w-full disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {qrInProgress ? "Settle to Member Account (locked while QR in progress)" : "Settle to Member Account"}
          </button>
          <button
            type="button"
            disabled={!canSettleQr || pending}
            onClick={() => openSettleConfirm("QR_PAY")}
            className={`btn w-full disabled:opacity-50 disabled:cursor-not-allowed ${
              qrInProgress
                ? "border border-amber-300 bg-amber-100 text-amber-900"
                : "btn-secondary"
            }`}
          >
            {qrInProgress
              ? "Payment in progress…"
              : qrFailed
              ? "Retry Pay by Phone (QR)"
              : "Settle by Phone (QR)"}
          </button>
        </div>
      </div>
      </div>{/* end grid: modals below are NOT grid items */}

      {voidCheckModalNode}

      {modifierModal && (
        <ModifierModal
          line={modifierModal.line}
          pending={pending}
          onSave={saveModifiers}
          onCancel={() => setModifierModal(null)}
        />
      )}

      {/* Settle confirmation modal */}
      {confirmSettleOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4" role="dialog" aria-modal="true">
          <div className="bg-white rounded-xl shadow-elevated w-full max-w-md p-6">
            <h2 className="font-serif text-xl text-club-ink">
              {pendingPaymentMethod === "QR_PAY" ? "Settle by Phone" : "Settle to Member Account"}
            </h2>
            <p className="mt-2 text-sm text-stone-600">
              Close check {check.checkNumber} for <strong>{formatCurrency(totals.grandTotal)}</strong>?
            </p>
            {draftLineCount > 0 && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {draftLineCount} item{draftLineCount === 1 ? " is" : "s are"} still in draft (not sent to prep). Tap Cancel to send them first, or settle anyway.
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => setConfirmSettleOpen(false)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={pending} onClick={() => confirmSettle(draftLineCount > 0)}>
                {pending ? "Posting…" : draftLineCount > 0 ? "Settle anyway" : "Settle"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Void line modal */}
      {voidLineModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4" role="dialog" aria-modal="true">
          <div className="bg-white rounded-xl shadow-elevated w-full max-w-md p-6">
            <h2 className="font-serif text-xl text-club-ink">Void item</h2>
            <p className="mt-2 text-sm text-stone-600">{voidLineModal.description}</p>
            <p className="mt-2 text-xs text-stone-500">Voiding a sent item requires a reason for the audit log.</p>
            <textarea
              className="input mt-3 text-sm"
              rows={2}
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="e.g. Guest changed their mind"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => setVoidLineModal(null)}>Cancel</button>
              <button type="button" className="btn btn-primary btn-sm" disabled={pending || voidReason.trim().length < 3} onClick={confirmVoid}>Void item</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------
// Inline subcomponents
// -------------------------------------------------------------------------

// Menu-item tile rendered in the category grid. Fills its cell (the
// parent grid uses `auto-rows-fr` so all tiles share the available
// vertical space evenly). Title shrinks via `pickTitleClass`; the
// description is line-clamped so a long F&B-manager pairing note
// can't push the price out of its row. Price stays anchored at the
// bottom via `mt-auto`.
function MenuItemTile({
  displayName,
  description,
  price,
  onClick,
  disabled,
}: {
  displayName: string;
  description: string | null | undefined;
  price: number;
  onClick: () => void;
  disabled: boolean;
}) {
  const titleCls = pickTitleClass(displayName, description ?? "");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-left rounded-lg border border-stone-200 bg-white hover:border-club-green-400 hover:bg-club-green-50/30 transition-colors px-3 py-2 disabled:opacity-60 flex flex-col h-full overflow-hidden min-h-[3.5rem]"
    >
      <div className={`font-medium text-club-ink leading-tight ${titleCls}`}>{displayName}</div>
      {description && (
        <div className="mt-0.5 text-[11px] text-stone-500 leading-snug line-clamp-3">{description}</div>
      )}
      <div className="mt-auto pt-1 font-serif text-club-ink">{formatCurrency(price)}</div>
    </button>
  );
}

// Title-size ladder. Heuristic: weight the description more than the
// title since description usually drives total tile height. Numbers
// were picked to keep typical wine/beer pairings (≈80–110 chars) on
// a single comfortable title line while still letting a very long
// description push the title down to text-xs.
function pickTitleClass(name: string, description: string): string {
  const nameLen = name.length;
  const descLen = description.length;
  const score = nameLen + descLen * 1.5;
  if (descLen === 0 && nameLen <= 22) return "text-base";
  if (score <= 120) return "text-sm";
  if (score <= 200) return "text-[13px]";
  return "text-xs";
}

function CheckLineRow({ line, onQty, onDiscount, onCourse, onNote, onRemove, onModify, pending, chitOverridesLine }: {
  line: CheckLine;
  onQty: (delta: number) => void;
  onDiscount: (p: number) => void;
  onCourse: (c: number) => void;
  onNote: (n: string) => void;
  onRemove: () => void;
  onModify: () => void;
  pending: boolean;
  chitOverridesLine: boolean;
}) {
  const qty = Number(String(line.quantity));
  const basePrice = Number(String(line.unitPrice));
  const pct = Number(String(line.discountPct));
  // Modifier delta per unit + the effective unit price after modifiers.
  // Allergy / Note modifiers always have priceDelta = 0; Remove / Add /
  // Substitute may carry a delta the cart needs to reflect.
  const modDelta = line.modifiers.reduce(
    (s, m) => s + Number(String(m.priceDelta)),
    0
  );
  const effectivePrice = basePrice + modDelta;
  const lineTotal = qty * effectivePrice;
  // Compact summary of structured modifiers, plus the allergy badge
  // (which may carry multiple allergens) and any free-text note.
  const structuredMods = line.modifiers.filter(
    (m) => m.modifierType !== "ALLERGY" && m.modifierType !== "NOTE"
  );
  const noteMod = line.modifiers.find((m) => m.modifierType === "NOTE");
  const allergyMods = line.modifiers.filter((m) => m.modifierType === "ALLERGY");
  return (
    <div className="rounded-md border border-stone-200 px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-club-ink truncate">{line.description}</div>
          <div className="text-xs text-stone-500">
            {formatCurrency(effectivePrice)} each
            {modDelta !== 0 && (
              <span className="ml-1 text-stone-400">
                ({formatCurrency(basePrice)} {modDelta > 0 ? "+" : "−"} {formatCurrency(Math.abs(modDelta))} mods)
              </span>
            )}
          </div>
        </div>
        <div className="text-sm text-club-ink shrink-0 tabular-nums">{formatCurrency(lineTotal)}</div>
      </div>

      {/* Modifier summary + allergy / note callouts */}
      {(structuredMods.length > 0 || noteMod || allergyMods.length > 0) && (
        <div className="mt-1.5 space-y-1">
          {structuredMods.length > 0 && (
            <div className="text-[11px] text-stone-600 leading-snug">
              {structuredMods.map((m) => (m.printLabel || m.label)).join(" · ")}
            </div>
          )}
          {allergyMods.length > 0 && (
            <div className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-800">
              <span className="text-[10px] uppercase tracking-wide">Allergy</span>
              <span className="font-normal">{allergyMods.map((m) => m.label).join(", ")}</span>
            </div>
          )}
          {noteMod && (
            <div className="text-[11px] text-stone-500 italic leading-snug">&ldquo;{noteMod.label}&rdquo;</div>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="inline-flex items-center rounded-md border border-stone-200">
          <button type="button" disabled={pending} className="px-2 py-1 text-stone-600 hover:bg-stone-50" aria-label="Decrease" onClick={() => onQty(-1)}>−</button>
          <span className="px-3 text-sm tabular-nums">{qty}</span>
          <button type="button" disabled={pending} className="px-2 py-1 text-stone-600 hover:bg-stone-50" aria-label="Increase" onClick={() => onQty(1)}>+</button>
        </div>
        <button type="button" disabled={pending} className="text-xs text-stone-500 hover:text-red-700" onClick={onRemove}>Remove</button>
      </div>
      <input
        type="text"
        placeholder="Note / modifier (optional)"
        defaultValue={line.note ?? ""}
        onBlur={(e) => { if ((e.target.value || "") !== (line.note ?? "")) onNote(e.target.value); }}
        className="mt-2 w-full text-xs px-2 py-1 rounded border border-stone-200 focus:border-club-green-500 focus:outline-none focus:ring-1 focus:ring-club-green-500"
      />
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="text-stone-500 shrink-0">Course</span>
        <CoursePicker value={line.course} onChange={onCourse} disabled={pending} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-stone-500 shrink-0">Discount</span>
          <CompactDiscountPicker value={pct} onChange={onDiscount} overriddenByChit={chitOverridesLine} />
          {chitOverridesLine && pct > 0 && pct < 100 && (
            <span className="text-[10px] text-stone-500">overridden by check</span>
          )}
        </div>
        {/* Modify button — bottom-right of the row per spec. Opens the
            modifier panel for this line. */}
        <button
          type="button"
          disabled={pending}
          onClick={onModify}
          className="inline-flex items-center gap-1 rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:border-club-green-500 hover:bg-club-green-50/30 hover:text-club-green-800 disabled:opacity-50"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
          </svg>
          Modify
        </button>
      </div>
    </div>
  );
}

function SentLineRow({ line, onVoid, onServed, pending }: {
  line: CheckLine;
  onVoid: () => void;
  onServed: () => void;
  pending: boolean;
}) {
  const qty = Number(String(line.quantity));
  const basePrice = Number(String(line.unitPrice));
  const modDelta = line.modifiers.reduce((s, m) => s + Number(String(m.priceDelta)), 0);
  const lineTotal = qty * (basePrice + modDelta);
  const structuredMods = line.modifiers.filter(
    (m) => m.modifierType !== "ALLERGY" && m.modifierType !== "NOTE"
  );
  const allergyMods = line.modifiers.filter((m) => m.modifierType === "ALLERGY");
  const noteMod = line.modifiers.find((m) => m.modifierType === "NOTE");
  const isReady = line.status === "READY";
  const isServed = line.status === "SERVED";
  return (
    <div className={`rounded-md border px-3 py-2 ${isServed ? "border-club-green-200 bg-club-green-50/40" : "border-stone-200 bg-stone-50"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-club-ink truncate">{qty} × {line.description}</div>
          <div className="text-xs text-stone-500">
            {line.prepStation === "BAR" ? "Bar" : line.prepStation === "DESSERT" ? "Dessert" : "Kitchen"}
            <span className="text-stone-400"> · </span>Course {line.course}
            <span className="text-stone-400"> · </span>
            <span className={
              isServed ? "text-club-green-700 font-medium" :
              isReady ? "text-club-green-700" : ""
            }>{humaniseLineStatus(line.status)}</span>
          </div>
          {(structuredMods.length > 0 || allergyMods.length > 0 || noteMod) && (
            <div className="mt-1 space-y-1">
              {structuredMods.length > 0 && (
                <div className="text-[11px] text-stone-600 leading-snug">
                  {structuredMods.map((m) => (m.printLabel || m.label)).join(" · ")}
                </div>
              )}
              {allergyMods.length > 0 && (
                <div className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-800">
                  <span className="text-[10px] uppercase tracking-wide">Allergy</span>
                  <span className="font-normal">{allergyMods.map((m) => m.label).join(", ")}</span>
                </div>
              )}
              {noteMod && (
                <div className="text-[11px] text-stone-500 italic leading-snug">&ldquo;{noteMod.label}&rdquo;</div>
              )}
            </div>
          )}
        </div>
        <div className="text-sm text-club-ink shrink-0 tabular-nums">{formatCurrency(lineTotal)}</div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-3">
        {/* "Mark Served" is the READY → SERVED transition the server
            (or expo) taps after delivering to the table. Once SERVED
            it stays visible on the timeline with a green badge. */}
        {isReady && (
          <button
            type="button"
            className="text-xs font-medium text-club-green-700 hover:text-club-green-800 disabled:opacity-50"
            onClick={onServed}
            disabled={pending}
          >
            Mark served
          </button>
        )}
        <button type="button" className="text-xs text-red-700 hover:underline disabled:opacity-50" onClick={onVoid} disabled={pending}>Void with reason</button>
      </div>
    </div>
  );
}

function VoidedLineRow({ line }: { line: CheckLine }) {
  const qty = Number(String(line.quantity));
  return (
    <div className="rounded-md border border-stone-100 px-3 py-2 text-stone-400 text-sm line-through">
      {qty} × {line.description} <span className="text-[10px] uppercase">({line.status})</span>
    </div>
  );
}

// -------------------------------------------------------------------------
// Modifier modal — opened from the "Modify" button on a DRAFT cart row.
//
// Layout is purposely two-column at lg+ so the entire panel fits the
// viewport without scrolling — POS workstations run on a fixed-size
// touch screen. Left side: Remove / Add / Substitute chips. Right
// side: common-allergen chip multi-select + free-text kitchen note
// driven by an on-screen TouchKeyboard (no physical keyboard exists
// on the lounge POS).
// -------------------------------------------------------------------------
type CatalogGroup = {
  id: string;
  label: string;
  modifierType: "REMOVE" | "ADD" | "SUBSTITUTE";
  options: { id: string; label: string; printLabel: string | null; priceDelta: number }[];
};

// Health Canada priority + most-common-in-practice allergens. Kept
// short on purpose so the chip grid fits one row of three by three.
const COMMON_ALLERGENS: readonly string[] = [
  "Peanuts",
  "Tree nuts",
  "Gluten",
  "Dairy",
  "Eggs",
  "Shellfish",
  "Fish",
  "Soy",
  "Sesame",
];

function ModifierModal({
  line,
  pending,
  onSave,
  onCancel,
}: {
  line: CheckLine;
  pending: boolean;
  onSave: (mods: ModifierInputUI[]) => void;
  onCancel: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogGroup[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Selected catalog option IDs.
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(
    () => new Set(line.modifiers.filter((m) => m.optionId).map((m) => m.optionId as string))
  );
  // Single-select per SUBSTITUTE group (groupId → optionId).
  const [substituteByGroup, setSubstituteByGroup] = useState<Map<string, string>>(
    () => new Map()
  );
  // Allergy set — hydrated from any existing ALLERGY modifiers whose
  // label matches a known allergen. Unknown labels (legacy free-text
  // like "Gluten sensitivity") are dropped on next save; the server
  // can re-pick from the chip grid.
  const [selectedAllergens, setSelectedAllergens] = useState<Set<string>>(() => {
    const known = new Set<string>();
    for (const m of line.modifiers) {
      if (m.modifierType !== "ALLERGY") continue;
      if (COMMON_ALLERGENS.includes(m.label)) known.add(m.label);
    }
    return known;
  });
  // Free-text kitchen note.
  const initialNote = line.modifiers.find((m) => m.modifierType === "NOTE");
  const [noteText, setNoteText] = useState<string>(initialNote?.label ?? "");
  // Touch keyboard for the note — closed until the server taps the
  // note field. The note input is `readOnly` so the touch keyboard is
  // the only path to type, mirroring the member-search flow.
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  // Refs let us implement "tap anywhere outside the note + keyboard
  // to retract the keyboard" without dismissing the modal. The note
  // input keeps it open while focused; the keyboard wrapper keeps it
  // open while the server is tapping keys.
  const noteInputRef = useRef<HTMLInputElement>(null);
  const keyboardRef = useRef<HTMLDivElement>(null);

  // Load the catalog on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!line.menuItemId) {
        setCatalog([]);
        return;
      }
      const r = await listLineModifiersAction(line.menuItemId);
      if (cancelled) return;
      if (r.ok) {
        setCatalog(r.data as CatalogGroup[]);
        // Hydrate substituteByGroup from current line state.
        const subMap = new Map<string, string>();
        for (const g of r.data as CatalogGroup[]) {
          if (g.modifierType !== "SUBSTITUTE") continue;
          for (const o of g.options) {
            if (line.modifiers.some((m) => m.optionId === o.id)) {
              subMap.set(g.id, o.id);
              break;
            }
          }
        }
        setSubstituteByGroup(subMap);
      } else {
        setLoadError(r.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [line.id, line.menuItemId]);

  function toggleOption(option: { id: string }) {
    setSelectedOptions((prev) => {
      const next = new Set(prev);
      if (next.has(option.id)) next.delete(option.id);
      else next.add(option.id);
      return next;
    });
  }
  function pickSubstitute(groupId: string, optionId: string | null) {
    setSubstituteByGroup((prev) => {
      const next = new Map(prev);
      // Clear previous selection in this group from selectedOptions.
      const group = catalog?.find((g) => g.id === groupId);
      if (group) {
        const oldOptId = prev.get(groupId);
        if (oldOptId) {
          setSelectedOptions((s) => {
            const ss = new Set(s);
            ss.delete(oldOptId);
            return ss;
          });
        }
      }
      if (optionId === null) {
        next.delete(groupId);
      } else {
        next.set(groupId, optionId);
        setSelectedOptions((s) => new Set(s).add(optionId));
      }
      return next;
    });
  }
  function toggleAllergen(name: string) {
    setSelectedAllergens((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }
  function appendNoteChar(c: string) {
    setNoteText((p) => (p + c).slice(0, 200));
  }
  function backspaceNote() {
    setNoteText((p) => p.slice(0, -1));
  }
  function clearNote() {
    setNoteText("");
  }

  const canSave = !pending && catalog !== null;

  function handleSave() {
    if (!catalog || !canSave) return;
    const out: ModifierInputUI[] = [];
    // Catalog options (Remove / Add / Substitute).
    for (const g of catalog) {
      for (const o of g.options) {
        if (!selectedOptions.has(o.id)) continue;
        out.push({
          optionId: o.id,
          modifierType: g.modifierType,
          label: o.label,
          printLabel: o.printLabel,
          priceDelta: o.priceDelta,
        });
      }
    }
    // One ALLERGY modifier row per selected allergen. The server
    // requires a non-empty label — chip labels guarantee that.
    for (const name of selectedAllergens) {
      out.push({
        optionId: null,
        modifierType: "ALLERGY",
        label: name,
        priceDelta: 0,
      });
    }
    // Free-text kitchen / bar note (optional).
    if (noteText.trim()) {
      out.push({
        optionId: null,
        modifierType: "NOTE",
        label: noteText.trim(),
        priceDelta: 0,
      });
    }
    onSave(out);
  }

  // Modifier delta preview so the server sees the price impact before
  // saving. Loops the same way the cart row will once saved.
  const previewDelta = (() => {
    if (!catalog) return 0;
    let d = 0;
    for (const g of catalog) {
      for (const o of g.options) {
        if (selectedOptions.has(o.id)) d += o.priceDelta;
      }
    }
    return d;
  })();
  const qty = Number(String(line.quantity));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        // Clicking outside the modal closes it — fast escape for an
        // accidental "Modify" tap.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="bg-white rounded-xl shadow-elevated w-full max-w-5xl p-5 relative"
        onMouseDown={(e) => {
          // If the keyboard is open and the tap landed outside the
          // note field + keyboard, retract the keyboard. The chip
          // grids and other modal controls still receive their own
          // click (this handler doesn't prevent default) — so a
          // single tap dismisses the keyboard AND fires whatever
          // chip the server actually tapped.
          if (!keyboardOpen) return;
          const target = e.target as Node | null;
          if (!target) return;
          if (noteInputRef.current?.contains(target)) return;
          if (keyboardRef.current?.contains(target)) return;
          setKeyboardOpen(false);
        }}
      >
        {/* X close — top-right. Replaces the old Clear button so a
            server who tapped Modify by accident can dismiss instantly. */}
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          aria-label="Close"
          className="absolute top-3 right-3 inline-flex h-9 w-9 items-center justify-center rounded-md border border-stone-200 bg-white text-stone-500 hover:bg-stone-50 hover:text-stone-700 focus:outline-none focus:ring-2 focus:ring-club-green-400/40 disabled:opacity-60"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        {/* Header */}
        <div className="pr-10 min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-stone-500">Modify item</div>
          <h2 className="mt-0.5 font-serif text-xl text-club-ink truncate">{line.description}</h2>
          <div className="mt-1 text-xs text-stone-500">
            Quantity {qty}
            {previewDelta !== 0 && (
              <span className="ml-2 text-stone-700">
                · {previewDelta > 0 ? "+" : "−"}
                {formatCurrency(Math.abs(previewDelta))} per unit
              </span>
            )}
          </div>
        </div>

        {loadError && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</div>
        )}
        {!catalog && !loadError && (
          <div className="mt-6 text-sm text-stone-500 text-center py-6">Loading options…</div>
        )}

        {catalog && (
          // Two-column layout. Left side carries the structured
          // Remove/Add/Substitute panels; right side carries allergens
          // + note + touch keyboard. No internal overflow-scroll —
          // the modal is sized for the whole panel to fit a 1080p
          // POS workstation outright.
          <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* LEFT: modifications */}
            <div className="space-y-4 min-w-0">
              {(["REMOVE", "ADD", "SUBSTITUTE"] as const).map((type) => {
                const groups = catalog.filter((g) => g.modifierType === type);
                if (groups.length === 0) return null;
                return (
                  <section key={type}>
                    <div className="text-xs uppercase tracking-wide text-stone-500 font-medium">
                      {type === "REMOVE" ? "Remove" : type === "ADD" ? "Add" : "Substitute"}
                    </div>
                    {groups.map((g) => (
                      <div key={g.id} className="mt-2">
                        {groups.length > 1 && (
                          <div className="text-[11px] text-stone-500 mb-1">{g.label}</div>
                        )}
                        <div className="flex flex-wrap gap-1.5">
                          {g.modifierType === "SUBSTITUTE"
                            ? g.options.map((o) => {
                                const active = substituteByGroup.get(g.id) === o.id;
                                return (
                                  <button
                                    key={o.id}
                                    type="button"
                                    onClick={() => pickSubstitute(g.id, active ? null : o.id)}
                                    disabled={pending}
                                    aria-pressed={active}
                                    className={`min-h-[2.25rem] rounded-md border px-2.5 py-1 text-sm transition-colors ${
                                      active
                                        ? "bg-club-green-700 text-white border-club-green-700"
                                        : "bg-white text-stone-700 border-stone-200 hover:border-club-green-400 hover:bg-club-green-50/30"
                                    }`}
                                  >
                                    {o.label}
                                    {o.priceDelta !== 0 && (
                                      <span className={`ml-1.5 text-[10px] ${active ? "text-club-green-50" : "text-stone-500"}`}>
                                        {o.priceDelta > 0 ? "+" : "−"}
                                        {formatCurrency(Math.abs(o.priceDelta))}
                                      </span>
                                    )}
                                  </button>
                                );
                              })
                            : g.options.map((o) => {
                                const active = selectedOptions.has(o.id);
                                return (
                                  <button
                                    key={o.id}
                                    type="button"
                                    onClick={() => toggleOption(o)}
                                    disabled={pending}
                                    aria-pressed={active}
                                    className={`min-h-[2.25rem] rounded-md border px-2.5 py-1 text-sm transition-colors ${
                                      active
                                        ? "bg-club-green-700 text-white border-club-green-700"
                                        : "bg-white text-stone-700 border-stone-200 hover:border-club-green-400 hover:bg-club-green-50/30"
                                    }`}
                                  >
                                    {o.label}
                                    {o.priceDelta !== 0 && (
                                      <span className={`ml-1.5 text-[10px] ${active ? "text-club-green-50" : "text-stone-500"}`}>
                                        {o.priceDelta > 0 ? "+" : "−"}
                                        {formatCurrency(Math.abs(o.priceDelta))}
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                        </div>
                      </div>
                    ))}
                  </section>
                );
              })}
              {catalog.length === 0 && (
                <div className="text-sm text-stone-500 text-center py-4">
                  No catalogued modifiers for this item. Use the allergy chips or kitchen note on the right.
                </div>
              )}
            </div>

            {/* RIGHT: allergens + note + keyboard */}
            <div className="space-y-4 min-w-0">
              <section>
                <div className="text-xs uppercase tracking-wide text-red-700 font-medium">
                  Allergies <span className="text-stone-400 normal-case tracking-normal">(tap any that apply)</span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1.5">
                  {COMMON_ALLERGENS.map((name) => {
                    const active = selectedAllergens.has(name);
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => toggleAllergen(name)}
                        disabled={pending}
                        aria-pressed={active}
                        className={`min-h-[2.25rem] rounded-md border px-2 py-1 text-sm transition-colors ${
                          active
                            ? "bg-red-600 text-white border-red-600"
                            : "bg-white text-stone-700 border-stone-200 hover:border-red-300 hover:bg-red-50/40"
                        }`}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section>
                <div className="text-xs uppercase tracking-wide text-stone-500 font-medium">
                  Note to kitchen / bar
                </div>
                {/* readOnly so the on-screen keyboard is the only entry
                    path. The keyboard itself lives outside the modal
                    as a slide-up overlay so the modal never resizes. */}
                <input
                  ref={noteInputRef}
                  type="text"
                  value={noteText}
                  readOnly
                  inputMode="none"
                  onClick={(e) => { e.stopPropagation(); setKeyboardOpen(true); }}
                  onFocus={() => setKeyboardOpen(true)}
                  placeholder="Tap to type a note (e.g. well done, no ice, extra spicy)"
                  className="input mt-2 text-sm cursor-pointer"
                />
                {!keyboardOpen && noteText && (
                  <div className="mt-1 text-[10px] text-stone-400">Tap the note field again to edit.</div>
                )}
              </section>
            </div>
          </div>
        )}

        {/* Footer — Save only. The X in the corner handles dismiss. */}
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            className="btn btn-primary disabled:opacity-60"
            onClick={handleSave}
            disabled={!canSave}
          >
            Save modifications
          </button>
        </div>
      </div>

      {/* Floating touch keyboard — slides up from the bottom of the
          viewport, completely decoupled from the modal so opening /
          closing it doesn't morph the modal at all. Sibling of the
          modal inside the same fixed wrapper so it shares the same
          backdrop and z-index. Tapping anywhere inside the modal
          body that isn't the note field or the keyboard itself
          retracts it (see the modal's onMouseDown handler above).
          Visibility is animated via `translate-y` + `opacity` for a
          clean, fast transition. */}
      <div
        ref={keyboardRef}
        aria-hidden={!keyboardOpen}
        className={`pointer-events-none absolute inset-x-0 bottom-0 transition-all duration-200 ease-out ${
          keyboardOpen ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
        }`}
      >
        <div className={`mx-auto max-w-3xl px-4 pb-4 ${keyboardOpen ? "pointer-events-auto" : ""}`}>
          <div className="bg-white rounded-t-xl shadow-elevated border border-stone-200 px-3 pb-3">
            <TouchKeyboard
              onKey={appendNoteChar}
              onBackspace={backspaceNote}
              onClear={clearNote}
              onClose={() => setKeyboardOpen(false)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// Service-progress badge for the open-checks queue. Replaces the
// raw POSCheck.status (OPEN / SENT / PARTIALLY_SENT — bookkeeping
// states) with a derived status that reflects what the kitchen +
// bar have actually done with the chits. Per-station breakdown
// renders below the badge when chits are mixed-state across
// kitchen / bar / dessert.
function ServiceStatusBadge({
  chits,
  hasDrafts,
  checkStatus,
  paymentFailureReason,
}: {
  chits: Array<{ status: string; station: string }>;
  hasDrafts: boolean;
  checkStatus?: string;
  paymentFailureReason?: string | null;
}) {
  // Drop cancelled chits before deriving — a cancelled chit shouldn't
  // hold the check back from "Ready" or "Served".
  const active = chits.filter((c) => c.status !== "CANCELLED");

  // Payment-state has highest priority — when QR Pay is in flight,
  // the queue should say so regardless of what's happening at the
  // prep stations.
  let label: string;
  let toneCls: string;
  if (checkStatus === "PAYMENT_PENDING") {
    label = "Payment in progress";
    toneCls = "bg-amber-50 text-amber-800 border-amber-300";
  } else if (checkStatus === "PAYMENT_FAILED") {
    const reason = (paymentFailureReason ?? "").toLowerCase();
    if (reason.includes("expir")) {
      label = "Payment timed out";
    } else {
      label = "Payment declined";
    }
    toneCls = "bg-red-50 text-red-700 border-red-300";
  } else if (active.length === 0) {
    label = hasDrafts ? "Draft" : "Open";
    toneCls = "bg-stone-100 text-stone-700 border-stone-200";
  } else {
    const allServed = active.every((c) => c.status === "SERVED");
    const someServed = active.some((c) => c.status === "SERVED");
    const allReadyOrServed = active.every((c) => c.status === "READY" || c.status === "SERVED");
    const someReady = active.some((c) => c.status === "READY");
    const anyAck = active.some((c) =>
      c.status === "ACKNOWLEDGED" || c.status === "PRINTED"
    );
    if (allServed) {
      label = "Delivered";
      toneCls = "bg-club-green-100 text-club-green-900 border-club-green-400";
    } else if (allReadyOrServed && someServed) {
      label = "Partially delivered";
      toneCls = "bg-club-green-50 text-club-green-800 border-club-green-300";
    } else if (allReadyOrServed) {
      label = "Ready for pickup";
      toneCls = "bg-club-green-50 text-club-green-800 border-club-green-300";
    } else if (someReady || someServed) {
      label = "Partially ready";
      toneCls = "bg-amber-50 text-amber-800 border-amber-300";
    } else if (anyAck) {
      label = "Preparing";
      toneCls = "bg-amber-50 text-amber-800 border-amber-200";
    } else {
      label = "Sent to prep";
      toneCls = "bg-stone-100 text-stone-700 border-stone-300";
    }
  }

  // Per-station breakdown — render when stations differ OR when
  // there's a mix of READY / SERVED so the operator can see who's
  // delivered what.
  const stationLabels: Array<{ station: string; label: string; tone: string }> = [];
  const stations = Array.from(new Set(active.map((c) => c.station)));
  const hasMix = active.some((c) => c.status === "READY") || active.some((c) => c.status === "SERVED");
  if (stations.length > 1 || (hasMix && !active.every((c) => c.status === active[0].status))) {
    for (const station of stations) {
      const stationChits = active.filter((c) => c.station === station);
      const stationStatus = chitGroupStatus(stationChits);
      stationLabels.push({
        station,
        label: stationStatus.label,
        tone: stationStatus.tone,
      });
    }
  }

  return (
    <div className="space-y-0.5">
      <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${toneCls}`}>
        {label}
      </span>
      {stationLabels.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-0.5">
          {stationLabels.map((s) => (
            <span
              key={s.station}
              className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${s.tone}`}
            >
              {humaniseStation(s.station)} {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function chitGroupStatus(chits: Array<{ status: string }>): { label: string; tone: string } {
  if (chits.length === 0) return { label: "—", tone: "bg-stone-100 text-stone-600 border-stone-200" };
  if (chits.every((c) => c.status === "SERVED")) {
    return { label: "served", tone: "bg-club-green-100 text-club-green-900 border-club-green-400" };
  }
  if (chits.every((c) => c.status === "READY" || c.status === "SERVED")) {
    return { label: "ready", tone: "bg-club-green-50 text-club-green-800 border-club-green-300" };
  }
  if (chits.some((c) => c.status === "READY")) {
    return { label: "partial", tone: "bg-amber-50 text-amber-800 border-amber-300" };
  }
  if (chits.some((c) => c.status === "ACKNOWLEDGED" || c.status === "PRINTED")) {
    return { label: "preparing", tone: "bg-amber-50 text-amber-800 border-amber-200" };
  }
  return { label: "sent", tone: "bg-stone-100 text-stone-700 border-stone-300" };
}

function humaniseStation(s: string): string {
  if (s === "KITCHEN") return "Kitchen";
  if (s === "BAR") return "Bar";
  if (s === "DESSERT") return "Dessert";
  return s;
}

// -------------------------------------------------------------------------
// Settlement success screen — charge-to-member confirmed, OR QR pay
// just transitioned from CONFIRMED. Auto-opens the receipt PDF, shows
// the email-delivery status pulled from POSCheck, runs a 10-second
// auto-return countdown back to the open-checks landing. The
// operator can hit "Return now" to skip the wait.
// -------------------------------------------------------------------------
function SettlementSuccessScreen({
  success,
  check,
  onDone,
}: {
  success: SettleSuccess;
  check: Check | null;
  onDone: () => void;
}) {
  const isQR = success.chargeMode === "QR_PAY";
  const chitUrl = `/api/admin/pos/lounge/sales/${success.saleId}/chit/SIGNATURE`;
  const [secondsLeft, setSecondsLeft] = useState(10);
  const [emailStatus, setEmailStatus] = useState<{
    status: string | null;
    address: string | null;
    failure: string | null;
  }>(() => ({
    status: null,
    address: null,
    failure: null,
  }));

  // Auto-open the receipt PDF on mount. Wrapped in a ref-guard so
  // React StrictMode doesn't fire it twice in dev.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    try {
      const win = window.open(chitUrl, "_blank", "noopener,noreferrer");
      // Popup blocked? `win` is null. We fall back to the manual
      // button below.
      if (!win) {
        // eslint-disable-next-line no-console
        console.warn("[lounge POS] popup blocked — receipt PDF must be opened manually");
      }
    } catch {
      /* ignore — manual button always available */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll POSCheck for the receipt email status so the success card
  // can show "Receipt emailed to j***@silver.club" once the adapter
  // returns. Pulls a couple of times then stops (the email send is
  // synchronous-ish inside settleCheck / confirmQRPayment, but the
  // refreshed `check` prop isn't always available immediately).
  useEffect(() => {
    let ticks = 0;
    let cancelled = false;
    const t = setInterval(async () => {
      ticks++;
      if (cancelled) return;
      const r = await getCheckAction(check?.id ?? "");
      if (cancelled) return;
      if (r.ok) {
        const c = r.data as { receiptEmailStatus: string | null; receiptEmailAddress: string | null; receiptEmailFailure: string | null };
        setEmailStatus({
          status: c.receiptEmailStatus,
          address: c.receiptEmailAddress,
          failure: c.receiptEmailFailure,
        });
        if (c.receiptEmailStatus || ticks > 4) clearInterval(t);
      }
      if (ticks > 4) clearInterval(t);
    }, 1500);
    return () => { cancelled = true; clearInterval(t); };
  }, [check?.id]);

  // 10-second auto-return countdown.
  useEffect(() => {
    if (secondsLeft <= 0) {
      onDone();
      return;
    }
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft, onDone]);

  // Friendly email-status label.
  const emailLine = (() => {
    const s = emailStatus.status;
    if (!s) return "Sending receipt…";
    if (s === "SENT") return `Receipt emailed to ${maskEmailLocal(emailStatus.address)}`;
    if (s === "DEV_LOGGED") return `Receipt generated in the development email log for ${maskEmailLocal(emailStatus.address)} (not delivered — set EMAIL_DELIVERY_MODE=smtp to send for real)`;
    if (s === "SKIPPED_NO_EMAIL") return "No email on file — receipt available in check history";
    if (s === "SUPPRESSED") return `Receipt blocked (${emailStatus.failure ?? "suppressed"}) — visible in check history`;
    if (s === "FAILED") return `Receipt email failed (${emailStatus.failure ?? "see history"}) — check history retains the receipt`;
    return s;
  })();
  const emailOk = emailStatus.status === "SENT";
  const emailDevLogged = emailStatus.status === "DEV_LOGGED";

  return (
    <div className="card card-body max-w-xl mx-auto text-center">
      <div className="mx-auto h-12 w-12 rounded-full bg-club-green-50 text-club-green-700 flex items-center justify-center">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
      </div>
      <h2 className="mt-4 font-serif text-2xl text-club-ink">
        {isQR ? "Payment confirmed" : "Charged to member account"}
      </h2>
      <p className="mt-1 text-sm text-stone-500">Sale {success.saleNumber}</p>
      <div className="mt-4 text-3xl font-serif text-club-ink">{formatCurrency(success.grandTotal)}</div>

      {/* Confirmation rows */}
      <ul className="mt-5 mx-auto max-w-sm text-left text-sm space-y-1.5">
        <li className="flex items-start gap-2">
          <CheckGlyph good />
          <span className="text-stone-700">Check closed</span>
        </li>
        <li className="flex items-start gap-2">
          <CheckGlyph good />
          <span className="text-stone-700">
            {isQR ? "Payment captured" : "Member account charged"}
          </span>
        </li>
        <li className="flex items-start gap-2">
          <CheckGlyph good={emailOk} muted={!emailStatus.status || emailDevLogged} />
          <span className={emailOk ? "text-stone-700" : emailDevLogged ? "text-amber-700" : "text-stone-500"}>{emailLine}</span>
        </li>
        <li className="flex items-start gap-2">
          <CheckGlyph good />
          <span className="text-stone-700">Receipt opened in browser</span>
        </li>
      </ul>

      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <button
          type="button"
          onClick={onDone}
          className="btn btn-primary"
        >
          Return now ({secondsLeft}s)
        </button>
        <button
          type="button"
          onClick={() => window.open(chitUrl, "_blank", "noopener,noreferrer")}
          className="btn btn-secondary"
        >
          Reopen receipt
        </button>
        <a href="/app/admin/ops/pos/lounge/history" className="btn btn-secondary">View history</a>
      </div>
    </div>
  );
}

function CheckGlyph({ good = false, muted = false }: { good?: boolean; muted?: boolean }) {
  const cls = muted
    ? "text-stone-400"
    : good
    ? "text-club-green-700"
    : "text-amber-600";
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={`mt-0.5 shrink-0 ${cls}`} aria-hidden="true">
      {good ? (
        <path d="M20 6 9 17l-5-5" />
      ) : (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </>
      )}
    </svg>
  );
}

function maskEmailLocal(email: string | null): string {
  if (!email) return "—";
  const [name, host] = email.split("@");
  if (!host) return email;
  return `${name.slice(0, 1)}${"*".repeat(Math.max(2, name.length - 1))}@${host}`;
}

// -------------------------------------------------------------------------
// QR-pay pending screen — operator is waiting for the gateway to
// confirm payment. The parent component polls the status; when
// CONFIRMED the parent transitions to the success screen. If
// DECLINED / EXPIRED the parent sets `failureReason`, which we
// surface here so the operator can dismiss + retry with another
// method.
// -------------------------------------------------------------------------
function PendingPaymentScreen({
  sale,
  qrLandingUrl,
  failureReason,
  onDecline,
  onRetry,
}: {
  sale: { saleId: string; saleNumber: string; grandTotal: number };
  qrLandingUrl: string;
  failureReason: string | null;
  onDecline: () => void;
  onRetry: () => void;
}) {
  const failed = !!failureReason;
  const chitUrl = `/api/admin/pos/lounge/sales/${sale.saleId}/chit/SIGNATURE`;

  // Auto-open the live chit PDF in a new tab on mount so the operator
  // can immediately review what the member will see / print. The
  // chit endpoint live-renders for DRAFT QR sales (no snapshot exists
  // yet), and the QR code on the chit is what the member scans.
  // Ref-guarded so React StrictMode doesn't fire twice in dev.
  const openedRef = useRef(false);
  useEffect(() => {
    if (failed || openedRef.current) return;
    openedRef.current = true;
    try {
      window.open(chitUrl, "_blank", "noopener,noreferrer");
    } catch {
      /* fallback button below stays available */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sale.saleId]);

  return (
    <div className="card card-body max-w-xl mx-auto text-center">
      {failed ? (
        <div className="mx-auto h-12 w-12 rounded-full bg-red-50 text-red-700 flex items-center justify-center">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M15 9l-6 6" />
            <path d="M9 9l6 6" />
          </svg>
        </div>
      ) : (
        <div className="mx-auto h-12 w-12 rounded-full bg-amber-50 text-amber-700 flex items-center justify-center">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="animate-pulse">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        </div>
      )}
      <h2 className="mt-4 font-serif text-2xl text-club-ink">
        {failed ? "Payment failed" : "Waiting for payment confirmation"}
      </h2>
      <p className="mt-1 text-sm text-stone-500">Sale {sale.saleNumber}</p>
      <div className="mt-4 text-3xl font-serif text-club-ink">{formatCurrency(sale.grandTotal)}</div>

      {failed ? (
        <>
          <p className="mt-4 text-sm text-red-700 max-w-sm mx-auto">
            {failureReason}. The check stays in your active list — retry or pick another payment method.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <button type="button" onClick={onRetry} className="btn btn-primary">
              Back to check
            </button>
            <button type="button" onClick={onDecline} className="btn btn-secondary">
              Return to open checks
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-4 text-sm text-stone-600 max-w-sm mx-auto">
            The chit has opened in a new tab — review it with the member or hand them the printed copy. They scan the QR at the bottom to pay.
          </p>
          <p className="mt-2 text-xs font-mono text-stone-500 break-all">{qrLandingUrl}</p>
          {/* Manual fallback for popup-blocker. */}
          <div className="mt-3">
            <button
              type="button"
              onClick={() => window.open(chitUrl, "_blank", "noopener,noreferrer")}
              className="btn btn-secondary btn-sm"
            >
              Reopen chit with QR
            </button>
          </div>
          <p className="mt-4 text-xs text-stone-400">
            Polling the gateway every 2 seconds. This screen will transition to success once the payment is confirmed — or to a failure banner if it&rsquo;s declined or expires.
          </p>
        </>
      )}
    </div>
  );
}

function Row({ label, value, green }: { label: string; value: string; green?: boolean }) {
  return (
    <div className={`flex justify-between text-sm ${green ? "text-club-green-700" : ""}`}>
      <span className={green ? "" : "text-stone-500"}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

// Touch-friendly course picker on a DRAFT line. Course 1 = fire with
// the first round (default). Higher courses are HELD until either the
// server taps "Fire course N" or the auto-pace timer elapses. Only
// shown on draft lines — sent lines display their course read-only.
function CoursePicker({ value, onChange, disabled }: { value: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex items-center rounded-md border border-stone-200 overflow-hidden" role="radiogroup" aria-label="Course">
      {COURSES.map((n) => {
        const active = value === n;
        return (
          <button
            key={n}
            type="button"
            disabled={disabled}
            onClick={() => onChange(n)}
            aria-pressed={active}
            className={`min-w-[2rem] px-2.5 py-1 text-xs border-r border-stone-200 last:border-r-0 ${
              active ? "bg-club-green-700 text-white font-medium" : "bg-white text-stone-600 hover:bg-stone-50"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}

// Check-level auto-pace control. Off = courses fire manually only.
// 5 / 10 / 15 / 20 = held chits get a fireAt at (sendTime + (course-1) * gap).
function AutoPacePicker({ value, onChange, disabled }: { value: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex items-center rounded-md border border-stone-200 overflow-hidden">
      {AUTO_PACE_OPTIONS.map((n) => {
        const active = value === n;
        return (
          <button
            key={n}
            type="button"
            disabled={disabled}
            onClick={() => onChange(n)}
            aria-pressed={active}
            className={`px-2.5 py-1 text-xs border-r border-stone-200 last:border-r-0 ${
              active ? "bg-club-green-700 text-white font-medium" : "bg-white text-stone-600 hover:bg-stone-50"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {n === 0 ? "Off" : `${n}m`}
          </button>
        );
      })}
    </div>
  );
}

// Touch-friendly discount picker for an individual line or the chit.
function CompactDiscountPicker({ value, onChange, overriddenByChit }: { value: number; onChange: (v: number) => void; overriddenByChit?: boolean }) {
  function tap(p: number) {
    onChange(value === p ? 0 : p);
  }
  return (
    <div className="inline-flex items-center rounded-md border border-stone-200 overflow-hidden">
      {DISCOUNT_PRESETS.map((p) => {
        const active = value === p.pct;
        const locked = !!overriddenByChit && p.pct !== 100;
        return (
          <button
            key={p.key}
            type="button"
            disabled={locked}
            onClick={() => tap(p.pct)}
            className={`px-2.5 py-1 text-xs border-r border-stone-200 last:border-r-0 ${
              active ? "bg-club-green-700 text-white" : "bg-white text-stone-600 hover:bg-stone-50"
            } ${locked ? "opacity-40 cursor-not-allowed" : ""}`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

// Inline numeric-only touch keyboard (numbers + backspace/clear/done).
function TouchKeyboard({ onKey, onBackspace, onClear, onClose }: { onKey: (c: string) => void; onBackspace: () => void; onClear: () => void; onClose: () => void }) {
  const numbers = "1234567890".split("");
  const rows = ["qwertyuiop".split(""), "asdfghjkl".split(""), "zxcvbnm".split("")];
  const keyCls = "min-w-[2.25rem] flex-1 h-12 rounded-md bg-white border border-stone-200 text-base font-medium text-club-ink hover:bg-stone-50 active:bg-stone-200 shadow-sm select-none";
  const actionCls = "px-4 h-11 rounded-md bg-white border border-stone-200 text-sm text-stone-700 hover:bg-stone-50 active:bg-stone-200 shadow-sm select-none";
  return (
    <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 p-2 pt-8 space-y-1.5 relative" onMouseDown={(e) => e.preventDefault()} onTouchStart={(e) => e.stopPropagation()}>
      <button type="button" onClick={onClose} aria-label="Close keyboard" className="absolute top-1.5 right-1.5 h-7 w-7 inline-flex items-center justify-center rounded-md text-stone-500 hover:bg-stone-100">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
      <div className="flex gap-1.5">{numbers.map((n) => <button key={n} type="button" className={keyCls} onClick={() => onKey(n)}>{n}</button>)}</div>
      {rows.map((row, i) => (
        <div key={i} className="flex gap-1.5">{row.map((c) => <button key={c} type="button" className={keyCls} onClick={() => onKey(c)}>{c}</button>)}</div>
      ))}
      <div className="flex gap-1.5 pt-0.5">
        <button type="button" className={`${actionCls} flex-1`} onClick={() => onKey(" ")}>Space</button>
        <button type="button" className={actionCls} onClick={onBackspace} aria-label="Backspace">⌫</button>
        <button type="button" className={actionCls} onClick={onClear}>Clear</button>
        <button type="button" onClick={onClose} className="px-4 h-11 rounded-md bg-club-green-700 text-white text-sm font-medium hover:bg-club-green-800 active:bg-club-green-900 shadow-sm select-none">Done</button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------
function round2(n: number): number { return Math.round(n * 100) / 100; }
function stripMemberPrefix(num: string): string { return num.replace(/^[A-Z]+-/i, ""); }
function humaniseAccess(s: string): string {
  switch (s) {
    case "CHARGE_ACCOUNT_SUSPENDED": return "Charges suspended";
    case "TEE_SHEET_SUSPENDED": return "Tee sheet suspended";
    case "FULL_SUSPENSION": return "Suspended";
    default: return s;
  }
}
function humaniseLineStatus(s: string): string {
  switch (s) {
    case "DRAFT": return "Not sent";
    case "SENT": return "Sent";
    case "FIRED": return "Firing";
    case "PREPARING": return "Preparing";
    case "READY": return "Ready";
    case "SERVED": return "Served";
    case "VOIDED": return "Voided";
    case "COMPED": return "Comped";
    default: return s;
  }
}

// Mirror of the server-side discount math (lib/pos/checks.ts:priceCheckLines).
// Pre-flight calculation so the staff sees what the server will compute.
function priceCheck(lines: CheckLine[], chitDiscountPct: number) {
  const chitPct = Math.max(0, Math.min(100, chitDiscountPct));
  const chitOverrides = chitPct > 0;
  let subtotal = 0;
  let compTotal = 0;
  let chitAppliedTotal = 0;
  let regularLineTotal = 0;
  let taxableNet = 0;
  for (const l of lines) {
    if (l.status === "VOIDED") continue;
    const quantity = Number(String(l.quantity));
    const unitPrice = Number(String(l.unitPrice));
    const linePct = Number(String(l.discountPct));
    const raw = round2(quantity * unitPrice);
    const isComp = l.status === "COMPED" || linePct >= 100;
    const effectivePct = isComp ? 100 : chitOverrides ? chitPct : linePct;
    const lineDisc = round2(raw * (effectivePct / 100));
    const net = round2(raw - lineDisc);
    subtotal = round2(subtotal + raw);
    if (isComp) compTotal = round2(compTotal + lineDisc);
    else if (chitOverrides) chitAppliedTotal = round2(chitAppliedTotal + lineDisc);
    else if (lineDisc > 0) regularLineTotal = round2(regularLineTotal + lineDisc);
    if (l.taxable) taxableNet = round2(taxableNet + net);
  }
  const totalDiscount = round2(compTotal + chitAppliedTotal + regularLineTotal);
  const taxTotal = round2(taxableNet * GST_RATE);
  const grandTotal = round2(subtotal + taxTotal - totalDiscount);
  return { subtotal, compTotal, chitAppliedTotal, regularLineTotal, taxTotal, grandTotal };
}
