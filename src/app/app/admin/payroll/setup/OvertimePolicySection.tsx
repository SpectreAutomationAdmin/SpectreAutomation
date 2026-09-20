// Slice F (2026-09-19) — Payroll Settings §8: Overtime policy card.
//
// Slice F workweek-closeout (2026-09-19): SPLIT out the workweek anchor.
// The OT policy owns the statutory rules; the CLUB owns the workweek
// boundary. Alberta ES defines the "greater-of 8/44 at 1.5×" — it does
// NOT mandate a start day. See `WorkweekSection` for the sibling card.
//
// Read-only for now: the Spectre payroll engine supports the Alberta
// Employment Standards Act default (8/44 greater-of, 1.5×) as the ONLY
// calculable overtime-rules policy. Special arrangements
// (EXEMPT / AGREEMENT_REQUIRED / AVERAGING_REQUIRED) are declared on the
// Employee record and fail-closed at Prepare so payroll cannot silently
// miscalculate under an unsupported rule.

interface OvertimePolicyDisplay {
  overtimePolicyKind: string;
  overtimeDailyThresholdHours: string;
  overtimeWeeklyThresholdHours: string;
  overtimeMultiplier: string;
}

export default function OvertimePolicySection({
  policy,
}: {
  policy: OvertimePolicyDisplay | null;
}) {
  return (
    <section
      className="rounded-spectre-panel border p-spectre-6 mb-spectre-8"
      style={{ background: "var(--spectre-surface)", borderColor: "var(--spectre-border-hairline)" }}
      data-testid="payroll-overtime-policy-section"
    >
      {!policy ? (
        <p className="text-sm" style={{ color: "var(--spectre-text-secondary)" }}>
          Overtime policy is unavailable until Payroll Configuration is saved for this Club.
        </p>
      ) : (
        <>
          <div className="mb-4 flex items-baseline justify-between">
            <div>
              <div
                className="text-[11px] font-semibold uppercase tracking-[0.06em]"
                style={{ color: "var(--spectre-text-muted)" }}
              >
                Statutory policy in effect
              </div>
              <div
                className="mt-1 text-lg font-semibold"
                style={{ color: "var(--spectre-text-primary)" }}
                data-testid="ot-policy-kind"
              >
                {policy.overtimePolicyKind === "ALBERTA_DEFAULT_ES"
                  ? "Alberta Employment Standards default"
                  : policy.overtimePolicyKind}
              </div>
              <div
                className="mt-1 text-sm"
                style={{ color: "var(--spectre-text-secondary)" }}
              >
                {policy.overtimePolicyKind === "ALBERTA_DEFAULT_ES"
                  ? "Greater-of daily/weekly OT at 1.5×"
                  : null}
              </div>
            </div>
            <span
              className="inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.06em]"
              style={{
                background: "var(--spectre-accent-soft, #edf2ec)",
                color: "var(--spectre-accent, #2f5832)",
              }}
              data-testid="ot-policy-status-badge"
            >
              Fail-closed enforced
            </span>
          </div>

          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="ot-policy-details">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.06em]"
                  style={{ color: "var(--spectre-text-muted)" }}>
                Daily threshold
              </dt>
              <dd className="mt-1 text-base"
                  style={{ color: "var(--spectre-text-primary)" }}
                  data-testid="ot-policy-daily-threshold">
                {policy.overtimeDailyThresholdHours} hours
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.06em]"
                  style={{ color: "var(--spectre-text-muted)" }}>
                Weekly threshold
              </dt>
              <dd className="mt-1 text-base"
                  style={{ color: "var(--spectre-text-primary)" }}
                  data-testid="ot-policy-weekly-threshold">
                {policy.overtimeWeeklyThresholdHours} hours
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.06em]"
                  style={{ color: "var(--spectre-text-muted)" }}>
                Overtime multiplier
              </dt>
              <dd className="mt-1 text-base"
                  style={{ color: "var(--spectre-text-primary)" }}
                  data-testid="ot-policy-multiplier">
                {policy.overtimeMultiplier}×
              </dd>
            </div>
          </dl>

          <div
            className="mt-6 rounded border p-4 text-sm"
            style={{
              background: "var(--spectre-surface-muted, #faf7f2)",
              borderColor: "var(--spectre-border-hairline)",
              color: "var(--spectre-text-secondary)",
            }}
          >
            <p className="font-semibold" style={{ color: "var(--spectre-text-primary)" }}>
              What this means in practice
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>
                Every hourly employee&apos;s approved time is classified under this policy each pay period.
                Regular and overtime hours are frozen into the batch snapshot and posted as separate earnings.
              </li>
              <li>
                Employees whose situation does not fit the default policy — statutory exempts,
                overtime agreements, and averaging arrangements — are declared per-employee on
                the Employee Payroll workspace. Prepare refuses to calculate under an unsupported
                arrangement until the situation is declared.
              </li>
              <li>
                Additional statutory jurisdictions (other provinces, federal Part III workers) will
                arrive as first-class policies alongside this one — the engine is fail-closed to
                prevent silent miscalculation before they are certified.
              </li>
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
