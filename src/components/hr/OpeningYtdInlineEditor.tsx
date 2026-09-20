"use client";

// FPP-2 (2026-09-20) — Opening YTD Workspace (redesigned).
//
// The founder needs ONE unified data-entry surface for an employee's
// mid-year opening YTD position:
//
//   * Aggregate/statutory YTD fields (16 canonical items — earnings,
//     CPP/EI/tax, employer statutory) rendered as pre-listed rows.
//   * Per-Component YTD amounts (Cell Phone, RRSP EE/ER, LTD, AD&D,
//     Life, Dependent Life, Health & Dental) rendered as pre-listed
//     rows RIGHT ALONGSIDE — no picker prerequisite, no save-first
//     prerequisite, no hidden section.
//   * ONE Save Draft button that persists everything atomically.
//
// Any component the founder leaves blank is NOT persisted (no
// meaningless zero rows). Direct-edit in place works because each
// component row is submitted every save under a stable
// `component_<componentId>` field name — the atomic server action
// upserts to the row's current value.
//
// "+ Add another component" remains for unusual/historical items not
// pre-listed (rare — most Clubs list the same eight canonical rows).
//
// DRAFT-only editing. ACTIVE opening balances render read-only.

import { useMemo, useState } from "react";

type Status = "MISSING" | "DRAFT" | "VALIDATED" | "ACTIVE" | "SUPERSEDED";
type PriorPayrollKind = "PRIOR_SYSTEM_SAME_EMPLOYER" | "PRIOR_EMPLOYER" | "PRIOR_ADJUSTMENT";
type Side = "EMPLOYEE" | "EMPLOYER";
type CashEffect = "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";

export interface OpeningYtdComponentOpening {
  id: string;
  componentCode: string;
  displayName: string;
  category: string;
  side: Side;
  cashEffect: CashEffect;
  ytdAmount: string;
}
export interface OpeningYtdComponentChoice {
  id: string;
  code: string;
  displayName: string;
  category: string;
  side: Side;
  cashEffect: CashEffect;
  active: boolean;
}

export interface OpeningYtdInlineEditorProps {
  employeeId: string;
  taxYear: number;
  firstSpectrePayDateIso: string | null;
  canWrite: boolean;
  status: Status;
  openingBalanceId: string | null;
  throughPayDateIso: string | null;
  priorPayrollKind: PriorPayrollKind | null;
  /** FPP-2 (2026-09-20) — the "Set / Edit opening YTD" button now
   *  navigates to the dedicated workspace page instead of opening a
   *  modal. When present, entry buttons render as anchors to this URL.
   *  Left optional for backward compatibility. */
  workspaceHref?: string;
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
    /** FPP-2 atomic single-save action. Persists parent + components in one tx. */
    saveDraft: (form: FormData) => Promise<void>;
    validate: (form: FormData) => Promise<void>;
    activate: (form: FormData) => Promise<void>;
    /** Retained for "+ Add another component" secondary flow on unusual items. */
    addComponent?: (form: FormData) => Promise<void>;
    removeComponent?: (form: FormData) => Promise<void>;
  };
  componentOpenings?: OpeningYtdComponentOpening[];
  componentCatalogue?: OpeningYtdComponentChoice[];
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

// Grouping decisions: the founder brief's canonical shape — earnings,
// statutory deductions, employee deductions, employer contributions &
// benefits, other earnings/allowances, employer statutory. Components
// route to a section by (side, category, cashEffect).
type Section =
  | "EARNINGS"
  | "STAT_EMPLOYEE"
  | "EMPLOYEE_DEDUCTIONS"
  | "EMPLOYER_BENEFITS"
  | "OTHER_ALLOWANCES"
  | "STAT_EMPLOYER";

function componentSection(c: { side: Side; category: string; cashEffect: CashEffect }): Section {
  if (c.side === "EMPLOYEE") {
    if (c.category === "ALLOWANCE" || c.category === "ADDITIONAL_EARNING" || c.category === "REGULAR_EARNING") {
      return "OTHER_ALLOWANCES";
    }
    // Employee deductions (RRSP EE, LTD, etc.)
    return "EMPLOYEE_DEDUCTIONS";
  }
  // Employer side — all group under employer benefits / contributions.
  return "EMPLOYER_BENEFITS";
}

