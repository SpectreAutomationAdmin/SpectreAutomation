// COA-UX-2 (2026-09-29) — Inspector-driven COA import review workspace.
//
// Replaces the DIM-2b permanently-visible bulk block with a two-pane
// workspace matching the Spectre Data Workspace convention (used on
// /app/admin/coa). Layout:
//
//   [ compact summary strip ]
//   [ compact filter ribbon ] [ contextual bulk toolbar (only when
//                                selection > 0) ]
//   [ compact account list (left)      ] [ Account Inspector (right) ]
//
// Row click = inspect one account (single-select inspector target).
// Checkbox  = include account in a bulk action.
// The two interactions are independent (COA-UX-2 §9).
//
// The old CoaMappingTable is preserved in the page (collapsed into
// an "Advanced grid" details block) so per-row edits keep working.
// Editing from the Inspector routes through the SAME server action
// so there is only one commit path (COA-UX-2 §15).

"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { applyBulkCoaEditAction, applyInspectorEditAction } from "./_bulk-coa-actions";

type DimensionPolicy = "REQUIRED" | "OPTIONAL" | "NOT_APPLICABLE";
type Confidence = "high" | "medium" | "low";

export type BulkReviewRow = {
  rowId: string;
  accountNumber: string;
  name: string;
  type: string;
  fsGroupKey: string;
  categoryKey: string;
  confidence: Confidence;
  departmentPolicy: DimensionPolicy;
  fundPolicy: DimensionPolicy;
  departmentApplicabilityCodes: string[];
  fundApplicabilityKeys: string[];
  reviewed: boolean;
  capitalCandidate: boolean;
};

export type BulkReviewDepartment = { code: string; name: string };
export type BulkReviewFund = { key: string; name: string };
export type BulkReviewCategoryOption = { key: string; name: string; accountType: string };
export type BulkReviewFsGroupOption = { key: string; name: string; statement: string };

export type BulkReviewSummary = {
  totalRows: number;
  confidence: { high: number; medium: number; low: number };
  departmentPolicy: Record<DimensionPolicy, number>;
  fundPolicy: Record<DimensionPolicy, number>;
  fundKeyOperating: number;
  fundKeyCapital: number;
  fundKeyBoth: number;
  fundKeyNone: number;
  fundPolicyRequiredWithoutApplicability: number;
  departmentPolicyRequiredWithoutApplicability: number;
  mediumConfidenceNotReviewed: number;
  capitalCandidates: number;
  rowsReviewed: number;
  rowsNotReviewed: number;
  rowsRequiringAttention: number;
};

export type BulkReviewControlsProps = {
  batchId: string;
  readOnly: boolean;
  rows: BulkReviewRow[];
  departments: BulkReviewDepartment[];
  funds: BulkReviewFund[];
  categories: BulkReviewCategoryOption[];
  fsGroups: BulkReviewFsGroupOption[];
  summary: BulkReviewSummary;
};

type FilterState = {
  confidence: Confidence | "";
  departmentPolicy: DimensionPolicy | "";
  fundPolicy: DimensionPolicy | "";
  departmentApplicability: "" | "NONE" | "SOME";
  fundApplicability: "" | "NONE" | "OPERATING" | "CAPITAL" | "OPERATING+CAPITAL";
  reviewState: "" | "REVIEWED" | "NOT_REVIEWED";
  capitalCandidate: "" | "YES" | "NO";
  search: string;
};

function parseFilters(sp: URLSearchParams): FilterState {
  return {
    confidence: (sp.get("f_conf") ?? "") as FilterState["confidence"],
    departmentPolicy: (sp.get("f_deptpol") ?? "") as FilterState["departmentPolicy"],
    fundPolicy: (sp.get("f_fundpol") ?? "") as FilterState["fundPolicy"],
    departmentApplicability: (sp.get("f_deptapp") ?? "") as FilterState["departmentApplicability"],
    fundApplicability: (sp.get("f_fundapp") ?? "") as FilterState["fundApplicability"],
    reviewState: (sp.get("f_review") ?? "") as FilterState["reviewState"],
    capitalCandidate: (sp.get("f_capital") ?? "") as FilterState["capitalCandidate"],
    search: sp.get("f_q") ?? "",
  };
}

