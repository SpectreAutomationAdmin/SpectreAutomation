"use client";

// Slice C closeout (2026-09-18) — client editor for Benefit Plans.
//
// Renders the tenant's plan catalogue with an "+ Add Benefit Plan" dialog
// and a per-row End (Deactivate) affordance. Component pickers filter by
// side (Employee / Employer) and show a compact treatment readout so the
// founder can see the frozen semantics that will apply on Prepare.

import { useMemo, useState } from "react";

interface PlanRow {
  id: string;
  kind: string;
  code: string;
  name: string;
  description: string | null;
  providerName: string | null;
  active: boolean;
  effectiveFromIso: string;
  effectiveToIso: string | null;
  employeeComponentId: string | null;
  employerComponentId: string | null;
  defaultElectionKind: string;
  eligibleEarningsBasis: string | null;
}
interface ComponentOption {
  id: string;
  code: string;
  displayName: string;
  side: "EMPLOYEE" | "EMPLOYER";
  cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
  taxableEffect: "NONE" | "ADD" | "SUBTRACT";
  cppPensionableEffect: "NONE" | "ADD" | "SUBTRACT";
  eiInsurableEffect: "NONE" | "ADD" | "SUBTRACT";
  calculationMethod: string;
  expenseAccountNumber: string | null;
  liabilityAccountNumber: string | null;
}

const KIND_LABEL: Record<string, string> = {
  LTD: "Long-Term Disability",
  HEALTH_DENTAL: "Health & Dental",
  RRSP: "RRSP",
};
const ELECTION_LABEL: Record<string, string> = {
  FIXED_AMOUNT: "Fixed amount per pay",
  PERCENT_OF_ELIGIBLE_EARNINGS: "Percentage of eligible earnings",
};
const BASIS_LABEL: Record<string, string> = {
  REGULAR_EARNINGS_ONLY: "Regular earnings only",
  CASH_EARNINGS: "All cash earnings",
};

