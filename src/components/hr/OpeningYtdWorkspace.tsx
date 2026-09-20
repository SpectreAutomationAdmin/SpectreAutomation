"use client";

// FPP-2 (2026-09-20) — Opening YTD Workspace client component.
//
// Reference-driven full-page workspace layout:
//
//   two-column body {
//     main {
//       header (title + supporting copy + DRAFT pill + last saved timestamp)
//       through-pay-date + prior-payroll-source row
//       6-card grid (3 columns × 2 rows) — numbered cards
//         1. Earnings          2. Employee Statutory   3. Employer Statutory
//         4. Employee Deducts  5. Employer Benefits    6. Other Allowances
//       notes card (7)
//       bottom action bar (Cancel | Save Draft | Mark Ready | Activate)
//     }
//     right rail {
//       About Opening YTD
//       Highlighted callout (You can start with any section…)
//       Tips
//     }
//   }
//
// Every currency input is DIRECTLY editable while the parent DRAFT
// exists (or MISSING — the atomic action creates the parent + rows in
// one transaction on first Save Draft). No picker prerequisite, no
// save-first prerequisite, no hidden section.

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

export interface OpeningYtdWorkspaceProps {
  employeeId: string;
  employeeName: string;
  clubName: string;
  taxYear: number;
  firstSpectrePayDateIso: string | null;
  canWrite: boolean;
  status: Status;
  openingBalanceId: string | null;
  throughPayDateIso: string | null;
  priorPayrollKind: PriorPayrollKind | null;
  lastSavedIso: string | null;
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
    addComponent?: (form: FormData) => Promise<void>;
    removeComponent?: (form: FormData) => Promise<void>;
    updateComponent?: (form: FormData) => Promise<void>;
  };
  componentOpenings?: OpeningYtdComponentOpening[];
  componentCatalogue?: OpeningYtdComponentChoice[];
  backHref: string;
}

const KIND_LABELS: Record<PriorPayrollKind, string> = {
  PRIOR_SYSTEM_SAME_EMPLOYER: "Previous payroll system — same employer",
  PRIOR_EMPLOYER:             "Previous employer (different business)",
  PRIOR_ADJUSTMENT:           "Opening balance adjustment / correction",
};

function statusPillClass(s: Status): string {
  switch (s) {
    case "ACTIVE":     return "fpp2-ytd-pill fpp2-ytd-pill--ok";
    case "VALIDATED":  return "fpp2-ytd-pill fpp2-ytd-pill--ok";
    case "DRAFT":      return "fpp2-ytd-pill fpp2-ytd-pill--warn";
    case "SUPERSEDED": return "fpp2-ytd-pill fpp2-ytd-pill--neutral";
    default:           return "fpp2-ytd-pill fpp2-ytd-pill--warn";
  }
}
function statusLabel(s: Status): string {
  switch (s) {
    case "ACTIVE":     return "ACTIVE";
    case "VALIDATED":  return "READY";
    case "DRAFT":      return "DRAFT";
    case "SUPERSEDED": return "SUPERSEDED";
    default:           return "NOT STARTED";
  }
}
function formatSaved(iso: string | null): string {
  if (!iso) return "Never saved";
  const d = new Date(iso);
  return `Last saved: ${d.toLocaleDateString("en-CA", {
    year: "numeric", month: "short", day: "numeric",
  })} ${d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}`;
}

type CardId =
  | "earnings"
  | "stat_employee"
  | "stat_employer"
  | "employee_deductions"
  | "employer_benefits"
  | "other_allowances";

function routeComponent(c: { side: Side; category: string; cashEffect: CashEffect }): CardId | null {
  if (c.side === "EMPLOYEE") {
    if (c.category === "ALLOWANCE" || c.category === "ADDITIONAL_EARNING" || c.category === "REGULAR_EARNING") {
      return "other_allowances";
    }
    if (c.category === "EMPLOYEE_DEDUCTION" || c.cashEffect === "DECREASES_NET_PAY") {
      return "employee_deductions";
    }
    return "employee_deductions";
  }
  // Employer-side
  return "employer_benefits";
}

// -------------------------------------------------------------------
// Root component
// -------------------------------------------------------------------

