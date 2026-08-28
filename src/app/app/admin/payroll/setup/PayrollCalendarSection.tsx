"use client";

import { useCallback, useMemo, useState } from "react";
import type { PayGroupView } from "@/lib/payroll/pay-groups";

interface PeriodRow {
  id?: string;
  sequenceInYear: number;
  taxYear: number;
  periodStart: string; // ISO
  periodEnd: string;   // ISO
  payDate: string;     // ISO
  status?: string;
}

interface Props {
  clubId: string;
  canWrite: boolean;
  payGroups: PayGroupView[];
  initialByGroup: Record<string, PeriodRow[]>;
  defaultTaxYear: number;
}

export default function PayrollCalendarSection({
  clubId,
  canWrite,
  payGroups,
  initialByGroup,
  defaultTaxYear,
}: Props) {
  const [taxYear, setTaxYear] = useState<number>(defaultTaxYear);
  const [rowsByGroup, setRowsByGroup] = useState<Record<string, PeriodRow[]>>(initialByGroup);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "idle" | "ok" | "err"; text: string }>({
    tone: "idle",
    text: "",
  });
  const [previewByGroup, setPreviewByGroup] = useState<Record<string, PeriodRow[] | null>>({});

  const api = useCallback(
    (payGroupId: string) => `/api/clubs/${clubId}/payroll/pay-groups/${payGroupId}/pay-periods`,
    [clubId],
  );

  const fetchYear = async (payGroupId: string, year: number) => {
    const res = await fetch(`${api(payGroupId)}?taxYear=${year}`);
    if (!res.ok) return [];
    const body = (await res.json()) as { periods: PeriodRow[] };
    return body.periods;
  };

  const setYear = async (year: number) => {
    setTaxYear(year);
    const next: Record<string, PeriodRow[]> = {};
    for (const g of payGroups) {
      next[g.id] = await fetchYear(g.id, year);
    }
    setRowsByGroup(next);
    setPreviewByGroup({});
  };

  const runPreview = async (payGroupId: string) => {
    setBusyId(payGroupId);
    setStatus({ tone: "idle", text: "" });
    try {
      const res = await fetch(api(payGroupId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", taxYear }),
      });
      if (!res.ok) throw new Error(await res.text());
      const body = (await res.json()) as { preview: PeriodRow[] };
      setPreviewByGroup((prev) => ({ ...prev, [payGroupId]: body.preview }));
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  };

  const generate = async (payGroupId: string) => {
    if (!canWrite) return;
    setBusyId(payGroupId);
    setStatus({ tone: "idle", text: "" });
    try {
      const res = await fetch(api(payGroupId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", taxYear }),
      });
      if (!res.ok) throw new Error(await res.text());
      const body = (await res.json()) as {
        result: { status: "created" | "existing-matches"; count: number; periods: PeriodRow[] };
      };
      setRowsByGroup((prev) => ({ ...prev, [payGroupId]: body.result.periods }));
      setPreviewByGroup((prev) => ({ ...prev, [payGroupId]: null }));
      setStatus({
        tone: "ok",
        text:
          body.result.status === "created"
            ? `Generated ${body.result.count} pay periods.`
            : `Schedule already exists and matches the current configuration.`,
      });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  };

  const yearOptions = useMemo(() => {
    const now = new Date().getUTCFullYear();
    return [now - 1, now, now + 1, now + 2];
  }, []);

  if (payGroups.length === 0) {
    return (
      <p className="text-sm text-stone-600" data-testid="pay-periods-empty-no-groups">
        Create at least one Pay Group in Section 2 before generating a payroll calendar.
      </p>
    );
  }

  return (
    <div className="space-y-5" data-testid="pay-periods-section">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm text-club-ink font-medium">Payroll year:</label>
        <select
          value={taxYear}
          onChange={(e) => setYear(Number(e.target.value))}
          className="spectre-input"
          data-testid="pay-periods-year"
        >
          {yearOptions.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        <span className="text-[11.5px] text-stone-500">
          Payroll year = the year the pay date falls in. A period worked in December that pays in
          January belongs to the January year.
        </span>
      </div>

      {payGroups.map((g) => {
        const rows = rowsByGroup[g.id] ?? [];
        const preview = previewByGroup[g.id];
        const needsAnchor =
          (g.payFrequency === "WEEKLY" || g.payFrequency === "BIWEEKLY") && !g.calendarAnchorDate;
        return (
          <div
            key={g.id}
            className="rounded-xl border border-stone-200 bg-white p-4 space-y-3"
            data-testid={`pay-periods-group-${g.id}`}
          >
            <div className="flex items-baseline gap-2 flex-wrap">
              <h3 className="font-serif text-[16px] text-club-ink">{g.name}</h3>
              <span className="font-mono text-xs text-stone-500">{g.code}</span>
              <span className="text-[11px] text-stone-500">
                {g.payFrequency.replace("_", "-").toLowerCase()} · pay date +{g.payDateOffsetDays}d
              </span>
              {!g.active && (
                <span className="text-[10px] uppercase tracking-widest rounded px-1.5 py-0.5 border border-stone-300 bg-stone-100 text-stone-500">
                  Inactive
                </span>
              )}
            </div>
            {needsAnchor ? (
              <p className="text-sm text-amber-800 bg-amber-50 border border-amber-300 rounded px-3 py-2">
                This {g.payFrequency.toLowerCase()} pay group needs a first known period start
                (calendar anchor) before Spectre can generate its schedule. Edit the pay group in
                Section 2 and add the anchor.
              </p>
            ) : rows.length === 0 ? (
              <div className="flex items-center gap-3">
                <p className="text-sm text-stone-600">
                  No pay periods generated for {taxYear} yet.
                </p>
                <button
                  type="button"
                  onClick={() => runPreview(g.id)}
                  disabled={busyId === g.id}
                  className="text-sm text-stone-600 hover:underline"
                  data-testid={`pay-periods-preview-${g.id}`}
                >
                  Preview schedule
                </button>
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => generate(g.id)}
                    disabled={busyId === g.id}
                    className="spectre-btn spectre-btn-primary"
                    data-testid={`pay-periods-generate-${g.id}`}
                  >
                    Generate pay periods
                  </button>
                )}
              </div>
            ) : (
              <PeriodsTable rows={rows} testIdPrefix={`pay-periods-row-${g.id}`} />
            )}
            {preview && preview.length > 0 && rows.length === 0 && (
              <div className="mt-3 rounded border border-sky-200 bg-sky-50 p-2">
                <p className="text-xs text-sky-900 font-semibold mb-1">
                  Preview of {preview.length} pay period{preview.length === 1 ? "" : "s"} (not saved):
                </p>
                <PeriodsTable rows={preview} testIdPrefix={`pay-periods-preview-row-${g.id}`} />
              </div>
            )}
          </div>
        );
      })}

      {status.text && (
        <p
          role={status.tone === "err" ? "alert" : "status"}
          className={
            "text-sm " +
            (status.tone === "ok" ? "text-emerald-700" : status.tone === "err" ? "text-red-700" : "text-stone-600")
          }
          data-testid="pay-periods-status"
        >
          {status.text}
        </p>
      )}
    </div>
  );
}

function PeriodsTable({ rows, testIdPrefix }: { rows: PeriodRow[]; testIdPrefix: string }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-[11px] uppercase tracking-widest text-stone-500 border-b border-stone-200/70">
          <th className="py-1 pr-3">#</th>
          <th className="py-1 pr-3">Period start</th>
          <th className="py-1 pr-3">Period end</th>
          <th className="py-1 pr-3">Pay date</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.id ?? `${r.sequenceInYear}-${r.payDate}`} className="border-b border-stone-200/50" data-testid={`${testIdPrefix}-${i}`}>
            <td className="py-1 pr-3 text-stone-500 font-mono">{r.sequenceInYear}</td>
            <td className="py-1 pr-3">{fmt(r.periodStart)}</td>
            <td className="py-1 pr-3">{fmt(r.periodEnd)}</td>
            <td className="py-1 pr-3 text-club-ink">{fmt(r.payDate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function fmt(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