function applyFilter(rows: BulkReviewRow[], f: FilterState): BulkReviewRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.confidence && r.confidence !== f.confidence) return false;
    if (f.departmentPolicy && r.departmentPolicy !== f.departmentPolicy) return false;
    if (f.fundPolicy && r.fundPolicy !== f.fundPolicy) return false;
    if (f.departmentApplicability === "NONE" && r.departmentApplicabilityCodes.length > 0) return false;
    if (f.departmentApplicability === "SOME" && r.departmentApplicabilityCodes.length === 0) return false;
    if (f.fundApplicability === "NONE" && r.fundApplicabilityKeys.length > 0) return false;
    if (f.fundApplicability === "OPERATING" && !(r.fundApplicabilityKeys.length === 1 && r.fundApplicabilityKeys[0] === "OPERATING")) return false;
    if (f.fundApplicability === "CAPITAL" && !(r.fundApplicabilityKeys.length === 1 && r.fundApplicabilityKeys[0] === "CAPITAL")) return false;
    if (f.fundApplicability === "OPERATING+CAPITAL") {
      const s = new Set(r.fundApplicabilityKeys);
      if (!(s.has("OPERATING") && s.has("CAPITAL"))) return false;
    }
    if (f.reviewState === "REVIEWED" && !r.reviewed) return false;
    if (f.reviewState === "NOT_REVIEWED" && r.reviewed) return false;
    if (f.capitalCandidate === "YES" && !r.capitalCandidate) return false;
    if (f.capitalCandidate === "NO" && r.capitalCandidate) return false;
    if (q.length > 0 && !r.accountNumber.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false;
    return true;
  });
}

const POLICY_OPTIONS: ReadonlyArray<{ value: DimensionPolicy; label: string }> = [
  { value: "REQUIRED", label: "REQUIRED" },
  { value: "OPTIONAL", label: "OPTIONAL" },
  { value: "NOT_APPLICABLE", label: "NOT APPLICABLE" },
];

/**
 * COA-UX-2a (2026-09-29) — pure range-selection helper for the
 * checkbox column. Extracted so the 12-case matrix (§12 of the
 * COA-UX-2a directive) can be unit-tested without a full React
 * render.
 *
 * Semantics:
 *   * `visibleRowIds` is the CURRENT DISPLAYED order (respects
 *     filters + search + sort).
 *   * `shiftKey=false` OR `anchorId=null` OR `anchorId === rowId` OR
 *     anchor no longer visible → normal single toggle of `rowId`
 *     (add when `checked=true`, delete when `checked=false`).
 *   * `shiftKey=true` with a visible anchor → inclusive range over
 *     the visible-index bounds (direction-safe via Math.min/max).
 *     Applies SELECT when `checked=true` OR DESELECT when
 *     `checked=false` to EVERY row in the range.
 *   * Rows NOT in `visibleRowIds` (hidden by filter) are never
 *     touched (§3 filtered-view behaviour).
 */