export default function OpeningYtdWorkspace(props: OpeningYtdWorkspaceProps) {
  const {
    componentOpenings = [], componentCatalogue = [],
    values, actions, status, openingBalanceId, canWrite,
    firstSpectrePayDateIso, priorPayrollKind, throughPayDateIso,
    lastSavedIso, taxYear, employeeId, backHref,
  } = props;

  const canEdit = canWrite && status !== "ACTIVE" && status !== "SUPERSEDED";
  const [pending, setPending] = useState(false);

  const defaultThrough = throughPayDateIso
    ? throughPayDateIso.slice(0, 10)
    : (firstSpectrePayDateIso
        ? (() => {
            const d = new Date(firstSpectrePayDateIso);
            d.setUTCDate(d.getUTCDate() - 1);
            return d.toISOString().slice(0, 10);
          })()
        : "");

  // Build slot registry — catalogue first, then overlay existing rows
  // so a saved opening row for a component that later left the catalogue
  // still surfaces (read-only fallback via orphan flag).
  const slots = useMemo(() => {
    interface Slot {
      key: string; componentId: string; code: string; displayName: string;
      side: Side; category: string; cashEffect: CashEffect;
      existingRowId: string | null; initialAmount: string;
      active: boolean; orphan: boolean;
    }
    const byCode = new Map<string, Slot>();
    for (const c of componentCatalogue) {
      byCode.set(c.code, {
        key: c.code, componentId: c.id, code: c.code, displayName: c.displayName,
        side: c.side, category: c.category, cashEffect: c.cashEffect,
        existingRowId: null, initialAmount: "",
        active: c.active, orphan: false,
      });
    }
    for (const r of componentOpenings) {
      const existing = byCode.get(r.componentCode);
      if (existing) {
        existing.existingRowId = r.id;
        existing.initialAmount = r.ytdAmount ?? "";
      } else {
        byCode.set(r.componentCode, {
          key: r.componentCode, componentId: "", code: r.componentCode,
          displayName: r.displayName, side: r.side, category: r.category,
          cashEffect: r.cashEffect, existingRowId: r.id,
          initialAmount: r.ytdAmount ?? "", active: false, orphan: true,
        });
      }
    }
    return Array.from(byCode.values());
  }, [componentCatalogue, componentOpenings]);

  const byCard: Record<CardId, typeof slots> = {
    earnings: [], stat_employee: [], stat_employer: [],
    employee_deductions: [], employer_benefits: [], other_allowances: [],
  };
  for (const s of slots) {
    const dest = routeComponent(s);
    if (dest) byCard[dest].push(s);
  }
  for (const key of Object.keys(byCard) as CardId[]) {
    byCard[key].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  const shownCodes = new Set(slots.map((s) => s.code));
  const extraChoices = componentCatalogue.filter((c) => !shownCodes.has(c.code));

  return (
    <div className="fpp2-ytd-wrap">
      <form
        action={async (fd) => {
          setPending(true);
          try { await actions.saveDraft(fd); } finally { setPending(false); }
        }}
        className="fpp2-ytd-main"
      >
        <input type="hidden" name="employeeId" value={employeeId} />
        <input type="hidden" name="taxYear" value={taxYear} />

        {/* ---------------- Workspace title + status ---------------- */}
        <section className="fpp2-ytd-title">
          <div className="fpp2-ytd-title-left">
            <h2>Opening YTD — {taxYear}</h2>
            <p>
              Enter the year-to-date amounts from your previous payroll system. These values tell
              Spectre what this employee has already accumulated this year so we can take over
              payroll correctly. You can save a draft with incomplete information and return at
              any time.
            </p>
          </div>
          <div className="fpp2-ytd-title-right">
            <span
              className={statusPillClass(status)}
              data-testid="opening-ytd-status-pill"
            >
              {statusLabel(status)}
            </span>
            <div className="fpp2-ytd-saved" data-testid="opening-ytd-last-saved">
              {formatSaved(lastSavedIso)}
            </div>
          </div>
        </section>

        {/* ---------------- Meta row ---------------- */}
        <section className="fpp2-ytd-meta" data-testid="opening-ytd-meta">
          <label className="fpp2-ytd-meta-field">
            <span className="fpp2-ytd-label">
              Through pay date <span className="fpp2-ytd-label-hint">(inclusive)</span>
              <span className="fpp2-ytd-required">*</span>
            </span>
            <input
              type="date" name="throughPayDate"
              defaultValue={defaultThrough} disabled={!canEdit} required
              className="fpp2-ytd-input" data-testid="opening-ytd-through-pay-date"
            />
          </label>
          <label className="fpp2-ytd-meta-field">
            <span className="fpp2-ytd-label">
              Prior payroll source <span className="fpp2-ytd-required">*</span>
            </span>
            <select
              name="priorPayrollKind"
              defaultValue={priorPayrollKind ?? "PRIOR_SYSTEM_SAME_EMPLOYER"}
              disabled={!canEdit}
              className="fpp2-ytd-input" data-testid="opening-ytd-prior-kind"
            >
              {(Object.keys(KIND_LABELS) as PriorPayrollKind[]).map((k) => (
                <option key={k} value={k}>{KIND_LABELS[k]}</option>
              ))}
            </select>
          </label>
        </section>

        {/* ---------------- 6-card grid ---------------- */}
        <section className="fpp2-ytd-grid">
          {/* 1. Earnings */}
          <Card index={1} title="Earnings" tone="earnings" icon={<IconStack />}>
            <MoneyRow name="ytdGrossEarnings"       label="Gross earnings"       initial={values?.ytdGrossEarnings}       disabled={!canEdit} />
            <MoneyRow name="ytdTaxableEarnings"     label="Taxable earnings"     initial={values?.ytdTaxableEarnings}     disabled={!canEdit} />
            <MoneyRow name="ytdPensionableEarnings" label="Pensionable earnings" initial={values?.ytdPensionableEarnings} disabled={!canEdit} info />
            <MoneyRow name="ytdInsurableEarnings"   label="Insurable earnings"   initial={values?.ytdInsurableEarnings}   disabled={!canEdit} info />
          </Card>

          {/* 2. Employee Statutory Deductions */}
          <Card index={2} title="Employee Statutory Deductions" tone="stat-employee" icon={<IconGavel />}>
            <MoneyRow name="ytdCppEE"         label="CPP (Box 16)"           initial={values?.ytdCppEE}         disabled={!canEdit} />
            <MoneyRow name="ytdCpp2EE"        label="CPP2 (Box 16A)"         initial={values?.ytdCpp2EE}        disabled={!canEdit} />
            <MoneyRow name="ytdEiEE"          label="EI (Box 18)"            initial={values?.ytdEiEE}          disabled={!canEdit} />
            <MoneyRow name="ytdFederalTax"    label="Federal income tax"     initial={values?.ytdFederalTax}    disabled={!canEdit} />
            <MoneyRow name="ytdProvincialTax" label="Provincial income tax"  initial={values?.ytdProvincialTax} disabled={!canEdit} />
          </Card>

          {/* 3. Employer Statutory Contributions */}
          <Card index={3} title="Employer Statutory Contributions" tone="stat-employer" icon={<IconBuilding />}>
            <MoneyRow name="ytdCppER"  label="Employer CPP"  initial={values?.ytdCppER}  disabled={!canEdit} />
            <MoneyRow name="ytdCpp2ER" label="Employer CPP2" initial={values?.ytdCpp2ER} disabled={!canEdit} />
            <MoneyRow name="ytdEiER"   label="Employer EI"   initial={values?.ytdEiER}   disabled={!canEdit} />
          </Card>

          {/* 4. Employee Deductions */}
          <Card index={4} title="Employee Deductions" tone="employee-deductions" icon={<IconPerson />}>
            {byCard.employee_deductions.map((s) => (
              <ComponentRow key={s.key} slot={s} disabled={!canEdit} />
            ))}
            {byCard.employee_deductions.length === 0 ? (
              <p className="fpp2-ytd-empty">No employee-deduction components configured.</p>
            ) : null}
            <AddAnotherLink
              label="+ Add another employee deduction"
              choices={extraChoices.filter((c) => c.side === "EMPLOYEE" && (c.category === "EMPLOYEE_DEDUCTION" || c.cashEffect === "DECREASES_NET_PAY"))}
              openingBalanceId={openingBalanceId}
              status={status} canWrite={canWrite}
              addAction={actions.addComponent}
              employeeId={employeeId} pending={pending} setPending={setPending}
            />
          </Card>

          {/* 5. Employer Contributions & Benefits */}
          <Card index={5} title="Employer Contributions & Benefits" tone="employer-benefits" icon={<IconGift />}>
            {byCard.employer_benefits.map((s) => (
              <ComponentRow key={s.key} slot={s} disabled={!canEdit} />
            ))}
            {byCard.employer_benefits.length === 0 ? (
              <p className="fpp2-ytd-empty">No employer benefit components configured.</p>
            ) : null}
            <AddAnotherLink
              label="+ Add another employer benefit"
              choices={extraChoices.filter((c) => c.side === "EMPLOYER")}
              openingBalanceId={openingBalanceId}
              status={status} canWrite={canWrite}
              addAction={actions.addComponent}
              employeeId={employeeId} pending={pending} setPending={setPending}
            />
          </Card>

          {/* 6. Other Earnings / Allowances */}
          <Card index={6} title="Other Earnings / Allowances" tone="allowances" icon={<IconGift />}>
            {byCard.other_allowances.map((s) => (
              <ComponentRow key={s.key} slot={s} disabled={!canEdit} />
            ))}
            {byCard.other_allowances.length === 0 ? (
              <p className="fpp2-ytd-empty">No other-earning components configured.</p>
            ) : null}
            <AddAnotherLink
              label="+ Add another earning / allowance"
              choices={extraChoices.filter((c) => c.side === "EMPLOYEE" && (c.category === "ALLOWANCE" || c.category === "ADDITIONAL_EARNING" || c.category === "REGULAR_EARNING"))}
              openingBalanceId={openingBalanceId}
              status={status} canWrite={canWrite}
              addAction={actions.addComponent}
              employeeId={employeeId} pending={pending} setPending={setPending}
            />
          </Card>
        </section>

        {/* ---------------- 7. Notes ---------------- */}
        <section className="fpp2-ytd-notes">
          <div className="fpp2-ytd-notes-head">
            <span className="fpp2-ytd-index">7.</span>
            <h3>Notes <span className="fpp2-ytd-notes-optional">(optional)</span></h3>
          </div>
          <textarea
            name="notes"
            rows={4}
            disabled={!canEdit}
            className="fpp2-ytd-notes-input"
            placeholder="Add any notes about the source payroll data or special considerations..."
            data-testid="opening-ytd-notes"
          />
        </section>

        {/* ---------------- Bottom action bar ---------------- */}
        <section className="fpp2-ytd-actions">
          <a href={backHref} className="fpp2-btn fpp2-btn-ghost" data-testid="opening-ytd-cancel">
            Cancel
          </a>
          <div className="fpp2-ytd-actions-right">
            {canEdit ? (
              <button
                type="submit"
                className="fpp2-btn fpp2-btn-secondary"
                disabled={pending}
                data-testid="opening-ytd-save-draft"
              >
                {pending ? "Saving..." : "Save Draft"}
              </button>
            ) : null}
            {openingBalanceId && status === "DRAFT" && canWrite ? (
              <button
                type="button"
                className="fpp2-btn fpp2-btn-outline"
                disabled={pending}
                onClick={async () => {
                  const fd = new FormData();
                  fd.set("employeeId", employeeId);
                  fd.set("id", openingBalanceId);
                  setPending(true);
                  try { await actions.validate(fd); } finally { setPending(false); }
                }}
                data-testid="opening-ytd-validate"
              >
                Mark Ready / Validate
              </button>
            ) : null}
            {openingBalanceId && (status === "DRAFT" || status === "VALIDATED") && canWrite ? (
              <button
                type="button"
                className="fpp2-btn fpp2-btn-primary"
                disabled={pending}
                onClick={async () => {
                  if (!confirm("Activate opening YTD? Values become immutable and next payroll will use them.")) return;
                  const fd = new FormData();
                  fd.set("employeeId", employeeId);
                  fd.set("id", openingBalanceId);
                  setPending(true);
                  try { await actions.activate(fd); } finally { setPending(false); }
                }}
                data-testid="opening-ytd-activate"
              >
                Activate
              </button>
            ) : null}
          </div>
        </section>
      </form>

      {/* -------------------------- Right rail -------------------------- */}
      <aside className="fpp2-ytd-rail" aria-label="Opening YTD guidance">
        <div className="fpp2-ytd-rail-card">
          <div className="fpp2-ytd-rail-head">
            <span className="fpp2-ytd-rail-icon" aria-hidden="true"><IconInfo /></span>
            <h4>About Opening YTD</h4>
          </div>
          <p>
            Enter the amounts this employee has already accumulated this year with your previous
            payroll system. These values ensure Spectre calculates future payroll amounts
            correctly (taxes, CPP, EI, etc.).
          </p>
          <p>
            You can save a draft with incomplete information and return later. All fields are
            editable while in Draft status.
          </p>
        </div>

        <div className="fpp2-ytd-rail-callout" data-testid="opening-ytd-any-section-callout">
          <div className="fpp2-ytd-rail-callout-icon" aria-hidden="true"><IconLightbulb /></div>
          <p>
            <strong>You can start with any section</strong> — component fields are available
            immediately. You don't need to complete the statutory fields first.
          </p>
        </div>

        <div className="fpp2-ytd-rail-card">
          <div className="fpp2-ytd-rail-head">
            <span className="fpp2-ytd-rail-icon" aria-hidden="true"><IconQuestion /></span>
            <h4>Tips</h4>
          </div>
          <ul className="fpp2-ytd-rail-list">
            <li>Enter only the amounts you have from your prior payroll report.</li>
            <li>Leave a field blank if it doesn't apply.</li>
            <li>Component amounts do <strong>NOT</strong> change your overall earnings or statutory totals.</li>
            <li>You can edit values directly while in Draft status.</li>
            <li>Once Activated, the opening position is locked.</li>
          </ul>
        </div>
      </aside>
    </div>
  );
}

// -------------------------------------------------------------------
// Card scaffold
// -------------------------------------------------------------------

function Card({
  index, title, tone, icon, children,
}: {
  index: number;
  title: string;
  tone: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={`fpp2-ytd-card fpp2-ytd-card--${tone}`} data-testid={`opening-ytd-card-${index}`}>
      <header className="fpp2-ytd-card-head">
        <span className={`fpp2-ytd-card-icon fpp2-ytd-card-icon--${tone}`} aria-hidden="true">{icon}</span>
        <h3 className="fpp2-ytd-card-title">
          <span className="fpp2-ytd-card-index">{index}.</span> {title}
        </h3>
      </header>
      <div className="fpp2-ytd-card-body">{children}</div>
    </section>
  );
}

// -------------------------------------------------------------------
// Row primitives (label + $ + right-aligned money input)
// -------------------------------------------------------------------

function MoneyRow({
  name, label, initial, disabled, info,
}: {
  name: string; label: string; initial: string | undefined | null; disabled: boolean; info?: boolean;
}) {
  return (
    <label className="fpp2-ytd-row" data-testid={`opening-ytd-${name}-row`}>
      <span className="fpp2-ytd-row-label">
        {label}
        {info ? <span className="fpp2-ytd-info" aria-hidden="true">ⓘ</span> : null}
      </span>
      <span className="fpp2-ytd-row-input">
        <span className="fpp2-ytd-currency" aria-hidden="true">$</span>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          name={name}
          defaultValue={initial ?? ""}
          disabled={disabled}
          placeholder="0.00"
          data-testid={`opening-ytd-${name}`}
        />
      </span>
    </label>
  );
}

// FPP-2 (2026-09-20) — short labels used in the compact card grid.
// The catalogue's full displayName remains authoritative for the
// component itself; this map only affects rendering inside the
// workspace's dense per-card row list where a slightly shorter label
// gives every canonical component one-line legibility at 1440x900.
const SHORT_LABELS: Record<string, string> = {
  LTD: "Long Term Disability (LTD)",
  HEALTH_DENTAL: "Health & Dental",
  DEPENDENT_LIFE_INSURANCE: "Dependent Life",
  LIFE_INSURANCE: "Life Insurance",
  AD_D: "AD&D",
  CELL_PHONE_ALLOWANCE: "Cell Phone Allowance",
  RRSP_EE: "RRSP — Employee",
  RRSP_ER: "RRSP — Employer",
};

function ComponentRow({
  slot, disabled,
}: {
  slot: {
    key: string; componentId: string; code: string; displayName: string;
    initialAmount: string; active: boolean; orphan: boolean;
  };
  disabled: boolean;
}) {
  const hasId = slot.componentId !== "";
  const label = SHORT_LABELS[slot.code] ?? slot.displayName;
  return (
    <label className="fpp2-ytd-row" data-testid={`opening-ytd-component-${slot.code}-row`}>
      <span className="fpp2-ytd-row-label">
        {label}
        {!slot.active ? <span className="fpp2-ytd-inactive">inactive</span> : null}
      </span>
      {hasId ? (
        <span className="fpp2-ytd-row-input">
          <span className="fpp2-ytd-currency" aria-hidden="true">$</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            name={`component_${slot.componentId}`}
            defaultValue={slot.initialAmount ?? ""}
            disabled={disabled}
            placeholder="0.00"
            data-testid={`opening-ytd-component-input-${slot.code}`}
          />
        </span>
      ) : (
        <span className="fpp2-ytd-row-input fpp2-ytd-row-input--orphan" data-testid={`opening-ytd-component-orphan-${slot.code}`}>
          {slot.initialAmount || "—"} <span className="fpp2-ytd-inactive">read-only</span>
        </span>
      )}
    </label>
  );
}

// -------------------------------------------------------------------
// Add-another link (per card)
// -------------------------------------------------------------------

function AddAnotherLink(props: {
  label: string;
  choices: OpeningYtdComponentChoice[];
  openingBalanceId: string | null;
  status: Status;
  canWrite: boolean;
  addAction?: (fd: FormData) => Promise<void>;
  employeeId: string;
  pending: boolean;
  setPending: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const canUse = props.canWrite
    && props.status === "DRAFT"
    && !!props.openingBalanceId
    && !!props.addAction
    && props.choices.length > 0;
  if (!canUse) {
    return (
      <div className="fpp2-ytd-add-another">
        <span className="fpp2-ytd-add-another-link fpp2-ytd-add-another-link--disabled" title={
          props.status === "MISSING" || !props.openingBalanceId
            ? "Save Draft first so component additions can attach to the parent."
            : "Editable only while parent Opening YTD is a Draft."
        }>
          {props.label}
        </span>
      </div>
    );
  }
  return (
    <div className="fpp2-ytd-add-another">
      {!open ? (
        <button
          type="button"
          className="fpp2-ytd-add-another-link"
          onClick={() => setOpen(true)}
          data-testid={`opening-ytd-add-another-${props.label.replace(/\W+/g, "_")}`}
        >
          {props.label}
        </button>
      ) : (
        <form
          action={async (fd) => {
            props.setPending(true);
            try { await props.addAction!(fd); } finally { props.setPending(false); }
          }}
          className="fpp2-ytd-add-another-form"
        >
          <input type="hidden" name="employeeId" value={props.employeeId} />
          <input type="hidden" name="openingBalanceId" value={props.openingBalanceId!} />
          <select name="componentId" required defaultValue="" className="fpp2-ytd-input">
            <option value="" disabled>Select…</option>
            {props.choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}{!c.active ? " (inactive)" : ""}
              </option>
            ))}
          </select>
          <span className="fpp2-ytd-currency" aria-hidden="true">$</span>
          <input
            type="number" inputMode="decimal" step="0.01" min="0"
            name="ytdAmount" required placeholder="0.00"
            className="fpp2-ytd-input fpp2-ytd-input--money"
          />
          <button type="submit" className="fpp2-btn fpp2-btn-secondary" disabled={props.pending}>Add</button>
          <button type="button" className="fpp2-btn fpp2-btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
        </form>
      )}
    </div>
  );
}