export default function OpeningYtdInlineEditor(props: OpeningYtdInlineEditorProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const pill = statusPill(props.status);
  const canEdit = props.canWrite && props.status !== "ACTIVE" && props.status !== "SUPERSEDED";

  const defaultThrough = props.throughPayDateIso
    ? props.throughPayDateIso.slice(0, 10)
    : (props.firstSpectrePayDateIso
        ? (() => {
            const d = new Date(props.firstSpectrePayDateIso);
            d.setUTCDate(d.getUTCDate() - 1);
            return d.toISOString().slice(0, 10);
          })()
        : "");

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
          props.workspaceHref ? (
            <a
              href={props.workspaceHref}
              className="btn btn-secondary btn-sm"
              data-testid="opening-ytd-open-editor"
            >
              {props.status === "MISSING" ? "Set opening YTD" : "Edit opening YTD"}
            </a>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setOpen(true)}
              data-testid="opening-ytd-open-editor"
            >
              {props.status === "MISSING" ? "Set opening YTD" : "Edit opening YTD"}
            </button>
          )
        ) : null}
        {props.status === "ACTIVE" ? (
          props.workspaceHref ? (
            <a
              href={props.workspaceHref}
              className="btn btn-secondary btn-sm"
              data-testid="opening-ytd-view-values"
            >
              View values
            </a>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setOpen(true)}
              data-testid="opening-ytd-view-values"
            >
              View values
            </button>
          )
        ) : null}
      </div>

      {props.status === "ACTIVE" && props.values ? (
        <ValuesSummary
          throughPayDateIso={props.throughPayDateIso}
          priorPayrollKind={props.priorPayrollKind}
          values={props.values}
          componentOpenings={props.componentOpenings ?? []}
        />
      ) : null}

      {open ? (
        <Workspace
          {...props}
          canEdit={canEdit}
          defaultThrough={defaultThrough}
          pending={pending}
          setPending={setPending}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------------
// Workspace — the redesigned unified data-entry surface
// -------------------------------------------------------------------

function Workspace(props: OpeningYtdInlineEditorProps & {
  canEdit: boolean;
  defaultThrough: string;
  pending: boolean;
  setPending: (v: boolean) => void;
  onClose: () => void;
}) {
  const {
    canEdit, defaultThrough, pending, setPending, onClose,
    componentOpenings = [],
    componentCatalogue = [],
  } = props;

  // Merge catalogue + existing opening rows into a single ordered list
  // of "component slots" — one row per component the founder should
  // see up-front. Existing openings preserve their id + amount for
  // direct-edit; catalogue-only rows expose the component's id so the
  // atomic save can create the row on submission.
  const slots = useMemo(() => {
    const byCode = new Map<string, {
      key: string; componentId: string; code: string; displayName: string;
      side: Side; category: string; cashEffect: CashEffect;
      existingRowId: string | null; initialAmount: string; active: boolean;
      catalogueMember: boolean;
    }>();
    // Seed from catalogue (active components first, ordered by side/section).
    for (const c of componentCatalogue) {
      byCode.set(c.code, {
        key: c.code,
        componentId: c.id,
        code: c.code,
        displayName: c.displayName,
        side: c.side,
        category: c.category,
        cashEffect: c.cashEffect,
        existingRowId: null,
        initialAmount: "",
        active: c.active,
        catalogueMember: true,
      });
    }
    // Overlay existing rows. If a row references a component that's no
    // longer in the catalogue (deactivated / renamed), still surface it
    // so its historical amount stays editable — the row is authoritative
    // for what was saved.
    for (const r of componentOpenings) {
      const existing = byCode.get(r.componentCode);
      if (existing) {
        existing.existingRowId = r.id;
        existing.initialAmount = r.ytdAmount ?? "";
      } else {
        byCode.set(r.componentCode, {
          key: r.componentCode,
          // No live componentId (component may have been deactivated /
          // removed from catalogue). We fall back to the row's own id
          // so the atomic action can still round-trip the existing
          // amount without needing to look up the catalogue row.
          componentId: "",
          code: r.componentCode,
          displayName: r.displayName,
          side: r.side,
          category: r.category,
          cashEffect: r.cashEffect,
          existingRowId: r.id,
          initialAmount: r.ytdAmount ?? "",
          active: false,
          catalogueMember: false,
        });
      }
    }
    return Array.from(byCode.values());
  }, [componentCatalogue, componentOpenings]);

  const slotsBySection: Record<Section, typeof slots> = {
    EARNINGS: [],
    STAT_EMPLOYEE: [],
    EMPLOYEE_DEDUCTIONS: [],
    EMPLOYER_BENEFITS: [],
    OTHER_ALLOWANCES: [],
    STAT_EMPLOYER: [],
  };
  for (const s of slots) slotsBySection[componentSection(s)].push(s);
  for (const key of Object.keys(slotsBySection) as Section[]) {
    slotsBySection[key].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/40 p-6"
      role="dialog"
      aria-modal
      data-testid="opening-ytd-modal"
    >
      <div className="w-full max-w-4xl rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-baseline justify-between">
          <div>
            <h3 className="text-lg font-semibold text-stone-900">
              Opening YTD — {props.taxYear}
            </h3>
            <p className="mt-1 text-xs text-stone-600">
              One position. Enter every value you have from the prior payroll — aggregate totals
              (gross / CPP / EI / tax) <em>and</em> per-component amounts (RRSP, LTD, benefits) — in
              any order. Then click <strong>Save Draft</strong> once. Blank rows are not saved.
              Values become immutable only when you <em>Activate</em>.
            </p>
          </div>
          <button
            type="button"
            className="text-sm text-stone-500 hover:text-stone-900"
            onClick={onClose}
            data-testid="opening-ytd-close"
          >
            ✕ Close
          </button>
        </div>

        {props.status === "ACTIVE" ? (
          <div className="mb-4 rounded border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
            This opening YTD is <strong>Active</strong> and immutable. To correct it, create a
            new opening balance under Payroll Settings → Opening YTD Balances (supersede
            workflow).
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="opening-ytd-meta">
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
              <span className="mt-1 block text-[10px] text-stone-500">
                Must be strictly earlier than the Club's first Spectre pay date
                {props.firstSpectrePayDateIso
                  ? ` (${props.firstSpectrePayDateIso.slice(0, 10)})`
                  : ""}.
              </span>
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
            {slotsBySection.OTHER_ALLOWANCES.map((s) => (
              <ComponentField key={s.key} slot={s} disabled={!canEdit} />
            ))}
          </FieldsetGroup>

          <FieldsetGroup title="Statutory deductions" testId="opening-ytd-employee-stat">
            <MoneyField name="ytdCppEE"            label="CPP (Box 16)"          initial={props.values?.ytdCppEE} disabled={!canEdit} />
            <MoneyField name="ytdCpp2EE"           label="CPP2 (Box 16A)"        initial={props.values?.ytdCpp2EE} disabled={!canEdit} />
            <MoneyField name="ytdEiEE"             label="EI (Box 18)"           initial={props.values?.ytdEiEE} disabled={!canEdit} />
            <MoneyField name="ytdFederalTax"       label="Federal income tax"    initial={props.values?.ytdFederalTax} disabled={!canEdit} />
            <MoneyField name="ytdProvincialTax"    label="Provincial income tax" initial={props.values?.ytdProvincialTax} disabled={!canEdit} />
          </FieldsetGroup>

          <CppAdvancedDetails
            values={props.values}
            disabled={!canEdit}
          />

          {slotsBySection.EMPLOYEE_DEDUCTIONS.length > 0 ? (
            <FieldsetGroup title="Employee deductions" testId="opening-ytd-employee-deductions">
              {slotsBySection.EMPLOYEE_DEDUCTIONS.map((s) => (
                <ComponentField key={s.key} slot={s} disabled={!canEdit} />
              ))}
            </FieldsetGroup>
          ) : null}

          {slotsBySection.EMPLOYER_BENEFITS.length > 0 ? (
            <FieldsetGroup title="Employer contributions & benefits" testId="opening-ytd-employer-benefits">
              {slotsBySection.EMPLOYER_BENEFITS.map((s) => (
                <ComponentField key={s.key} slot={s} disabled={!canEdit} />
              ))}
            </FieldsetGroup>
          ) : null}

          <FieldsetGroup title="Employer statutory contributions" testId="opening-ytd-employer">
            <MoneyField name="ytdCppER"        label="Employer CPP"        initial={props.values?.ytdCppER} disabled={!canEdit} />
            <MoneyField name="ytdCpp2ER"       label="Employer CPP2"       initial={props.values?.ytdCpp2ER} disabled={!canEdit} />
            <MoneyField name="ytdEiER"         label="Employer EI"         initial={props.values?.ytdEiER} disabled={!canEdit} />
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

          <AddAnotherComponentControls
            employeeId={props.employeeId}
            openingBalanceId={props.openingBalanceId}
            status={props.status}
            canWrite={props.canWrite}
            pending={pending}
            setPending={setPending}
            componentCatalogue={componentCatalogue}
            slots={slots}
            addAction={props.actions.addComponent}
          />

          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            {canEdit ? (
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={pending}
                data-testid="opening-ytd-save-draft"
              >
                {pending ? "Saving..." : "Save Draft"}
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
                Mark Ready
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
              onClick={onClose}
              data-testid="opening-ytd-cancel"
            >
              {canEdit ? "Cancel" : "Close"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------
// Sub-components
// -------------------------------------------------------------------

function ComponentField({
  slot,
  disabled,
}: {
  slot: {
    key: string;
    componentId: string;
    code: string;
    displayName: string;
    initialAmount: string;
    active: boolean;
    catalogueMember: boolean;
  };
  disabled: boolean;
}) {
  const hasId = slot.componentId !== "";
  return (
    <label className="block text-xs" data-testid={`opening-ytd-component-${slot.code}`}>
      <span className="mb-1 block font-semibold text-stone-700">
        {slot.displayName}
        {!slot.active ? (
          <span className="ml-1 text-[10px] font-normal italic text-stone-400">inactive</span>
        ) : null}
      </span>
      {hasId ? (
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          name={`component_${slot.componentId}`}
          defaultValue={slot.initialAmount ?? ""}
          disabled={disabled}
          placeholder="0.00"
          className="w-full rounded border border-stone-300 px-2 py-1.5 text-right font-mono text-sm"
          data-testid={`opening-ytd-component-input-${slot.code}`}
        />
      ) : (
        // Orphaned historical row (component removed from catalogue) —
        // show its amount read-only. No submission field.
        <div
          className="w-full rounded border border-stone-200 bg-stone-50 px-2 py-1.5 text-right font-mono text-sm text-stone-500"
          data-testid={`opening-ytd-component-orphan-${slot.code}`}
        >
          {fmtMoney(slot.initialAmount)} <span className="ml-1 text-[10px] italic">read-only</span>
        </div>
      )}
    </label>
  );
}

function CppAdvancedDetails({
  values,
  disabled,
}: {
  values: OpeningYtdInlineEditorProps["values"];
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  // FPP-2 §13 — decompose CPP base + first-additional only when the
  // administrator explicitly opens the Advanced surface. Default form
  // stays clean; internal fields still round-trip through hidden inputs
  // so historical drafts (like Chris's) keep their values intact.
  const baseEE = values?.ytdCppEE_Base ?? "";
  const firstAddEE = values?.ytdCppEE_FirstAdd ?? "";
  const baseER = values?.ytdCppER_Base ?? "";
  const firstAddER = values?.ytdCppER_FirstAdd ?? "";
  return (
    <div className="rounded border border-dashed border-stone-300 bg-stone-50 p-3" data-testid="opening-ytd-cpp-advanced">
      <button
        type="button"
        className="text-xs font-semibold text-stone-700 hover:underline"
        onClick={() => setOpen((v) => !v)}
        data-testid="opening-ytd-cpp-advanced-toggle"
      >
        {open ? "▾" : "▸"} Advanced CPP details (base + first-additional decomposition)
      </button>
      {!open ? (
        // Preserve any prior-persisted decomposition on save even while
        // the surface is collapsed.
        <>
          <input type="hidden" name="ytdCppEE_Base"      value={baseEE || "0"} />
          <input type="hidden" name="ytdCppEE_FirstAdd"  value={firstAddEE || "0"} />
          <input type="hidden" name="ytdCppER_Base"      value={baseER || "0"} />
          <input type="hidden" name="ytdCppER_FirstAdd"  value={firstAddER || "0"} />
          <p className="mt-1 text-[11px] text-stone-500">
            Most prior payroll systems only expose CPP total. Leave this collapsed unless the
            source system reports Base + First-additional separately.
          </p>
        </>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <MoneyField name="ytdCppEE_Base"      label="CPP base"                initial={baseEE}      disabled={disabled} />
          <MoneyField name="ytdCppEE_FirstAdd"  label="CPP first-additional"    initial={firstAddEE}  disabled={disabled} />
          <MoneyField name="ytdCppER_Base"      label="Employer CPP base"       initial={baseER}      disabled={disabled} />
          <MoneyField name="ytdCppER_FirstAdd"  label="Employer CPP first-add." initial={firstAddER}  disabled={disabled} />
        </div>
      )}
    </div>
  );
}

function AddAnotherComponentControls(props: {
  employeeId: string;
  openingBalanceId: string | null;
  status: Status;
  canWrite: boolean;
  pending: boolean;
  setPending: (v: boolean) => void;
  componentCatalogue: OpeningYtdComponentChoice[];
  slots: Array<{ code: string }>;
  addAction?: (fd: FormData) => Promise<void>;
}) {
  const [show, setShow] = useState(false);
  // "+ Add another component" is a SECONDARY flow — the primary flow is
  // the pre-listed rows above. It exists so historical rare items can
  // be captured without polluting the main workspace with 40 blank rows.
  //
  // Restricted to catalogue codes that DON'T already have a pre-listed
  // slot (which covers every active + historical row). Duplicate
  // prevention piggybacks the @@unique(openingBalanceId, componentCode)
  // constraint at the service layer.
  const shownCodes = new Set(props.slots.map((s) => s.code));
  const extraChoices = props.componentCatalogue.filter((c) => !shownCodes.has(c.code));
  const canUse = props.canWrite
    && props.status === "DRAFT"
    && !!props.openingBalanceId
    && !!props.addAction
    && extraChoices.length > 0;
  if (!canUse) return null;
  return (
    <div className="rounded border border-dashed border-stone-300 p-3" data-testid="opening-ytd-add-another">
      {!show ? (
        <button
          type="button"
          className="text-xs font-semibold text-stone-700 hover:underline"
          onClick={() => setShow(true)}
          data-testid="opening-ytd-add-another-toggle"
        >
          + Add another component
        </button>
      ) : (
        <form
          action={async (fd) => {
            props.setPending(true);
            try { await props.addAction!(fd); } finally { props.setPending(false); }
          }}
          className="flex flex-wrap items-end gap-2"
          data-testid="opening-ytd-add-another-form"
        >
          <input type="hidden" name="employeeId" value={props.employeeId} />
          <input type="hidden" name="openingBalanceId" value={props.openingBalanceId!} />
          <label className="block text-xs">
            <span className="mb-1 block font-semibold text-stone-700">Component</span>
            <select
              name="componentId"
              required
              defaultValue=""
              className="rounded border border-stone-300 px-2 py-1.5 text-sm"
              data-testid="opening-ytd-add-another-picker"
            >
              <option value="" disabled>Select…</option>
              {extraChoices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName} — {c.side === "EMPLOYEE" ? "EE" : "ER"}
                  {c.active ? "" : " · inactive"}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-semibold text-stone-700">YTD amount</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              name="ytdAmount"
              required
              placeholder="0.00"
              className="w-32 rounded border border-stone-300 px-2 py-1.5 text-right font-mono text-sm"
              data-testid="opening-ytd-add-another-amount"
            />
          </label>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={props.pending}
            data-testid="opening-ytd-add-another-submit"
          >
            Add
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShow(false)}
            data-testid="opening-ytd-add-another-cancel"
          >
            Cancel
          </button>
        </form>
      )}
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
  componentOpenings,
}: {
  throughPayDateIso: string | null;
  priorPayrollKind: PriorPayrollKind | null;
  values: NonNullable<OpeningYtdInlineEditorProps["values"]>;
  componentOpenings: OpeningYtdComponentOpening[];
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
      {componentOpenings.length > 0 ? (
        <div className="mt-2 border-t pt-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-stone-500">Payroll components</div>
          <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            {componentOpenings.map((c) => (
              <>
                <span key={`${c.id}-l`} className="text-stone-500">{c.displayName}</span>
                <span key={`${c.id}-v`} className="font-mono">{fmtMoney(c.ytdAmount)}</span>
              </>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
