"use client";

// Founder rule 2026-07-01 v14.17 — the map-accounts form is a
// Client Component so onChange handlers (the bulk-approve helper)
// can attach cleanly. Server data (suggestions + dropdown options)
// arrives via props; the Server Action `approveTbMappingsAction`
// is imported and threaded onto the <form> as its action — server
// actions ARE passable across the client boundary because they
// carry their own transport metadata.

import Link from "next/link";
import { approveTbMappingsAction } from "../../_actions";

const TYPES = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const;

type Suggestion = {
  rowNumber: number;
  accountNumber: string;
  description: string;
  debit: number;
  credit: number;
  prediction: {
    type: string;
    categoryKey: string;
    fsGroupKey: string;
    defaultDepartmentCode: string | null;
    /**
     * Founder rule 2026-07-02 v15.1 — predictor's default Fund
     * Applicability CSV (e.g. "OPERATING", "CAPITAL",
     * "OPERATING,CAPITAL"). Rendered as pre-checked checkboxes
     * in the review row; operators may override before approval.
     */
    fundApplicability: string | null;
    confidence: "high" | "medium" | "low";
    source: string;
  };
  alreadyExists: boolean;
};

const FUND_KEYS = ["OPERATING", "CAPITAL"] as const;
type FundKey = (typeof FUND_KEYS)[number];

type Option = { key: string; name: string };
type DeptOption = { code: string; name: string };

export function MapAccountsForm({
  batchId,
  suggestions,
  categories,
  fsGroups,
  departments,
}: {
  batchId: string;
  suggestions: ReadonlyArray<Suggestion>;
  categories: ReadonlyArray<Option>;
  fsGroups: ReadonlyArray<Option>;
  departments: ReadonlyArray<DeptOption>;
}) {
  const fmt = (n: number) =>
    n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const highCount = suggestions.filter((s) => s.prediction.confidence === "high").length;

  return (
    <form action={approveTbMappingsAction} className="mt-6" data-testid="tb-map-form">
      <input type="hidden" name="batchId" value={batchId} />

      <div className="mb-3 flex items-center gap-3 text-xs text-stone-500">
        <label className="flex items-center gap-2 cursor-pointer" data-testid="tb-map-bulk-approve-high">
          <input
            type="checkbox"
            onChange={(e) => {
              const checked = e.target.checked;
              document
                .querySelectorAll('[data-confidence="high"] input[type="checkbox"]')
                .forEach((el) => { (el as HTMLInputElement).checked = checked; });
            }}
          />
          Approve all high-confidence suggestions ({highCount})
        </label>
      </div>

      <div className="card overflow-hidden">
        <table className="table-base">
          <thead>
            <tr>
              <th className="w-16">Approve</th>
              <th className="w-24">Number</th>
              <th>Description</th>
              <th className="w-24 text-right">Debit</th>
              <th className="w-24 text-right">Credit</th>
              <th className="w-28">Type</th>
              <th className="w-52">Category</th>
              <th className="w-52">FS Group</th>
              <th className="w-36">Department</th>
              <th className="w-32">Fund</th>
              <th className="w-24">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {suggestions.map((s) => {
              const prefix = `row.${s.rowNumber}`;
              return (
                <tr
                  key={s.rowNumber}
                  data-testid={`tb-map-row-${s.accountNumber}`}
                  data-confidence={s.prediction.confidence}
                  className={s.alreadyExists ? "bg-stone-50 text-stone-400" : ""}
                >
                  <td>
                    <input
                      type="checkbox"
                      name={`${prefix}.approved`}
                      defaultChecked={s.prediction.confidence === "high" && !s.alreadyExists}
                      disabled={s.alreadyExists}
                      data-testid={`tb-map-approve-${s.accountNumber}`}
                    />
                    <input type="hidden" name={`${prefix}.accountNumber`} value={s.accountNumber} />
                  </td>
                  <td className="text-xs font-mono">{s.accountNumber}</td>
                  <td className="text-xs">
                    <input
                      type="text"
                      name={`${prefix}.name`}
                      defaultValue={s.description}
                      className="input input-sm w-full"
                      required
                      data-testid={`tb-map-name-${s.accountNumber}`}
                    />
                  </td>
                  <td className="text-xs font-mono text-right">{s.debit === 0 ? "—" : fmt(s.debit)}</td>
                  <td className="text-xs font-mono text-right">{s.credit === 0 ? "—" : fmt(s.credit)}</td>
                  <td>
                    <select
                      name={`${prefix}.type`}
                      defaultValue={s.prediction.type}
                      className="select select-sm w-full"
                      data-testid={`tb-map-type-${s.accountNumber}`}
                    >
                      {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </td>
                  <td>
                    <select
                      name={`${prefix}.categoryKey`}
                      defaultValue={s.prediction.categoryKey}
                      className="select select-sm w-full"
                      data-testid={`tb-map-category-${s.accountNumber}`}
                    >
                      <option value="">— None —</option>
                      {categories.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select
                      name={`${prefix}.fsGroupKey`}
                      defaultValue={s.prediction.fsGroupKey}
                      className="select select-sm w-full"
                      data-testid={`tb-map-fsgroup-${s.accountNumber}`}
                    >
                      <option value="">— None —</option>
                      {fsGroups.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select
                      name={`${prefix}.departmentCode`}
                      defaultValue={s.prediction.defaultDepartmentCode ?? ""}
                      className="select select-sm w-full"
                      data-testid={`tb-map-department-${s.accountNumber}`}
                    >
                      <option value="">— None —</option>
                      {departments.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
                    </select>
                  </td>
                  <td>
                    {/* Founder rule 2026-07-02 v15.1 — Fund Applicability
                        checkboxes per row. Pre-checked from the predictor's
                        default (fund-applicability.ts's FS Group table).
                        The operator can override before approval; empty
                        selection means the service falls back to the
                        FS Group derive-default at create time. */}
                    {(() => {
                      const predictedFunds = new Set<FundKey>(
                        (s.prediction.fundApplicability ?? "")
                          .split(",")
                          .map((t) => t.trim().toUpperCase())
                          .filter((t): t is FundKey => (FUND_KEYS as readonly string[]).includes(t)),
                      );
                      return (
                        <div
                          className="flex flex-col gap-1 text-xs"
                          data-testid={`tb-map-fund-${s.accountNumber}`}
                        >
                          {FUND_KEYS.map((k) => (
                            <label key={k} className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                name={`${prefix}.fundApplicability`}
                                value={k}
                                defaultChecked={predictedFunds.has(k)}
                                data-testid={`tb-map-fund-${s.accountNumber}-${k}`}
                              />
                              <span className="capitalize">{k.toLowerCase()}</span>
                            </label>
                          ))}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="text-xs">
                    <span
                      className={
                        "inline-block px-1.5 py-0.5 rounded text-[10px] font-medium " +
                        (s.prediction.confidence === "high"
                          ? "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200"
                          : s.prediction.confidence === "medium"
                            ? "bg-amber-100 text-amber-800 ring-1 ring-amber-200"
                            : "bg-stone-100 text-stone-700 ring-1 ring-stone-200")
                      }
                    >
                      {s.prediction.confidence}
                    </span>
                    <div className="text-[10px] text-stone-500 mt-0.5">{s.prediction.source}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Link href={`/app/admin/imports/${batchId}`} className="btn btn-secondary">Cancel</Link>
        <button type="submit" className="btn btn-primary" data-testid="tb-map-submit">
          Approve + create accounts
        </button>
      </div>
    </form>
  );
}
