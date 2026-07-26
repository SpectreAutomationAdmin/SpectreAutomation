"use client";

/**
 * Data Workspace v1.0 — Chart of Accounts client-side controller.
 *
 * Scope of this file:
 *   • Renders the grouped account table (Type → Category → FS Group → Row).
 *   • Owns the client-side workspace state: search text, density mode,
 *     sort state, selection set, row-action overflow menu, inspector
 *     open/close.
 *   • Preserves every legacy URL entry — `?edit=<id>`, `?delete=<id>`,
 *     `?modal=new`, `?mode=fund`, `?showInactive=1`, `?fund=<value>`.
 *     Actions inside the table still navigate via these params so the
 *     server-rendered modals continue to open and every existing test
 *     that walks the URL surface keeps working.
 *   • Preserves every legacy test-id — `coa-account-row-<num>`,
 *     `coa-account-fund-<num>`, `coa-account-flags-<num>`,
 *     `coa-edit-<num>`, `coa-archive-<num>`, `coa-reactivate-<num>`,
 *     `coa-delete-<num>`, `coa-bulk-select-<num>`, `coa-type-<TYPE>`,
 *     `coa-fsgroup-*`, `coa-fsgroup-label-*`, `coa-flags-info`,
 *     `coa-account-flag-{control,inactive}-<num>`, and
 *     `coa-account-fund-unmapped-<num>`.
 *
 * Editing scope in this integration phase:
 *   • The read-only inspector opens when a row is clicked (via
 *     `?select=<id>`) OR when `?edit=<id>` is present (in which case
 *     the legacy modal ALSO opens on top; the inspector still renders
 *     underneath so the workspace state is visible when the modal is
 *     closed).
 *   • The inspector's "Edit" primary action navigates to `?edit=<id>`,
 *     which opens the same legacy modal used today. Inspector-level
 *     editing (Phase B / phase 7 of the integration plan) is a
 *     follow-up sprint.
 */

import React, {
  useMemo,
  useState,
  useEffect,
  useCallback,
  useRef,
  useTransition,
} from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { SectionSelectAllCheckbox } from "@/app/app/admin/coa/SectionSelectAllCheckbox";
import { updateAccountInspectorAction, bulkArchiveAccountsAction } from "@/app/app/admin/coa/_actions";
import { KNOWN_FUND_KEYS } from "@/lib/accounting/fund-applicability";

// ----- Public row shape (serialised from the RSC) ---------------------

export type DwAccountRow = {
  id: string;
  accountNumber: string;
  name: string;
  description: string | null;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  categoryKey: string;
  categoryLabel: string;
  categorySortOrder: number;
  fsGroupKey: string;
  fsGroupLabel: string;
  fsGroupSortOrder: number;
  departmentLabel: string | null;
  fundKeys: Array<"OPERATING" | "CAPITAL">;
  fundApplicabilityRaw: string;
  fundValidation: "ok" | "warn" | "blocked";
  isActive: boolean;
  isControl: boolean;
  isBank: boolean;
  isCash: boolean;
  isTaxRelevant: boolean;
  allowManualPosting: boolean;
  isPL: boolean;
  parentAccountNumber: string | null;
  updatedAt: string; // ISO — drives the "Recently changed" saved view
  // Sprint 1 acceptance repair (2026-07-19) — `naturalBalance` from
  // `accountBalances(...)` in `src/lib/accounting/balance.ts`. Positive
  // is the account's normal side (debit for ASSET/EXPENSE, credit for
  // LIABILITY/EQUITY/REVENUE); a contra-account's normal-side balance
  // arrives here as a negative number (e.g. an accumulated-depreciation
  // asset with a credit balance is negative). Do NOT invert this sign
  // in the client — the balance service already canonicalised it.
  balance: number;
};

// Category / FS Group / Department option lists shipped from the RSC
// so the inspector's edit form can populate the same dropdowns the
// legacy modal did. No new lookups; the page already fetches them.
export type DwOption = { key: string; label: string; type?: string; statement?: string };
export type DwParentOption = { id: string; accountNumber: string; name: string };

export type ChartOfAccountsClientProps = {
  rows: DwAccountRow[];
  canEdit: boolean;
  disabledTooltip: string;
  fundMode: boolean;
  showInactive: boolean;
  fundFilter: "OPERATING" | "CAPITAL" | "BOTH" | "NONE" | null;
  savedView: string;
  totalAccounts: number;
  activeAccounts: number;
  lastUpdatedLabel: string;
  lastUpdatedActor: string | null;
  /** Sprint 1 acceptance repair (2026-07-19).
   *  Renders the floating "Review states" design-QA panel when true.
   *  Computed on the server: NODE_ENV=development OR `?_review=1`.
   *  Never true in production for real users — the founder pinned
   *  this specifically so the utility survives for internal design
   *  review without leaking into the customer-facing workspace. */
  reviewMode: boolean;
  unmappedPlCount: number;
  currentSelectId: string | null;
  currentEditId: string | null;
  // Phase B — dropdown option lists for the inspector edit form.
  // Fetched by the RSC alongside the accounts so no client-side
  // hydration cost is incurred and the inspector can render its
  // full field set on first open.
  categoryOptions: DwOption[];
  fsGroupOptions: DwOption[];
  departmentOptions: DwOption[];
  parentOptions: DwParentOption[];
};

// ----- Constants ------------------------------------------------------

const TYPE_ORDER: DwAccountRow["type"][] = [
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "REVENUE",
  "EXPENSE",
];
const TYPE_LABEL: Record<DwAccountRow["type"], string> = {
  ASSET: "Assets",
  LIABILITY: "Liabilities",
  EQUITY: "Equity",
  REVENUE: "Revenue",
  EXPENSE: "Expenses",
};

// Sprint 1 acceptance repair (2026-07-19) — density was previously a
// user-facing preference (Comfy/Standard/Compact) with localStorage
// persistence. The founder removed the switcher: production ships one
// polished density, matching the founder-approved concept's Standard.
// The Density type is preserved (unused-import cleanup happens below)
// only to keep the .spectre-dw-table[data-density="standard"] CSS
// selector working with a hard-coded value.
type SortKey = "number" | "name" | "type" | "fsGroup" | "balance" | "status";
type SortDir = "asc" | "desc";

// Phase B — the editable subset of an Account. Every field is a
// string here so we can drive the DOM inputs directly; the RSC-side
// action normalises trims + coerces via `fdString` / `fdBool` /
// `fdFundApplicability`.
type EditFormState = {
  accountId: string;
  accountNumber: string;
  name: string;
  description: string;
  type: string;
  categoryKey: string;
  fsGroupKey: string;
  fundKeys: Array<"OPERATING" | "CAPITAL">;
  departmentCode: string;
  parentAccountNumber: string;
  isControlAccount: boolean;
  isBankAccount: boolean;
  isCashAccount: boolean;
  isTaxRelevant: boolean;
  allowManualPosting: boolean;
};

// Reverse-lookup: options carry `key` but the RSC gives us the
// selected row's `categoryKey` / `fsGroupKey` etc. so this is only
// needed for parent account (id → accountNumber).


function rowToEditForm(
  r: DwAccountRow,
  parentOptions: DwParentOption[],
  departmentOptions: DwOption[],
): EditFormState {
  // The row shape carries `parentAccountNumber` already (nullable),
  // so no lookup is needed. Department code needs a lookup from the
  // row's label. If it can't be resolved we leave it blank — the
  // user can re-pick from the dropdown.
  const dept = departmentOptions.find((d) => d.label === (r.departmentLabel ?? ""));
  const _ = parentOptions; // parentAccountNumber already resolved
  return {
    accountId: r.id,
    accountNumber: r.accountNumber,
    name: r.name,
    description: r.description ?? "",
    type: r.type,
    categoryKey: r.categoryKey === "__uncategorised__" ? "" : r.categoryKey,
    fsGroupKey: r.fsGroupKey === "__no_fs_group__" ? "" : r.fsGroupKey,
    fundKeys: r.fundKeys.slice(),
    departmentCode: dept?.key ?? "",
    parentAccountNumber: r.parentAccountNumber ?? "",
    isControlAccount: r.isControl,
    isBankAccount: r.isBank,
    isCashAccount: r.isCash,
    isTaxRelevant: r.isTaxRelevant,
    allowManualPosting: r.allowManualPosting,
  };
}

function editFormEquals(a: EditFormState | null, b: EditFormState | null): boolean {
  if (!a || !b) return a === b;
  if (a.accountId !== b.accountId) return false;
  return (
    a.accountNumber === b.accountNumber &&
    a.name === b.name &&
    a.description === b.description &&
    a.type === b.type &&
    a.categoryKey === b.categoryKey &&
    a.fsGroupKey === b.fsGroupKey &&
    a.departmentCode === b.departmentCode &&
    a.parentAccountNumber === b.parentAccountNumber &&
    a.isControlAccount === b.isControlAccount &&
    a.isBankAccount === b.isBankAccount &&
    a.isCashAccount === b.isCashAccount &&
    a.isTaxRelevant === b.isTaxRelevant &&
    a.allowManualPosting === b.allowManualPosting &&
    a.fundKeys.length === b.fundKeys.length &&
    a.fundKeys.every((k) => b.fundKeys.includes(k))
  );
}

// ----- Component ------------------------------------------------------

