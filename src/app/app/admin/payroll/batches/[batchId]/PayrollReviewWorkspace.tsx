"use client";

// Payroll-3B-5B-3A — Payroll Review workspace (client).
//
// Renders the sanitized `ReviewBatch` DTO. No calculator logic runs
// here. Employee detail opens through a lightweight in-place expander.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
  const router = useRouter();
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [detail, setDetail]                 = useState<ReviewEmployeeDetail | null>(null);
  const [loadingDetail, setLoadingDetail]   = useState(false);
  const [detailError, setDetailError]       = useState<string | null>(null);
  const [q, setQ]                           = useState("");
  const [sort, setSort]                     = useState<"name" | "gross" | "deductions" | "net">("name");
  const [ascending, setAscending]           = useState(true);
  const [warningsOnly, setWarningsOnly]     = useState(false);

  // Payroll-3C-4 — refetch the currently-open employee drawer without
  // toggling it closed. Used after an adjustment is added or removed.
  async function refetchDetail(batchEmployeeId: string) {
    setLoadingDetail(true); setDetailError(null);
    try {
      const res = await fetch(`/api/clubs/${clubId}/payroll/batches/${review.header.batchId}/employees/${batchEmployeeId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetail((await res.json()) as ReviewEmployeeDetail);
    } catch (err) {
      setDetailError((err as Error).message);
    } finally {
      setLoadingDetail(false);
    }
  }

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
                          <EmployeeDetailPanel
                            detail={detail}
                            clubId={clubId}
                            batchId={review.header.batchId}
                            batchStatus={review.header.status}
                            // Payroll-3C-4 — while the batch is PREPARED, Raelene
                            // may add / remove one-time adjustments.
                            canRun={review.header.status === "PREPARED" || review.header.status === "DRAFT"}
                            onChanged={() => { void refetchDetail(row.batchEmployeeId); router.refresh(); }}
                          />
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

      {/* Final approval + posting action block (Payroll MVP) */}
      <ApproveAndPostActions clubId={clubId} batchId={review.header.batchId} status={review.header.status} glJournalEntryId={review.header.glJournalEntryId ?? null} />
    </div>
  );
}

function ApproveAndPostActions({
  clubId, batchId, status, glJournalEntryId,
}: {
  clubId: string; batchId: string; status: string; glJournalEntryId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "post" | null>(null);
  const [banner, setBanner] = useState<{ tone: "success" | "error"; text: string; jeId?: string; totalDebits?: string; totalCredits?: string } | null>(null);

  async function approve() {
    if (!confirm("Approve this payroll batch? This authorises posting to the general ledger.")) return;
    setBanner(null); setBusy("approve");
    try {
      const res = await fetch(`/api/clubs/${clubId}/payroll/batches/${batchId}/approve`, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setBanner({ tone: "error", text: j.error ?? `Approve failed (HTTP ${res.status})` }); return; }
      setBanner({ tone: "success", text: "Payroll approved. You can now post to the general ledger." });
      router.refresh();
    } finally { setBusy(null); }
  }
  async function post() {
    if (!confirm("Post this payroll batch to the general ledger? Once posted, the batch and its GL entry are immutable. No bank submission is performed.")) return;
    setBanner(null); setBusy("post");
    try {
      const res = await fetch(`/api/clubs/${clubId}/payroll/batches/${batchId}/post`, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { error?: string; gl?: { journalEntryId: string; totalDebits: string; totalCredits: string } };
      if (!res.ok) { setBanner({ tone: "error", text: j.error ?? `Post failed (HTTP ${res.status})` }); return; }
      setBanner({
        tone: "success",
        text: `Payroll posted. Debits $${j.gl?.totalDebits} = Credits $${j.gl?.totalCredits}. Payment transmission: not yet enabled.`,
        jeId: j.gl?.journalEntryId, totalDebits: j.gl?.totalDebits, totalCredits: j.gl?.totalCredits,
      });
      router.refresh();
    } finally { setBusy(null); }
  }

  const isCalculated = status === "CALCULATED" || status === "SUBMITTED_FOR_APPROVAL";
  const isApproved   = status === "APPROVED";
  const isPosted     = status === "POSTED";

  return (
    <section
      className="rounded-lg border p-5"
      style={{ borderColor: "var(--spectre-border-muted)", background: "var(--spectre-surface)" }}
      data-testid="review-actions"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide" style={{ color: "var(--spectre-text-muted)" }}>
          Payroll lifecycle
        </h3>
        <span
          className="rounded-full border px-3 py-0.5 text-xs font-semibold"
          style={{ borderColor: isPosted ? "#166534" : isApproved ? "#1e40af" : "#78350f", color: isPosted ? "#166534" : isApproved ? "#1e40af" : "#78350f" }}
          data-testid="review-lifecycle-badge"
        >{status}</span>
      </div>
      {banner ? (
        <div
          className="mb-3 rounded-md border px-3 py-2 text-sm"
          style={{ borderColor: banner.tone === "success" ? "#166534" : "#b91c1c", background: banner.tone === "success" ? "#f0fdf4" : "#fef2f2", color: banner.tone === "success" ? "#14532d" : "#7f1d1d" }}
          data-testid="review-actions-banner"
        >{banner.text}</div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={approve}
          disabled={!isCalculated || busy !== null}
          data-testid="review-approve-btn"
          style={{ opacity: !isCalculated ? 0.5 : 1 }}
        >
          {busy === "approve" ? "Approving…" : "Approve payroll"}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={post}
          disabled={!isApproved || busy !== null}
          data-testid="review-post-btn"
          style={{ opacity: !isApproved ? 0.5 : 1 }}
        >
          {busy === "post" ? "Posting…" : "Post payroll"}
        </button>
        {isPosted && glJournalEntryId ? (
          <a
            href={`/app/admin/payroll/batches/${batchId}/gl`}
            className="btn btn-secondary btn-sm"
            data-testid="review-view-gl-link"
          >View GL journal</a>
        ) : null}
        {isPosted ? (
          <a
            href={`/app/admin/payroll/batches/${batchId}/paystubs`}
            className="btn btn-secondary btn-sm"
            data-testid="review-view-paystubs-link"
          >View pay statements</a>
        ) : null}
      </div>
      <p className="mt-3 text-xs" style={{ color: "var(--spectre-text-secondary)" }}>
        Segregation of duties: the user who prepared this batch may not be its final approver
        (a same-actor approval is recorded distinctly in the audit trail). Posting writes a
        balanced GL journal — payment transmission is not enabled in this build.
      </p>
    </section>
  );
}

function EmployeeDetailPanel({ detail, clubId, batchId, batchStatus, canRun, onChanged }: {
  detail: ReviewEmployeeDetail;
  clubId: string; batchId: string; batchStatus: string; canRun: boolean;
  onChanged: () => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3" data-testid={`review-emp-detail:${detail.employeeId}`}>
      {/* Payroll-3C-2 — four independent remuneration bases. */}
      <div className="lg:col-span-3">
        <ComponentBreakdown detail={detail} clubId={clubId} batchId={batchId} batchStatus={batchStatus} canRun={canRun} onChanged={onChanged} />
        <BasesPanel detail={detail} />
      </div>
      {/* Earnings */}
      <div>
        <h4 className="text-sm font-semibold" style={{ color: "var(--spectre-text-primary)" }}>Earnings</h4>
        {detail.salaryDerivation && (
          <div
            className="mt-2 rounded border px-3 py-2 text-xs"
            style={{ borderColor: "var(--spectre-border-muted)", background: "var(--spectre-surface)", color: "var(--spectre-text-secondary)" }}
            data-testid="salary-derivation"
          >
            <div className="font-semibold uppercase tracking-wide text-[10px]" style={{ color: "var(--spectre-text-muted)" }}>
              Regular salary
            </div>
            <div className="mt-1 tabular-nums">
              Annual salary: <strong>${detail.salaryDerivation.annualSalary}</strong>
            </div>
            <div className="tabular-nums">
              Pay frequency: <strong>{detail.salaryDerivation.frequencyLabel}</strong>{" "}
              ({detail.salaryDerivation.periodsPerYear} periods / year)
            </div>
            <div className="tabular-nums">
              Regular period earnings:{" "}
              <strong>${detail.salaryDerivation.annualSalary} ÷ {detail.salaryDerivation.periodsPerYear} = ${detail.salaryDerivation.periodEarning}</strong>
            </div>
          </div>
        )}
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

// -------------------------------------------------------------------
// Payroll-3C-2 (2026-09-07) — component + bases panels.
// -------------------------------------------------------------------
function BasesPanel({ detail }: { detail: ReviewEmployeeDetail }) {
  return (
    <section
      className="mb-3 rounded border p-3 text-xs"
      style={{ borderColor: "var(--spectre-border-muted)", background: "var(--spectre-surface)" }}
      data-testid="review-bases-panel"
    >
      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide"
          style={{ color: "var(--spectre-text-muted)" }}>
        Calculation bases (independent)
      </h4>
      <dl className="grid grid-cols-2 gap-y-1 gap-x-4 tabular-nums" style={{ color: "var(--spectre-text-primary)" }}>
        <dt className="text-[color:var(--spectre-text-secondary)]">Cash earnings</dt>
        <dd className="text-right">{money(detail.bases.cashEarnings)}</dd>
        <dt className="text-[color:var(--spectre-text-secondary)]">Taxable remuneration</dt>
        <dd className="text-right">{money(detail.bases.taxableRemuneration)}</dd>
        <dt className="text-[color:var(--spectre-text-secondary)]">CPP pensionable</dt>
        <dd className="text-right">{money(detail.bases.cppPensionableRemuneration)}</dd>
        <dt className="text-[color:var(--spectre-text-secondary)]">EI insurable</dt>
        <dd className="text-right">{money(detail.bases.eiInsurableRemuneration)}</dd>
      </dl>
    </section>
  );
}

function ComponentBreakdown({ detail, clubId, batchId, batchStatus, canRun, onChanged }: {
  detail: ReviewEmployeeDetail;
  clubId: string; batchId: string; batchStatus: string; canRun: boolean;
  onChanged: () => void;
}) {
  const showEmpty = detail.componentLines.length === 0;
  const groups: Record<string, typeof detail.componentLines> = { EARNINGS: [], BENEFITS: [], DEDUCTIONS: [] };
  for (const l of detail.componentLines) {
    (groups[l.displaySection] ??= []).push(l);
  }
  const order: Array<"EARNINGS" | "BENEFITS" | "DEDUCTIONS"> = ["EARNINGS", "BENEFITS", "DEDUCTIONS"];
  return (
    <section
      className="mb-3 rounded border p-3 text-xs"
      style={{ borderColor: "var(--spectre-border-muted)", background: "var(--spectre-surface)" }}
      data-testid="review-components-panel"
    >
      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide"
          style={{ color: "var(--spectre-text-muted)" }}>
        Payroll components (this pay)
      </h4>
      {showEmpty ? (
        <p className="mb-2 text-[11px]" style={{ color: "var(--spectre-text-secondary)" }}>
          No Payroll components on this employee for this pay period yet.
        </p>
      ) : null}
      {canRun ? (
        <AddAdjustmentForm
          clubId={clubId} batchId={batchId} batchStatus={batchStatus}
          batchEmployeeId={detail.batchEmployeeId}
          onAdded={onChanged}
        />
      ) : null}
      {order.filter((s) => (groups[s] ?? []).length > 0).map((section) => (
        <div key={section} className="mb-2">
          <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--spectre-text-muted)" }}>
            {section.toLowerCase()}
          </div>
          <ul className="space-y-0.5">
            {groups[section]!.map((l) => (
              <li key={l.id} className="flex flex-col gap-0.5" data-testid={`component-line:${l.code}`}
                  data-provenance={l.provenance}>
                <div className="flex items-baseline justify-between gap-2">
                  <span>
                    {l.displayName}
                    {l.provenance === "ONE_TIME_PAYROLL_ADJUSTMENT" ? (
                      <span
                        className="ml-1 inline-block rounded bg-amber-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-amber-800"
                        data-testid={`component-onetime-badge:${l.code}`}
                      >One-time</span>
                    ) : null}
                    {l.reason ? (
                      <span className="ml-1 text-[10px]" style={{ color: "var(--spectre-text-secondary)" }}>
                        · {l.reason}
                      </span>
                    ) : null}
                    {l.warningCode ? (
                      <span className="ml-1 text-amber-700 text-[10px]" data-testid={`component-warning:${l.code}`}>
                        · {l.warningMessage ?? l.warningCode}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-baseline gap-2">
                    <span className="tabular-nums">
                      {l.resolvedAmount ? `$${l.resolvedAmount}` : "—"}
                    </span>
                    {canRun && l.provenance === "ONE_TIME_PAYROLL_ADJUSTMENT" ? (
                      <RemoveAdjustmentButton
                        clubId={clubId} batchId={batchId} snapshotId={l.id}
                        onRemoved={onChanged}
                      />
                    ) : null}
                  </span>
                </div>
                {l.percentDerivation ? (
                  <div
                    className="text-[10px] pl-2"
                    style={{ color: "var(--spectre-text-muted)" }}
                    data-testid={`component-percent-derivation:${l.code}`}
                  >
                    {l.percentDerivation.percentBpsLabel} of {l.percentDerivation.eligibleBaseLabel}:{" "}
                    ${l.percentDerivation.eligibleAmount} × {l.percentDerivation.percentBpsLabel}{" "}
                    = ${l.resolvedAmount}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

// -------------------------------------------------------------------
// Payroll-3C-4 (2026-09-09) — one-time adjustment UI primitives.
// -------------------------------------------------------------------

interface CatalogueComponent {
  id: string;
  code: string;
  displayName: string;
  category: string;
  side: "EMPLOYEE" | "EMPLOYER";
  cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
  calculationMethod: "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS";
  active: boolean;
}

function cashEffectSentence(c: Pick<CatalogueComponent, "cashEffect">) {
  switch (c.cashEffect) {
    case "INCREASES_NET_PAY":  return "Employee cash: increases";
    case "DECREASES_NET_PAY":  return "Employee cash: decreases (deduction)";
    case "NO_NET_PAY_EFFECT":  return "Employee cash: no change";
    default:                   return "";
  }
}

function AddAdjustmentForm({
  clubId, batchId, batchStatus, batchEmployeeId, onAdded,
}: {
  clubId: string; batchId: string; batchStatus: string; batchEmployeeId: string;
  onAdded: () => void;
}) {
  const [open, setOpen]           = useState(false);
  const [catalogue, setCatalogue] = useState<CatalogueComponent[] | null>(null);
  const [code, setCode]           = useState<string>("");
  const [amount, setAmount]       = useState<string>("");
  const [reason, setReason]       = useState<string>("");
  const [busy, setBusy]           = useState(false);
  const [err, setErr]             = useState<string | null>(null);

  const selected = catalogue?.find((c) => c.code === code) ?? null;

  async function loadCatalogue() {
    if (catalogue) return;
    const res = await fetch(`/api/clubs/${clubId}/payroll/components`);
    if (res.ok) {
      const j = (await res.json()) as { components: CatalogueComponent[] };
      // Only FIXED_AMOUNT + active components; PERCENT one-time
      // adjustments are deferred (§8 of the 3C-4 brief).
      setCatalogue(j.components.filter((c) => c.active && c.calculationMethod === "FIXED_AMOUNT"));
    } else {
      setErr(`Could not load components (HTTP ${res.status})`);
    }
  }

  async function submit() {
    setErr(null); setBusy(true);
    try {
      const res = await fetch(`/api/clubs/${clubId}/payroll/batches/${batchId}/adjustments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchEmployeeId, componentCode: code, amount: amount.trim(), reason: reason.trim(),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setErr(body.error ?? `HTTP ${res.status}`); return; }
      setOpen(false); setCode(""); setAmount(""); setReason("");
      onAdded();
    } finally { setBusy(false); }
  }

  if (!open) {
    return (
      <div className="mb-2">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => { setOpen(true); void loadCatalogue(); }}
          data-testid="adjustment-open"
        >
          + Add one-time adjustment
        </button>
        <span className="ml-2 text-[10px]" style={{ color: "var(--spectre-text-muted)" }}>
          batch is {batchStatus}
        </span>
      </div>
    );
  }
  return (
    <div
      className="mb-3 rounded border p-3 text-xs"
      style={{ borderColor: "var(--spectre-border-muted)", background: "#fffbe6" }}
      data-testid="adjustment-form"
    >
      <div className="mb-1 flex items-baseline justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--spectre-text-muted)" }}>
          Add one-time adjustment
        </div>
        <button
          type="button"
          onClick={() => { setOpen(false); setErr(null); }}
          className="text-[10px] underline"
          style={{ color: "var(--spectre-text-secondary)" }}
          data-testid="adjustment-cancel"
        >
          Cancel
        </button>
      </div>
      {err ? <p className="mb-1 text-red-700" data-testid="adjustment-error">{err}</p> : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--spectre-text-muted)" }}>Component</span>
          <select
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="spectre-input"
            data-testid="adjustment-component"
            disabled={!catalogue}
          >
            <option value="">— Select —</option>
            {catalogue?.map((c) => (
              <option key={c.id} value={c.code}>{c.displayName}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--spectre-text-muted)" }}>Amount (positive)</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="500.00"
            className="spectre-input"
            data-testid="adjustment-amount"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--spectre-text-muted)" }}>Reason (required)</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={240}
            placeholder="August performance bonus"
            className="spectre-input"
            data-testid="adjustment-reason"
          />
        </label>
      </div>
      {selected ? (
        <div className="mt-2 text-[10px]" style={{ color: "var(--spectre-text-secondary)" }} data-testid="adjustment-treatment">
          {selected.displayName} · {cashEffectSentence(selected)} · side {selected.side}
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || !code || !amount || !reason}
          onClick={submit}
          data-testid="adjustment-submit"
        >
          {busy ? "Adding…" : "Add to payroll"}
        </button>
      </div>
    </div>
  );
}

function RemoveAdjustmentButton({
  clubId, batchId, snapshotId, onRemoved,
}: {
  clubId: string; batchId: string; snapshotId: string; onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="text-[10px] text-red-700 underline"
      disabled={busy}
      data-testid={`adjustment-remove:${snapshotId}`}
      onClick={async () => {
        if (!confirm("Remove this one-time adjustment?")) return;
        setBusy(true);
        try {
          await fetch(`/api/clubs/${clubId}/payroll/batches/${batchId}/adjustments/${snapshotId}`,
            { method: "DELETE" });
          onRemoved();
        } finally { setBusy(false); }
      }}
    >
      remove
    </button>
  );
}
