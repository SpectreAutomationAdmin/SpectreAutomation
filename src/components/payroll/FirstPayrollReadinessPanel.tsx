// Slice E (2026-09-19) §24 — compact first-payroll readiness panel.
// Renders as a mixed READY / ACTION_REQUIRED / EXTERNAL summary; each
// failed item deep-links to the appropriate configuration surface.

import Link from "next/link";
import type { FirstPayrollReadinessV1 } from "@/lib/payroll/first-payroll-readiness";

const TONE: Record<string, { bg: string; fg: string; label: string }> = {
  READY:           { bg: "#dcfce7", fg: "#166534", label: "Ready" },
  ACTION_REQUIRED: { bg: "#fef3c7", fg: "#92400e", label: "Action required" },
  EXTERNAL:        { bg: "#e5e7eb", fg: "#374151", label: "External" },
};

export default function FirstPayrollReadinessPanel(
  { readiness }: { readiness: FirstPayrollReadinessV1 },
) {
  return (
    <section
      className="mb-spectre-8 rounded-spectre-panel border p-spectre-6"
      style={{ background: "var(--spectre-surface)", borderColor: "var(--spectre-border-hairline)" }}
      data-testid="first-payroll-readiness-panel"
    >
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-stone-500">
            First-payroll readiness · {readiness.taxYear}
          </div>
          <h2 className="mt-1 text-spectre-h3 font-semibold text-stone-900">
            {readiness.overallReady
              ? "Configuration prerequisites in place"
              : "Some configuration prerequisites still need attention"}
          </h2>
        </div>
      </div>
      <ul className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2 text-sm" data-testid="first-payroll-readiness-rows">
        {readiness.rows.map((r) => {
          const tone = TONE[r.state]!;
          return (
            <li
              key={r.key}
              className="rounded border p-2 flex items-center gap-3 bg-white"
              style={{ borderColor: "var(--spectre-border-muted)" }}
              data-testid={`readiness-row-${r.key}`}
            >
              <span
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase whitespace-nowrap"
                style={{ background: tone.bg, color: tone.fg }}
              >
                {tone.label}
              </span>
              <div className="flex-1">
                <div className="font-medium text-stone-900">{r.label}</div>
                <div className="text-[11px] text-stone-500">{r.detail}</div>
              </div>
              {r.actionHref && r.actionLabel && (
                <Link href={r.actionHref} className="text-[11px] underline text-stone-600 whitespace-nowrap">
                  {r.actionLabel}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[10px] text-stone-500">
        Employee payment always shows as External — Spectre does not yet transmit payments to a bank
        file or payment processor. Employees are paid outside Spectre until a payment slice ships.
      </p>
    </section>
  );
}
