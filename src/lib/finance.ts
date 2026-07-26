// Pure helpers for financing math and currency formatting.
// Kept side-effect-free so they can be used in seed scripts, API routes,
// and React components without pulling in Prisma.

export type AmortizationRow = {
  paymentNumber: number;
  dueDate: Date;
  paymentAmount: number;
  principalAmount: number;
  interestAmount: number;
  remainingBalance: number;
};

export type AmortizationResult = {
  monthlyPayment: number;
  totalInterest: number;
  totalPaid: number;
  schedule: AmortizationRow[];
};

export function calculateAmortization(
  principal: number,
  annualRate: number,
  termMonths: number,
  startDate: Date = new Date()
): AmortizationResult {
  const monthlyRate = annualRate / 12;
  const monthlyPayment =
    monthlyRate === 0
      ? principal / termMonths
      : (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -termMonths));

  let remaining = principal;
  const schedule: AmortizationRow[] = [];
  let totalInterest = 0;

  for (let i = 1; i <= termMonths; i++) {
    const interest = remaining * monthlyRate;
    let principalPaid = monthlyPayment - interest;
    if (i === termMonths) {
      principalPaid = remaining; // ensure final payment zeroes the balance
    }
    remaining = Math.max(0, remaining - principalPaid);
    totalInterest += interest;

    const dueDate = new Date(startDate);
    dueDate.setMonth(dueDate.getMonth() + i);

    schedule.push({
      paymentNumber: i,
      dueDate,
      paymentAmount: round2(principalPaid + interest),
      principalAmount: round2(principalPaid),
      interestAmount: round2(interest),
      remainingBalance: round2(remaining),
    });
  }

  return {
    monthlyPayment: round2(monthlyPayment),
    totalInterest: round2(totalInterest),
    totalPaid: round2(principal + totalInterest),
    schedule,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatCurrency(amount: number | null | undefined): string {
  if (amount == null) return "$0.00";
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    minimumFractionDigits: 2,
  }).format(amount);
}

export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Used by operational receipt logs (POS history, AP captures) where a
// member or auditor needs to know exactly when a transaction happened,
// not just the calendar day.
export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
