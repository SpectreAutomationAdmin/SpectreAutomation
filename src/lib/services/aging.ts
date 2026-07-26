// Pure aging calculation.
//
// Inputs: raw posted charges + posted payments + posted adjustments.
// Outputs: balance plus aging buckets and the running ledger.
//
// Allocation policy: payments + credits are applied FIFO against the oldest
// posted charge first. Reversed/voided rows are excluded (their statuses
// are set elsewhere — see ar.ts).

export type LedgerInput = {
  charges: Array<{ id: string; amount: number; dueDate: Date | null; transactionDate: Date; status: string; reversesId: string | null }>;
  payments: Array<{ id: string; amount: number; paymentDate: Date; status: string; reversesId: string | null }>;
  adjustments: Array<{ id: string; amount: number; type: string; transactionDate: Date; status: string }>;
};

export type AgingResult = {
  currentBalance: number;
  buckets: { current: number; d30: number; d60: number; d90: number; d120: number };
  creditBalance: number; // negative balances expressed positively
  ledger: Array<{ id: string; date: Date; type: "CHARGE" | "PAYMENT" | "ADJUSTMENT"; description: string; amount: number; signedAmount: number; runningBalance: number }>;
};

const DAY = 24 * 60 * 60 * 1000;

export function calculateAging(input: LedgerInput, asOf: Date = new Date()): AgingResult {
  // Keep only POSTED items.
  const charges = input.charges.filter((c) => c.status === "POSTED");
  const payments = input.payments.filter((p) => p.status === "SUCCESS");
  const adjustments = input.adjustments.filter((a) => a.status === "POSTED");

  // For aging: unpaid amount per charge.
  // Use FIFO: oldest unpaid charge gets paid first by each payment+credit.
  const remainingByCharge: Array<{ id: string; due: Date; remaining: number }> = charges
    .slice()
    .sort((a, b) => (a.dueDate ?? a.transactionDate).getTime() - (b.dueDate ?? b.transactionDate).getTime())
    .map((c) => ({ id: c.id, due: c.dueDate ?? c.transactionDate, remaining: c.amount }));

  // Apply payments + CREDIT/REFUND/WRITE_OFF adjustments to charges in date order.
  const credits: Array<{ date: Date; amount: number }> = [
    ...payments.map((p) => ({ date: p.paymentDate, amount: p.amount })),
    ...adjustments
      .filter((a) => a.type === "CREDIT" || a.type === "WRITE_OFF" || a.type === "REFUND")
      .map((a) => ({ date: a.transactionDate, amount: a.amount })),
  ];
  // DEBIT adjustments behave like additional charges.
  const debitsAsCharges = adjustments
    .filter((a) => a.type === "DEBIT")
    .map((a) => ({ id: `adj-${a.id}`, due: a.transactionDate, remaining: a.amount }));
  remainingByCharge.push(...debitsAsCharges);
  remainingByCharge.sort((a, b) => a.due.getTime() - b.due.getTime());

  // FIFO allocation.
  credits.sort((a, b) => a.date.getTime() - b.date.getTime());
  let creditPool = credits.reduce((s, c) => s + c.amount, 0);
  for (const row of remainingByCharge) {
    if (creditPool <= 0) break;
    const applied = Math.min(row.remaining, creditPool);
    row.remaining -= applied;
    creditPool -= applied;
  }

  // Sum buckets.
  const buckets = { current: 0, d30: 0, d60: 0, d90: 0, d120: 0 };
  for (const r of remainingByCharge) {
    if (r.remaining <= 0) continue;
    const ageDays = Math.floor((asOf.getTime() - r.due.getTime()) / DAY);
    if (ageDays < 30) buckets.current += r.remaining;
    else if (ageDays < 60) buckets.d30 += r.remaining;
    else if (ageDays < 90) buckets.d60 += r.remaining;
    else if (ageDays < 120) buckets.d90 += r.remaining;
    else buckets.d120 += r.remaining;
  }

  // Currency rounding.
  for (const k of Object.keys(buckets) as Array<keyof typeof buckets>) {
    buckets[k] = round2(buckets[k]);
  }
  const currentBalance = round2(buckets.current + buckets.d30 + buckets.d60 + buckets.d90 + buckets.d120);
  const creditBalance = round2(Math.max(0, creditPool));

  // Running-balance ledger across all event types.
  type LedgerRow = AgingResult["ledger"][number];
  const rows: LedgerRow[] = [];
  for (const c of charges) {
    rows.push({ id: c.id, date: c.transactionDate, type: "CHARGE", description: "", amount: c.amount, signedAmount: c.amount, runningBalance: 0 });
  }
  for (const p of payments) {
    rows.push({ id: p.id, date: p.paymentDate, type: "PAYMENT", description: "", amount: p.amount, signedAmount: -p.amount, runningBalance: 0 });
  }
  for (const a of adjustments) {
    const sign = (a.type === "CREDIT" || a.type === "REFUND" || a.type === "WRITE_OFF") ? -1 : 1;
    rows.push({ id: a.id, date: a.transactionDate, type: "ADJUSTMENT", description: "", amount: a.amount, signedAmount: sign * a.amount, runningBalance: 0 });
  }
  rows.sort((a, b) => a.date.getTime() - b.date.getTime());
  let running = 0;
  for (const r of rows) {
    running = round2(running + r.signedAmount);
    r.runningBalance = running;
  }

  return { currentBalance, buckets, creditBalance, ledger: rows };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
