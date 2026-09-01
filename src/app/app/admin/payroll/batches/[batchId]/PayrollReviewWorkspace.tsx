"use client";

// Payroll-3B-5B-3A — Payroll Review workspace (client).
//
// Renders the sanitized `ReviewBatch` DTO. No calculator logic runs
// here. Employee detail opens through a lightweight in-place expander.

import { useMemo, useState } from "react";
import type { ReviewBatch, ReviewEmployeeDetail } from "@/lib/payroll/review-dto";

interface Props {
  clubId: string;
  review: ReviewBatch;
}

const money = (v: string | null | undefined): string => {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return `$${n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone =
    status === "CALCULATED"                 ? "#166534" :
    status === "POSTED"                     ? "#0f172a" :
    status === "APPROVED"                   ? "#1e40af" :
    status === "SUBMITTED_FOR_APPROVAL"     ? "#78350f" :
    status === "PREPARED"                   ? "#334155" :
    status === "VOIDED"                     ? "#7f1d1d" : "#374151";
  return (
    <span
      className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium"
      style={{ color: tone, borderColor: tone, background: "transparent" }}
      data-testid="review-status-badge"
      data-status={status}
    >
      {label}
    </span>
  );
}

function SummaryCard({ label, value, testid, hint }: { label: string; value: string; testid: string; hint?: string; }) {
  return (
    <div
      className="rounded-lg border p-4"
      style={{ borderColor: "var(--spectre-border-muted)", background: "var(--spectre-surface)" }}
      data-testid={testid}
    >
      <div
        className="text-[11px] font-semibold uppercase tracking-[0.06em]"
        style={{ color: "var(--spectre-text-muted)" }}
      >
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums" style={{ color: "var(--spectre-text-primary)" }}>
        {value}
      </div>
      {hint ? (
        <div className="mt-1 text-xs" style={{ color: "var(--spectre-text-secondary)" }}>{hint}</div>
      ) : null}
    </div>
  );
}

export default function PayrollReviewWorkspace({ clubId, review }: Props) {
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [detail, setDetail]                 = useState<ReviewEmployeeDetail | null>(null);
  const [loadingDetail, setLoadingDetail]   = useState(false);
  const [detailError, setDetailError]       = useState<string | null>(null);
  const [q, setQ]                           = useState("");
  const [sort, setSort]                     = useState<"name" | "gross" | "deductions" | "net">("name");
  const [ascending, setAscending]           = useState(true);
  const [warningsOnly, setWarningsOnly]     = useState(false);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    let rows = review.employees;
    if (term) {
      rows = rows.filter((r) =>
        r.displayName.toLowerCase().includes(term) ||
        (r.employeeNumber ?? "").toLowerCase().includes(term),
      );
    }
    if (warningsOnly) rows = rows.filter((r) => r.hasWarning || r.hasBlockingException);
    const key = (r: (typeof rows)[number]) => {
      if (sort === "name")       return r.displayName.toLowerCase();
      if (sort === "gross")      return Number(r.earningsGross ?? 0);
      if (sort === "deductions") return Number(r.totalDeductions ?? 0);
      return Number(r.netPay ?? 0);
    };
    rows = [...rows].sort((a, b) => {
      const ka = key(a), kb = key(b);
      if (ka < kb) return ascending ? -1 : 1;
      if (ka > kb) return ascending ?  1 : -1;
      return 0;
    });
    return rows;
  }, [review.employees, q, sort, ascending, warningsOnly]);

  async function openEmployee(row: (typeof review.employees)[number]) {
    if (expandedRowId === row.batchEmployeeId) {
      setExpandedRowId(null); setDetail(null); return;
    }
    setExpandedRowId(row.batchEmployeeId);
    setDetail(null); setDetailError(null); setLoadingDetail(true);
    try {
      const res = await fetch(`/api/clubs/${clubId}/payroll/batches/${review.header.batchId}/employees/${row.batchEmployeeId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as ReviewEmployeeDetail;
      setDetail(j);
    } catch (err) {
      setDetailError((err as Error).message);
    } finally {
      setLoadingDetail(false);
    }
  }

  return (
    <div className="space-y-spectre-6">
      {/* Batch header card */}
      <section
        className="rounded-lg border p-5"
        style={{ borderColor: "var(--spectre-border-muted)", background: "var(--spectre-surface)" }}
        data-testid="review-header-card"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div
              className="text-[11px] font-semibold uppercase tracking-[0.06em]"
              style={{ color: "var(--spectre-text-muted)" }}
            >
              {review.header.payGroupCode} · Tax year {review.header.taxYear}
            </div>
            <div className="mt-1 text-lg font-semibold" style={{ color: "var(--spectre-text-primary)" }}>
              Pay period {review.header.periodStartIso.slice(0, 10)} → {review.header.periodEndInclusiveIso.slice(0, 10)}
            </div>
            <div className="mt-1 text-sm" style={{ color: "var(--spectre-text-secondary)" }}>
              Pay date {review.header.payDateIso.slice(0, 10)} · {review.header.employeeCount} employee{review.header.employeeCount === 1 ? "" : "s"}
            </div>
          </div>
          <StatusBadge status={review.header.status} label={review.header.statusLabel} />
        </div>
        <details className="mt-4" data-testid="review-calc-metadata">
          <summary
            className="cursor-pointer text-xs"
            style={{ color: "var(--spectre-text-secondary)" }}
          >
            Calculation metadata
          </summary>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs" style={{ color: "var(--spectre-text-secondary)" }}>
            <dt>Calculated at</dt>
            <dd className="tabular-nums">{review.header.calculatedAtIso ?? "—"}</dd>
            <dt>Calculation version</dt>
            <dd className="tabular-nums">{review.header.calculationVersion}</dd>
            <dt>Algorithm version</dt>
            <dd>{review.header.algorithmVersion ?? "—"}</dd>
            <dt>Statutory package</dt>
            <dd>{review.header.statutoryPackageVersion ?? "—"}</dd>
            <dt>Package checksum</dt>
            <dd className="truncate">{review.header.statutoryPackageChecksum ?? "—"}</dd>
          </dl>
        </details>
      </section>

      {/* Summary cards */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="review-summary-cards">
        <SummaryCard testid="summary-gross"            label="Gross payroll"           value={money(review.totals.gross)} />
        <SummaryCard testid="summary-deductions"       label="Employee deductions"     value={money(review.totals.employeeDeductions)} />
        <SummaryCard testid="summary-net"              label="Net payroll"             value={money(review.totals.netPay)} />
        <SummaryCard testid="summary-employer"         label="Employer contributions"  value={money(review.totals.employerContributions)}
                     hint={`Total employer payroll cost ${money(review.totals.totalEmployerCost)}`} />
      </section>

      {/* Reconciliation */}
      <section
        className="rounded-lg border p-4"
        style={{
          borderColor: review.totals.reconciled ? "var(--spectre-border-muted)" : "#b91c1c",
          background: review.totals.reconciled ? "var(--spectre-surface)" : "#fef2f2",
        }}
        data-testid="review-reconciliation"
        data-reconciled={review.totals.reconciled ? "true" : "false"}
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <div
              className="text-[11px] font-semibold uppercase tracking-[0.06em]"
              style={{ color: "var(--spectre-text-muted)" }}
            >
              Batch reconciliation
            </div>
            <div className="mt-1 text-sm tabular-nums" style={{ color: "var(--spectre-text-primary)" }}>
              {money(review.totals.gross)} <span aria-hidden="true">−</span> {money(review.totals.employeeDeductions)} = {money(review.totals.reconciliation.grossMinusDeductions)}
            </div>
            <div className="mt-1 text-sm tabular-nums" style={{ color: "var(--spectre-text-secondary)" }}>
              Net payroll: {money(review.totals.reconciliation.netPay)}
            </div>
          </div>
          <div className="text-right">
            {review.totals.reconciled ? (
              <span className="text-sm font-medium" style={{ color: "#166534" }}>Reconciles to the cent</span>
            ) : (
              <span className="text-sm font-medium" style={{ color: "#b91c1c" }} data-testid="reconciliation-failed">
                RECONCILIATION FAILED · Δ {review.totals.reconciliation.differenceCents} cents
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Search / filter / sort controls */}
      <section className="flex flex-wrap items-center gap-3" data-testid="review-controls">
        <input
          className="input min-w-[220px]"
          placeholder="Search employee (name or number)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="review-search"
        />
        <label className="flex items-center gap-2 text-sm" style={{ color: "var(--spectre-text-secondary)" }}>
          <input type="checkbox" checked={warningsOnly} onChange={(e) => setWarningsOnly(e.target.checked)}
                 data-testid="review-warnings-only" />
          Warnings only
        </label>
        <div className="ml-auto flex items-center gap-2 text-sm" style={{ color: "var(--spectre-text-secondary)" }}>
          Sort
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value as any)} data-testid="review-sort">
            <option value="name">Employee</option>
            <option value="gross">Gross</option>
            <option value="deductions">Total deductions</option>
            <option value="net">Net pay</option>
          </select>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => setAscending((a) => !a)}
            aria-label={ascending ? "Ascending" : "Descending"}
          >
            {ascending ? "↑" : "↓"}
          </button>
        </div>
      </section>

      {/* Employee table */}
      <section
        className="rounded-lg border overflow-x-auto"
        style={{ borderColor: "var(--spectre-border-muted)" }}
      >
        <table className="table-base w-full" data-testid="review-employee-table">
          <thead>
            <tr>
              <th className="text-left">Employee</th>
              <th className="text-right">Gross</th>
              <th className="text-right">CPP</th>
              <th className="text-right">CPP2</th>
              <th className="text-right">EI</th>
              <th className="text-right">Federal tax</th>
              <th className="text-right">Alberta tax</th>
              <th className="text-right">Additional</th>
              <th className="text-right">Total ded.</th>
              <th className="text-right">Net pay</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-4 py-6 text-center" style={{ color: "var(--spectre-text-secondary)" }}>
                  No employees match your search.
                </td>
              </tr>
            ) : filtered.map((row) => {
              const expanded = expandedRowId === row.batchEmployeeId;
              return (
                <>
                  <tr key={row.batchEmployeeId} data-testid={`review-emp-row:${row.employeeId}`}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{row.displayName}</span>
                        {row.hasBlockingException ? (
                          <span className="text-xs font-medium" style={{ color: "#b91c1c" }} data-testid="row-blocker">BLOCKER</span>
                        ) : null}
                        {row.hasWarning ? (
                          <span className="text-xs font-medium" style={{ color: "#a16207" }} data-testid="row-warning">warning</span>
                        ) : null}
                      </div>
                      {row.employeeNumber ? (
                        <div className="text-xs" style={{ color: "var(--spectre-text-secondary)" }}>{row.employeeNumber}</div>
                      ) : null}
                    </td>
                    <td className="text-right tabular-nums">{money(row.earningsGross)}</td>
                    <td className="text-right tabular-nums">{money(row.cppCombined)}</td>
                    <td className="text-right tabular-nums">{money(row.cpp2)}</td>
                    <td className="text-right tabular-nums">{money(row.ei)}</td>
                    <td className="text-right tabular-nums">{money(row.federalTax)}</td>
                    <td className="text-right tabular-nums">{money(row.provincialTax)}</td>
                    <td className="text-right tabular-nums">{money(row.additionalTax)}</td>
                    <td className="text-right tabular-nums">{money(row.totalDeductions)}</td>
                    <td className="text-right tabular-nums font-medium">{money(row.netPay)}</td>
                    <td className="text-right">
                      <button
                        className="btn btn-secondary btn-sm"
                        type="button"
                        onClick={() => openEmployee(row)}
                        aria-expanded={expanded}
                        data-testid={`review-emp-expand:${row.employeeId}`}
                      >
                        {expanded ? "Hide" : "Details"}
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={11} className="bg-stone-50 px-4 py-4">
                        {loadingDetail && <div className="text-sm" style={{ color: "var(--spectre-text-secondary)" }}>Loading detail…</div>}
                        {detailError  && <div className="text-sm" style={{ color: "#b91c1c" }}>Failed: {detailError}</div>}
                        {detail && detail.batchEmployeeId === row.batchEmployeeId && (
                          <EmployeeDetailPanel detail={detail} />
                        )}
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* Batch-level exceptions */}
      {review.batchLevelExceptions.length > 0 && (
        <section
          className="rounded-lg border p-4"
          style={{ borderColor: "#a16207", background: "#fffbeb" }}
          data-testid="review-batch-exceptions"
        >
          <div className="text-sm font-medium" style={{ color: "#78350f" }}>Batch-level exceptions</div>
          <ul className="mt-2 space-y-1 text-xs" style={{ color: "#78350f" }}>
            {review.batchLevelExceptions.map((e, i) => (
              <li key={i}><b>{e.severity}</b> · <code>{e.code}</code> — {e.message}</li>
            ))}
          </ul>
        </section>
      )}

      {/* No-approve informational state (§38) */}
      <section
        className="rounded-lg border border-dashed p-4 text-sm"
        style={{ borderColor: "var(--spectre-border-muted)", color: "var(--spectre-text-secondary)" }}
        data-testid="review-no-approve"
      >
        Final approval workflow will be enabled after review acceptance. This page intentionally
        provides no approve, post, or payment control.
      </section>
    </div>
  );
}