export function applyCheckboxToggle(
  prevSelected: ReadonlySet<string>,
  input: {
    rowId: string;
    checked: boolean;
    shiftKey: boolean;
    anchorId: string | null;
    visibleRowIds: ReadonlyArray<string>;
  },
): Set<string> {
  const { rowId, checked, shiftKey, anchorId, visibleRowIds } = input;
  const next = new Set(prevSelected);

  if (shiftKey && anchorId !== null && anchorId !== rowId) {
    const anchorIdx = visibleRowIds.indexOf(anchorId);
    const targetIdx = visibleRowIds.indexOf(rowId);
    // §10 — if the anchor is no longer visible (stale after a
    // filter change) OR the target isn't visible either, fall
    // through to a normal single toggle. Never compute a range
    // against a hidden/stale row.
    if (anchorIdx >= 0 && targetIdx >= 0) {
      const lo = Math.min(anchorIdx, targetIdx);
      const hi = Math.max(anchorIdx, targetIdx);
      for (let i = lo; i <= hi; i++) {
        const id = visibleRowIds[i];
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    }
  }

  // Normal single toggle.
  if (checked) next.add(rowId);
  else next.delete(rowId);
  return next;
}

export function BulkCoaReviewControls(props: BulkReviewControlsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filter = useMemo(() => parseFilters(searchParams), [searchParams]);
  const visibleRows = useMemo(() => applyFilter(props.rows, filter), [props.rows, filter]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // COA-UX-2a (2026-09-29) — anchor for Shift-click range selection.
  // Set on every normal checkbox click; reused when the next click
  // carries `event.shiftKey`. Direction-safe (min/max on visible
  // indices), operates on `visibleRows` (current display order after
  // filters), and falls back to a normal toggle if the anchor is
  // no longer visible (e.g. filter changed).
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(props.rows[0]?.rowId ?? null);
  const inspected = useMemo(
    () => props.rows.find((r) => r.rowId === inspectedId) ?? null,
    [props.rows, inspectedId],
  );
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [showBulkMenu, setShowBulkMenu] = useState<null | "DEPT" | "FUND" | "POLICY">(null);

  function setQueryParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "") params.delete(key);
    else params.set(key, value);
    router.push(`?${params.toString()}`, { scroll: false });
  }
  function clearFilters() {
    const params = new URLSearchParams(searchParams.toString());
    for (const k of ["f_conf", "f_deptpol", "f_fundpol", "f_deptapp", "f_fundapp", "f_review", "f_capital", "f_q"]) {
      params.delete(k);
    }
    router.push(`?${params.toString()}`, { scroll: false });
  }

  function toggleCheckbox(rowId: string, checked: boolean, shiftKey: boolean) {
    setSelected((prev) => applyCheckboxToggle(prev, {
      rowId, checked, shiftKey, anchorId,
      visibleRowIds: visibleRows.map((r) => r.rowId),
    }));
    // §4 — every checkbox interaction (whether a normal toggle or
    // a Shift-range) sets the clicked row as the new anchor.
    setAnchorId(rowId);
  }
  function selectAllVisible() { setSelected(new Set(visibleRows.map((r) => r.rowId))); }
  function clearSelection() { setSelected(new Set()); setShowBulkMenu(null); setAnchorId(null); }

  const selectedRowIds = useMemo(() => Array.from(selected), [selected]);
  const anySelected = selectedRowIds.length > 0;

  async function runBulk(action: Parameters<typeof applyBulkCoaEditAction>[2], describeAction: string) {
    if (!anySelected) return;
    const confirmed = window.confirm(
      `${describeAction}\n\nApplies to ${selectedRowIds.length} selected account${selectedRowIds.length === 1 ? "" : "s"}. Continue?`,
    );
    if (!confirmed) return;
    startTransition(async () => {
      const result = await applyBulkCoaEditAction(props.batchId, selectedRowIds, action);
      if (result.ok) {
        setMessage(`Applied to ${result.rowsAffected} row${result.rowsAffected === 1 ? "" : "s"}.`);
        setSelected(new Set());
        setShowBulkMenu(null);
      } else {
        setMessage("Bulk action failed: " + result.message);
      }
      router.refresh();
    });
  }

  async function runInspectorEdit(edits: Parameters<typeof applyInspectorEditAction>[2]) {
    if (!inspected) return;
    startTransition(async () => {
      const result = await applyInspectorEditAction(props.batchId, inspected.rowId, edits);
      if (!result.ok) setMessage("Inspector edit failed: " + result.message);
      else setMessage(null);
      router.refresh();
    });
  }

  // ── Summary strip (compact — single row) ────────────────────────────────
  const attention = props.summary.rowsRequiringAttention;

  return (
    <div className="mt-6 rounded-md border border-stone-200 bg-white">
      {/* SUMMARY STRIP */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-stone-200 px-4 py-2 text-[11.5px]">
        <span className="font-semibold uppercase tracking-wide text-stone-500">Batch</span>
        <span><span className="text-stone-500">rows</span> <b className="tabular-nums">{props.summary.totalRows}</b></span>
        <span><span className="text-stone-500">conf</span>{" "}
          <b className="tabular-nums">H {props.summary.confidence.high}</b>
          <span className="text-stone-400"> · </span>
          <b className="tabular-nums text-amber-700">M {props.summary.confidence.medium}</b>
          <span className="text-stone-400"> · </span>
          <b className="tabular-nums">L {props.summary.confidence.low}</b>
        </span>
        <span><span className="text-stone-500">dept</span>{" "}
          <b className="tabular-nums">R {props.summary.departmentPolicy.REQUIRED}</b>
          <span className="text-stone-400"> · </span>
          <b className="tabular-nums">O {props.summary.departmentPolicy.OPTIONAL}</b>
          <span className="text-stone-400"> · </span>
          <b className="tabular-nums">N/A {props.summary.departmentPolicy.NOT_APPLICABLE}</b>
        </span>
        <span><span className="text-stone-500">fund</span>{" "}
          <b className="tabular-nums">R {props.summary.fundPolicy.REQUIRED}</b>
          <span className="text-stone-400"> · </span>
          <b className="tabular-nums">O {props.summary.fundPolicy.OPTIONAL}</b>
          <span className="text-stone-400"> · </span>
          <b className="tabular-nums">N/A {props.summary.fundPolicy.NOT_APPLICABLE}</b>
        </span>
        <span><span className="text-stone-500">CAPITAL cand</span> <b className="tabular-nums">{props.summary.capitalCandidates}</b></span>
        <span><span className="text-stone-500">reviewed</span> <b className="tabular-nums">{props.summary.rowsReviewed}/{props.summary.totalRows}</b></span>
        <span className={attention > 0 ? "text-amber-700" : ""}><span className="text-stone-500">attention</span> <b className="tabular-nums">{attention}</b></span>
      </div>

      {/* FILTER RIBBON + CONTEXTUAL BULK TOOLBAR */}
      <div className="flex flex-wrap items-center gap-2 border-b border-stone-200 px-4 py-2 text-[11.5px]">
        <label className="flex items-center gap-1">
          <span className="text-stone-500">Search</span>
          <input className="rounded border border-stone-300 bg-white px-1.5 py-0.5 text-[11.5px] w-40"
                 value={filter.search} onChange={(e) => setQueryParam("f_q", e.target.value)}
                 placeholder="# or name" />
        </label>
        <Divider />
        <FilterSelect label="Conf" value={filter.confidence} onChange={(v) => setQueryParam("f_conf", v)}
          options={[["", "any"], ["high", "HIGH"], ["medium", "MEDIUM"], ["low", "LOW"]]} />
        <FilterSelect label="DeptPol" value={filter.departmentPolicy} onChange={(v) => setQueryParam("f_deptpol", v)}
          options={[["", "any"], ["REQUIRED", "REQ"], ["OPTIONAL", "OPT"], ["NOT_APPLICABLE", "N/A"]]} />
        <FilterSelect label="FundPol" value={filter.fundPolicy} onChange={(v) => setQueryParam("f_fundpol", v)}
          options={[["", "any"], ["REQUIRED", "REQ"], ["OPTIONAL", "OPT"], ["NOT_APPLICABLE", "N/A"]]} />
        <FilterSelect label="DeptApp" value={filter.departmentApplicability} onChange={(v) => setQueryParam("f_deptapp", v)}
          options={[["", "any"], ["NONE", "NONE"], ["SOME", "any dept"]]} />
        <FilterSelect label="FundApp" value={filter.fundApplicability} onChange={(v) => setQueryParam("f_fundapp", v)}
          options={[["", "any"], ["NONE", "NONE"], ["OPERATING", "OP"], ["CAPITAL", "CAP"], ["OPERATING+CAPITAL", "OP+CAP"]]} />
        <FilterSelect label="Review" value={filter.reviewState} onChange={(v) => setQueryParam("f_review", v)}
          options={[["", "any"], ["NOT_REVIEWED", "needs"], ["REVIEWED", "done"]]} />
        <FilterSelect label="CAP?" value={filter.capitalCandidate} onChange={(v) => setQueryParam("f_capital", v)}
          options={[["", "any"], ["YES", "YES"], ["NO", "NO"]]} />
        <button type="button" className="rounded border border-stone-300 bg-white px-1.5 py-0.5 hover:bg-stone-50" onClick={clearFilters}>
          Clear
        </button>
        <div className="flex-1" />

        {/* Contextual bulk toolbar — only when selection > 0 */}
        {anySelected && !props.readOnly && (
          <div className="flex items-center gap-1.5 rounded border border-amber-300 bg-amber-50 px-2 py-1">
            <span className="font-semibold text-amber-800">{selectedRowIds.length} selected</span>
            <BulkMenu label="Department" open={showBulkMenu === "DEPT"} onToggle={() => setShowBulkMenu(showBulkMenu === "DEPT" ? null : "DEPT")}>
              <BulkDeptMenu departments={props.departments}
                onApply={(codes, mode) => runBulk({ kind: "SET_DEPARTMENT_APPLICABILITY", mode, departmentCodes: codes },
                  `Set Department Applicability: ${codes.join(", ") || "(empty)"} (${mode})`)} />
            </BulkMenu>
            <BulkMenu label="Fund" open={showBulkMenu === "FUND"} onToggle={() => setShowBulkMenu(showBulkMenu === "FUND" ? null : "FUND")}>
              <BulkFundMenu funds={props.funds}
                onApply={(keys, mode) => runBulk({ kind: "SET_FUND_APPLICABILITY", mode, fundKeys: keys },
                  `Set Fund Applicability: ${keys.join(", ") || "(empty)"} (${mode})`)} />
            </BulkMenu>
            <BulkMenu label="Policy" open={showBulkMenu === "POLICY"} onToggle={() => setShowBulkMenu(showBulkMenu === "POLICY" ? null : "POLICY")}>
              <BulkPolicyMenu
                onDept={(v) => runBulk({ kind: "SET_DEPARTMENT_POLICY", value: v }, `Set Department Policy → ${v}`)}
                onFund={(v) => runBulk({ kind: "SET_FUND_POLICY", value: v }, `Set Fund Policy → ${v}`)} />
            </BulkMenu>
            <button type="button" className="rounded bg-stone-800 text-white px-2 py-0.5 disabled:opacity-40"
              disabled={isPending}
              onClick={() => runBulk({ kind: "MARK_REVIEWED" }, "Mark Reviewed")}>
              Mark Reviewed
            </button>
            <button type="button" className="rounded border border-stone-300 bg-white px-2 py-0.5 hover:bg-stone-50" onClick={clearSelection}>
              Clear
            </button>
          </div>
        )}
      </div>

      {message && (
        <div className="border-b border-stone-200 px-4 py-1 text-[11.5px] text-emerald-800 bg-emerald-50">
          {message}
        </div>
      )}

      {/* TWO-PANE BODY: LEFT list · RIGHT Inspector */}
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_360px]">
        {/* LEFT — compact account list */}
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full text-[11.5px]">
            <thead className="sticky top-0 bg-stone-50 text-stone-500">
              <tr>
                <th className="w-8 px-2 py-1 text-left">
                  <input type="checkbox" onChange={(e) => e.target.checked ? selectAllVisible() : clearSelection()}
                    checked={visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.rowId))} />
                </th>
                <th className="px-2 py-1 text-left w-20">#</th>
                <th className="px-2 py-1 text-left">Name</th>
                <th className="px-2 py-1 text-left w-16">Type</th>
                <th className="px-2 py-1 text-left w-40">FS Group</th>
                <th className="w-8 px-2 py-1 text-center" title="Status">•</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => (
                <tr key={r.rowId}
                    className={
                      "cursor-pointer border-t border-stone-100 " +
                      (inspectedId === r.rowId ? "bg-amber-100" : (selected.has(r.rowId) ? "bg-amber-50" : "hover:bg-stone-50"))
                    }
                    onClick={() => setInspectedId(r.rowId)}>
                  <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(r.rowId)}
                      title="Shift-click to select a range"
                      onClick={(e) => {
                        // COA-UX-2a — capture `shiftKey` on the click
                        // event (which fires for mouse AND for
                        // keyboard spacebar), toggle manually, and
                        // preventDefault so React's controlled state
                        // stays in sync with our own selection Set.
                        e.preventDefault();
                        const shift = (e as unknown as { shiftKey?: boolean }).shiftKey === true;
                        const nextChecked = !selected.has(r.rowId);
                        toggleCheckbox(r.rowId, nextChecked, shift);
                      }}
                      onChange={() => { /* controlled by onClick above */ }}
                    />
                  </td>
                  <td className="px-2 py-1 font-mono tabular-nums">{r.accountNumber}</td>
                  <td className="px-2 py-1">{r.name}</td>
                  <td className="px-2 py-1">{r.type}</td>
                  <td className="px-2 py-1 text-stone-600">{r.fsGroupKey}</td>
                  <td className="px-2 py-1 text-center" title={statusDotTitle(r)}>
                    <StatusDot row={r} />
                  </td>
                </tr>
              ))}
              {visibleRows.length === 0 && (
                <tr><td className="px-2 py-4 text-center text-stone-400" colSpan={6}>No rows match the current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* RIGHT — Account Inspector */}
        <aside className="border-l border-stone-200 bg-stone-50 max-h-[560px] overflow-auto">
          {!inspected ? (
            <div className="p-6 text-[12px] text-stone-500">
              <div className="text-[10px] font-bold uppercase tracking-widest text-stone-400 mb-2">Inspector</div>
              <p>Click a row to inspect an account.</p>
            </div>
          ) : (
            <div className="p-4 text-[12px] text-stone-700">
              <div className="text-[10px] font-bold uppercase tracking-widest text-stone-400 mb-1">Account</div>
              <div className="flex items-baseline gap-2 mb-3">
                <span className="font-mono text-[14px] font-bold tabular-nums text-club-ink">{inspected.accountNumber}</span>
                <span className="text-[13px] font-semibold text-club-ink">{inspected.name}</span>
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[10px]">
                <span className={"rounded-full border px-1.5 py-0.5 " + (inspected.confidence === "high" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : inspected.confidence === "medium" ? "border-amber-300 bg-amber-50 text-amber-800" : "border-red-300 bg-red-50 text-red-800")}>
                  {inspected.confidence.toUpperCase()}
                </span>
                {inspected.capitalCandidate && <span className="rounded-full border border-stone-300 bg-stone-50 px-1.5 py-0.5">CAPITAL candidate</span>}
                {inspected.reviewed
                  ? <span className="rounded-full border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-emerald-800">Reviewed</span>
                  : <span className="rounded-full border border-stone-300 bg-white px-1.5 py-0.5">Needs review</span>}
              </div>

              <Section title="Classification">
                <InspectorSelect label="Type" value={inspected.type} disabled={props.readOnly}
                  options={["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"].map((t) => [t, t])}
                  onChange={(v) => runInspectorEdit({ type: v })} />
                <InspectorSelect label="Category" value={inspected.categoryKey} disabled={props.readOnly}
                  options={[["", "— select —"], ...props.categories.filter((c) => c.accountType === inspected.type).map((c): [string, string] => [c.key, c.name])]}
                  onChange={(v) => runInspectorEdit({ categoryKey: v || null })} />
                <InspectorSelect label="FS Group" value={inspected.fsGroupKey} disabled={props.readOnly}
                  options={[["", "— select —"], ...props.fsGroups.map((g): [string, string] => [g.key, g.name])]}
                  onChange={(v) => runInspectorEdit({ fsGroupKey: v || null })} />
              </Section>

              <Section title="Department">
                <InspectorSelect label="Policy" value={inspected.departmentPolicy} disabled={props.readOnly}
                  helpText="Whether transactions on this account MUST identify a Department"
                  options={POLICY_OPTIONS.map((o): [string, string] => [o.value, o.label])}
                  onChange={(v) => runInspectorEdit({ departmentPolicy: v as DimensionPolicy })} />
                <InspectorMultiCheck label="Applicability" disabled={props.readOnly}
                  helpText="Which Departments MAY use this account"
                  values={inspected.departmentApplicabilityCodes}
                  options={props.departments.map((d) => ({ value: d.code, label: d.code }))}
                  onChange={(next) => runInspectorEdit({ departmentCodes: next })} />
              </Section>

              <Section title="Fund">
                <InspectorSelect label="Policy" value={inspected.fundPolicy} disabled={props.readOnly}
                  helpText="Whether transactions on this account MUST identify a Fund"
                  options={POLICY_OPTIONS.map((o): [string, string] => [o.value, o.label])}
                  onChange={(v) => runInspectorEdit({ fundPolicy: v as DimensionPolicy })} />
                <InspectorMultiCheck label="Applicability" disabled={props.readOnly}
                  helpText="Which Funds MAY use this account"
                  values={inspected.fundApplicabilityKeys}
                  options={props.funds.map((f) => ({ value: f.key, label: f.key }))}
                  onChange={(next) => runInspectorEdit({ fundApplicabilityKeys: next })} />
              </Section>

              <Section title="Review">
                <div className="mt-2 flex gap-2">
                  {!props.readOnly && (
                    <button type="button" className="rounded bg-stone-800 text-white px-2 py-1 text-[11.5px] disabled:opacity-40"
                      disabled={isPending || inspected.reviewed}
                      onClick={() => runInspectorEdit({ reviewed: true })}>
                      Mark Reviewed
                    </button>
                  )}
                  {!props.readOnly && inspected.reviewed && (
                    <button type="button" className="rounded border border-stone-300 bg-white px-2 py-1 text-[11.5px] hover:bg-stone-50"
                      disabled={isPending}
                      onClick={() => runInspectorEdit({ reviewed: false })}>
                      Unmark
                    </button>
                  )}
                </div>
              </Section>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// ─── Small display + input helpers ─────────────────────────────────────────

function Divider() { return <span className="mx-1 text-stone-300">|</span>; }

function FilterSelect(props: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1">
      <span className="text-stone-500">{props.label}</span>
      <select className="rounded border border-stone-300 bg-white px-1.5 py-0.5 text-[11.5px]"
              value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map(([v, lbl]) => <option key={v} value={v}>{lbl}</option>)}
      </select>
    </label>
  );
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-stone-200 pt-3">
      <div className="text-[10px] font-bold uppercase tracking-widest text-stone-500 mb-2">{props.title}</div>
      {props.children}
    </div>
  );
}

