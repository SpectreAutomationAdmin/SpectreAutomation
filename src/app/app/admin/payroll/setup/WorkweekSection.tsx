// Slice F workweek-closeout (2026-09-19) — Payroll Settings: Workweek card.
//
// The CLUB's payroll workweek boundary. Distinct from the OT policy —
// Alberta ES does NOT mandate a start day; it's the employer's choice.
// Rendered as its own Section 9 in the Settings page so nothing implies
// the OT rules dictate the workweek.
//
// Read-only for now — write path lands with the Payroll Settings write
// form. If the value is NULL, Prepare fails-closed on hourly payrolls
// with a WORKWEEK_NOT_CONFIGURED blocker (see batch-preparation.ts).

const DAY_LABEL: Record<string, string> = {
  SUNDAY:    "Sunday",
  MONDAY:    "Monday",
  TUESDAY:   "Tuesday",
  WEDNESDAY: "Wednesday",
  THURSDAY:  "Thursday",
  FRIDAY:    "Friday",
  SATURDAY:  "Saturday",
};

// Returns the sibling weekday for the "start-end" range display. Since the
// workweek is 7 consecutive days, the end is the day BEFORE the start
// (cyclically). Sunday → Saturday; Monday → Sunday; etc.
function endOfWorkweek(start: string): string {
  const order = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  const i = order.indexOf(start);
  if (i < 0) return start;
  return order[(i + 6) % 7];
}

export default function WorkweekSection({
  workweekStartsOn,
}: {
  workweekStartsOn: string | null;
}) {
  const configured = !!workweekStartsOn && workweekStartsOn in DAY_LABEL;
  return (
    <section
      className="rounded-spectre-panel border p-spectre-6 mb-spectre-8"
      style={{ background: "var(--spectre-surface)", borderColor: "var(--spectre-border-hairline)" }}
      data-testid="payroll-workweek-section"
    >
      <div className="mb-4 flex items-baseline justify-between">
        <div>
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.06em]"
            style={{ color: "var(--spectre-text-muted)" }}
          >
            Club payroll workweek
          </div>
          <div
            className="mt-1 text-lg font-semibold"
            style={{ color: "var(--spectre-text-primary)" }}
            data-testid="workweek-value"
          >
            {configured
              ? `${DAY_LABEL[workweekStartsOn!]} – ${DAY_LABEL[endOfWorkweek(workweekStartsOn!)]}`
              : "Not configured"}
          </div>
        </div>
        {!configured ? (
          <span
            className="inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.06em]"
            style={{ background: "#fef3c7", color: "#78350f" }}
            data-testid="workweek-status-badge"
          >
            Required for hourly payroll
          </span>
        ) : (
          <span
            className="inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.06em]"
            style={{
              background: "var(--spectre-accent-soft, #edf2ec)",
              color: "var(--spectre-accent, #2f5832)",
            }}
            data-testid="workweek-status-badge"
          >
            Configured
          </span>
        )}
      </div>

      <div
        className="mt-4 rounded border p-4 text-sm"
        style={{
          background: "var(--spectre-surface-muted, #faf7f2)",
          borderColor: "var(--spectre-border-hairline)",
          color: "var(--spectre-text-secondary)",
        }}
      >
        <p className="font-semibold" style={{ color: "var(--spectre-text-primary)" }}>
          Why the workweek is a Club setting
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            Alberta Employment Standards defines the overtime <em>rules</em>
            {" "}(daily and weekly thresholds, the 1.5× multiplier). It does not
            dictate which day the workweek starts — that is the employer&apos;s
            choice, so long as the choice is documented and consistent.
          </li>
          <li>
            The workweek anchor is used by the overtime classifier to group
            approved time into 7-day windows before the 8/44 greater-of rule
            is applied. Changing it retroactively would change historical
            payrolls; Prepare freezes the workweek used at Prepare time onto
            each batch employee snapshot for that reason.
          </li>
          <li>
            Spectre refuses to prepare an hourly payroll until this value is
            set. There is no silent Sunday default — an explicit choice is
            required so the audit trail records the employer&apos;s decision.
          </li>
        </ul>
      </div>
    </section>
  );
}
