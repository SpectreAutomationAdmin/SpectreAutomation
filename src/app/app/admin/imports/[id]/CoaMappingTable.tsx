"use client";

// Chart-of-Accounts mapping table.
//
// Renders one row per ImportRow with operator-editable dropdowns for:
//   • Type           (asset/liability/equity/revenue/expense)
//   • Category Key   (filtered to categories whose type matches the
//                    selected Type)
//   • FS Group Key   (per-club FinancialStatementGroup list, grouped
//                    by statement)
//   • Departments    (multi-select via checkbox popover; supports
//                    zero, one, or many)
//
// A bulk-action bar lets the operator apply the same Type / Category /
// FS Group / Departments value across every selected row in one click.
// This is the difference between "I can map 200 accounts" and "I have
// to map each one by hand."
//
// State lives entirely in the client until the user clicks
// "Save mapping." Then the rows are sent to the saveCoaMappingAction
// server action which persists them onto each ImportRow.rawJson. The
// page revalidates and the operator can run Validate / Commit as
// normal.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import type {
  CoaMappingOptions,
  AccountTypeKey,
} from "@/lib/imports/coa-mapping";
import { SearchablePicker, type PickerOptionGroup } from "@/components/SearchablePicker";
import { InfoTip } from "@/components/InfoTip";

import { saveCoaMappingAction, type CoaRowMappingInput } from "./_coa-actions";

export type InitialCoaRow = {
  rowId: string;
  rowNumber: number;
  number: string;
  name: string;
  type: AccountTypeKey | null;
  categoryKey: string | null;
  fsGroupKey: string | null;
  departmentCodes: string[];
  /** Server-side validation status set by the validateBatch run.
   *  PENDING before any validation; VALID / INVALID afterward.
   *  INVALID rows are the ones the founder's 2026-07-06 spec
   *  wants surfaced as Error + auto-scrolled-to. */
  serverStatus?: string;
  /** Top-level error message stored on ImportRow.errorMessage —
   *  semicolon-joined when multiple per-row errors exist. Shown
   *  inline beside the Status pill. */
  errorMessage?: string | null;
  /** Per-error breakdown surfaced by the validator. Each entry is
   *  one of the founder's "Invalid FS Group" / "Missing Type" /
   *  "Invalid Department: GOLF" style messages, optionally
   *  tagged with the column that produced it. */
  errorCodes?: ReadonlyArray<{
    code: string;
    columnName: string | null;
    message: string;
  }>;
  /** Auto-mapping engine confidence (founder rule 2026-06-29).
   *  High → no indicator; Medium → amber dot; Low → subtle row
   *  tint + dot. Null when prediction hasn't run. */
  predictionConfidence?: "high" | "medium" | "low" | null;
  /** Which prediction signal produced the mapping — for
   *  diagnostics/tooltips. */
  predictionSource?: string | null;
};

type Props = {
  batchId: string;
  /** True once the batch is COMMITTED — the table is read-only. */
  readOnly: boolean;
  initialRows: InitialCoaRow[];
  options: CoaMappingOptions;
};

type EditableRow = InitialCoaRow & {
  selected: boolean;
  /** True the moment any field on the row is edited locally.
   *  While dirty, the row's server-side error styling is
   *  suppressed (the operator's edit is provisional — the actual
   *  error doesn't clear server-side until Save Mapping + Validate
   *  runs again). The Save Mapping reset clears this flag. */
  dirtySinceValidation: boolean;
};