function EmployeeDetailPanel({ detail }: { detail: ReviewEmployeeDetail }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3" data-testid={`review-emp-detail:${detail.employeeId}`}>
      {/* Earnings */}
      <div>
        <h4 className="text-sm font-semibold" style={{ color: "var(--spectre-text-primary)" }}>Earnings</h4>
        <ul className="mt-2 space-y-1 text-sm">
          {detail.earningLines.length === 0
            ? <li style={{ color: "var(--spectre-text-secondary)" }}>—</li>
            : detail.earningLines.map((l, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span>{l.label}</span>
                  <span className="tabular-nums">{money(l.amount)}</span>
                </li>
              ))}
          {detail.allowanceLines.map((a, i) => (
            <li key={`al-${i}`} className="flex justify-between gap-3">
              <span>Allowance · {a.allowanceType}</span>
              <span className="tabular-nums">{money(a.amount)}</span>
            </li>
          ))}
          <li className="flex justify-between gap-3 border-t pt-1 font-medium" style={{ borderColor: "var(--spectre-border-muted)" }}>
            <span>Gross</span><span className="tabular-nums">{money(detail.earningsGross)}</span>
          </li>
        </ul>
      </div>

      {/* Employee statutory deductions */}
      <div>
        <h4 className="text-sm font-semibold" style={{ color: "var(--spectre-text-primary)" }}>Employee deductions</h4>
        <ul className="mt-2 space-y-1 text-sm">
          <li className="flex justify-between gap-3">
            <span>CPP contributions</span>
            <span className="tabular-nums">{money(detail.cppCombined)}</span>
          </li>
          {detail.explanation && (
            <li className="text-xs pl-2" style={{ color: "var(--spectre-text-secondary)" }}>
              Base {money(detail.explanation.cpp.base)} · First-additional {money(detail.explanation.cpp.firstAdd)}
            </li>
          )}
          <li className="flex justify-between gap-3">
            <span>CPP2 (second-additional)</span>
            <span className="tabular-nums">{money(detail.cpp2)}</span>
          </li>
          <li className="flex justify-between gap-3">
            <span>EI</span>
            <span className="tabular-nums">{money(detail.ei)}</span>
          </li>
          <li className="flex justify-between gap-3">
            <span>Federal income tax</span>
            <span className="tabular-nums">{money(detail.federalTax)}</span>
          </li>
          <li className="flex justify-between gap-3">
            <span>Alberta income tax</span>
            <span className="tabular-nums">{money(detail.provincialTax)}</span>
          </li>
          {detail.additionalTax && (
            <li className="flex justify-between gap-3">
              <span>Additional withholding</span>
              <span className="tabular-nums">{money(detail.additionalTax)}</span>
            </li>
          )}
          <li className="flex justify-between gap-3 border-t pt-1 font-medium" style={{ borderColor: "var(--spectre-border-muted)" }}>
            <span>Total deductions</span>
            <span className="tabular-nums">{money(detail.totalDeductions)}</span>
          </li>
          <li className="flex justify-between gap-3 font-medium">
            <span>Net pay</span>
            <span className="tabular-nums">{money(detail.netPay)}</span>
          </li>
        </ul>

        <h4 className="mt-4 text-sm font-semibold" style={{ color: "var(--spectre-text-primary)" }}>Employer contributions</h4>
        <ul className="mt-2 space-y-1 text-sm">
          <li className="flex justify-between gap-3"><span>Employer CPP</span><span className="tabular-nums">{money(detail.employerContributions.cppCombined)}</span></li>
          <li className="flex justify-between gap-3"><span>Employer CPP2</span><span className="tabular-nums">{money(detail.employerContributions.cpp2)}</span></li>
          <li className="flex justify-between gap-3"><span>Employer EI</span><span className="tabular-nums">{money(detail.employerContributions.ei)}</span></li>
          <li className="pt-1 text-xs" style={{ color: "var(--spectre-text-secondary)" }}>
            Employer contributions do NOT reduce employee net pay.
          </li>
        </ul>
      </div>

      {/* Calculation explanation */}
      <div>
        <h4 className="text-sm font-semibold" style={{ color: "var(--spectre-text-primary)" }}>Calculation explanation</h4>
        {detail.explanation == null ? (
          <div className="mt-2 text-sm" style={{ color: "var(--spectre-text-secondary)" }}>
            No calculation explanation is available for this employee.
          </div>
        ) : (
          <>
            <div className="mt-2 space-y-1 text-sm">
              <div><b>Federal</b></div>
              <div className="flex justify-between gap-3"><span>Taxable income for pay period</span><span className="tabular-nums">{money(detail.explanation.earnings.earningsTaxable)}</span></div>
              <div className="flex justify-between gap-3"><span>Deductible CPP additional contributions</span><span className="tabular-nums">{money(detail.explanation.cpp.deductibleAdditional)}</span></div>
              <div className="flex justify-between gap-3"><span>Annualised taxable income</span><span className="tabular-nums">{money(detail.explanation.federal.annualisedTaxableIncome)}</span></div>
              <div className="flex justify-between gap-3"><span>Annualised gross employment income</span><span className="tabular-nums">{money(detail.explanation.federal.annualisedGrossEmployment)}</span></div>
              <div className="flex justify-between gap-3">
                <span>Federal TD1 claim used</span>
                <span className="tabular-nums">
                  {detail.explanation.federal.claimZeroFederal
                    ? "$0.00 · claim-zero (more than one employer)"
                    : money(detail.explanation.federal.federalClaimUsed)}
                </span>
              </div>
              <div className="flex justify-between gap-3"><span>Federal bracket rate</span><span className="tabular-nums">{(Number(detail.explanation.federal.bracketRate) * 100).toFixed(2)}%</span></div>
              <div className="flex justify-between gap-3"><span>Canada Employment Amount credit</span><span className="tabular-nums">{money(detail.explanation.federal.canadaEmploymentAmountCap)}</span></div>
              <div className="flex justify-between gap-3 font-medium"><span>Federal income tax (per pay)</span><span className="tabular-nums">{money(detail.explanation.federal.baseTax)}</span></div>
              <div className="mt-3"><b>Alberta</b></div>
              <div className="flex justify-between gap-3"><span>Annualised taxable income</span><span className="tabular-nums">{money(detail.explanation.provincial.annualisedTaxableIncome)}</span></div>
              <div className="flex justify-between gap-3">
                <span>Alberta TD1 claim used</span>
                <span className="tabular-nums">
                  {detail.explanation.provincial.claimZeroProvincial
                    ? "$0.00 · claim-zero"
                    : money(detail.explanation.provincial.provincialClaimUsed)}
                </span>
              </div>
              <div className="flex justify-between gap-3"><span>Alberta bracket rate</span><span className="tabular-nums">{(Number(detail.explanation.provincial.bracketRate) * 100).toFixed(2)}%</span></div>
              <div className="flex justify-between gap-3 font-medium"><span>Alberta income tax (per pay)</span><span className="tabular-nums">{money(detail.explanation.provincial.baseTax)}</span></div>
            </div>

            <details className="mt-3" data-testid="explanation-advanced">
              <summary className="cursor-pointer text-xs" style={{ color: "var(--spectre-text-secondary)" }}>
                Advanced statutory factors (T4127)
              </summary>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs" style={{ color: "var(--spectre-text-secondary)" }}>
                <dt>Federal K1</dt><dd className="tabular-nums">{money(detail.explanation.federal.advanced.K1)}</dd>
                <dt>Federal K2 (base CPP + EI)</dt><dd className="tabular-nums">{money(detail.explanation.federal.advanced.K2)}</dd>
                <dt>Federal K4 (CEA)</dt><dd className="tabular-nums">{money(detail.explanation.federal.advanced.K4)}</dd>
                <dt>Federal T3 (annual)</dt><dd className="tabular-nums">{money(detail.explanation.federal.advanced.T3Annual)}</dd>
                <dt>Alberta K1P</dt><dd className="tabular-nums">{money(detail.explanation.provincial.advanced.K1P)}</dd>
                <dt>Alberta K2P (base CPP + EI)</dt><dd className="tabular-nums">{money(detail.explanation.provincial.advanced.K2P)}</dd>
                <dt>Alberta K5P</dt><dd className="tabular-nums">{money(detail.explanation.provincial.advanced.K5P)}</dd>
                <dt>Alberta T3P (annual)</dt><dd className="tabular-nums">{money(detail.explanation.provincial.advanced.T3PAnnual)}</dd>
              </dl>
            </details>
          </>
        )}

        {detail.exceptions.length > 0 && (
          <div className="mt-4">
            <h4 className="text-sm font-semibold" style={{ color: "var(--spectre-text-primary)" }}>Notes</h4>
            <ul className="mt-2 space-y-1 text-xs">
              {detail.exceptions.map((e, i) => (
                <li key={i}>
                  <b>{e.severity}</b> · <code>{e.code}</code> — {e.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
