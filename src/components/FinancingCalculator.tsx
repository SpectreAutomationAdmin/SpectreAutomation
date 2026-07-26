"use client";

import { useMemo, useState } from "react";
import { calculateAmortization, formatCurrency, formatDate, formatPercent } from "@/lib/finance";

type Props = {
  memberId: string;
  defaultPrincipal?: number;
  defaultRate?: number;
  defaultTerm?: number;
  // Server action for "Accept and sign". Receives (formData).
  // We post: principal, interestRate (decimal), termMonths, paymentFrequency, signatureName.
  acceptAction: (formData: FormData) => Promise<void>;
};

export function FinancingCalculator({
  memberId,
  defaultPrincipal = 19600,
  defaultRate = 0.065,
  defaultTerm = 60,
  acceptAction,
}: Props) {
  const [principal, setPrincipal] = useState(defaultPrincipal);
  const [ratePct, setRatePct] = useState(defaultRate * 100);
  const [term, setTerm] = useState(defaultTerm);
  const [frequency, setFrequency] = useState("MONTHLY");
  const [signature, setSignature] = useState("");

  const result = useMemo(() => calculateAmortization(principal, ratePct / 100, term), [principal, ratePct, term]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="card card-body lg:col-span-1">
          <h2 className="section-title text-xl">Inputs</h2>
          <div className="mt-4 space-y-4">
            <div>
              <label className="label">Principal</label>
              <input
                type="number"
                className="input"
                value={principal}
                min={0}
                step={100}
                onChange={(e) => setPrincipal(Number(e.target.value) || 0)}
              />
            </div>
            <div>
              <label className="label">Annual interest rate</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  className="input"
                  value={ratePct}
                  step={0.05}
                  onChange={(e) => setRatePct(Number(e.target.value) || 0)}
                />
                <span className="text-sm text-stone-500">%</span>
              </div>
            </div>
            <div>
              <label className="label">Term (months)</label>
              <input
                type="number"
                className="input"
                value={term}
                min={1}
                max={120}
                onChange={(e) => setTerm(Number(e.target.value) || 1)}
              />
            </div>
            <div>
              <label className="label">Payment frequency</label>
              <select className="select" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                <option value="MONTHLY">Monthly</option>
                <option value="QUARTERLY">Quarterly (placeholder)</option>
                <option value="SEMI_ANNUAL">Semi-annual (placeholder)</option>
              </select>
            </div>
          </div>
        </div>

        <div className="card card-body lg:col-span-2">
          <h2 className="section-title text-xl">Summary</h2>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
            <Stat label="Monthly payment" value={formatCurrency(result.monthlyPayment)} />
            <Stat label="Total interest" value={formatCurrency(result.totalInterest)} />
            <Stat label="Total paid" value={formatCurrency(result.totalPaid)} />
          </div>

          <div className="mt-6 flex items-center gap-3">
            <button type="button" className="btn btn-secondary text-sm" onClick={() => alert("Promissory note PDF generation placeholder. FUTURE: integrate e-signature provider.")}>Generate Promissory Note (placeholder)</button>
          </div>

          <form action={acceptAction} className="mt-6 border-t border-stone-200 pt-6 space-y-3">
            <input type="hidden" name="memberId" value={memberId} />
            <input type="hidden" name="principal" value={principal} />
            <input type="hidden" name="interestRate" value={(ratePct / 100).toString()} />
            <input type="hidden" name="termMonths" value={term} />
            <input type="hidden" name="paymentFrequency" value={frequency} />
            <input type="hidden" name="monthlyPayment" value={result.monthlyPayment} />
            <input type="hidden" name="totalInterest" value={result.totalInterest} />
            <div>
              <label className="label">Typed signature</label>
              <input
                className="input font-serif italic text-lg"
                name="signatureName"
                placeholder="Type your full legal name"
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
              />
              <p className="mt-1 text-xs text-stone-500">By typing your name above you acknowledge and accept the schedule shown.</p>
            </div>
            <button type="submit" className="btn btn-primary" disabled={!signature.trim()}>Accept and sign</button>
          </form>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
          <h3 className="font-serif text-lg">Amortization schedule</h3>
          <div className="text-sm text-stone-500">{result.schedule.length} payments · {formatPercent(ratePct / 100)} APR</div>
        </div>
        <div className="overflow-x-auto max-h-[420px]">
          <table className="table-base">
            <thead className="sticky top-0">
              <tr>
                <th>#</th>
                <th>Due date</th>
                <th>Payment</th>
                <th>Principal</th>
                <th>Interest</th>
                <th>Remaining</th>
              </tr>
            </thead>
            <tbody>
              {result.schedule.map((r) => (
                <tr key={r.paymentNumber}>
                  <td className="text-stone-500">{r.paymentNumber}</td>
                  <td>{formatDate(r.dueDate)}</td>
                  <td>{formatCurrency(r.paymentAmount)}</td>
                  <td>{formatCurrency(r.principalAmount)}</td>
                  <td>{formatCurrency(r.interestAmount)}</td>
                  <td>{formatCurrency(r.remainingBalance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-stone-50 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-stone-500">{label}</div>
      <div className="mt-1 font-serif text-2xl text-club-ink">{value}</div>
    </div>
  );
}