function InspectorSelect(props: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (v: string) => void;
  disabled?: boolean;
  helpText?: string;
}) {
  return (
    <div className="mb-2">
      <div className="text-[10.5px] font-bold uppercase tracking-wider text-stone-500 mb-0.5">{props.label}</div>
      {props.helpText && <div className="mb-1 text-[10.5px] text-stone-500">{props.helpText}</div>}
      <select className="w-full rounded border border-stone-300 bg-white px-2 py-1 text-[12px] disabled:bg-stone-100 disabled:text-stone-500"
              disabled={props.disabled} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map(([v, lbl]) => <option key={v} value={v}>{lbl}</option>)}
      </select>
    </div>
  );
}

function InspectorMultiCheck(props: {
  label: string;
  values: string[];
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (next: string[]) => void;
  disabled?: boolean;
  helpText?: string;
}) {
  const set = new Set(props.values);
  return (
    <div className="mb-2">
      <div className="text-[10.5px] font-bold uppercase tracking-wider text-stone-500 mb-0.5">{props.label}</div>
      {props.helpText && <div className="mb-1 text-[10.5px] text-stone-500">{props.helpText}</div>}
      <div className="flex flex-wrap gap-1">
        {props.options.map((o) => (
          <label key={o.value} className={"inline-flex items-center gap-1 rounded border px-1.5 py-0.5 " + (set.has(o.value) ? "border-club-ink bg-club-ink text-white" : "border-stone-300 bg-white text-stone-700")}>
            <input type="checkbox" className="hidden" checked={set.has(o.value)} disabled={props.disabled}
              onChange={() => {
                const next = new Set(set);
                if (next.has(o.value)) next.delete(o.value);
                else next.add(o.value);
                props.onChange(Array.from(next));
              }} />
            {o.label}
          </label>
        ))}
      </div>
    </div>
  );
}