function fmtCivil(iso: string): string {
  const d = new Date(iso);
  return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function humanCash(c: ComponentOption["cashEffect"]): string {
  return c === "INCREASES_NET_PAY" ? "Increases net pay"
    : c === "DECREASES_NET_PAY"    ? "Decreases net pay"
    : "No net-pay effect";
}
function humanEffect(k: "NONE" | "ADD" | "SUBTRACT"): string {
  return k === "ADD" ? "Add" : k === "SUBTRACT" ? "Subtract" : "No effect";
}

function ComponentTreatment({ opt }: { opt: ComponentOption }) {
  return (
    <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[11px]"
        data-testid={`component-treatment-${opt.id}`}>
      <dt className="text-stone-500">Side</dt>
      <dd className="text-stone-800">{opt.side === "EMPLOYEE" ? "Employee" : "Employer"}</dd>
      <dt className="text-stone-500">Cash effect</dt>
      <dd className="text-stone-800">{humanCash(opt.cashEffect)}</dd>
      <dt className="text-stone-500">Taxable earnings</dt>
      <dd className="text-stone-800">{humanEffect(opt.taxableEffect)}</dd>
      <dt className="text-stone-500">CPP pensionable</dt>
      <dd className="text-stone-800">{humanEffect(opt.cppPensionableEffect)}</dd>
      <dt className="text-stone-500">EI insurable</dt>
      <dd className="text-stone-800">{humanEffect(opt.eiInsurableEffect)}</dd>
      {opt.expenseAccountNumber && (
        <>
          <dt className="text-stone-500">Expense a/c</dt>
          <dd className="text-stone-800">{opt.expenseAccountNumber}</dd>
        </>
      )}
      {opt.liabilityAccountNumber && (
        <>
          <dt className="text-stone-500">Liability a/c</dt>
          <dd className="text-stone-800">{opt.liabilityAccountNumber}</dd>
        </>
      )}
    </dl>
  );
}

export default function BenefitPlansEditor(props: {
  canWrite: boolean;
  plans: PlanRow[];
  components: ComponentOption[];
  createAction: (form: FormData) => Promise<void>;
  endAction: (form: FormData) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<"LTD" | "HEALTH_DENTAL">("LTD");
  const [electionKind, setElectionKind] = useState<"FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS">("FIXED_AMOUNT");
  const [employeeComponentId, setEmployeeComponentId] = useState<string>("");
  const [employerComponentId, setEmployerComponentId] = useState<string>("");

  const activePlans = useMemo(() => props.plans.filter((p) => p.active), [props.plans]);
  const historicalPlans = useMemo(() => props.plans.filter((p) => !p.active), [props.plans]);

  const employeeChoices = useMemo(
    () => props.components.filter((c) => c.side === "EMPLOYEE"),
    [props.components],
  );
  const employerChoices = useMemo(
    () => props.components.filter((c) => c.side === "EMPLOYER"),
    [props.components],
  );

  const selectedEmployee = employeeChoices.find((c) => c.id === employeeComponentId) ?? null;
  const selectedEmployer = employerChoices.find((c) => c.id === employerComponentId) ?? null;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-stone-500">
          Plans ({activePlans.length} active{historicalPlans.length > 0 ? ` · ${historicalPlans.length} historical` : ""})
        </div>
        {props.canWrite && !adding && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="benefits-add-plan-btn"
            onClick={() => setAdding(true)}
          >
            + Add Benefit Plan
          </button>
        )}
      </div>

      {activePlans.length === 0 && !adding && (
        <div
          className="rounded-lg border border-dashed p-8 text-center text-sm"
          style={{ borderColor: "var(--spectre-border-muted)", color: "var(--spectre-text-secondary)" }}
          data-testid="benefits-empty"
        >
          No benefit plans configured.
        </div>
      )}

      {activePlans.length > 0 && (
        <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--spectre-border-muted)" }}>
          <table className="w-full text-sm" data-testid="benefit-plans-table">
            <thead className="bg-stone-50">
              <tr className="border-b" style={{ borderColor: "var(--spectre-border-muted)" }}>
                <Th>Plan</Th>
                <Th>Type</Th>
                <Th>Employee treatment</Th>
                <Th>Employer treatment</Th>
                <Th>Effective</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {activePlans.map((p) => {
                const ee = props.components.find((c) => c.id === p.employeeComponentId) ?? null;
                const er = props.components.find((c) => c.id === p.employerComponentId) ?? null;
                return (
                  <tr key={p.id} className="border-b" style={{ borderColor: "var(--spectre-border-muted)" }} data-testid={`benefit-plan-row-${p.id}`}>
                    <Td>
                      <div className="font-medium text-stone-900">{p.name}</div>
                      <div className="text-[11px] text-stone-500">{p.code}</div>
                    </Td>
                    <Td>{KIND_LABEL[p.kind] ?? p.kind}</Td>
                    <Td>{ee ? (<><div>{ee.displayName}</div><div className="text-[11px] text-stone-500">{humanCash(ee.cashEffect)}</div></>) : <span className="text-stone-400">—</span>}</Td>
                    <Td>{er ? (<><div>{er.displayName}</div><div className="text-[11px] text-stone-500">{humanCash(er.cashEffect)}</div></>) : <span className="text-stone-400">—</span>}</Td>
                    <Td>
                      <div>{fmtCivil(p.effectiveFromIso)}</div>
                      <div className="text-[11px] text-stone-500">{p.effectiveToIso ? `until ${fmtCivil(p.effectiveToIso)}` : "no end date"}</div>
                    </Td>
                    <Td>
                      {props.canWrite && (
                        <form action={props.endAction}>
                          <input type="hidden" name="planId" value={p.id} />
                          <button
                            type="submit"
                            className="btn btn-secondary btn-sm"
                            data-testid={`benefit-plan-end-${p.id}`}
                            onClick={(e) => {
                              if (!confirm(`End plan "${p.name}"? Existing enrolments continue to be honoured historically; new enrolments cannot be created after End.`)) {
                                e.preventDefault();
                              }
                            }}
                          >
                            End plan
                          </button>
                        </form>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {historicalPlans.length > 0 && (
        <details className="mt-4" data-testid="benefits-history-disclosure">
          <summary className="cursor-pointer text-xs text-stone-500">
            Ended / historical plans ({historicalPlans.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-stone-600">
            {historicalPlans.map((p) => (
              <li key={p.id}>
                {KIND_LABEL[p.kind] ?? p.kind} — {p.name} · ended{" "}
                {p.effectiveToIso ? fmtCivil(p.effectiveToIso) : "—"}
              </li>
            ))}
          </ul>
        </details>
      )}

      {adding && props.canWrite && (
        <div
          className="mt-6 rounded-spectre-panel border p-spectre-6"
          style={{ background: "var(--spectre-surface)", borderColor: "var(--spectre-border-hairline)" }}
          data-testid="benefits-add-form"
        >
          <h2 className="mb-3 text-spectre-h3 font-semibold text-stone-900">Add benefit plan</h2>
          <form action={props.createAction} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="kind">Plan type</Label>
                <select
                  id="kind"
                  name="kind"
                  required
                  value={kind}
                  onChange={(e) => setKind(e.target.value as "LTD" | "HEALTH_DENTAL")}
                  className="mt-1 w-full rounded border px-2 py-1 text-sm"
                  data-testid="benefits-form-kind"
                >
                  <option value="LTD">Long-Term Disability</option>
                  <option value="HEALTH_DENTAL">Health &amp; Dental</option>
                  <option value="RRSP" disabled>RRSP — coming in RRSP configuration slice</option>
                </select>
              </div>
              <div>
                <Label htmlFor="code">Plan code</Label>
                <input id="code" name="code" required placeholder="e.g. LTD_STANDARD"
                       className="mt-1 w-full rounded border px-2 py-1 text-sm font-mono uppercase"
                       data-testid="benefits-form-code" />
              </div>
              <div className="md:col-span-2">
                <Label htmlFor="name">Plan name</Label>
                <input id="name" name="name" required placeholder="e.g. LTD — Standard Group Plan"
                       className="mt-1 w-full rounded border px-2 py-1 text-sm"
                       data-testid="benefits-form-name" />
              </div>
              <div className="md:col-span-2">
                <Label htmlFor="providerName">Provider (optional)</Label>
                <input id="providerName" name="providerName" placeholder="e.g. Sun Life"
                       className="mt-1 w-full rounded border px-2 py-1 text-sm" />
              </div>
              <div>
                <Label htmlFor="effectiveFrom">Effective from</Label>
                <input id="effectiveFrom" name="effectiveFrom" type="date" required
                       className="mt-1 w-full rounded border px-2 py-1 text-sm"
                       data-testid="benefits-form-effective-from" />
              </div>
              <div>
                <Label htmlFor="effectiveTo">Effective to (optional)</Label>
                <input id="effectiveTo" name="effectiveTo" type="date"
                       className="mt-1 w-full rounded border px-2 py-1 text-sm" />
              </div>
              <div>
                <Label htmlFor="defaultElectionKind">Default election</Label>
                <select
                  id="defaultElectionKind"
                  name="defaultElectionKind"
                  value={electionKind}
                  onChange={(e) => setElectionKind(e.target.value as "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS")}
                  className="mt-1 w-full rounded border px-2 py-1 text-sm"
                >
                  <option value="FIXED_AMOUNT">{ELECTION_LABEL.FIXED_AMOUNT}</option>
                  <option value="PERCENT_OF_ELIGIBLE_EARNINGS">{ELECTION_LABEL.PERCENT_OF_ELIGIBLE_EARNINGS}</option>
                </select>
              </div>
              {electionKind === "PERCENT_OF_ELIGIBLE_EARNINGS" && (
                <div>
                  <Label htmlFor="eligibleEarningsBasis">Eligible-earnings basis</Label>
                  <select
                    id="eligibleEarningsBasis"
                    name="eligibleEarningsBasis"
                    className="mt-1 w-full rounded border px-2 py-1 text-sm"
                  >
                    <option value="REGULAR_EARNINGS_ONLY">{BASIS_LABEL.REGULAR_EARNINGS_ONLY}</option>
                    <option value="CASH_EARNINGS">{BASIS_LABEL.CASH_EARNINGS}</option>
                  </select>
                  <p className="mt-1 text-[10px] text-stone-500">
                    This is the payroll-period earnings basis used to compute an employee percent
                    election, not a CRA contribution-room ceiling.
                  </p>
                </div>
              )}
            </div>

            <hr className="my-2" style={{ borderColor: "var(--spectre-border-muted)" }} />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="employeeComponentId">
                  Employee payroll component
                  <span className="ml-1 text-[10px] text-stone-400">(optional if employer-paid only)</span>
                </Label>
                <select
                  id="employeeComponentId"
                  name="employeeComponentId"
                  value={employeeComponentId}
                  onChange={(e) => setEmployeeComponentId(e.target.value)}
                  className="mt-1 w-full rounded border px-2 py-1 text-sm"
                  data-testid="benefits-form-employee-component"
                >
                  <option value="">— none —</option>
                  {employeeChoices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName} · {humanCash(c.cashEffect)}
                    </option>
                  ))}
                </select>
                {selectedEmployee && <ComponentTreatment opt={selectedEmployee} />}
              </div>
              <div>
                <Label htmlFor="employerComponentId">
                  Employer payroll component
                  <span className="ml-1 text-[10px] text-stone-400">(optional if employee-paid only)</span>
                </Label>
                <select
                  id="employerComponentId"
                  name="employerComponentId"
                  value={employerComponentId}
                  onChange={(e) => setEmployerComponentId(e.target.value)}
                  className="mt-1 w-full rounded border px-2 py-1 text-sm"
                  data-testid="benefits-form-employer-component"
                >
                  <option value="">— none —</option>
                  {employerChoices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName} · {humanCash(c.cashEffect)}
                    </option>
                  ))}
                </select>
                {selectedEmployer && <ComponentTreatment opt={selectedEmployer} />}
              </div>
            </div>
            <p className="text-[11px] text-stone-500">
              Configure Payroll components in{" "}
              <a href="/app/admin/payroll/setup/components" className="underline">Payroll components</a>.
              Plan does not carry tax / pensionable / GL config — the linked component does.
            </p>

            <div className="mt-4 flex items-center gap-2">
              <button type="submit" className="btn btn-primary btn-sm" data-testid="benefits-form-submit">
                Save plan
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-[11px] font-semibold uppercase tracking-[0.04em] text-stone-600">
      {children}
    </label>
  );
}
function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-stone-600">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 align-top">{children}</td>;
}
