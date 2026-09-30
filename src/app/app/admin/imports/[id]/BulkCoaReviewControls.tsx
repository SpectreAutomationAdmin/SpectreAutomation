// DIM-2b (2026-09-29) — Bulk review controls surrounding the
// existing CoaMappingTable. Preserves the mapping table; adds a
// compact filter row + selection + bulk-action bar above.
//
// State model: query-params drive filters (?f_confidence=medium
// etc.), client state manages selection, form submissions invoke
// `applyBulkCoaEditAction`. No parallel commit path.

"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { applyBulkCoaEditAction } from "./_bulk-coa-actions";

type DimensionPolicy = "REQUIRED" | "OPTIONAL" | "NOT_APPLICABLE";
type Confidence = "high" | "medium" | "low";

export type BulkReviewRow = {
  rowId: string;
  accountNumber: string;
  name: string;
  type: string;
  fsGroupKey: string;
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

export type BulkReviewControlsProps = {
  batchId: string;
  readOnly: boolean;
  rows: BulkReviewRow[];
  departments: BulkReviewDepartment[];
  funds: BulkReviewFund[];
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

function parseFilterFromSearchParams(sp: URLSearchParams): FilterState {
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
      const set = new Set(r.fundApplicabilityKeys);
      if (!(set.has("OPERATING") && set.has("CAPITAL"))) return false;
    }
    if (f.reviewState === "REVIEWED" && !r.reviewed) return false;
    if (f.reviewState === "NOT_REVIEWED" && r.reviewed) return false;
    if (f.capitalCandidate === "YES" && !r.capitalCandidate) return false;
    if (f.capitalCandidate === "NO" && r.capitalCandidate) return false;
    if (q.length > 0 && !r.accountNumber.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function BulkCoaReviewControls(props: BulkReviewControlsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const filter = useMemo(
    () => parseFilterFromSearchParams(searchParams),
    [searchParams],
  );
  const visibleRows = useMemo(
    () => applyFilter(props.rows, filter),
    [props.rows, filter],
  );

  function setQueryParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "") params.delete(key);
    else params.set(key, value);
    router.push(`?${params.toString()}`, { scroll: false });
  }

  function clearAllFilters() {
    const params = new URLSearchParams(searchParams.toString());
    ["f_conf", "f_deptpol", "f_fundpol", "f_deptapp", "f_fundapp", "f_review", "f_capital", "f_q"].forEach((k) => params.delete(k));
    router.push(`?${params.toString()}`, { scroll: false });
  }

  function toggleRow(rowId: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(rowId);
      else next.delete(rowId);
      return next;
    });
  }
  function selectAllVisible() {
    setSelected(new Set(visibleRows.map((r) => r.rowId)));
  }
  function clearSelection() { setSelected(new Set()); }

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
      } else {
        setMessage("Bulk action failed: " + result.message);
      }
      router.refresh();
    });
  }

  // Bulk-action state (form-style pickers).
  const [applyDeptCodes, setApplyDeptCodes] = useState<Set<string>>(new Set());
  const [applyDeptMode, setApplyDeptMode] = useState<"REPLACE" | "ADD">("REPLACE");
  const [applyFundKeys, setApplyFundKeys] = useState<Set<string>>(new Set());
  const [applyFundMode, setApplyFundMode] = useState<"REPLACE" | "ADD">("REPLACE");
  const [applyDeptPolicy, setApplyDeptPolicy] = useState<DimensionPolicy>("REQUIRED");
  const [applyFundPolicy, setApplyFundPolicy] = useState<DimensionPolicy>("REQUIRED");

  function toggleInSet<T>(set: Set<T>, value: T, setter: (s: Set<T>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  const inputClass = "rounded border border-stone-300 bg-white px-2 py-1 text-xs text-club-ink";

  return (
    <div className="mt-6 rounded-md border border-stone-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Bulk review controls (DIM-2b)
        </div>
        <div className="text-xs text-stone-500">
          {visibleRows.length} of {props.rows.length} rows visible ·{" "}
          <span className="font-medium">{selectedRowIds.length}</span> selected
        </div>
      </div>

      {message && (
        <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
          {message}
        </div>
      )}

      {/* -------- Filters -------- */}
      <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
        <label>Confidence
          <select className={"mt-0.5 block w-full " + inputClass} value={filter.confidence} onChange={(e) => setQueryParam("f_conf", e.target.value)}>
            <option value="">any</option>
            <option value="high">HIGH</option>
            <option value="medium">MEDIUM</option>
            <option value="low">LOW</option>
          </select>
        </label>
        <label>Department Policy
          <select className={"mt-0.5 block w-full " + inputClass} value={filter.departmentPolicy} onChange={(e) => setQueryParam("f_deptpol", e.target.value)}>
            <option value="">any</option>
            <option value="REQUIRED">REQUIRED</option>
            <option value="OPTIONAL">OPTIONAL</option>
            <option value="NOT_APPLICABLE">NOT_APPLICABLE</option>
          </select>
        </label>
        <label>Fund Policy
          <select className={"mt-0.5 block w-full " + inputClass} value={filter.fundPolicy} onChange={(e) => setQueryParam("f_fundpol", e.target.value)}>
            <option value="">any</option>
            <option value="REQUIRED">REQUIRED</option>
            <option value="OPTIONAL">OPTIONAL</option>
            <option value="NOT_APPLICABLE">NOT_APPLICABLE</option>
          </select>
        </label>
        <label>Department Applicability
          <select className={"mt-0.5 block w-full " + inputClass} value={filter.departmentApplicability} onChange={(e) => setQueryParam("f_deptapp", e.target.value)}>
            <option value="">any</option>
            <option value="NONE">NONE</option>
            <option value="SOME">any Department</option>
          </select>
        </label>
        <label>Fund Applicability
          <select className={"mt-0.5 block w-full " + inputClass} value={filter.fundApplicability} onChange={(e) => setQueryParam("f_fundapp", e.target.value)}>
            <option value="">any</option>
            <option value="NONE">NONE</option>
            <option value="OPERATING">OPERATING only</option>
            <option value="CAPITAL">CAPITAL only</option>
            <option value="OPERATING+CAPITAL">OPERATING + CAPITAL</option>
          </select>
        </label>
        <label>Review state
          <select className={"mt-0.5 block w-full " + inputClass} value={filter.reviewState} onChange={(e) => setQueryParam("f_review", e.target.value)}>
            <option value="">any</option>
            <option value="NOT_REVIEWED">Needs Review</option>
            <option value="REVIEWED">Reviewed</option>
          </select>
        </label>
        <label>CAPITAL candidate
          <select className={"mt-0.5 block w-full " + inputClass} value={filter.capitalCandidate} onChange={(e) => setQueryParam("f_capital", e.target.value)}>
            <option value="">any</option>
            <option value="YES">YES</option>
            <option value="NO">NO</option>
          </select>
        </label>
        <label>Search
          <input className={"mt-0.5 block w-full " + inputClass} type="text" placeholder="account #, name…" value={filter.search} onChange={(e) => setQueryParam("f_q", e.target.value)} />
        </label>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
        <button type="button" className="rounded border border-stone-300 bg-white px-2 py-1 hover:bg-stone-50" onClick={clearAllFilters}>Clear filters</button>
        <button type="button" className="rounded border border-stone-300 bg-white px-2 py-1 hover:bg-stone-50" onClick={selectAllVisible} disabled={visibleRows.length === 0}>Select all visible ({visibleRows.length})</button>
        <button type="button" className="rounded border border-stone-300 bg-white px-2 py-1 hover:bg-stone-50" onClick={clearSelection} disabled={!anySelected}>Clear selection</button>
      </div>

      {/* -------- Bulk-action bar -------- */}
      {!props.readOnly && (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="rounded border border-stone-200 p-2">
            <div className="font-semibold text-club-ink">Set Department Applicability</div>
            <div className="mt-1 text-[10px] uppercase tracking-wide text-stone-500">Applicability = which departments MAY use these accounts</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {props.departments.map((d) => (
                <label key={d.code} className="inline-flex items-center gap-1">
                  <input type="checkbox" checked={applyDeptCodes.has(d.code)} onChange={() => toggleInSet(applyDeptCodes, d.code, setApplyDeptCodes)} />
                  {d.code}
                </label>
              ))}
              <button type="button" className="ml-2 rounded border border-stone-300 bg-white px-1.5 py-0.5 hover:bg-stone-50" onClick={() => setApplyDeptCodes(new Set(props.departments.map((d) => d.code)))}>All Active Departments</button>
              <button type="button" className="rounded border border-stone-300 bg-white px-1.5 py-0.5 hover:bg-stone-50" onClick={() => setApplyDeptCodes(new Set())}>None</button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label className="inline-flex items-center gap-1"><input type="radio" name="deptmode" checked={applyDeptMode === "REPLACE"} onChange={() => setApplyDeptMode("REPLACE")}/> REPLACE (default)</label>
              <label className="inline-flex items-center gap-1"><input type="radio" name="deptmode" checked={applyDeptMode === "ADD"} onChange={() => setApplyDeptMode("ADD")}/> ADD</label>
            </div>
            <button type="button" className="mt-2 rounded bg-club-forest text-white px-2 py-1 disabled:opacity-40" disabled={isPending || !anySelected} onClick={() => runBulk(
              { kind: "SET_DEPARTMENT_APPLICABILITY", mode: applyDeptMode, departmentCodes: Array.from(applyDeptCodes) },
              `Set Department Applicability: ${Array.from(applyDeptCodes).join(", ") || "(empty)"}\nMode: ${applyDeptMode}`,
            )}>Apply to {selectedRowIds.length} rows</button>
          </div>

          <div className="rounded border border-stone-200 p-2">
            <div className="font-semibold text-club-ink">Set Fund Applicability</div>
            <div className="mt-1 text-[10px] uppercase tracking-wide text-stone-500">Applicability = which funds MAY use these accounts</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {props.funds.map((f) => (
                <label key={f.key} className="inline-flex items-center gap-1">
                  <input type="checkbox" checked={applyFundKeys.has(f.key)} onChange={() => toggleInSet(applyFundKeys, f.key, setApplyFundKeys)} />
                  {f.key}
                </label>
              ))}
              <button type="button" className="ml-2 rounded border border-stone-300 bg-white px-1.5 py-0.5 hover:bg-stone-50" onClick={() => setApplyFundKeys(new Set(props.funds.map((f) => f.key)))}>All Active Funds</button>
              <button type="button" className="rounded border border-stone-300 bg-white px-1.5 py-0.5 hover:bg-stone-50" onClick={() => setApplyFundKeys(new Set())}>None</button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label className="inline-flex items-center gap-1"><input type="radio" name="fundmode" checked={applyFundMode === "REPLACE"} onChange={() => setApplyFundMode("REPLACE")}/> REPLACE (default)</label>
              <label className="inline-flex items-center gap-1"><input type="radio" name="fundmode" checked={applyFundMode === "ADD"} onChange={() => setApplyFundMode("ADD")}/> ADD</label>
            </div>
            <button type="button" className="mt-2 rounded bg-club-forest text-white px-2 py-1 disabled:opacity-40" disabled={isPending || !anySelected} onClick={() => runBulk(
              { kind: "SET_FUND_APPLICABILITY", mode: applyFundMode, fundKeys: Array.from(applyFundKeys) },
              `Set Fund Applicability: ${Array.from(applyFundKeys).join(", ") || "(empty)"}\nMode: ${applyFundMode}`,
            )}>Apply to {selectedRowIds.length} rows</button>
          </div>

          <div className="rounded border border-stone-200 p-2">
            <div className="font-semibold text-club-ink">Set Department Policy</div>
            <div className="mt-1 text-[10px] uppercase tracking-wide text-stone-500">Policy = whether the account requires Department attribution (never touches applicability)</div>
            <div className="mt-2">
              <select className={inputClass} value={applyDeptPolicy} onChange={(e) => setApplyDeptPolicy(e.target.value as DimensionPolicy)}>
                <option value="REQUIRED">REQUIRED</option>
                <option value="OPTIONAL">OPTIONAL</option>
                <option value="NOT_APPLICABLE">NOT_APPLICABLE</option>
              </select>
            </div>
            <button type="button" className="mt-2 rounded bg-club-forest text-white px-2 py-1 disabled:opacity-40" disabled={isPending || !anySelected} onClick={() => runBulk(
              { kind: "SET_DEPARTMENT_POLICY", value: applyDeptPolicy },
              `Set Department Policy → ${applyDeptPolicy}`,
            )}>Apply to {selectedRowIds.length} rows</button>
          </div>

          <div className="rounded border border-stone-200 p-2">
            <div className="font-semibold text-club-ink">Set Fund Policy</div>
            <div className="mt-1 text-[10px] uppercase tracking-wide text-stone-500">Policy = whether the account requires Fund attribution (never touches applicability)</div>
            <div className="mt-2">
              <select className={inputClass} value={applyFundPolicy} onChange={(e) => setApplyFundPolicy(e.target.value as DimensionPolicy)}>
                <option value="REQUIRED">REQUIRED</option>
                <option value="OPTIONAL">OPTIONAL</option>
                <option value="NOT_APPLICABLE">NOT_APPLICABLE</option>
              </select>
            </div>
            <button type="button" className="mt-2 rounded bg-club-forest text-white px-2 py-1 disabled:opacity-40" disabled={isPending || !anySelected} onClick={() => runBulk(
              { kind: "SET_FUND_POLICY", value: applyFundPolicy },
              `Set Fund Policy → ${applyFundPolicy}`,
            )}>Apply to {selectedRowIds.length} rows</button>
          </div>

          <div className="rounded border border-stone-200 p-2 md:col-span-2">
            <div className="font-semibold text-club-ink">Mark Reviewed</div>
            <div className="mt-1 text-[10px] uppercase tracking-wide text-stone-500">Explicitly accepts the current proposal without changing it.</div>
            <button type="button" className="mt-2 rounded bg-stone-800 text-white px-2 py-1 disabled:opacity-40" disabled={isPending || !anySelected} onClick={() => runBulk(
              { kind: "MARK_REVIEWED" },
              `Mark Reviewed`,
            )}>Mark {selectedRowIds.length} rows reviewed</button>
          </div>
        </div>
      )}

      {/* -------- Row list (compact — dimensional overview) -------- */}
      <div className="mt-4 overflow-auto rounded border border-stone-200">
        <table className="w-full text-xs">
          <thead className="bg-stone-50 text-stone-500">
            <tr>
              <th className="w-8 px-2 py-1 text-left"><input type="checkbox" onChange={(e) => e.target.checked ? selectAllVisible() : clearSelection()} checked={visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.rowId))} /></th>
              <th className="px-2 py-1 text-left">Number</th>
              <th className="px-2 py-1 text-left">Name</th>
              <th className="px-2 py-1 text-left">Conf</th>
              <th className="px-2 py-1 text-left">Dept Policy</th>
              <th className="px-2 py-1 text-left">Dept Applic.</th>
              <th className="px-2 py-1 text-left">Fund Policy</th>
              <th className="px-2 py-1 text-left">Fund Applic.</th>
              <th className="px-2 py-1 text-left">Cap?</th>
              <th className="px-2 py-1 text-left">Reviewed</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <tr key={r.rowId} className={selected.has(r.rowId) ? "bg-amber-50" : ""}>
                <td className="px-2 py-1"><input type="checkbox" checked={selected.has(r.rowId)} onChange={(e) => toggleRow(r.rowId, e.target.checked)} /></td>
                <td className="px-2 py-1 font-mono">{r.accountNumber}</td>
                <td className="px-2 py-1">{r.name}</td>
                <td className="px-2 py-1">{r.confidence}</td>
                <td className="px-2 py-1">{r.departmentPolicy}</td>
                <td className="px-2 py-1">{r.departmentApplicabilityCodes.join(", ") || "—"}</td>
                <td className="px-2 py-1">{r.fundPolicy}</td>
                <td className="px-2 py-1">{r.fundApplicabilityKeys.join(", ") || "—"}</td>
                <td className="px-2 py-1">{r.capitalCandidate ? "yes" : ""}</td>
                <td className="px-2 py-1">{r.reviewed ? "✓" : ""}</td>
              </tr>
            ))}
            {visibleRows.length === 0 && (
              <tr><td className="px-2 py-4 text-center text-stone-400" colSpan={10}>No rows match the current filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