function StatusDot({ row }: { row: BulkReviewRow }) {
  const attention =
    row.confidence !== "high" && !row.reviewed
      ? "medium-needs-review"
      : row.departmentPolicy === "REQUIRED" && row.departmentApplicabilityCodes.length === 0
      ? "dept-req-no-app"
      : row.fundPolicy === "REQUIRED" && row.fundApplicabilityKeys.length === 0
      ? "fund-req-no-app"
      : row.capitalCandidate && !row.reviewed
      ? "capital-candidate"
      : "";
  if (row.reviewed) return <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />;
  if (attention) return <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />;
  return <span className="inline-block w-2 h-2 rounded-full bg-stone-300" />;
}
function statusDotTitle(r: BulkReviewRow): string {
  if (r.reviewed) return "Reviewed";
  const bits: string[] = [];
  if (r.confidence !== "high") bits.push(r.confidence + " confidence · needs review");
  if (r.departmentPolicy === "REQUIRED" && r.departmentApplicabilityCodes.length === 0) bits.push("dept REQUIRED · no applicability");
  if (r.fundPolicy === "REQUIRED" && r.fundApplicabilityKeys.length === 0) bits.push("fund REQUIRED · no applicability");
  if (r.capitalCandidate) bits.push("CAPITAL candidate");
  return bits.length ? bits.join("; ") : "OK";
}

