"use client";

// EPW-1 hotfix (2026-09-20) — inline Opening YTD editor for
// Employee → Payroll → Implementation & YTD.
//
// The founder never leaves the employee profile for opening-YTD work.
// Draft / Validate / Activate all submit through server actions that
// redirect back to `/app/admin/people/employees/[id]?tab=payroll`.
//
// Uses the same canonical `OpeningBalanceFields` model as the
// Club-level workspace; nothing is duplicated. All 16 fields exposed
// with human-readable grouping (earnings / employee statutory /
// employer statutory) so the founder can see the parallel-payroll
// values line up with T4 boxes and the CRA statement.

import { useState } from "react";

type Status = "MISSING" | "DRAFT" | "VALIDATED" | "ACTIVE" | "SUPERSEDED";
type PriorPayrollKind = "PRIOR_SYSTEM_SAME_EMPLOYER" | "PRIOR_EMPLOYER" | "PRIOR_ADJUSTMENT";

export interface OpeningYtdInlineEditorProps {
  employeeId: string;
  taxYear: number;
  firstSpectrePayDateIso: string | null;
  canWrite: boolean;
  status: Status;
  openingBalanceId: string | null;
  throughPayDateIso: string | null;
  priorPayrollKind: PriorPayrollKind | null;
  values: {
    ytdGrossEarnings: string;
    ytdTaxableEarnings: string;
    ytdPensionableEarnings: string;
    ytdInsurableEarnings: string;
    ytdCppEE_Base: string;
    ytdCppEE_FirstAdd: string;
    ytdCppEE: string;
    ytdCpp2EE: string;
    ytdEiEE: string;
    ytdFederalTax: string;
    ytdProvincialTax: string;
    ytdCppER_Base: string;
    ytdCppER_FirstAdd: string;
    ytdCppER: string;
    ytdCpp2ER: string;
    ytdEiER: string;
  } | null;
  actions: {
    saveDraft: (form: FormData) => Promise<void>;
    validate: (form: FormData) => Promise<void>;
    activate: (form: FormData) => Promise<void>;
  };
}

const KIND_LABELS: Record<PriorPayrollKind, string> = {
  PRIOR_SYSTEM_SAME_EMPLOYER: "Previous payroll system — same employer",
  PRIOR_EMPLOYER:             "Previous employer (different business)",
  PRIOR_ADJUSTMENT:           "Opening balance adjustment / correction",
};

function fmtMoney(v: string | null | undefined): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function statusPill(s: Status): { tone: "ok" | "warn" | "neutral"; label: string } {
  switch (s) {
    case "ACTIVE":     return { tone: "ok",      label: "Active" };
    case "VALIDATED":  return { tone: "ok",      label: "Ready" };
    case "DRAFT":      return { tone: "warn",    label: "Draft" };
    case "SUPERSEDED": return { tone: "neutral", label: "Superseded" };
    default:           return { tone: "warn",    label: "Not started" };
  }
}