// -------------------------------------------------------------------
// Icons (inline SVG — no CDN reliance)
// -------------------------------------------------------------------

function IconStack() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <ellipse cx="10" cy="5" rx="6" ry="2" />
      <path d="M4 10c0 1.1 2.7 2 6 2s6-.9 6-2M4 15c0 1.1 2.7 2 6 2s6-.9 6-2M4 5v10M16 5v10" />
    </svg>
  );
}
function IconGavel() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="10" cy="6" r="3.5" />
      <path d="M10 9.5v4M6.5 17h7M8 13.5h4l-.5 3.5h-3z" />
    </svg>
  );
}
function IconBuilding() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 17V5h12v12M4 17h12M7 8h2M11 8h2M7 11h2M11 11h2M7 14h2M11 14h2" />
    </svg>
  );
}
function IconPerson() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="10" cy="7" r="3" />
      <path d="M4 17c1-3 3-4 6-4s5 1 6 4" />
    </svg>
  );
}
function IconGift() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3.5 8h13v9h-13zM3 8h14M10 8v9M6.5 8c-1 0-2-.7-2-1.8s.9-1.7 1.8-1.7c1.2 0 3 1.5 3.7 3.5M13.5 8c1 0 2-.7 2-1.8s-.9-1.7-1.8-1.7c-1.2 0-3 1.5-3.7 3.5" />
    </svg>
  );
}
function IconInfo() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 9v5M10 6v.5" strokeLinecap="round" />
    </svg>
  );
}
function IconQuestion() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M8 7.5c0-1.1.9-2 2-2s2 .9 2 2c0 1.6-2 1.9-2 3.5M10 15v.5" strokeLinecap="round" />
    </svg>
  );
}
function IconLightbulb() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M10 3a5 5 0 0 0-3 9v2h6v-2a5 5 0 0 0-3-9zM8 16h4M9 18h2" strokeLinecap="round" />
    </svg>
  );
}