export function ChartOfAccountsClient(props: ChartOfAccountsClientProps) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app/admin/coa";
  const searchParams = useSearchParams();

  const [search, setSearch] = useState("");
  // Density is fixed to "standard" — see removal note near the type
  // declaration. Kept as a const so the `data-density` attribute on
  // the table below reads statically and the CSS selectors continue
  // to work without an attribute-value migration.
  const density = "standard" as const;
  const [sortKey, setSortKey] = useState<SortKey>("number");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  // Sprint 1 interaction correction (2026-07-19c) — unified selection
  // model. Founder ruled that the previous split between checkbox
  // selection and inspector selection was not intuitive. The rule now:
  //   • `selected` is the SINGLE source of truth for what's selected.
  //   • `selected.size === 1` → inspector shows that account.
  //   • `selected.size ≥ 2`  → inspector shows the bulk-selection state.
  //   • `selected.size === 0` → inspector shows the empty state
  //                             (unless `?edit=<id>` is present).
  //   • Row click REPLACES the selection with a single-item set —
  //     this ties the visible checkbox to the row-open action so a
  //     freshly opened account also reads as "checked".
  //   • URL `?select=<id>` mirrors the single-selection so refresh
  //     and back/forward stay coherent. Initial `selected` hydrates
  //     from the URL on first mount.
  const [selected, setSelected] = useState<Set<string>>(
    () => (props.currentSelectId ? new Set([props.currentSelectId]) : props.currentEditId ? new Set([props.currentEditId]) : new Set()),
  );
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<DwAccountRow["type"]>>(new Set());
  const [inspectorTab, setInspectorTab] = useState<"details" | "rules" | "activity" | "audit">("details");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Phase B — inspector edit state machine.
  //
  //   viewing        → read-only, "Edit" primary
  //   editing        → fields active, "Discard" + "Save changes" (disabled until dirty)
  //   dirty          → same UI, "Save changes" enabled
  //   validation     → red banner + field-level `.err`, "Save changes" disabled
  //   saving         → optimistic disabled state during the transition
  //   saved          → green banner, back to editing (fields active with fresh data)
  //   permission     → banner "Your role does not have permission…" + no Save
  //
  // `editForm` mirrors the currently-editing account's editable fields;
  // `editBaseline` is the last-saved snapshot so we can compute the
  // dirty predicate without a deep compare.
  type InspectorMode = "viewing" | "editing" | "saving" | "saved" | "validation" | "permission-denied";
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>("viewing");
  const [editForm, setEditForm] = useState<EditFormState | null>(null);
  const [editBaseline, setEditBaseline] = useState<EditFormState | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [savePending, startSaveTransition] = useTransition();

  // Close any open row-action menu on outside click
  useEffect(() => {
    if (!openMenuFor) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".spectre-dw-row-actions")) return;
      setOpenMenuFor(null);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [openMenuFor]);

  // Keyboard shortcuts: ⌘F / "/" focus search, Esc closes inspector
  // (with a dirty-guard so accidental Esc doesn't discard changes)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = t?.matches?.("input, textarea, select");
      if ((e.key === "/" && !inField) || (e.key.toLowerCase() === "f" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "Escape") {
        const sp = new URLSearchParams(searchParams?.toString() ?? "");
        if (sp.has("select") || sp.has("edit")) {
          if (isDirty() && !window.confirm("Discard unsaved changes?")) return;
          sp.delete("select");
          sp.delete("edit");
          router.replace(sp.toString() ? `${pathname}?${sp.toString()}` : pathname);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, router, searchParams, editForm, editBaseline]);

  // Search predicate on the row's precomputed blob
  const searchLC = search.trim().toLowerCase();
  const rowMatchesSearch = useCallback(
    (r: DwAccountRow) => {
      if (!searchLC) return true;
      const blob = [
        r.accountNumber,
        r.name,
        r.description ?? "",
        r.type,
        r.categoryLabel,
        r.fsGroupLabel,
        r.departmentLabel ?? "",
        r.fundKeys.join(" ").toLowerCase(),
        r.fundValidation,
      ].join(" ").toLowerCase();
      return blob.includes(searchLC);
    },
    [searchLC],
  );

  // Compare fn for sort
  const compare = useCallback((a: DwAccountRow, b: DwAccountRow): number => {
    let cmp = 0;
    switch (sortKey) {
      case "number": cmp = a.accountNumber.localeCompare(b.accountNumber, undefined, { numeric: true }); break;
      case "name":   cmp = a.name.localeCompare(b.name); break;
      case "type":   cmp = TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type); break;
      case "fsGroup": cmp = a.fsGroupLabel.localeCompare(b.fsGroupLabel); break;
      case "balance": cmp = a.balance - b.balance; break;
      case "status": {
        const rank = (r: DwAccountRow) => (r.fundValidation === "blocked" ? 0 : r.fundValidation === "warn" ? 1 : r.isActive ? 2 : 3);
        cmp = rank(a) - rank(b);
        break;
      }
    }
    if (cmp === 0) cmp = a.accountNumber.localeCompare(b.accountNumber, undefined, { numeric: true });
    return sortDir === "asc" ? cmp : -cmp;
  }, [sortKey, sortDir]);

  // Phase B — saved view predicate. `fund`, `inactive` are enforced
  // server-side (they change what the RSC fetches / filters). The
  // remaining three run client-side against the row data the RSC
  // already sent, so switching views is instant.
  const viewPredicate = useCallback(
    (r: DwAccountRow): boolean => {
      switch (props.savedView) {
        case "needs-attention": return r.fundValidation !== "ok";
        case "unassigned-fs":   return r.fsGroupKey === "__no_fs_group__" || r.fsGroupKey === "";
        case "recently-changed": {
          const d = new Date(r.updatedAt);
          if (Number.isNaN(d.getTime())) return false;
          const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
          return d.getTime() >= cutoff;
        }
        default: return true;
      }
    },
    [props.savedView],
  );

  const visibleRows = useMemo(() => {
    return props.rows.filter((r) => viewPredicate(r) && rowMatchesSearch(r));
  }, [props.rows, rowMatchesSearch, viewPredicate]);

  const totalSelected = selected.size;
  const visibleSelectedCount = useMemo(
    () => visibleRows.reduce((n, r) => (selected.has(r.id) ? n + 1 : n), 0),
    [visibleRows, selected],
  );
  const hiddenSelectedCount = totalSelected - visibleSelectedCount;

  // Grouped rendering payload — Type → sorted rows only when sortKey === "number".
  // For all other sorts, present a single "sorted view" (no grouping) so results
  // don't jump around visually.
  const grouped = sortKey === "number" && !searchLC;
  const sortedVisibleRows = useMemo(() => {
    const arr = [...visibleRows];
    arr.sort(compare);
    return arr;
  }, [visibleRows, compare]);

  const rowsByType = useMemo(() => {
    const map = new Map<DwAccountRow["type"], DwAccountRow[]>();
    for (const t of TYPE_ORDER) map.set(t, []);
    for (const r of sortedVisibleRows) map.get(r.type)?.push(r);
    return map;
  }, [sortedVisibleRows]);

  // Sprint 1 interaction correction (2026-07-19c) — inspector target
  // derives from the unified selection model. Priorities:
  //   1. `?edit=<id>` in URL → edit mode on that account (highest —
  //      it's the user's in-flight intent).
  //   2. `selected.size === 1` → viewing mode on that account.
  //   3. `selected.size >= 2` → bulk-selection inspector.
  //   4. Nothing selected and no ?edit → instructional empty state.
  // `currentInspectorId` is retained as a name so downstream row
  // highlighting (`isInspectorTarget`) reads correctly — it's the id
  // of whichever account the inspector is currently focused on.
  const currentInspectorId = props.currentEditId ?? (selected.size === 1 ? [...selected][0] : null);
  const inspectorRow = useMemo(
    () => (currentInspectorId ? props.rows.find((r) => r.id === currentInspectorId) ?? null : null),
    [currentInspectorId, props.rows],
  );
  const isBulkInspector = selected.size >= 2;

  // Sprint 1 interaction correction (2026-07-19c) — sync FROM URL to
  // `selected` on browser back / forward. Firing `router.replace(...)`
  // from `updateSelection` triggers an RSC re-render with the new
  // `currentSelectId` / `currentEditId` props — this effect is idempotent
  // for that case (values already match). It matters when the URL
  // changes for reasons OTHER than a local mutation: browser back,
  // shared link paste, external link, etc.
  useEffect(() => {
    const urlId = props.currentEditId ?? props.currentSelectId ?? null;
    if (urlId) {
      if (selected.size !== 1 || !selected.has(urlId)) {
        setSelected(new Set([urlId]));
      }
    } else if (selected.size === 1) {
      // URL cleared its `?select` / `?edit` — the single-selection is
      // no longer coherent with the URL, so clear it. Bulk selections
      // (size ≥ 2) are ephemeral UI, not URL-encoded — leave alone.
      setSelected(new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.currentSelectId, props.currentEditId]);

  // Phase B — dirty predicate + hydrate on select change.
  const isDirty = useCallback(() => {
    if (inspectorMode !== "editing" && inspectorMode !== "validation" && inspectorMode !== "saved") return false;
    return !editFormEquals(editForm, editBaseline);
  }, [inspectorMode, editForm, editBaseline]);

  // When the URL points at a different account, or the RSC hands us
  // a fresher snapshot after a save, re-hydrate the edit form baseline
  // ONLY if we're not currently editing (so an in-flight edit doesn't
  // get clobbered by a router.refresh() from another source).
  useEffect(() => {
    if (!inspectorRow) {
      setInspectorMode("viewing");
      setEditForm(null);
      setEditBaseline(null);
      setSaveMessage(null);
      return;
    }
    // Different account clicked → reset to viewing, hydrate baseline.
    if (!editBaseline || editBaseline.accountId !== inspectorRow.id) {
      const hydrated = rowToEditForm(inspectorRow, props.parentOptions, props.departmentOptions);
      setEditForm(hydrated);
      setEditBaseline(hydrated);
      // If URL is `?edit=<id>` and we have permission, jump straight
      // to editing mode. If URL is `?select=<id>`, land in viewing.
      if (props.currentEditId === inspectorRow.id && props.canEdit) {
        setInspectorMode("editing");
      } else if (props.currentEditId === inspectorRow.id && !props.canEdit) {
        setInspectorMode("permission-denied");
      } else {
        setInspectorMode("viewing");
      }
      setSaveMessage(null);
      return;
    }
    // Same account, but the RSC handed us a re-fetched row (e.g. after
    // router.refresh() following a save). Rebuild the baseline so the
    // dirty predicate resets to clean. Skip this if we're currently
    // editing with unsaved changes — router.refresh() from a filter
    // change should not blow away the operator's work.
    if (inspectorMode === "viewing" || inspectorMode === "saved") {
      const hydrated = rowToEditForm(inspectorRow, props.parentOptions, props.departmentOptions);
      setEditForm(hydrated);
      setEditBaseline(hydrated);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectorRow?.id, inspectorRow?.accountNumber, inspectorRow?.name, inspectorRow?.description, props.currentEditId, props.canEdit]);

  // Sprint 1 interaction correction (2026-07-19c).
  // Every selection mutation goes through `updateSelection` so URL
  // and state can never drift. Contract:
  //   • size === 1 → set `?select=<id>` (and clear `?edit`)
  //   • size === 0 or ≥ 2 → clear `?select` (bulk state is ephemeral
  //     UI — the founder does not want a 100-account bulk selection
  //     encoded in a URL; `?edit=` is left untouched so an in-flight
  //     edit URL is not clobbered by a stray bulk-select).
  // Uses `router.replace` so browser Back does not fill up with every
  // intermediate selection state — one entry per meaningful transition.
  const updateSelection = useCallback((nextSelected: Set<string>) => {
    setSelected(nextSelected);
    const sp = new URLSearchParams(searchParams?.toString() ?? "");
    if (nextSelected.size === 1) {
      sp.delete("edit");
      sp.set("select", [...nextSelected][0]);
    } else {
      sp.delete("select");
    }
    router.replace(sp.toString() ? `${pathname}?${sp.toString()}` : pathname);
  }, [router, pathname, searchParams]);

  // Reset selection to only visible rows when user clicks "Clear hidden"
  const clearHidden = () => {
    const next = new Set<string>();
    for (const id of selected) if (visibleRows.some((r) => r.id === id)) next.add(id);
    updateSelection(next);
  };
  const clearAll = () => updateSelection(new Set());
  const showSelected = () => setSearch("");

  const toggleRow = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    updateSelection(next);
  };
  const toggleAllVisible = () => {
    const next = new Set(selected);
    const allChecked = visibleRows.every((r) => next.has(r.id));
    if (allChecked) for (const r of visibleRows) next.delete(r.id);
    else for (const r of visibleRows) next.add(r.id);
    updateSelection(next);
  };

  // Sprint 1 interaction correction (2026-07-19c) — `openInspector`
  // now REPLACES the checkbox selection with the single account. That
  // is the founder-approved unification: row click → checkbox checked
  // → inspector shows the account. This function is used by both the
  // programmatic row-open action (used by the row-click handler) and
  // by internal navigation (Enter key, deep-link resolution).
  const openInspector = (id: string) => {
    if (isDirty() && !window.confirm("Discard unsaved changes?")) return;
    updateSelection(new Set([id]));
  };
  // Sprint 1 interaction correction (2026-07-19c) — closing the
  // inspector now ALSO clears the checkbox selection. When the user
  // dismisses the inspector, they've decided this account is no
  // longer their focus; leaving its checkbox checked while the
  // inspector shows the empty state would recreate the desync the
  // founder just flagged.
  const closeInspector = () => {
    if (isDirty() && !window.confirm("Discard unsaved changes?")) return;
    updateSelection(new Set());
  };

  // Phase B — edit mode transitions.
  const startEditing = () => {
    if (!props.canEdit) { setInspectorMode("permission-denied"); return; }
    if (!inspectorRow) return;
    // Sync URL to `?edit=<id>` so refresh preserves editing intent.
    const sp = new URLSearchParams(searchParams?.toString() ?? "");
    sp.delete("select");
    sp.set("edit", inspectorRow.id);
    router.replace(sp.toString() ? `${pathname}?${sp.toString()}` : pathname);
    setInspectorMode("editing");
  };
  const discardEdits = () => {
    if (isDirty() && !window.confirm("Discard unsaved changes?")) return;
    if (editBaseline) setEditForm(editBaseline);
    // Return to viewing; the URL flips back to `?select=<id>`.
    if (inspectorRow) {
      const sp = new URLSearchParams(searchParams?.toString() ?? "");
      sp.delete("edit");
      sp.set("select", inspectorRow.id);
      router.replace(sp.toString() ? `${pathname}?${sp.toString()}` : pathname);
    }
    setInspectorMode("viewing");
    setSaveMessage(null);
  };
  const patchEdit = <K extends keyof EditFormState>(key: K, value: EditFormState[K]) => {
    setEditForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    // Any keystroke while in `saved` or `validation` returns us to editing.
    if (inspectorMode === "saved" || inspectorMode === "validation") {
      setInspectorMode("editing");
      setSaveMessage(null);
    }
  };
  const toggleFund = (key: "OPERATING" | "CAPITAL") => {
    setEditForm((prev) => {
      if (!prev) return prev;
      const set = new Set(prev.fundKeys);
      if (set.has(key)) set.delete(key); else set.add(key);
      return { ...prev, fundKeys: Array.from(set) };
    });
    if (inspectorMode === "saved" || inspectorMode === "validation") {
      setInspectorMode("editing");
      setSaveMessage(null);
    }
  };

  const saveInspector = () => {
    if (!editForm || !props.canEdit) return;
    const fd = new FormData();
    fd.set("accountId", editForm.accountId);
    fd.set("accountNumber", editForm.accountNumber);
    fd.set("name", editForm.name);
    fd.set("description", editForm.description);
    fd.set("type", editForm.type);
    fd.set("categoryKey", editForm.categoryKey);
    fd.set("fsGroupKey", editForm.fsGroupKey);
    fd.set("parentAccountNumber", editForm.parentAccountNumber);
    fd.set("defaultDepartmentCode", editForm.departmentCode);
    // Fund applicability — the sentinel tells the service "the form
    // submitted fund fields; treat no boxes as explicit clear".
    fd.set("_fundApplicabilityForm", "1");
    for (const k of editForm.fundKeys) fd.append("fundApplicability", k);
    // Flags — each key must be present in the FormData for the service
    // to know it was submitted (matches the legacy modal contract).
    fd.set("isControlAccount", editForm.isControlAccount ? "on" : "off");
    fd.set("isBankAccount",     editForm.isBankAccount     ? "on" : "off");
    fd.set("isCashAccount",     editForm.isCashAccount     ? "on" : "off");
    fd.set("isTaxRelevant",     editForm.isTaxRelevant     ? "on" : "off");
    fd.set("allowManualPosting",editForm.allowManualPosting? "on" : "off");

    setInspectorMode("saving");
    setSaveMessage(null);
    startSaveTransition(async () => {
      try {
        const result = await updateAccountInspectorAction(fd);
        if (result.status === "saved") {
          setEditBaseline(editForm);
          setInspectorMode("saved");
          setSaveMessage(
            result.warnings.length > 0
              ? `Saved. ${result.warnings.join(" · ")}`
              : `Saved. Account ${result.accountNumber} updated.`,
          );
          // Reload-less refresh — the RSC re-fetches Prisma and the row
          // list, group headers, and fund progress ribbon update in
          // place. The inspector stays open on the same account because
          // the URL still says `?edit=<id>`.
          router.refresh();
        } else if (result.status === "validation-error") {
          setInspectorMode("validation");
          setSaveMessage(result.message);
        } else if (result.status === "permission-denied") {
          setInspectorMode("permission-denied");
          setSaveMessage(result.message);
        } else {
          setInspectorMode("validation");
          setSaveMessage(result.message);
        }
      } catch (err) {
        setInspectorMode("validation");
        setSaveMessage(err instanceof Error ? err.message : "Save failed");
      }
    });
  };

  const rowClick = (r: DwAccountRow, ev: React.MouseEvent) => {
    const t = ev.target as HTMLElement;
    if (t.closest("input, button, a, form, .spectre-dw-row-actions")) return;
    openInspector(r.id);
  };

  const setSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const allVisibleChecked = visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.id));
  const someVisibleChecked = !allVisibleChecked && visibleRows.some((r) => selected.has(r.id));

  const totalCount = props.totalAccounts;
  const activeCount = props.activeAccounts;

  return (
    <div className="spectre-dw-root" data-inspector-open={inspectorRow || isBulkInspector ? "true" : "false"}>
      {/* Sprint 1 acceptance repair (2026-07-19) — the founder-approved
          concept has one white toolbar spanning the full workspace
          width, with the two-pane split (table + inspector) beginning
          BELOW the toolbar. Previously the toolbar lived inside
          .spectre-dw-main (left pane only), so a vertical inspector
          divider cut through it. The DOM is now:
            .spectre-dw-root
              .spectre-dw-toolbar   ← spans both panes
              .spectre-dw-progress  ← spans both panes (fund-mode only)
              .spectre-dw-selection ← spans both panes (contextual)
              .spectre-dw-body
                .spectre-dw-main   (table)
                aside.spectre-dw-inspector-slot
          Inspector begins at the same y as the grey table header
          (see globals.css .spectre-dw-inspector-slot rule). */}
      {/* -------------------------------- TOOLBAR */}
        <div className="spectre-dw-toolbar" role="toolbar" aria-label="Chart of Accounts toolbar">
          <div className="spectre-dw-search" data-active={searchLC ? "true" : "false"}>
            <SearchIcon />
            <input
              ref={searchInputRef}
              type="search"
              placeholder="Search number, name, category, FS group, department, fund…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search Chart of Accounts"
              data-testid="coa-workspace-search"
            />
            <span className="kbd">⌘F</span>
            <button type="button" className="clear" onClick={() => setSearch("")} aria-label="Clear search"><CloseIcon size={12} /></button>
          </div>

          <SavedViewMenu current={props.savedView} />


          {/* Fund filter chips — preserved verbatim from the legacy page.
              Each chip navigates to a canonical URL so bookmarks and
              tests that walk `?fund=…` continue to work. */}
          <FundChipRow
            fundFilter={props.fundFilter}
            fundMode={props.fundMode}
            showInactive={props.showInactive}
          />

          <div className="grow" />

          {/* Sprint 1 acceptance repair (2026-07-19) — density switcher
              removed per founder decision. The founder ruled the
              Comfy/Standard/Compact differences were not materially
              useful enough to justify a user preference. Production
              ships one polished density matching the founder-approved
              concept's Standard. The columns chip stays for now (still
              a founder-locked deferral). */}
          <span className="spectre-dw-chip" data-disabled="true" aria-disabled="true" title="Configurable columns arrive in a follow-up phase">
            <ColumnsIcon />
            <span>Columns</span>
          </span>
        </div>

        {/* -------------------------------- FUND-MODE PROGRESS RIBBON */}
        {props.fundMode && (
          <div className="spectre-dw-progress" data-testid="coa-fund-progress">
            <div className="stat"><b>Fund applicability</b></div>
            <FundProgress rows={props.rows} />
          </div>
        )}

        {/* -------------------------------- SELECTION BAR */}
        {totalSelected > 0 && (
          <div className="spectre-dw-selection" data-hidden={hiddenSelectedCount > 0 ? "true" : "false"} role="status">
            <span>
              <span className="count">{totalSelected}</span> account{totalSelected === 1 ? "" : "s"} selected
              {hiddenSelectedCount > 0 && (
                <>
                  {" "}·{" "}
                  <span className="hidden-note">{hiddenSelectedCount} hidden by current filters</span>
                </>
              )}
            </span>
            <div className="grow" />
            {hiddenSelectedCount > 0 && (
              <>
                <button className="spectre-dw-btn secondary sm" onClick={showSelected}>Show selected</button>
                <button className="spectre-dw-btn secondary sm" onClick={clearHidden}>Clear hidden</button>
              </>
            )}
            {props.fundMode && (
              <span className="spectre-dw-selection-fund-hint" style={{ fontSize: 11.5, color: "inherit", opacity: 0.8, fontWeight: 500 }}>
                Use the top toolbar to assign funds to selected accounts.
              </span>
            )}
            {!props.fundMode && props.canEdit && (
              <form
                action={bulkArchiveAccountsAction}
                onSubmit={(e) => {
                  if (!window.confirm(`Archive ${totalSelected} account${totalSelected === 1 ? "" : "s"}? Each will be soft-deleted; any that block will be reported as skipped.`)) {
                    e.preventDefault();
                  }
                }}
                data-testid="coa-bulk-archive-form"
                style={{ display: "inline" }}
              >
                {Array.from(selected).map((id) => (
                  <input key={id} type="hidden" name="accountIds" value={id} />
                ))}
                <button type="submit" className="spectre-dw-btn secondary sm" data-testid="coa-bulk-archive-submit">
                  Archive {totalSelected}
                </button>
              </form>
            )}
            <button className="spectre-dw-btn destructive sm" onClick={clearAll} data-testid="coa-workspace-clear-selection">Clear all</button>
          </div>
        )}

        {/* -------------------------------- TWO-PANE BODY
             Everything above (toolbar, fund-mode progress, selection
             bar) is a direct child of .spectre-dw-root and spans the
             full workspace width. Below, the table pane and the
             inspector pane sit side-by-side inside .spectre-dw-body.
             At viewports ≥ 1280 px, .spectre-dw-body is a two-column
             grid (`minmax(0, 1fr) 400px`); below that, the inspector
             collapses. The vertical divider between the two panes
             begins at the top of the grey table header row — NOT at
             the top of the workspace — so the toolbar reads as one
             continuous white strip. */}
        <div className="spectre-dw-body">
          <div className="spectre-dw-main">
        {/* -------------------------------- TABLE */}
        <div className="spectre-dw-table-wrap">
          {sortedVisibleRows.length === 0 && searchLC ? (
            <div className="spectre-dw-empty">
              <h3>No accounts match your search.</h3>
              <p>Try adjusting the search text or clearing filters. Chart of Accounts is scoped to the Silver Springs GAAP fund structure — accounts you can see here are the ones your role has permission to view.</p>
              <div className="actions">
                <button className="spectre-dw-btn secondary" onClick={() => setSearch("")}>Clear search</button>
                <Link className="spectre-dw-btn tertiary" href="/app/admin/coa">Show all active</Link>
              </div>
            </div>
          ) : sortedVisibleRows.length === 0 ? (
            <EmptyStateForView view={props.savedView} totalRows={props.rows.length} />
          ) : (
            <table
              className="spectre-dw-table"
              data-density={density}
              data-testid="coa-workspace-table"
              aria-label="Chart of Accounts"
            >
              <thead>
                <tr>
                  <th className="spectre-dw-select-cell">
                    <input
                      type="checkbox"
                      className="spectre-dw-check"
                      aria-label="Select all visible accounts"
                      checked={allVisibleChecked}
                      ref={(el) => { if (el) el.indeterminate = someVisibleChecked; }}
                      onChange={toggleAllVisible}
                    />
                  </th>
                  {props.fundMode && props.canEdit && <th className="fund-assign">Assign</th>}
                  <SortableHeader label="Number"   sortKey="number" active={sortKey === "number"} dir={sortDir} onClick={() => setSort("number")} />
                  <SortableHeader label="Name"     sortKey="name"   active={sortKey === "name"}   dir={sortDir} onClick={() => setSort("name")} />
                  <SortableHeader label="Type"     sortKey="type"   active={sortKey === "type"}   dir={sortDir} onClick={() => setSort("type")} />
                  <SortableHeader label="FS group" sortKey="fsGroup" active={sortKey === "fsGroup"} dir={sortDir} onClick={() => setSort("fsGroup")} />
                  <th>Department</th>
                  <th>Fund</th>
                  <SortableHeader label="Balance" sortKey="balance" active={sortKey === "balance"} dir={sortDir} onClick={() => setSort("balance")} className="num" />
                  <SortableHeader label="Status" sortKey="status" active={sortKey === "status"} dir={sortDir} onClick={() => setSort("status")} />
                  <th></th>
                </tr>
              </thead>
              {grouped ? (
                TYPE_ORDER.map((type) => {
                  const rows = rowsByType.get(type) ?? [];
                  if (rows.length === 0) return null;
                  const groupCollapsed = collapsed.has(type);
                  const flagged = rows.filter((r) => r.fundValidation !== "ok").length;
                  return (
                    <React.Fragment key={type}>
                      <tbody data-testid={`coa-type-${type}`} data-group={type}>
                        <tr
                          className={`spectre-dw-group-header${groupCollapsed ? " collapsed" : ""}`}
                          onClick={() => setCollapsed((prev) => {
                            const next = new Set(prev);
                            if (next.has(type)) next.delete(type); else next.add(type);
                            return next;
                          })}
                        >
                          <td colSpan={10 + (props.fundMode && props.canEdit ? 1 : 0)}>
                            <ChevronDown className="toggle" />
                            <span className="grp-title">{TYPE_LABEL[type]}</span>
                            <span className="grp-meta">
                              {rows.length} account{rows.length === 1 ? "" : "s"}
                            </span>
                            {flagged > 0 && (
                              <span className={`val-count${rows.some((r) => r.fundValidation === "blocked") ? " err" : ""}`}>
                                {flagged} needs attention
                              </span>
                            )}
                            <span className="grp-total" data-testid={`coa-section-total-${type}`}>
                              <BalanceValue amount={rows.reduce((s, r) => s + r.balance, 0)} bold />
                            </span>
                          </td>
                        </tr>
                      </tbody>
                      {!groupCollapsed && renderCategorySubgroups(rows, type, props, {
                        selected, toggleRow, rowClick, openMenuFor, setOpenMenuFor, canEdit: props.canEdit,
                        disabledTooltip: props.disabledTooltip, currentInspectorId,
                        columnCount: 10 + (props.fundMode && props.canEdit ? 1 : 0),
                      })}
                    </React.Fragment>
                  );
                })
              ) : (
                <tbody>
                  {sortedVisibleRows.map((r) => (
                    <AccountRow
                      key={r.id}
                      row={r}
                      selected={selected.has(r.id)}
                      onToggle={() => toggleRow(r.id)}
                      onRowClick={(ev) => rowClick(r, ev)}
                      canEdit={props.canEdit}
                      disabledTooltip={props.disabledTooltip}
                      fundMode={props.fundMode}
                      menuOpen={openMenuFor === r.id}
                      setMenuOpen={(open) => setOpenMenuFor(open ? r.id : null)}
                      isInspectorTarget={currentInspectorId === r.id}
                    />
                  ))}
                </tbody>
              )}
            </table>
          )}
        </div>
      </div>

      {/* ---------------------------------- INSPECTOR SLOT
           Sprint 1 reopened acceptance correction (2026-07-19): the
           inspector <aside> is now ALWAYS rendered. When no row is
           selected, it displays the empty state (matching the
           founder-approved concept at
           `public/design-concepts/data-workspace/chart-of-accounts.html`).
           When a row is selected, it renders the account details as
           before. The parent `.spectre-dw-root` grid stays at
           `1fr 400px` at every viewport ≥ 1280px so the inspector
           column always occupies its dedicated space — the workspace
           is not the table alone. */}
      <aside className="spectre-dw-inspector-slot">
        {/* Sprint 1 interaction correction (2026-07-19c) — bulk state.
             When two or more checkboxes are checked, the inspector
             stops trying to show one arbitrarily chosen account. It
             switches to a bulk state that reports the count, hidden
             count, and available bulk actions, and tells the operator
             how to get back to individual details. */}
        {isBulkInspector && (
          <div className="spectre-dw-inspector" data-mode="bulk" data-testid="coa-inspector">
            <div className="spectre-dw-inspector-head">
              <div className="spectre-dw-inspector-eyebrow">
                <span>Bulk selection · Chart of Accounts</span>
                <button
                  className="close-btn"
                  onClick={() => updateSelection(new Set())}
                  aria-label="Clear selection"
                  data-testid="coa-inspector-bulk-clear-x"
                >
                  <CloseIcon size={12} />
                </button>
              </div>
              <div className="spectre-dw-inspector-title">
                <span className="num" data-testid="coa-inspector-bulk-count">{totalSelected}</span>
                <span className="name">account{totalSelected === 1 ? "" : "s"} selected</span>
              </div>
              {hiddenSelectedCount > 0 && (
                <div className="spectre-dw-inspector-meta" data-testid="coa-inspector-bulk-hidden">
                  {hiddenSelectedCount} hidden by current filters
                </div>
              )}
            </div>
            <div className="spectre-dw-inspector-body">
              <p style={{ fontSize: 12.5, color: "var(--spectre-text-secondary)", lineHeight: "18px", marginBottom: 14 }}>
                Reduce the selection to a single account to view its details, posting rules, and audit history in this panel.
              </p>
              <p style={{ fontSize: 11.5, color: "var(--spectre-text-muted)", lineHeight: "17px", marginBottom: 18 }}>
                Bulk actions apply to every checked account, including any hidden by the current filters.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {hiddenSelectedCount > 0 && (
                  <button
                    type="button"
                    className="spectre-dw-btn secondary sm"
                    onClick={showSelected}
                    data-testid="coa-inspector-bulk-show-selected"
                  >
                    Show selected rows
                  </button>
                )}
                {hiddenSelectedCount > 0 && (
                  <button
                    type="button"
                    className="spectre-dw-btn secondary sm"
                    onClick={clearHidden}
                    data-testid="coa-inspector-bulk-clear-hidden"
                  >
                    Clear hidden from selection
                  </button>
                )}
                {props.canEdit && (
                  <form
                    action={bulkArchiveAccountsAction}
                    onSubmit={(e) => {
                      if (!window.confirm(`Archive ${totalSelected} account${totalSelected === 1 ? "" : "s"}? Each will be soft-deleted; any that block will be reported as skipped.`)) {
                        e.preventDefault();
                      }
                    }}
                    data-testid="coa-inspector-bulk-archive-form"
                  >
                    {Array.from(selected).map((id) => (
                      <input key={id} type="hidden" name="accountIds" value={id} />
                    ))}
                    <button
                      type="submit"
                      className="spectre-dw-btn secondary sm"
                      data-testid="coa-inspector-bulk-archive-submit"
                      style={{ width: "100%" }}
                    >
                      Archive {totalSelected} selected
                    </button>
                  </form>
                )}
                <button
                  type="button"
                  className="spectre-dw-btn destructive sm"
                  onClick={() => updateSelection(new Set())}
                  data-testid="coa-inspector-bulk-clear-all"
                >
                  Clear selection
                </button>
              </div>
            </div>
          </div>
        )}
        {!isBulkInspector && !inspectorRow && (
          <div className="spectre-dw-inspector" data-mode="empty" data-testid="coa-inspector">
            <div className="spectre-dw-inspector-empty">
              <div className="spectre-dw-inspector-eyebrow">
                <span>Inspector</span>
              </div>
              <h3>Select an account to inspect.</h3>
              <p>
                Pick a row on the left to see its details, posting rules, activity,
                and audit history. Editing happens inside this panel — the URL
                always reflects the selected account, so refreshing or sharing the
                link opens the same view.
              </p>
              <ul>
                <li>Press <span className="spectre-dw-kbd">/</span> or <span className="spectre-dw-kbd">⌘F</span> to search</li>
                <li>Press <span className="spectre-dw-kbd">N</span> for a new account</li>
                <li>Use <span className="spectre-dw-kbd">↑</span> <span className="spectre-dw-kbd">↓</span> to move the highlight, <span className="spectre-dw-kbd">Enter</span> to open</li>
                <li>Press <span className="spectre-dw-kbd">Esc</span> to close the inspector</li>
              </ul>
              {props.canEdit && (
                <div>
                  <Link href="/app/admin/coa?modal=new" className="spectre-dw-btn primary" data-testid="coa-inspector-empty-new">
                    + New account
                  </Link>
                </div>
              )}
            </div>
          </div>
        )}
        {!isBulkInspector && inspectorRow && (
          <div
            className="spectre-dw-inspector"
            data-mode="reader"
            data-testid="coa-inspector"
          >
            <div className="spectre-dw-inspector-head">
              <div className="spectre-dw-inspector-eyebrow">
                <span>Account · selected from Chart of Accounts</span>
                <button className="close-btn" onClick={closeInspector} aria-label="Close inspector" data-testid="coa-inspector-close">
                  <CloseIcon size={12} />
                </button>
              </div>
              <div className="spectre-dw-inspector-title">
                <span className="num">{inspectorRow.accountNumber}</span>
                <span className="name">{inspectorRow.name}</span>
              </div>
              <div className="spectre-dw-inspector-meta">
                <StatusPillLifecycle isActive={inspectorRow.isActive} />
                {inspectorRow.isControl && <span className="spectre-dw-pill control">Control</span>}
                {inspectorRow.fundValidation === "blocked" && <ValidationBadge tone="blocked" />}
                {inspectorRow.fundValidation === "warn" && <ValidationBadge tone="warn" />}
              </div>
            </div>

            <div className="spectre-dw-inspector-tabs" role="tablist">
              <button role="tab" aria-selected={inspectorTab === "details"}  onClick={() => setInspectorTab("details")}>Details</button>
              <button role="tab" aria-selected={inspectorTab === "rules"}    onClick={() => setInspectorTab("rules")}>Rules</button>
              <button role="tab" aria-selected={inspectorTab === "activity"} onClick={() => setInspectorTab("activity")}>Activity</button>
              <button role="tab" aria-selected={inspectorTab === "audit"}    onClick={() => setInspectorTab("audit")}>Audit</button>
            </div>

            {/* Phase B banners */}
            {inspectorMode === "saved" && saveMessage && (
              <div className="spectre-dw-inspector-banner ok" role="status" data-testid="coa-inspector-banner-saved">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
                <span>{saveMessage}</span>
              </div>
            )}
            {inspectorMode === "validation" && saveMessage && (
              <div className="spectre-dw-inspector-banner err" role="alert" data-testid="coa-inspector-banner-error">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l10 18H2z" /><path d="M12 10v5" /><circle cx="12" cy="18" r="0.7" fill="currentColor" /></svg>
                <span><b>Cannot save.</b> {saveMessage}</span>
              </div>
            )}
            {inspectorMode === "permission-denied" && (
              <div className="spectre-dw-inspector-banner warn" role="status" data-testid="coa-inspector-banner-permission">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v5" /><circle cx="12" cy="16" r="0.7" fill="currentColor" /></svg>
                <span>{saveMessage ?? props.disabledTooltip}</span>
              </div>
            )}

            <div className="spectre-dw-inspector-body">
              {inspectorTab === "details" && (
                editForm ? (
                  <EditableDetails
                    form={editForm}
                    mode={inspectorMode}
                    row={inspectorRow}
                    categoryOptions={props.categoryOptions}
                    fsGroupOptions={props.fsGroupOptions}
                    departmentOptions={props.departmentOptions}
                    parentOptions={props.parentOptions}
                    canEdit={props.canEdit}
                    onPatch={patchEdit}
                    onToggleFund={toggleFund}
                  />
                ) : null
              )}
              {inspectorTab === "rules" && (
                <p style={{ fontSize: 12.5, color: "var(--spectre-text-secondary)", lineHeight: "18px" }}>
                  Posting rules, close-out behaviour, and journal templates for this account
                  will surface here in a follow-up sprint. Today, edit the account to change
                  its posting behaviour.
                </p>
              )}
              {inspectorTab === "activity" && (
                <p style={{ fontSize: 12.5, color: "var(--spectre-text-secondary)", lineHeight: "18px" }}>
                  Recent journal entries touching this account will appear here. For the full
                  ledger, open{" "}
                  <Link href={`/app/admin/gl/account/${inspectorRow.id}`} style={{ color: "var(--spectre-status-info)", textDecoration: "underline" }}>
                    the account ledger →
                  </Link>
                </p>
              )}
              {inspectorTab === "audit" && (
                <p style={{ fontSize: 12.5, color: "var(--spectre-text-secondary)", lineHeight: "18px" }}>
                  Change history for this account record. Wired to the existing audit-log
                  service in a follow-up sprint.
                </p>
              )}
            </div>

            {inspectorTab === "details" && (
              <div className="spectre-dw-inspector-foot">
                <InspectorFooterStatus
                  mode={inspectorMode}
                  dirty={isDirty()}
                  pending={savePending}
                />
                <div className="actions">
                  {inspectorMode === "viewing" && (
                    <>
                      {props.canEdit ? (
                        <button
                          type="button"
                          className="spectre-dw-btn primary"
                          onClick={startEditing}
                          data-testid={`coa-edit-${inspectorRow.accountNumber}`}
                        >
                          <PencilIcon /> Edit
                        </button>
                      ) : (
                        <span
                          className="spectre-dw-btn secondary"
                          aria-disabled="true"
                          title={props.disabledTooltip}
                          data-testid={`coa-edit-${inspectorRow.accountNumber}`}
                          data-disabled-reason="no-coa-write"
                        >
                          Edit (permission required)
                        </span>
                      )}
                    </>
                  )}
                  {(inspectorMode === "editing" || inspectorMode === "saved" || inspectorMode === "validation") && props.canEdit && (
                    <>
                      <button
                        type="button"
                        className="spectre-dw-btn tertiary"
                        onClick={discardEdits}
                        disabled={savePending}
                        data-testid="coa-inspector-discard"
                      >
                        {isDirty() ? "Discard changes" : "Cancel"}
                      </button>
                      <button
                        type="button"
                        className="spectre-dw-btn primary"
                        onClick={saveInspector}
                        disabled={savePending || !isDirty() || inspectorMode === "validation"}
                        data-testid="coa-inspector-save"
                      >
                        <CheckIcon /> Save changes
                      </button>
                    </>
                  )}
                  {inspectorMode === "saving" && (
                    <button
                      type="button"
                      className="spectre-dw-btn primary"
                      disabled
                      data-testid="coa-inspector-save"
                    >
                      Saving…
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </aside>
      </div>{/* /.spectre-dw-body */}

      {/* Sprint 1 acceptance repair (2026-07-19).
           Design-QA "Review states" floating panel — mirrors the same
           utility in the founder-approved concept HTML. Rendered ONLY
           when the server flagged `reviewMode` true (NODE_ENV=development
           OR `?_review=1`). Never renders for a real production user.
           The links are anchor navigations to canonical state presets
           so a reviewer can jump between empty / selected / editing /
           error / no-results without hunting through the workspace. */}
      {props.reviewMode && <ReviewStatesPanel />}
    </div>
  );
}

// ----- Sub-components ---------------------------------------------------

const SAVED_VIEWS: Array<{ key: string; label: string; href: string; testKey: string }> = [
  { key: "all-active",       label: "All active",          href: "/app/admin/coa",                   testKey: "all-active" },
  { key: "needs-attention",  label: "Needs attention",     href: "/app/admin/coa?view=needs-attention", testKey: "needs-attention" },
  { key: "unassigned-fs",    label: "Unassigned FS group", href: "/app/admin/coa?view=unassigned-fs",   testKey: "unassigned-fs" },
  { key: "fund",             label: "Fund applicability",  href: "/app/admin/coa?mode=fund",         testKey: "fund" },
  { key: "inactive",         label: "Inactive accounts",   href: "/app/admin/coa?showInactive=1",    testKey: "inactive" },
  { key: "recently-changed", label: "Recently changed",    href: "/app/admin/coa?view=recently-changed", testKey: "recently-changed" },
];

function SavedViewMenu({ current }: { current: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("[data-saved-view-menu]")) return;
      setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);
  return (
    <span data-saved-view-menu style={{ position: "relative" }} data-testid="coa-workspace-view">
      <button
        type="button"
        className="spectre-dw-view-chip"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <FolderIcon />
        <span className="k">View:</span>
        <span className="active-view">{savedViewLabel(current)}</span>
        <ChevronDown />
      </button>
      {open && (
        <div role="menu" className="spectre-dw-view-menu">
          {SAVED_VIEWS.map((v) => (
            <Link
              key={v.key}
              href={v.href}
              role="menuitem"
              data-testid={`coa-view-${v.testKey}`}
              data-active={v.key === current ? "true" : "false"}
              onClick={() => setOpen(false)}
            >
              {v.label}
            </Link>
          ))}
        </div>
      )}
    </span>
  );
}

function savedViewLabel(view: string): string {
  switch (view) {
    case "fund": return "Fund applicability";
    case "inactive": return "Inactive accounts";
    case "needs-attention": return "Needs attention";
    case "unassigned-fs": return "Unassigned FS group";
    case "recently-changed": return "Recently changed";
    default: return "All active";
  }
}

function SortableHeader({
  label, active, dir, onClick, sortKey, className,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  sortKey: SortKey;
  className?: string;
}) {
  return (
    <th className={`sortable${className ? ` ${className}` : ""}`} scope="col" aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"} data-sort-key={sortKey}>
      <button type="button" className={`sort${active ? " active" : ""}`} onClick={onClick}>
        {label}
        {active
          ? (dir === "asc" ? <ChevronUp /> : <ChevronDown />)
          : <ArrowUpDown />}
      </button>
    </th>
  );
}

function FundChipRow({
  fundFilter, fundMode, showInactive,
}: {
  fundFilter: "OPERATING" | "CAPITAL" | "BOTH" | "NONE" | null;
  fundMode: boolean;
  showInactive: boolean;
}) {
  const chips = [
    { key: "",          label: "All",           testKey: "all" },
    { key: "OPERATING", label: "Operating",     testKey: "OPERATING" },
    { key: "CAPITAL",   label: "Capital",       testKey: "CAPITAL" },
    { key: "BOTH",      label: "Both",          testKey: "BOTH" },
    { key: "NONE",      label: "Unmapped",      testKey: "NONE" },
  ];
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }} data-testid="coa-fund-filter">
      {chips.map((chip) => {
        const isActive = (chip.key === "" && fundFilter === null) || chip.key === fundFilter;
        const params = new URLSearchParams();
        if (chip.key !== "") params.set("fund", chip.key);
        if (fundMode) params.set("mode", "fund");
        if (showInactive) params.set("showInactive", "1");
        const qs = params.toString();
        const href = qs ? `/app/admin/coa?${qs}` : "/app/admin/coa";
        return (
          <Link
            key={chip.key || "all"}
            href={href}
            className={`spectre-dw-chip${isActive ? " on" : ""}`}
            data-testid={`coa-fund-filter-${chip.testKey}`}
            data-active={isActive ? "true" : "false"}
          >
            {chip.key === "" ? <><span className="k">Fund:</span><span className="v">{chip.label}</span></> : chip.label}
          </Link>
        );
      })}
    </div>
  );
}

function FundProgress({ rows }: { rows: DwAccountRow[] }) {
  const plAll = rows.filter((r) => r.isPL);
  const plAssigned = plAll.filter((r) => r.fundKeys.length > 0).length;
  const plUnassigned = plAll.length - plAssigned;
  const pct = plAll.length === 0 ? 100 : Math.round((plAssigned / plAll.length) * 100);
  return (
    <>
      <div className="stat"><span>Assigned</span><b>{plAssigned} of {plAll.length}</b> P&amp;L accounts</div>
      <div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div>
      <div className="stat unassigned"><span>Unassigned</span><b>{plUnassigned}</b></div>
      <div className="stat" style={{ marginLeft: "auto", color: "var(--spectre-text-muted)" }}>
        Only revenue &amp; expense accounts appear in this view.
      </div>
    </>
  );
}

function renderCategorySubgroups(
  rows: DwAccountRow[],
  type: DwAccountRow["type"],
  props: ChartOfAccountsClientProps,
  ctx: {
    selected: Set<string>;
    toggleRow: (id: string) => void;
    rowClick: (r: DwAccountRow, ev: React.MouseEvent) => void;
    openMenuFor: string | null;
    setOpenMenuFor: (id: string | null) => void;
    canEdit: boolean;
    disabledTooltip: string;
    currentInspectorId: string | null;
    columnCount: number;
  },
): React.ReactNode[] {
  // Sub-group by category → FS Group with legacy sort. Emit ONE
  // <tbody data-section-key={fsg.key}> per FS Group so the legacy
  // SectionSelectAllCheckbox (which queries
  //   [data-section-key="X"] input[type="checkbox"][name="accountIds"]
  // ) scopes to only the rows inside its own section.
  const cats = new Map<string, { label: string; sortOrder: number; fsGroups: Map<string, { key: string; label: string; sortOrder: number; rows: DwAccountRow[] }> }>();
  for (const r of rows) {
    let c = cats.get(r.categoryKey);
    if (!c) { c = { label: r.categoryLabel, sortOrder: r.categorySortOrder, fsGroups: new Map() }; cats.set(r.categoryKey, c); }
    let g = c.fsGroups.get(r.fsGroupKey);
    if (!g) { g = { key: r.fsGroupKey, label: r.fsGroupLabel, sortOrder: r.fsGroupSortOrder, rows: [] }; c.fsGroups.set(r.fsGroupKey, g); }
    g.rows.push(r);
  }
  const catList = Array.from(cats.entries()).sort((a, b) => a[1].sortOrder - b[1].sortOrder || a[1].label.localeCompare(b[1].label));
  const out: React.ReactNode[] = [];
  for (const [catKey, cat] of catList) {
    const fsList = Array.from(cat.fsGroups.values()).sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
    for (const fsg of fsList) {
      out.push(
        <tbody
          key={`${type}-${catKey}-${fsg.key}-body`}
          data-section-key={fsg.key}
          data-testid={`coa-fsgroup-${type}-${catKey}-${fsg.key}`}
        >
          <tr className="spectre-dw-sub-header">
            <td colSpan={ctx.columnCount}>
              <span data-testid={`coa-fsgroup-label-${fsg.key}`} className="inline-flex items-center">
                {props.fundMode && ctx.canEdit && (
                  <SectionSelectAllCheckbox
                    sectionKey={fsg.key}
                    testId={`coa-fund-section-select-all-${fsg.key}`}
                    label={`Select all ${fsg.label} accounts`}
                  />
                )}
                {cat.label} · {fsg.label}
              </span>
              <span className="sg-count">{fsg.rows.length} account{fsg.rows.length === 1 ? "" : "s"}</span>
              <span className="sg-total" data-testid={`coa-subsection-total-${fsg.key}`}>
                <BalanceValue amount={fsg.rows.reduce((s, r) => s + r.balance, 0)} />
              </span>
            </td>
          </tr>
          {fsg.rows.map((r) => (
            <AccountRow
              key={r.id}
              row={r}
              selected={ctx.selected.has(r.id)}
              onToggle={() => ctx.toggleRow(r.id)}
              onRowClick={(ev) => ctx.rowClick(r, ev)}
              canEdit={ctx.canEdit}
              disabledTooltip={ctx.disabledTooltip}
              fundMode={props.fundMode}
              menuOpen={ctx.openMenuFor === r.id}
              setMenuOpen={(open) => ctx.setOpenMenuFor(open ? r.id : null)}
              isInspectorTarget={ctx.currentInspectorId === r.id}
            />
          ))}
        </tbody>,
      );
    }
  }
  return out;
}

function AccountRow({
  row, selected, onToggle, onRowClick, canEdit, disabledTooltip,
  fundMode, menuOpen, setMenuOpen, isInspectorTarget,
}: {
  row: DwAccountRow;
  selected: boolean;
  onToggle: () => void;
  onRowClick: (ev: React.MouseEvent) => void;
  canEdit: boolean;
  disabledTooltip: string;
  fundMode: boolean;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  isInspectorTarget: boolean;
}) {
  return (
    <tr
      className="spectre-dw-row"
      data-testid={`coa-account-row-${row.accountNumber}`}
      data-account-id={row.id}
      data-active={row.isActive ? "true" : "false"}
      data-fund-applicability={row.fundApplicabilityRaw}
      data-selected={selected ? "true" : "false"}
      data-inactive={row.isActive ? "false" : "true"}
      data-validation={row.fundValidation === "ok" ? undefined : row.fundValidation}
      data-active-inspector={isInspectorTarget ? "true" : "false"}
      onClick={onRowClick}
    >
      <td className="spectre-dw-select-cell">
        <input
          type="checkbox"
          className="spectre-dw-check"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select account ${row.accountNumber}`}
          {...(fundMode ? { name: "accountIds", value: row.id, form: "coa-bulk-fund-form", "data-testid": `coa-bulk-select-${row.accountNumber}` } : {})}
        />
      </td>
      {fundMode && canEdit && (
        <td className="fund-assign" onClick={(e) => e.stopPropagation()}>
          <div className="spectre-dw-fund-assign-pair">
            <label><input type="checkbox" defaultChecked={row.fundKeys.includes("OPERATING")} disabled /><span>Op</span></label>
            <label><input type="checkbox" defaultChecked={row.fundKeys.includes("CAPITAL")} disabled /><span>Cap</span></label>
          </div>
        </td>
      )}
      <td className="num-col">{row.accountNumber}</td>
      <td className="name">
        <Link
          href={`/app/admin/gl/account/${row.id}`}
          className="name-text"
          style={{ textDecoration: "none" }}
          onClick={(e) => e.stopPropagation()}
        >
          {row.name}
        </Link>
        {row.description && <span className="desc">{row.description}</span>}
        {row.fundValidation === "blocked" && (
          <span className="desc err" data-testid={`coa-account-fund-unmapped-${row.accountNumber}`}>
            Missing fund applicability · cannot post to Monthly Reporting Package until resolved
          </span>
        )}
      </td>
      <td className="tag">{TYPE_LABEL[row.type]}</td>
      <td className="tag">{row.fsGroupLabel}</td>
      <td className="tag">{row.departmentLabel ?? "—"}</td>
      <td data-testid={`coa-account-fund-${row.accountNumber}`}>
        {row.fundKeys.length > 0 ? (
          <span className={`spectre-dw-fund-chip ${row.fundKeys.length === 2 ? "both" : row.fundKeys[0] === "OPERATING" ? "op" : "cap"}`}>
            {row.fundKeys.length === 2 ? "Both" : row.fundKeys[0] === "OPERATING" ? "Operating" : "Capital"}
          </span>
        ) : row.isPL ? (
          <span className="spectre-dw-fund-chip none">Unmapped</span>
        ) : (
          <span className="spectre-dw-fund-chip na">—</span>
        )}
      </td>
      <td className="spectre-dw-balance-cell num" data-testid={`coa-account-balance-${row.accountNumber}`}>
        <BalanceValue amount={row.balance} />
      </td>
      <td data-testid={`coa-account-flags-${row.accountNumber}`}>
        <span className="spectre-dw-status-cell">
          <StatusPillLifecycle isActive={row.isActive} />
          {row.isControl && (
            <span className="spectre-dw-pill control" data-testid={`coa-account-flag-control-${row.accountNumber}`}>Control</span>
          )}
          {!row.isActive && (
            <span data-testid={`coa-account-flag-inactive-${row.accountNumber}`} style={{ display: "none" }}>Inactive</span>
          )}
          {row.fundValidation === "warn" && <ValidationBadge tone="warn" />}
          {row.fundValidation === "blocked" && <ValidationBadge tone="blocked" />}
        </span>
      </td>
      <td className="actions">
        <div className="spectre-dw-row-actions" data-open={menuOpen ? "true" : "false"}>
          <button
            type="button"
            className="trigger"
            aria-label={`Actions for ${row.accountNumber}`}
            onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
          >
            <EllipsisIcon />
          </button>
          <div className="menu" role="menu">
            <Link
              href={`/app/admin/coa?edit=${row.id}`}
              role="menuitem"
              data-testid={`coa-edit-${row.accountNumber}`}
              className={canEdit ? "" : "disabled"}
              title={canEdit ? undefined : disabledTooltip}
              onClick={(e) => { if (!canEdit) { e.preventDefault(); } setMenuOpen(false); }}
            >
              Edit account…
            </Link>
            {canEdit ? (
              row.isActive ? (
                <ArchiveMenuForm accountId={row.id} num={row.accountNumber} />
              ) : (
                <ReactivateMenuForm accountId={row.id} num={row.accountNumber} />
              )
            ) : (
              <span className="disabled" data-testid={`coa-archive-${row.accountNumber}`} title={disabledTooltip}>Archive</span>
            )}
            <hr />
            <Link
              href={`/app/admin/coa?delete=${row.id}`}
              role="menuitem"
              className={`destructive${canEdit ? "" : " disabled"}`}
              data-testid={`coa-delete-${row.accountNumber}`}
              title={canEdit ? undefined : disabledTooltip}
              onClick={(e) => { if (!canEdit) { e.preventDefault(); } setMenuOpen(false); }}
            >
              Delete…
            </Link>
          </div>
        </div>
      </td>
    </tr>
  );
}

function ArchiveMenuForm({ accountId, num }: { accountId: string; num: string }) {
  return (
    <form action="/api/coa/archive" method="post" onClick={(e) => e.stopPropagation()}>
      <input type="hidden" name="accountId" value={accountId} />
      <button type="submit" data-testid={`coa-archive-${num}`} formAction={undefined}>Archive</button>
    </form>
  );
}

function ReactivateMenuForm({ accountId, num }: { accountId: string; num: string }) {
  return (
    <form action="/api/coa/reactivate" method="post" onClick={(e) => e.stopPropagation()}>
      <input type="hidden" name="accountId" value={accountId} />
      <button type="submit" data-testid={`coa-reactivate-${num}`}>Reactivate</button>
    </form>
  );
}

function RowActionForm({
  ids, action, label, testId, isReactivate,
}: {
  ids: string[]; action: string; label: string; testId?: string; isReactivate?: boolean;
}) {
  // Placeholder form — the archive / reactivate server actions accept a single accountId.
  // Bulk archive is not supported in phase A of the integration (matches production).
  return (
    <form action={`/app/admin/coa?action=${action}`} method="post" style={{ display: "inline-flex" }}>
      {ids.map((id) => <input key={id} type="hidden" name="accountId" value={id} />)}
      <button className="spectre-dw-btn secondary sm" type="submit" data-testid={testId}>{label}</button>
    </form>
  );
}

function BulkArchiveForm({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <span style={{ fontSize: 11.5, color: "inherit", opacity: 0.8, fontWeight: 500 }}>
        Bulk archive not yet supported. Use the row menu ⋯ to archive individually.
      </span>
    </span>
  );
}

// Sprint 1 acceptance repair (2026-07-19) — canonical Balance
// renderer used by the row Balance cell, the section-total group
// header cell, and the sub-section sub-header. Preserves the sign
// from `naturalBalance` (positive = normal side; negative = contra
// balance). Zero balances render as a subdued em-dash so they don't
// crowd the eye — the concept treats zero as "no activity", not
// "$0.00".
function BalanceValue({ amount, bold }: { amount: number; bold?: boolean }) {
  if (!Number.isFinite(amount) || Math.abs(amount) < 0.005) {
    return <span className="spectre-dw-balance zero">—</span>;
  }
  const neg = amount < 0;
  const abs = Math.abs(amount);
  const whole = Math.floor(abs).toLocaleString("en-US");
  const cents = (abs - Math.floor(abs)).toFixed(2).slice(1); // ".NN"
  return (
    <span className={`spectre-dw-balance${neg ? " negative" : ""}${bold ? " bold" : ""}`}>
      {neg ? "−" : ""}${whole}<span className="cents">{cents}</span>
    </span>
  );
}

function StatusPillLifecycle({ isActive }: { isActive: boolean }) {
  return isActive
    ? <span className="spectre-dw-pill active">Active</span>
    : <span className="spectre-dw-pill archived">Inactive</span>;
}

function ValidationBadge({ tone }: { tone: "warn" | "blocked" }) {
  return (
    <span className={`spectre-dw-val-badge ${tone}`}>
      {tone === "warn"
        ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l10 18H2z" /><path d="M12 10v5" /><circle cx="12" cy="18" r="0.7" fill="currentColor" /></svg>
        : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M6 6l12 12" /></svg>}
      {tone === "warn" ? "Warning" : "Blocked"}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="spectre-dw-field">
      <span className="lbl">{label}</span>
      <span className="val">{children}</span>
    </div>
  );
}

// Sprint 1 acceptance repair (2026-07-19).
// Design-QA panel that mirrors the concept HTML's "Review states"
// utility. Rendered ONLY when the parent server component passes
// `reviewMode={true}` — i.e. NODE_ENV=development or `?_review=1`.
// The links jump to canonical state presets so a reviewer can flip
// between empty / selected / editing / error views without hunting.
// The panel is deliberately a small self-contained component with
// its own local open/close state — it never touches the shared
// workspace state and cannot corrupt selection or URL history.
function ReviewStatesPanel(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="spectre-dw-review-root" data-testid="coa-review-states-root">
      <button
        type="button"
        className="spectre-dw-review-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="coa-review-panel"
        data-testid="coa-review-states-toggle"
      >
        <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h10" />
        </svg>
        Review states
      </button>
      {open && (
        <div className="spectre-dw-review-panel" id="coa-review-panel" role="dialog" aria-label="Review state presets">
          <button
            type="button"
            className="spectre-dw-review-close"
            onClick={() => setOpen(false)}
            aria-label="Close review panel"
          >
            <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M6 6l12 12" /><path d="M18 6L6 18" /></svg>
          </button>
          <div className="grp">
            <h5>State demos</h5>
            <div className="btns">
              <Link href="/app/admin/coa">Default</Link>
              <Link href="/app/admin/coa?showInactive=1">With inactive</Link>
              <Link href="/app/admin/coa?fund=NONE">No fund applicability</Link>
              <Link href="/app/admin/coa?mode=fund">Fund-mode</Link>
              <Link href="/app/admin/coa?fund=OPERATING">Operating only</Link>
              <Link href="/app/admin/coa?fund=CAPITAL">Capital only</Link>
            </div>
          </div>
          <div className="grp">
            <h5>Saved views</h5>
            <div className="btns">
              <Link href="/app/admin/coa?view=all-active">All active</Link>
              <Link href="/app/admin/coa?view=needs-attention">Needs attention</Link>
              <Link href="/app/admin/coa?view=unassigned-fs">Unassigned FS</Link>
              <Link href="/app/admin/coa?view=fund-applicability">Fund applicability</Link>
              <Link href="/app/admin/coa?view=inactive">Inactive</Link>
              <Link href="/app/admin/coa?view=recently-changed">Recently changed</Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FlagLabel({ checked, label }: { checked: boolean; label: string }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <input type="checkbox" className="spectre-dw-check" checked={checked} disabled readOnly />
      <span>{label}</span>
    </label>
  );
}

// Phase B — editable Details tab. Renders the read-only view when
// `mode === "viewing"`, and controlled form inputs otherwise.
function EditableDetails({
  form, mode, row, categoryOptions, fsGroupOptions, departmentOptions, parentOptions,
  canEdit, onPatch, onToggleFund,
}: {
  form: EditFormState;
  mode: "viewing" | "editing" | "saving" | "saved" | "validation" | "permission-denied";
  row: DwAccountRow;
  categoryOptions: DwOption[];
  fsGroupOptions: DwOption[];
  departmentOptions: DwOption[];
  parentOptions: DwParentOption[];
  canEdit: boolean;
  onPatch: <K extends keyof EditFormState>(key: K, value: EditFormState[K]) => void;
  onToggleFund: (key: "OPERATING" | "CAPITAL") => void;
}) {
  const editing = mode === "editing" || mode === "saved" || mode === "validation" || mode === "saving";
  const disabled = !canEdit || mode === "saving";
  if (!editing) {
    return (
      <>
        <Field label="Number"><span style={{ fontFamily: "ui-monospace", fontWeight: 600 }}>{row.accountNumber}</span></Field>
        <Field label="Name">{row.name}</Field>
        {row.description && <Field label="Description">{row.description}</Field>}
        <Field label="Type">{TYPE_LABEL[row.type]}</Field>
        <Field label="Category">{row.categoryLabel}</Field>
        <Field label="FS Group">{row.fsGroupLabel}</Field>
        <Field label="Fund applicability">
          {row.fundKeys.length > 0 ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {row.fundKeys.map((k) => (
                <span key={k} className={`spectre-dw-fund-chip ${k.toLowerCase() === "operating" ? "op" : "cap"}`}>
                  {k.charAt(0) + k.slice(1).toLowerCase()}
                </span>
              ))}
            </div>
          ) : row.isPL ? (
            <span className="spectre-dw-fund-chip none">Unmapped</span>
          ) : (
            <span className="spectre-dw-fund-chip na">Not applicable</span>
          )}
          <span className="help">
            Balance-sheet accounts default to Not applicable. P&amp;L accounts must be Operating, Capital, or Both.
          </span>
        </Field>
        <Field label="Department">{row.departmentLabel ?? "—"}</Field>
        <Field label="Parent account">{row.parentAccountNumber ?? "—"}</Field>
        <Field label="Flags">
          <div className="spectre-dw-flags-list">
            <FlagLabel checked={row.isBank || row.isCash} label="Reconcilable (bank / cash)" />
            <FlagLabel checked={row.allowManualPosting} label="Allow manual posting" />
            <FlagLabel checked={row.isControl} label="Control account" />
            <FlagLabel checked={row.isTaxRelevant} label="Tax-relevant" />
          </div>
        </Field>
      </>
    );
  }
  return (
    <>
      <Field label="Number">
        <input
          type="text"
          className="spectre-dw-input"
          value={form.accountNumber}
          onChange={(e) => onPatch("accountNumber", e.target.value)}
          disabled={disabled}
          data-testid="coa-inspector-field-number"
          maxLength={40}
          required
        />
      </Field>
      <Field label="Name">
        <input
          type="text"
          className="spectre-dw-input"
          value={form.name}
          onChange={(e) => onPatch("name", e.target.value)}
          disabled={disabled}
          data-testid="coa-inspector-field-name"
          maxLength={200}
          required
        />
      </Field>
      <Field label="Description">
        <textarea
          className="spectre-dw-input"
          value={form.description}
          onChange={(e) => onPatch("description", e.target.value)}
          disabled={disabled}
          rows={2}
          maxLength={2000}
          data-testid="coa-inspector-field-description"
        />
        <span className="help">Shown as a caption on ledger reports.</span>
      </Field>
      <Field label="Type">
        <select
          className="spectre-dw-input"
          value={form.type}
          onChange={(e) => onPatch("type", e.target.value)}
          disabled={disabled}
          data-testid="coa-inspector-field-type"
        >
          <option value="ASSET">Asset</option>
          <option value="LIABILITY">Liability</option>
          <option value="EQUITY">Equity</option>
          <option value="REVENUE">Revenue</option>
          <option value="EXPENSE">Expense</option>
        </select>
      </Field>
      <Field label="Category">
        <select
          className="spectre-dw-input"
          value={form.categoryKey}
          onChange={(e) => onPatch("categoryKey", e.target.value)}
          disabled={disabled}
          data-testid="coa-inspector-field-category"
        >
          <option value="">— None —</option>
          {categoryOptions.map((c) => (
            <option key={c.key} value={c.key}>{c.label}{c.type ? ` (${c.type})` : ""}</option>
          ))}
        </select>
      </Field>
      <Field label="FS Group">
        <select
          className="spectre-dw-input"
          value={form.fsGroupKey}
          onChange={(e) => onPatch("fsGroupKey", e.target.value)}
          disabled={disabled}
          data-testid="coa-inspector-field-fsgroup"
        >
          <option value="">— None —</option>
          {fsGroupOptions.map((g) => (
            <option key={g.key} value={g.key}>{g.label}{g.statement ? ` (${g.statement})` : ""}</option>
          ))}
        </select>
      </Field>
      <Field label="Fund applicability">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }} data-testid="coa-inspector-field-fund">
          {KNOWN_FUND_KEYS.map((k) => (
            <label key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 500 }}>
              <input
                type="checkbox"
                className="spectre-dw-check"
                checked={form.fundKeys.includes(k)}
                onChange={() => onToggleFund(k)}
                disabled={disabled}
                data-testid={`coa-inspector-fund-${k}`}
              />
              <span style={{ textTransform: "capitalize" }}>{k.toLowerCase()}</span>
            </label>
          ))}
        </div>
        <span className="help">
          Profit &amp; Loss accounts require Operating, Capital, or Both. Balance-sheet accounts leave this empty.
        </span>
      </Field>
      <Field label="Department">
        <select
          className="spectre-dw-input"
          value={form.departmentCode}
          onChange={(e) => onPatch("departmentCode", e.target.value)}
          disabled={disabled}
          data-testid="coa-inspector-field-department"
        >
          <option value="">— None —</option>
          {departmentOptions.map((d) => (
            <option key={d.key} value={d.key}>{d.label}</option>
          ))}
        </select>
      </Field>
      <Field label="Parent account">
        <select
          className="spectre-dw-input"
          value={form.parentAccountNumber}
          onChange={(e) => onPatch("parentAccountNumber", e.target.value)}
          disabled={disabled}
          data-testid="coa-inspector-field-parent"
        >
          <option value="">— None —</option>
          {parentOptions
            .filter((p) => p.id !== form.accountId)
            .map((p) => (
              <option key={p.id} value={p.accountNumber}>{p.accountNumber} · {p.name}</option>
            ))}
        </select>
      </Field>
      <Field label="Flags">
        <div className="spectre-dw-flags-list">
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" className="spectre-dw-check" checked={form.isBankAccount || form.isCashAccount} onChange={(e) => { onPatch("isBankAccount", e.target.checked); onPatch("isCashAccount", e.target.checked); }} disabled={disabled} />
            <span>Reconcilable (bank / cash)</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" className="spectre-dw-check" checked={form.allowManualPosting} onChange={(e) => onPatch("allowManualPosting", e.target.checked)} disabled={disabled} />
            <span>Allow manual posting</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" className="spectre-dw-check" checked={form.isControlAccount} onChange={(e) => onPatch("isControlAccount", e.target.checked)} disabled={disabled} />
            <span>Control account</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" className="spectre-dw-check" checked={form.isTaxRelevant} onChange={(e) => onPatch("isTaxRelevant", e.target.checked)} disabled={disabled} />
            <span>Tax-relevant</span>
          </label>
        </div>
      </Field>
    </>
  );
}

function EmptyStateForView({ view, totalRows }: { view: string; totalRows: number }) {
  // Phase B — view-aware empty state so a zero-row Needs Attention
  // view celebrates the clean state rather than implying the ledger
  // itself is empty.
  if (totalRows === 0) {
    return (
      <div className="spectre-dw-empty">
        <h3>The Chart of Accounts is empty.</h3>
        <p>Start by importing your Chart of Accounts from a CSV, or create your first account.</p>
      </div>
    );
  }
  switch (view) {
    case "needs-attention":
      return (
        <div className="spectre-dw-empty">
          <h3>No accounts need attention.</h3>
          <p>Every P&amp;L account has an Operating or Capital tag and every FS Group assignment is complete. The Monthly Reporting Package will include every account in its rollups.</p>
        </div>
      );
    case "unassigned-fs":
      return (
        <div className="spectre-dw-empty">
          <h3>Every account has an FS Group.</h3>
          <p>Nothing needs to be mapped. Financial-statement rollups will resolve for every account.</p>
        </div>
      );
    case "recently-changed":
      return (
        <div className="spectre-dw-empty">
          <h3>No changes in the last 7 days.</h3>
          <p>The Chart of Accounts has been stable for the past week. Recently-edited accounts will appear here as soon as they are updated.</p>
        </div>
      );
    case "fund":
      return (
        <div className="spectre-dw-empty">
          <h3>Every P&amp;L account is assigned.</h3>
          <p>Every revenue and expense account has an Operating or Capital tag — the Monthly Reporting Package will roll everything into the right column.</p>
        </div>
      );
    case "inactive":
      return (
        <div className="spectre-dw-empty">
          <h3>No archived accounts.</h3>
          <p>The ledger has no soft-deleted accounts. Archived accounts appear here for review or reactivation.</p>
        </div>
      );
    default:
      return (
        <div className="spectre-dw-empty">
          <h3>No accounts to show.</h3>
          <p>Adjust the filters or switch to <b>All active</b> to see the full ledger.</p>
        </div>
      );
  }
}

function InspectorFooterStatus({
  mode, dirty, pending,
}: { mode: string; dirty: boolean; pending: boolean }) {
  let text = "Read only — press Edit to modify";
  let tone: "muted" | "warn" | "ok" | "err" = "muted";
  if (mode === "viewing")   { text = "Read only — press Edit to modify"; tone = "muted"; }
  if (mode === "editing")   { text = dirty ? "You have unsaved changes" : "Editing — no changes yet"; tone = dirty ? "warn" : "muted"; }
  if (mode === "saving" || pending) { text = "Saving…"; tone = "muted"; }
  if (mode === "saved")     { text = "Saved. Continue editing or discard to close."; tone = "ok"; }
  if (mode === "validation"){ text = "1 field needs attention"; tone = "err"; }
  return (
    <span className="status-text" data-tone={tone} data-testid="coa-inspector-status">
      {text}
    </span>
  );
}


// ----- Inline SVG icons (monochrome, 1.9 stroke) -----------------------

const SVG = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function SearchIcon()  { return <svg {...SVG}><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>; }
function CloseIcon({ size = 14 }: { size?: number }) { return <svg {...SVG} width={size} height={size}><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>; }
function FolderIcon()  { return <svg {...SVG}><path d="M4 4h10l4 4v12H4z"/><path d="M9 4v6h7"/></svg>; }
function ColumnsIcon() { return <svg {...SVG}><path d="M4 5h6"/><path d="M4 12h6"/><path d="M4 19h6"/><path d="M14 5h6"/><path d="M14 12h6"/><path d="M14 19h6"/></svg>; }
function ChevronUp()   { return <svg {...SVG} width={10} height={10}><path d="M8 14l4-4 4 4"/></svg>; }
function ChevronDown({ className }: { className?: string } = {}) { return <svg {...SVG} width={10} height={10} className={className}><path d="M8 10l4 4 4-4"/></svg>; }
function ArrowUpDown() { return <svg {...SVG} width={10} height={10}><path d="M8 10l4-4 4 4"/><path d="M8 14l4 4 4-4"/></svg>; }
function EllipsisIcon(){ return <svg viewBox="0 0 24 24" fill="currentColor" width={14} height={14}><circle cx="12" cy="6" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="18" r="1.6"/></svg>; }
function PencilIcon()  { return <svg {...SVG} width={12} height={12}><path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 6l4 4"/></svg>; }
function CheckIcon()   { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" width={12} height={12}><path d="M5 12l5 5L20 7"/></svg>; }