export function CoaMappingTable({ batchId, readOnly, initialRows, options }: Props) {
  const [rows, setRows] = useState<EditableRow[]>(() =>
    initialRows.map((r) => ({ ...r, selected: false, dirtySinceValidation: false })),
  );

  // Reconcile the server-driven fields (serverStatus, errorMessage,
  // errorCodes) back into local state whenever `initialRows`
  // changes. This is the founder's 2026-07-11 fix: clicking
  // Dry-run / Validate triggers a server-action + revalidatePath,
  // which delivers fresh `initialRows` to this client component
  // — but the original `useState` initializer above runs ONCE on
  // mount, so without this effect the new INVALID statuses never
  // reach the client and the auto-scroll-to-first-error never
  // fires (the user had to hard-refresh to see the scroll).
  //
  // We merge by `rowId` and only overwrite the server-state
  // fields — the operator's in-flight mapping edits + their
  // local dirty / selected flags are preserved.
  const serverStateFingerprint = useMemo(
    () =>
      initialRows
        .map(
          (r) =>
            `${r.rowId}:${r.serverStatus ?? ""}:${r.errorMessage ?? ""}:${(r.errorCodes ?? []).length}`,
        )
        .join("|"),
    [initialRows],
  );
  useEffect(() => {
    setRows((prev) => {
      const byId = new Map(initialRows.map((i) => [i.rowId, i]));
      return prev.map((r) => {
        const fresh = byId.get(r.rowId);
        if (!fresh) return r;
        return {
          ...r,
          serverStatus: fresh.serverStatus,
          errorMessage: fresh.errorMessage,
          errorCodes: fresh.errorCodes,
        };
      });
    });
    // The fingerprint is a function of `initialRows`, so depending
    // on it (rather than on the array reference) prevents this
    // effect from re-firing when the parent re-renders with the
    // same content but a fresh array allocation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverStateFingerprint]);

  const [isPending, startTransition] = useTransition();
  const [saveStatus, setSaveStatus] = useState<
    { kind: "idle" } | { kind: "ok"; count: number } | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Bulk-action bar state.
  const [bulkType, setBulkType] = useState<AccountTypeKey | "">("");
  const [bulkCategory, setBulkCategory] = useState<string>("");
  const [bulkFsGroup, setBulkFsGroup] = useState<string>("");
  const [bulkDepartments, setBulkDepartments] = useState<string[]>([]);

  const selectedCount = rows.filter((r) => r.selected).length;
  const allSelected = rows.length > 0 && selectedCount === rows.length;

  function patchRow(rowId: string, patch: Partial<EditableRow>) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.rowId !== rowId) return r;
        // Editing any field other than `selected` marks the row
        // dirty so the visual error styling clears immediately
        // — the operator gets feedback their edit landed even
        // before the next Save Mapping + Validate cycle runs.
        const editsValue = Object.keys(patch).some((k) => k !== "selected");
        return {
          ...r,
          ...patch,
          dirtySinceValidation: editsValue ? true : r.dirtySinceValidation,
        };
      }),
    );
  }

  function toggleAll() {
    const next = !allSelected;
    setRows((prev) => prev.map((r) => ({ ...r, selected: next })));
  }

  // ── Bulk Apply All — founder spec 2026-07-03 ──────────────────
  //
  // Single button replaces the prior 4 per-field Apply buttons.
  // Behaviour:
  //   • Blank bulk fields are ignored — they do NOT overwrite the
  //     row's existing value.
  //   • Bulk Departments is treated as "populated" only when the
  //     operator picked at least one department. Empty multi-select
  //     means "don't touch row departments" (use the per-row
  //     dropdown to clear).
  //   • Validation surfaces inline in the bulk bar:
  //       - "Select at least one row above" when nothing is selected.
  //       - "Choose at least one field to apply" when every bulk
  //         field is blank.
  //   • Successful apply clears the bulk-bar validation message but
  //     leaves the bulk-bar values populated so the operator can
  //     re-apply to a different selection.
  const [bulkValidation, setBulkValidation] = useState<string | null>(null);

  function applyAll() {
    if (selectedCount === 0) {
      setBulkValidation("Select at least one row above.");
      return;
    }
    const hasType = bulkType !== "";
    const hasCategory = bulkCategory !== "";
    const hasFsGroup = bulkFsGroup !== "";
    const hasDepartments = bulkDepartments.length > 0;
    if (!hasType && !hasCategory && !hasFsGroup && !hasDepartments) {
      setBulkValidation("Choose at least one field to apply.");
      return;
    }
    setBulkValidation(null);
    const bulkCategoryDef = hasCategory
      ? options.categories.find((c) => c.key === bulkCategory)
      : null;
    setRows((prev) =>
      prev.map((r) => {
        if (!r.selected) return r;
        let next: EditableRow = { ...r };
        if (hasType) {
          next.type = bulkType as AccountTypeKey;
          // Clear an existing category whose type no longer matches
          // so the operator notices the rebinding.
          const cat = options.categories.find((c) => c.key === next.categoryKey);
          if (cat && cat.accountType !== next.type) next.categoryKey = null;
        }
        if (hasCategory && bulkCategoryDef) {
          // Category implies type — adopt it to keep the row valid.
          if (!next.type) next.type = bulkCategoryDef.accountType;
          if (next.type === bulkCategoryDef.accountType) {
            next.categoryKey = bulkCategoryDef.key;
          }
        }
        if (hasFsGroup) {
          next.fsGroupKey = bulkFsGroup;
        }
        if (hasDepartments) {
          next.departmentCodes = [...bulkDepartments];
        }
        return next;
      }),
    );
  }


  function handleSave() {
    if (readOnly || isPending) return;
    setSaveStatus({ kind: "idle" });
    const payload: CoaRowMappingInput[] = rows.map((r) => ({
      rowId: r.rowId,
      type: r.type,
      categoryKey: r.categoryKey,
      fsGroupKey: r.fsGroupKey,
      departmentCodes: r.departmentCodes,
    }));
    startTransition(async () => {
      const result = await saveCoaMappingAction(batchId, payload);
      if (result.ok) {
        setSaveStatus({ kind: "ok", count: result.rowsUpdated });
        // Clear selection + dirty flags. The server-side error
        // state on each row stays as-is until the next Validate
        // run; the dirty flag was a transient UI shield while the
        // operator was editing.
        setRows((prev) =>
          prev.map((r) => ({ ...r, selected: false, dirtySinceValidation: false })),
        );
      } else {
        setSaveStatus({ kind: "error", message: result.message });
      }
    });
  }

  // Picker option shapes — derived from the per-club options bundle
  // and reused by both the bulk-bar and the per-row controls.
  const typePickerOptions = useMemo(
    () => options.types.map((t) => ({ value: t, label: t })),
    [options.types],
  );
  const categoryPickerOptions = useMemo(
    () =>
      options.categories.map((c) => ({
        value: c.key,
        label: c.name,
        key: c.key,
        subtitle: c.accountType,
      })),
    [options.categories],
  );
  const fsGroupPickerGroups = useMemo<PickerOptionGroup[]>(() => {
    const map = new Map<string, PickerOptionGroup>();
    for (const g of options.fsGroups) {
      const existing = map.get(g.statement);
      const opt = { value: g.key, label: g.name, key: g.key };
      if (existing) existing.options.push(opt);
      else map.set(g.statement, { label: g.statement, options: [opt] });
    }
    return Array.from(map.values());
  }, [options.fsGroups]);
  const departmentPickerOptions = useMemo(
    () =>
      options.departments.map((d) => ({
        value: d.code,
        label: d.name,
        key: d.code,
      })),
    [options.departments],
  );

  // Category options scoped to a given row's selected type. The
  // per-row Category picker uses this so a row whose Type is
  // EXPENSE only sees expense-typed categories.
  const categoryOptionsForType = (typeKey: AccountTypeKey | null) =>
    typeKey
      ? categoryPickerOptions.filter((o) =>
          options.categories.some((c) => c.key === o.value && c.accountType === typeKey),
        )
      : categoryPickerOptions;

  const readinessByRow = rows.map((r) => mapReadiness(r));
  const fullyMappedCount = readinessByRow.filter((s) => s === "ready").length;
  // Indices of rows the server flagged INVALID and the operator
  // hasn't started editing yet. Drives the Next-error jump cycle +
  // the auto-scroll-on-mount + the red row styling.
  const errorRowIndices = useMemo(() => {
    const out: number[] = [];
    rows.forEach((r, i) => {
      if (readinessByRow[i] === "error") out.push(i);
    });
    return out;
  }, [rows, readinessByRow]);
  const errorRowCount = errorRowIndices.length;

  // Sticky-header offset measurement.
  //
  // The title + bulk-bar block pins to viewport top via `sticky top-0`.
  // The table's <thead> pins immediately below it. Because the block
  // height varies with viewport width (the bulk grid wraps at narrower
  // sizes), we measure it at runtime via ResizeObserver and feed the
  // value as inline `top` on the <thead>. Without this the header row
  // floats over the title block (too high) or leaves a visible gap
  // (too low) at certain breakpoints.
  const stickyHeaderRef = useRef<HTMLDivElement | null>(null);
  const [stickyHeaderHeight, setStickyHeaderHeight] = useState(0);

  // Per-row DOM ref + cursor for the Next-error jump. The cursor
  // points at the index INTO `errorRowIndices` that the operator
  // last jumped to; clicking Next-error advances it modulo the
  // current error count. Re-validating may reorder errors, so the
  // cursor resets to 0 whenever the error list changes.
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const [nextErrorCursor, setNextErrorCursor] = useState(0);
  const [flashRowId, setFlashRowId] = useState<string | null>(null);
  // Re-anchor the cursor when the validation set changes (e.g.
  // operator fixed one row + ran Validate again — the surviving
  // errors shifted).
  useEffect(() => {
    setNextErrorCursor(0);
  }, [errorRowCount]);

  // Scroll an error row into view, offset by the sticky-header
  // height so the row clears the chrome instead of hiding beneath
  // it. Briefly flash the row red so the operator's eye lands on it.
  //
  // Defer the actual DOM read + scroll to the next animation frame
  // so any re-render triggered by the same React commit that fed
  // us new server-state (e.g. the Validate-completed
  // `serverStateFingerprint` change → setRows → re-render →
  // errorRowIndices recomputed → this effect fires) has finished
  // mounting the row's <tr>. Without the rAF gate, the row ref
  // can be stale on the first pass and `rowRefs.current.get(rowId)`
  // returns undefined, which is the founder's "Validate finishes
  // but no scroll happens until I hard refresh" bug.
  function scrollToErrorRow(rowId: string) {
    const doScroll = () => {
      const node = rowRefs.current.get(rowId);
      if (!node) {
        // Row hasn't mounted yet (very rare with our render path,
        // but defensive). Try one more frame, then give up to
        // avoid an infinite loop.
        window.requestAnimationFrame(() => {
          const retryNode = rowRefs.current.get(rowId);
          if (!retryNode) return;
          scrollTo(retryNode);
        });
        return;
      }
      scrollTo(node);
    };
    const scrollTo = (node: HTMLTableRowElement) => {
      const rect = node.getBoundingClientRect();
      const targetTop = window.scrollY + rect.top - stickyHeaderHeight - 12;
      window.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
      setFlashRowId(rowId);
      window.setTimeout(() => {
        setFlashRowId((current) => (current === rowId ? null : current));
      }, 1600);
    };
    window.requestAnimationFrame(doScroll);
  }

  // Auto-scroll to the first error row WHENEVER the validation
  // set changes from "no errors" to "has errors" (or a fresh
  // validate run produces a different error set). Runs after the
  // sticky-header height is measured so the offset math is right.
  //
  // The dep list includes `serverStateFingerprint` so we re-fire
  // on every distinct server-validation outcome — even when the
  // de-dup key happens to be identical to a previous round (e.g.
  // operator fixed-and-broke the same row).
  const lastAutoScrollKey = useRef<string>("");
  useEffect(() => {
    if (errorRowIndices.length === 0) {
      // Clear the de-dup key so a *future* error set (even one
      // that happens to match a prior round byte-for-byte) will
      // still trigger a scroll.
      lastAutoScrollKey.current = "";
      return;
    }
    if (stickyHeaderHeight === 0) return;
    // De-dup: only auto-scroll once per distinct error set.
    const key = errorRowIndices.map((i) => rows[i]?.rowId).join("|");
    if (lastAutoScrollKey.current === key) return;
    lastAutoScrollKey.current = key;
    const firstErrorRowId = rows[errorRowIndices[0]]?.rowId;
    if (firstErrorRowId) scrollToErrorRow(firstErrorRowId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorRowIndices, stickyHeaderHeight, serverStateFingerprint]);

  function jumpToNextError() {
    if (errorRowIndices.length === 0) return;
    const targetIdx = errorRowIndices[nextErrorCursor % errorRowIndices.length];
    const rowId = rows[targetIdx]?.rowId;
    if (rowId) scrollToErrorRow(rowId);
    setNextErrorCursor((c) => c + 1);
  }

  // Founder rule 2026-07-16: the Errors card is a sibling
  // component on the page (not inside this tree), so error
  // navigation is wired via two window CustomEvents. The Errors
  // card dispatches; this table listens and runs the same
  // jumpToNextError / scrollToErrorRow path that previously sat
  // behind its own in-header button.
  useEffect(() => {
    function onNext() {
      jumpToNextError();
    }
    function onJumpToRow(e: Event) {
      const detail = (e as CustomEvent<{ rowNumber?: number }>).detail;
      if (!detail || typeof detail.rowNumber !== "number") return;
      const row = rows.find((r) => r.rowNumber === detail.rowNumber);
      if (row) scrollToErrorRow(row.rowId);
    }
    window.addEventListener("spectre:coa-next-error", onNext);
    window.addEventListener("spectre:coa-jump-to-row", onJumpToRow);
    return () => {
      window.removeEventListener("spectre:coa-next-error", onNext);
      window.removeEventListener("spectre:coa-jump-to-row", onJumpToRow);
    };
    // jumpToNextError / scrollToErrorRow close over the latest
    // rows + cursor via React's render cycle; depending on the
    // identity of `rows` keeps the listener bound to the current
    // closure each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, errorRowIndices, nextErrorCursor, stickyHeaderHeight]);

  useEffect(() => {
    const el = stickyHeaderRef.current;
    if (!el) return;
    const sync = () =>
      setStickyHeaderHeight(Math.ceil(el.getBoundingClientRect().height));
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Page-level sticky enablement ────────────────────────────────────
  //
  // The admin AdminShell's <main> sets `overflow-x: auto`, which the
  // CSS spec coerces into `overflow-y: auto` as well. That makes
  // <main> a *scroll container* — and `position: sticky` inside a
  // non-scrolling scroll container pins to the CONTAINER'S top edge
  // (which moves with the page), not the viewport top. The visible
  // effect is "sticky doesn't work."
  //
  // Fix: while this mapping table is mounted, lift <main>'s overflow
  // back to `visible` so sticky's nearest scroll-ancestor is the
  // document. Restore on unmount so other admin pages are unaffected.
  // The mapping card itself fits within the viewport's content
  // width at all supported admin viewports (1366+), so dropping
  // main's horizontal-scroll fallback here is safe.
  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    const prevX = main.style.overflowX;
    const prevY = main.style.overflowY;
    main.style.overflowX = "visible";
    main.style.overflowY = "visible";
    return () => {
      main.style.overflowX = prevX;
      main.style.overflowY = prevY;
    };
  }, []);

  return (
    <section
      className="mt-6 card overflow-visible"
      data-testid="coa-mapping-table"
      aria-label="Chart of Accounts mapping"
    >
      {/* Sticky group — title + counter + helper text + bulk bar +
          Save mapping. Pins to the top of the viewport when the
          card scrolls past it. The matching `<thead>` further down
          stacks immediately below this block (its top offset is the
          measured height of this block). */}
      <div
        ref={stickyHeaderRef}
        className="sticky top-0 z-30 bg-white shadow-[0_2px_4px_-2px_rgba(0,0,0,0.08)]"
        data-testid="coa-mapping-sticky-header"
      >
        <div className="px-6 py-4 border-b border-stone-200 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="section-title text-lg">Map each account</h2>
            <p className="mt-0.5 text-xs text-stone-600">
              Classify every account before validating. Type, Category, and FS
              Group are required. One account can belong to multiple departments
              (e.g. Repairs & Maintenance → Admin + Golf + Grounds + F&amp;B + Pro Shop).
            </p>
          </div>
          {/* Founder rule 2026-07-16: the sticky mapping header
              stays focused on MAPPING actions only. The error
              count + Next-error nav has moved into CoaErrorsCard
              (rendered above this table by the page). The
              mapping-progress counter remains because it's a
              MAPPING readiness signal, not an error signal. */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="text-stone-600" data-testid="coa-mapping-progress">
              {fullyMappedCount} / {rows.length} rows fully mapped
            </span>
          </div>
        </div>

      {/* Bulk-action bar -------------------------------------------------*/}
      <div
        className="px-6 py-3 bg-stone-50 border-b border-stone-200"
        data-testid="coa-bulk-bar"
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs uppercase tracking-wide text-stone-500">
            Bulk actions — applies to {selectedCount} selected row
            {selectedCount === 1 ? "" : "s"}
          </div>
          {/* Save Mapping — relocated from a far-away footer to live
              with the mapping controls. Status messages render on the
              left so the operator gets feedback right where they
              clicked. */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-xs" aria-live="polite">
              {saveStatus.kind === "ok" && (
                <span className="text-emerald-700" data-testid="coa-save-ok">
                  Saved {saveStatus.count} rows.
                </span>
              )}
              {saveStatus.kind === "error" && (
                <span className="text-red-700" data-testid="coa-save-error">
                  {saveStatus.message}
                </span>
              )}
              {saveStatus.kind === "idle" && readOnly && (
                <span className="text-stone-500">Batch is read-only.</span>
              )}
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              disabled={readOnly || isPending}
              data-testid="coa-save-mapping"
            >
              {isPending ? "Saving…" : "Save mapping"}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <div>
            <label className="block text-xs text-stone-500">Type</label>
            <div className="mt-1">
              <SearchablePicker
                options={typePickerOptions}
                value={bulkType === "" ? null : bulkType}
                onChange={(v) => setBulkType((v ?? "") as AccountTypeKey | "")}
                disabled={readOnly}
                testid="coa-bulk-type"
                placeholder="—"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-stone-500">Category</label>
            <div className="mt-1">
              <SearchablePicker
                options={categoryPickerOptions}
                value={bulkCategory === "" ? null : bulkCategory}
                onChange={(v) => setBulkCategory(v ?? "")}
                disabled={readOnly}
                testid="coa-bulk-category"
                placeholder="—"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-stone-500">FS Group</label>
            <div className="mt-1">
              <SearchablePicker
                optgroups={fsGroupPickerGroups}
                value={bulkFsGroup === "" ? null : bulkFsGroup}
                onChange={(v) => setBulkFsGroup(v ?? "")}
                disabled={readOnly}
                testid="coa-bulk-fsgroup"
                placeholder="—"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-stone-500">Departments</label>
            <div className="mt-1">
              <SearchablePicker
                multi
                options={departmentPickerOptions}
                value={bulkDepartments}
                onChange={setBulkDepartments}
                disabled={readOnly}
                testid="coa-bulk-dept"
                placeholder="—"
              />
            </div>
          </div>
        </div>

        {/* Apply All — single button that applies every populated
            bulk field (blank fields are left alone). Validation
            message renders inline on the left so the user gets
            feedback without scrolling. */}
        <div className="mt-3 flex items-center justify-between gap-3">
          <div
            className="text-xs"
            aria-live="polite"
            data-testid="coa-bulk-validation"
          >
            {bulkValidation && (
              <span className="text-red-700">{bulkValidation}</span>
            )}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={applyAll}
            disabled={readOnly}
            data-testid="coa-bulk-apply-all"
          >
            Apply All
          </button>
        </div>
      </div>

      </div>
      {/* end of sticky group */}

      {/* Mapping table ---------------------------------------------------*/}
      <div>
        <table className="table-base text-xs w-full">
          <thead
            className="bg-stone-100 shadow-[0_2px_4px_-2px_rgba(0,0,0,0.08)]"
            data-testid="coa-mapping-thead"
            style={{
              position: "sticky",
              // Stacks directly under the sticky header block.
              top: stickyHeaderHeight,
              zIndex: 20,
            }}
          >
            <tr>
              <th className="w-10">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={readOnly}
                  aria-label="Select all rows"
                  data-testid="coa-select-all"
                />
              </th>
              <th className="w-10">#</th>
              <th>Account #</th>
              <th>Account Name</th>
              <th>
                <span className="inline-flex items-center">
                  Type
                  <InfoTip label="Type" testid="coa-info-type">
                    <div className="font-medium text-stone-800 mb-1">Available types</div>
                    <ul className="space-y-0.5 text-[11px]">
                      {options.types.map((t) => (
                        <li key={t} className="font-mono">{t}</li>
                      ))}
                    </ul>
                  </InfoTip>
                </span>
              </th>
              <th>
                <span className="inline-flex items-center">
                  Category
                  <InfoTip label="Category" testid="coa-info-category">
                    <div className="font-medium text-stone-800 mb-1">Available categories</div>
                    <ul className="space-y-0.5 text-[11px]">
                      {options.categories.map((c) => (
                        <li key={c.key} className="flex items-baseline gap-2">
                          <span className="font-mono text-stone-500 text-[10px] w-8 shrink-0">
                            {c.accountType.slice(0, 3)}
                          </span>
                          <span>{c.name}</span>
                        </li>
                      ))}
                    </ul>
                  </InfoTip>
                </span>
              </th>
              <th>
                <span className="inline-flex items-center">
                  FS Group
                  <InfoTip label="FS Group" testid="coa-info-fsgroup" maxWidthRem={22}>
                    <div className="font-medium text-stone-800 mb-1">Available FS groups</div>
                    {fsGroupPickerGroups.map((g) => (
                      <div key={g.label} className="mt-1">
                        <div className="text-[10px] uppercase tracking-wide text-stone-500 mb-0.5">
                          {g.label}
                        </div>
                        <ul className="space-y-0.5 text-[11px]">
                          {g.options.map((o) => (
                            <li key={o.value}>{o.label}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </InfoTip>
                </span>
              </th>
              <th>
                <span className="inline-flex items-center">
                  Departments
                  <InfoTip label="Departments" testid="coa-info-dept">
                    <div className="font-medium text-stone-800 mb-1">Available departments</div>
                    <ul className="space-y-0.5 text-[11px]">
                      {options.departments.map((d) => (
                        <li key={d.code} className="flex items-baseline gap-2">
                          <span className="font-mono text-stone-500 text-[10px] w-16 shrink-0">
                            {d.code}
                          </span>
                          <span>{d.name}</span>
                        </li>
                      ))}
                    </ul>
                  </InfoTip>
                </span>
              </th>
              <th className="text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center text-stone-500">
                  No rows in this batch.
                </td>
              </tr>
            )}
            {rows.map((row, i) => {
              const readiness = readinessByRow[i];
              const isError = readiness === "error";
              const isFlashing = flashRowId === row.rowId;
              // Founder rule 2026-06-29: auto-mapping confidence
              // surfaces as a subtle row tint + a per-row dot.
              // High confidence rows get NO indicator (operator
              // doesn't need to look at them). Medium gets the
              // amber dot; low gets the dot + a faint amber-tinted
              // background so it's reviewable at a glance.
              const conf = row.predictionConfidence;
              const showConfidenceHint =
                !isError && (conf === "medium" || conf === "low");
              // Layered row class:
              //   • Permanent: red left border + tint when the
              //     server flagged this row INVALID and the
              //     operator hasn't edited it yet.
              //   • Transient: a red flash background for ~1.6s
              //     after auto-scroll or Next-error jump.
              //   • Confidence tint: amber-50 for low-confidence
              //     predictions that need a closer look.
              //   • Default: subtle stone tint when the row is
              //     bulk-selected.
              const rowClass = [
                isError ? "bg-red-50/60 border-l-4 border-l-red-500" : "",
                isFlashing ? "animate-pulse-error" : "",
                !isError && conf === "low" ? "bg-amber-50/40" : "",
                !isError && row.selected ? "bg-stone-50" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <tr
                  key={row.rowId}
                  ref={(el) => {
                    if (el) rowRefs.current.set(row.rowId, el);
                    else rowRefs.current.delete(row.rowId);
                  }}
                  data-testid={`coa-row-${row.number}`}
                  data-row-status={isError ? "error" : readiness}
                  data-prediction-confidence={conf ?? undefined}
                  className={rowClass}
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={row.selected}
                      onChange={(e) =>
                        patchRow(row.rowId, { selected: e.target.checked })
                      }
                      disabled={readOnly}
                      aria-label={`Select row ${row.rowNumber}`}
                    />
                    {showConfidenceHint && (
                      <span
                        aria-hidden="true"
                        title={
                          conf === "low"
                            ? "Spectre's auto-mapping confidence was low — please review."
                            : "Spectre's auto-mapping confidence was medium — quick check recommended."
                        }
                        className={
                          "ml-1 inline-block h-1.5 w-1.5 rounded-full " +
                          (conf === "low" ? "bg-amber-500" : "bg-amber-300")
                        }
                        data-testid={`coa-row-${row.number}-confidence-${conf}`}
                      />
                    )}
                  </td>
                  <td className="text-stone-500">{row.rowNumber}</td>
                  <td className="font-mono">{row.number}</td>
                  <td>{row.name}</td>
                  <td>
                    <SearchablePicker
                      options={typePickerOptions}
                      value={row.type}
                      onChange={(v) => {
                        const nextType = (v ?? null) as AccountTypeKey | null;
                        const patch: Partial<EditableRow> = { type: nextType };
                        const cat = options.categories.find((c) => c.key === row.categoryKey);
                        if (cat && nextType && cat.accountType !== nextType) {
                          patch.categoryKey = null;
                        }
                        patchRow(row.rowId, patch);
                      }}
                      disabled={readOnly}
                      testid={`coa-row-${row.number}-type`}
                      placeholder="—"
                    />
                  </td>
                  <td>
                    <SearchablePicker
                      options={categoryOptionsForType(row.type)}
                      value={row.categoryKey}
                      onChange={(v) => patchRow(row.rowId, { categoryKey: v ?? null })}
                      disabled={readOnly}
                      testid={`coa-row-${row.number}-category`}
                      placeholder="—"
                    />
                  </td>
                  <td>
                    <SearchablePicker
                      optgroups={fsGroupPickerGroups}
                      value={row.fsGroupKey}
                      onChange={(v) => patchRow(row.rowId, { fsGroupKey: v ?? null })}
                      disabled={readOnly}
                      testid={`coa-row-${row.number}-fsgroup`}
                      placeholder="—"
                    />
                  </td>
                  <td>
                    <SearchablePicker
                      multi
                      options={departmentPickerOptions}
                      value={row.departmentCodes}
                      onChange={(next) =>
                        patchRow(row.rowId, { departmentCodes: [...next] })
                      }
                      disabled={readOnly}
                      testid={`coa-row-${row.number}-dept`}
                      placeholder="—"
                    />
                  </td>
                  <td className="text-right align-top">
                    {readiness === "error" ? (
                      <div className="flex flex-col items-end gap-0.5">
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700"
                          data-testid={`coa-row-${row.number}-status`}
                        >
                          <span
                            aria-hidden="true"
                            className="inline-block h-1.5 w-1.5 rounded-full bg-red-500"
                          />
                          Error
                        </span>
                        {(row.errorMessage || (row.errorCodes && row.errorCodes.length > 0)) && (
                          <span
                            className="max-w-[14rem] truncate text-[10px] text-red-700"
                            title={row.errorMessage ?? row.errorCodes?.map((e) => e.message).join("; ")}
                            data-testid={`coa-row-${row.number}-error-message`}
                          >
                            {row.errorMessage ?? row.errorCodes?.[0]?.message ?? ""}
                          </span>
                        )}
                      </div>
                    ) : readiness === "ready" ? (
                      <span
                        className="text-emerald-700"
                        data-testid={`coa-row-${row.number}-status`}
                      >
                        Ready
                      </span>
                    ) : (
                      <span
                        className="text-amber-700"
                        data-testid={`coa-row-${row.number}-status`}
                      >
                        Needs mapping
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

    </section>
  );
}

// Three-state row readiness used by the table:
//
//   • "error"      — the server's last Validate run flagged this
//                    row as INVALID AND the operator hasn't edited
//                    it since. The row gets a permanent red
//                    left-border + "Error" status pill + the
//                    inline error message; the Next-error jump
//                    cycles through these.
//   • "ready"      — every required field is filled AND the row
//                    isn't carrying a stale server error. Shows
//                    the green "Ready" pill.
//   • "incomplete" — required fields still missing. Amber "Needs
//                    mapping" copy as before.
//
// `dirtySinceValidation` is the local "operator just edited this"
// flag — once it flips true, the row visually exits the error
// state immediately even though the server's INVALID row record
// remains until the next Validate run.
function mapReadiness(r: EditableRow): "ready" | "incomplete" | "error" {
  if (r.serverStatus === "INVALID" && !r.dirtySinceValidation) return "error";
  if (!r.type || !r.categoryKey || !r.fsGroupKey) return "incomplete";
  return "ready";
}