export default function OpeningYtdInlineEditor(props: OpeningYtdInlineEditorProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const pill = statusPill(props.status);
  const canEdit = props.canWrite && props.status !== "ACTIVE" && props.status !== "SUPERSEDED";

  // Prefill through-pay-date: use existing, else fall back to first Spectre pay date minus 1 day.
  const defaultThrough = props.throughPayDateIso
    ? props.throughPayDateIso.slice(0, 10)
    : (props.firstSpectrePayDateIso ? props.firstSpectrePayDateIso.slice(0, 10) : "");

  return (
    <div data-testid="opening-ytd-inline-editor">
      <div className="flex items-center gap-3">
        <span
          className={
            pill.tone === "ok"
              ? "inline-flex items-center rounded-full bg-[#dcfce7] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#166534]"
              : pill.tone === "warn"
              ? "inline-flex items-center rounded-full bg-[#fef3c7] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#92400e]"
              : "inline-flex items-center rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-700"
          }
          data-testid="opening-ytd-status-pill"
        >
          {pill.label}
        </span>
        {canEdit ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setOpen(true)}
            data-testid="opening-ytd-open-editor"
          >
            {props.status === "MISSING" ? "Set opening YTD" : "Edit opening YTD"}
          </button>
        ) : null}
        {props.status === "ACTIVE" ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setOpen(true)}
            data-testid="opening-ytd-view-values"
          >
            View values
          </button>
        ) : null}
      </div>

      {props.status === "ACTIVE" && props.values ? (
        <ValuesSummary
          throughPayDateIso={props.throughPayDateIso}
          priorPayrollKind={props.priorPayrollKind}
          values={props.values}
        />
      ) : null}

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/40 p-6"
          role="dialog"
          aria-modal
          data-testid="opening-ytd-modal"
        >
          <div className="w-full max-w-3xl rounded-lg bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-baseline justify-between">
              <div>
                <h3 className="text-lg font-semibold text-stone-900">
                  Opening YTD — {props.taxYear}
                </h3>
                <p className="mt-1 text-xs text-stone-600">
                  Amounts accumulated <em>before</em> Spectre calculates the first Spectre payroll.
                  Do not include the first Spectre pay run in these totals.
                </p>
              </div>
              <button
                type="button"
                className="text-sm text-stone-500 hover:text-stone-900"
                onClick={() => setOpen(false)}
                data-testid="opening-ytd-close"
              >
                ✕ Close
              </button>
            </div>

            {props.status === "ACTIVE" ? (
              <div className="mb-4 rounded border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
                This opening YTD is <strong>Active</strong> and immutable. To correct it, create a
                new opening balance under Payroll Settings → Opening YTD Balances (supersede
                workflow), which is deliberately kept out of this editor.
              </div>
            ) : null}

            <form
              action={async (fd) => {
                setPending(true);
                try { await props.actions.saveDraft(fd); } finally { setPending(false); }
              }}
              className="space-y-6"
            >
              <input type="hidden" name="employeeId" value={props.employeeId} />
              <input type="hidden" name="taxYear" value={props.taxYear} />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block text-xs">
                  <span className="mb-1 block font-semibold text-stone-700">
                    Through pay date <span className="text-stone-400">(inclusive)</span>
                  </span>
                  <input
                    type="date"
                    name="throughPayDate"
                    defaultValue={defaultThrough}
                    disabled={!canEdit}
                    required
                    className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                    data-testid="opening-ytd-through-pay-date"
                  />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block font-semibold text-stone-700">Prior payroll source</span>
                  <select
                    name="priorPayrollKind"
                    defaultValue={props.priorPayrollKind ?? "PRIOR_SYSTEM_SAME_EMPLOYER"}
                    disabled={!canEdit}
                    className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                    data-testid="opening-ytd-prior-kind"
                  >
                    {(Object.keys(KIND_LABELS) as PriorPayrollKind[]).map((k) => (
                      <option key={k} value={k}>{KIND_LABELS[k]}</option>
                    ))}
                  </select>
                </label>
              </div>

              <FieldsetGroup title="Earnings" testId="opening-ytd-earnings">
                <MoneyField name="ytdGrossEarnings"       label="Gross earnings"       initial={props.values?.ytdGrossEarnings} disabled={!canEdit} />
                <MoneyField name="ytdTaxableEarnings"     label="Taxable earnings"     initial={props.values?.ytdTaxableEarnings} disabled={!canEdit} />
                <MoneyField name="ytdPensionableEarnings" label="Pensionable earnings" initial={props.values?.ytdPensionableEarnings} disabled={!canEdit} />
                <MoneyField name="ytdInsurableEarnings"   label="Insurable earnings"   initial={props.values?.ytdInsurableEarnings} disabled={!canEdit} />
              </FieldsetGroup>

              <FieldsetGroup title="Employee statutory deductions" testId="opening-ytd-employee-stat">
                <MoneyField name="ytdCppEE"        label="CPP total (Box 16)"     initial={props.values?.ytdCppEE} disabled={!canEdit} />
                <MoneyField name="ytdCppEE_Base"   label="CPP base"               initial={props.values?.ytdCppEE_Base} disabled={!canEdit} />
                <MoneyField name="ytdCppEE_FirstAdd" label="CPP first-additional" initial={props.values?.ytdCppEE_FirstAdd} disabled={!canEdit} />
                <MoneyField name="ytdCpp2EE"       label="CPP2 (Box 16A)"         initial={props.values?.ytdCpp2EE} disabled={!canEdit} />
                <MoneyField name="ytdEiEE"         label="EI (Box 18)"            initial={props.values?.ytdEiEE} disabled={!canEdit} />
                <MoneyField name="ytdFederalTax"   label="Federal income tax"     initial={props.values?.ytdFederalTax} disabled={!canEdit} />
                <MoneyField name="ytdProvincialTax" label="Provincial income tax" initial={props.values?.ytdProvincialTax} disabled={!canEdit} />
              </FieldsetGroup>

              <FieldsetGroup title="Employer contributions" testId="opening-ytd-employer">
                <MoneyField name="ytdCppER"        label="Employer CPP total"        initial={props.values?.ytdCppER} disabled={!canEdit} />
                <MoneyField name="ytdCppER_Base"   label="Employer CPP base"         initial={props.values?.ytdCppER_Base} disabled={!canEdit} />
                <MoneyField name="ytdCppER_FirstAdd" label="Employer CPP first-add." initial={props.values?.ytdCppER_FirstAdd} disabled={!canEdit} />
                <MoneyField name="ytdCpp2ER"       label="Employer CPP2"             initial={props.values?.ytdCpp2ER} disabled={!canEdit} />
                <MoneyField name="ytdEiER"         label="Employer EI"               initial={props.values?.ytdEiER} disabled={!canEdit} />
              </FieldsetGroup>

              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-stone-700">Notes (optional)</span>
                <textarea
                  name="notes"
                  rows={2}
                  disabled={!canEdit}
                  className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                  data-testid="opening-ytd-notes"
                />
              </label>

              <div className="flex flex-wrap items-center gap-3 border-t pt-4">
                {canEdit ? (
                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={pending}
                    data-testid="opening-ytd-save-draft"
                  >
                    {pending ? "Saving..." : "Save as draft"}
                  </button>
                ) : null}
                {props.openingBalanceId && props.status === "DRAFT" && props.canWrite ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={async () => {
                      const fd = new FormData();
                      fd.set("employeeId", props.employeeId);
                      fd.set("id", props.openingBalanceId!);
                      setPending(true);
                      try { await props.actions.validate(fd); } finally { setPending(false); }
                    }}
                    disabled={pending}
                    data-testid="opening-ytd-validate"
                  >
                    Mark ready
                  </button>
                ) : null}
                {props.openingBalanceId
                  && (props.status === "DRAFT" || props.status === "VALIDATED")
                  && props.canWrite ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={async () => {
                      if (!confirm("Activate opening YTD? Values become immutable and next payroll will use them.")) return;
                      const fd = new FormData();
                      fd.set("employeeId", props.employeeId);
                      fd.set("id", props.openingBalanceId!);
                      setPending(true);
                      try { await props.actions.activate(fd); } finally { setPending(false); }
                    }}
                    disabled={pending}
                    data-testid="opening-ytd-activate"
                  >
                    Activate
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm ml-auto"
                  onClick={() => setOpen(false)}
                  data-testid="opening-ytd-cancel"
                >
                  {canEdit ? "Cancel" : "Close"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FieldsetGroup({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-stone-500" data-testid={`${testId}-heading`}>
        {title}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function MoneyField({
  name, label, initial, disabled,
}: { name: string; label: string; initial: string | undefined | null; disabled: boolean }) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block font-semibold text-stone-700">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        name={name}
        defaultValue={initial ?? ""}
        disabled={disabled}
        placeholder="0.00"
        className="w-full rounded border border-stone-300 px-2 py-1.5 text-right font-mono text-sm"
        data-testid={`opening-ytd-${name}`}
      />
    </label>
  );
}

function ValuesSummary({
  throughPayDateIso,
  priorPayrollKind,
  values,
}: {
  throughPayDateIso: string | null;
  priorPayrollKind: PriorPayrollKind | null;
  values: NonNullable<OpeningYtdInlineEditorProps["values"]>;
}) {
  return (
    <div className="mt-3 space-y-2 text-xs text-stone-700" data-testid="opening-ytd-summary">
      {throughPayDateIso ? (
        <div>
          <span className="text-stone-500">Through pay date:</span>{" "}
          <span className="font-mono">{new Date(throughPayDateIso).toISOString().slice(0, 10)}</span>
        </div>
      ) : null}
      {priorPayrollKind ? (
        <div><span className="text-stone-500">Prior source:</span> {KIND_LABELS[priorPayrollKind]}</div>
      ) : null}
      <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <span className="text-stone-500">Gross</span>       <span className="font-mono">{fmtMoney(values.ytdGrossEarnings)}</span>
        <span className="text-stone-500">Taxable</span>     <span className="font-mono">{fmtMoney(values.ytdTaxableEarnings)}</span>
        <span className="text-stone-500">Pensionable</span> <span className="font-mono">{fmtMoney(values.ytdPensionableEarnings)}</span>
        <span className="text-stone-500">Insurable</span>   <span className="font-mono">{fmtMoney(values.ytdInsurableEarnings)}</span>
        <span className="text-stone-500">CPP EE</span>      <span className="font-mono">{fmtMoney(values.ytdCppEE)}</span>
        <span className="text-stone-500">CPP2 EE</span>     <span className="font-mono">{fmtMoney(values.ytdCpp2EE)}</span>
        <span className="text-stone-500">EI EE</span>       <span className="font-mono">{fmtMoney(values.ytdEiEE)}</span>
        <span className="text-stone-500">Fed. tax</span>    <span className="font-mono">{fmtMoney(values.ytdFederalTax)}</span>
        <span className="text-stone-500">Prov. tax</span>   <span className="font-mono">{fmtMoney(values.ytdProvincialTax)}</span>
        <span className="text-stone-500">Employer CPP</span><span className="font-mono">{fmtMoney(values.ytdCppER)}</span>
        <span className="text-stone-500">Employer CPP2</span><span className="font-mono">{fmtMoney(values.ytdCpp2ER)}</span>
        <span className="text-stone-500">Employer EI</span> <span className="font-mono">{fmtMoney(values.ytdEiER)}</span>
      </div>
    </div>
  );
}