// ─── Contextual bulk-menu components ────────────────────────────────────

function BulkMenu({ label, open, onToggle, children }: { label: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="relative">
      <button type="button" className="rounded border border-amber-300 bg-white px-2 py-0.5 hover:bg-amber-100" onClick={onToggle}>
        {label} ▾
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 w-72 rounded border border-stone-300 bg-white shadow-lg p-2 text-[11.5px] text-stone-700">
          {children}
        </div>
      )}
    </div>
  );
}

function BulkDeptMenu(props: { departments: BulkReviewDepartment[]; onApply: (codes: string[], mode: "REPLACE" | "ADD") => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"REPLACE" | "ADD">("REPLACE");
  return (
    <>
      <div className="text-[10px] font-bold uppercase tracking-widest text-stone-500 mb-1">Departments</div>
      <div className="flex flex-wrap gap-1 mb-2">
        {props.departments.map((d) => (
          <label key={d.code} className={"inline-flex items-center gap-1 rounded border px-1.5 py-0.5 cursor-pointer " + (picked.has(d.code) ? "border-club-ink bg-club-ink text-white" : "border-stone-300 bg-white")}>
            <input type="checkbox" className="hidden" checked={picked.has(d.code)}
              onChange={() => setPicked((prev) => { const next = new Set(prev); if (next.has(d.code)) next.delete(d.code); else next.add(d.code); return next; })} />
            {d.code}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 mb-2 text-[10.5px]">
        <button type="button" className="rounded border border-stone-300 bg-white px-1.5 py-0.5" onClick={() => setPicked(new Set(props.departments.map((d) => d.code)))}>All Active</button>
        <button type="button" className="rounded border border-stone-300 bg-white px-1.5 py-0.5" onClick={() => setPicked(new Set())}>None</button>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <label className="inline-flex items-center gap-1"><input type="radio" name="dm" checked={mode === "REPLACE"} onChange={() => setMode("REPLACE")}/> REPLACE</label>
        <label className="inline-flex items-center gap-1"><input type="radio" name="dm" checked={mode === "ADD"} onChange={() => setMode("ADD")}/> ADD</label>
      </div>
      <button type="button" className="w-full rounded bg-club-forest text-white px-2 py-1" onClick={() => props.onApply(Array.from(picked), mode)}>Apply</button>
    </>
  );
}

function BulkFundMenu(props: { funds: BulkReviewFund[]; onApply: (keys: string[], mode: "REPLACE" | "ADD") => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"REPLACE" | "ADD">("REPLACE");
  return (
    <>
      <div className="text-[10px] font-bold uppercase tracking-widest text-stone-500 mb-1">Funds</div>
      <div className="flex flex-wrap gap-1 mb-2">
        {props.funds.map((f) => (
          <label key={f.key} className={"inline-flex items-center gap-1 rounded border px-1.5 py-0.5 cursor-pointer " + (picked.has(f.key) ? "border-club-ink bg-club-ink text-white" : "border-stone-300 bg-white")}>
            <input type="checkbox" className="hidden" checked={picked.has(f.key)}
              onChange={() => setPicked((prev) => { const next = new Set(prev); if (next.has(f.key)) next.delete(f.key); else next.add(f.key); return next; })} />
            {f.key}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 mb-2 text-[10.5px]">
        <button type="button" className="rounded border border-stone-300 bg-white px-1.5 py-0.5" onClick={() => setPicked(new Set(props.funds.map((f) => f.key)))}>All Active</button>
        <button type="button" className="rounded border border-stone-300 bg-white px-1.5 py-0.5" onClick={() => setPicked(new Set())}>None</button>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <label className="inline-flex items-center gap-1"><input type="radio" name="fm" checked={mode === "REPLACE"} onChange={() => setMode("REPLACE")}/> REPLACE</label>
        <label className="inline-flex items-center gap-1"><input type="radio" name="fm" checked={mode === "ADD"} onChange={() => setMode("ADD")}/> ADD</label>
      </div>
      <button type="button" className="w-full rounded bg-club-forest text-white px-2 py-1" onClick={() => props.onApply(Array.from(picked), mode)}>Apply</button>
    </>
  );
}

function BulkPolicyMenu(props: { onDept: (v: DimensionPolicy) => void; onFund: (v: DimensionPolicy) => void }) {
  const [deptVal, setDeptVal] = useState<DimensionPolicy>("REQUIRED");
  const [fundVal, setFundVal] = useState<DimensionPolicy>("REQUIRED");
  return (
    <>
      <div className="text-[10px] font-bold uppercase tracking-widest text-stone-500 mb-1">Department Policy</div>
      <div className="flex items-center gap-2 mb-2">
        <select className="rounded border border-stone-300 px-1.5 py-0.5" value={deptVal} onChange={(e) => setDeptVal(e.target.value as DimensionPolicy)}>
          {POLICY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button type="button" className="rounded bg-club-forest text-white px-2 py-0.5" onClick={() => props.onDept(deptVal)}>Apply</button>
      </div>
      <div className="text-[10px] font-bold uppercase tracking-widest text-stone-500 mb-1">Fund Policy</div>
      <div className="flex items-center gap-2">
        <select className="rounded border border-stone-300 px-1.5 py-0.5" value={fundVal} onChange={(e) => setFundVal(e.target.value as DimensionPolicy)}>
          {POLICY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button type="button" className="rounded bg-club-forest text-white px-2 py-0.5" onClick={() => props.onFund(fundVal)}>Apply</button>
      </div>
    </>
  );
}
