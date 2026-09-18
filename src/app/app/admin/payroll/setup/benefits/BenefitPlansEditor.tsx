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
  predecessorPlanId: string | null;
  notes: string | null;
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
  updateMetadataAction: (form: FormData) => Promise<void>;
  changeConfigAction: (form: FormData) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<"LTD" | "HEALTH_DENTAL">("LTD");
  const [electionKind, setElectionKind] = useState<"FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS">("FIXED_AMOUNT");
  const [employeeComponentId, setEmployeeComponentId] = useState<string>("");
  const [employerComponentId, setEmployerComponentId] = useState<string>("");
  const [changingId, setChangingId] = useState<string | null>(null);

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
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            data-testid={`benefit-plan-change-btn-${p.id}`}
                            onClick={() => setChangingId(p.id === changingId ? null : p.id)}
                          >
                            Change
                          </button>
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
                        </div>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {changingId && props.canWrite && (() => {
        const p = props.plans.find((r) => r.id === changingId);
        if (!p) return null;
        const currentEE = props.components.find((c) => c.id === p.employeeComponentId) ?? null;
        const currentER = props.components.find((c) => c.id === p.employerComponentId) ?? null;
        return (
          <ChangePlanForm
            plan={p}
            currentEmployeeComponent={currentEE}
            currentEmployerComponent={currentER}
            components={props.components}
            updateMetadataAction={props.updateMetadataAction}
            changeConfigAction={props.changeConfigAction}
            onClose={() => setChangingId(null)}
          />
        );
      })()}

      {historicalPlans.length > 0 && (
        <details className="mt-4" data-testid="benefits-history-disclosure">
          <summary className="cursor-pointer text-xs text-stone-500">
            Ended / historical plans ({historicalPlans.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-stone-600">
            {historicalPlans.map((p) => {
              const successor = props.plans.find((s) => s.predecessorPlanId === p.id) ?? null;
              return (
                <li key={p.id}>
                  {KIND_LABEL[p.kind] ?? p.kind} — {p.name}
                  {" · "}
                  {fmtCivil(p.effectiveFromIso)} – {p.effectiveToIso ? fmtCivil(p.effectiveToIso) : "open"}
                  {successor && (
                    <span className="text-stone-500"> · replaced by <span className="font-mono">{successor.code}</span></span>
                  )}
                </li>
              );
            })}
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

function ChangePlanForm(props: {
  plan: PlanRow;
  currentEmployeeComponent: ComponentOption | null;
  currentEmployerComponent: ComponentOption | null;
  components: ComponentOption[];
  updateMetadataAction: (form: FormData) => Promise<void>;
  changeConfigAction: (form: FormData) => Promise<void>;
  onClose: () => void;
}) {
  const [nextEmployeeId, setNextEmployeeId] = useState<string>(props.plan.employeeComponentId ?? "");
  const [nextEmployerId, setNextEmployerId] = useState<string>(props.plan.employerComponentId ?? "");
  const nextEE = props.components.find((c) => c.side === "EMPLOYEE" && c.id === nextEmployeeId) ?? null;
  const nextER = props.components.find((c) => c.side === "EMPLOYER" && c.id === nextEmployerId) ?? null;
  const eeChoices = props.components.filter((c) => c.side === "EMPLOYEE");
  const erChoices = props.components.filter((c) => c.side === "EMPLOYER");

  const configWillChange =
    nextEmployeeId !== (props.plan.employeeComponentId ?? "") ||
    nextEmployerId !== (props.plan.employerComponentId ?? "");

  return (
    <div
      className="mt-6 rounded-spectre-panel border p-spectre-6"
      style={{ background: "var(--spectre-surface)", borderColor: "var(--spectre-border-hairline)" }}
      data-testid={`benefits-change-form-${props.plan.id}`}
    >
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-spectre-h3 font-semibold text-stone-900">Change plan — {props.plan.name}</h2>
          <p className="mt-1 text-[11px] text-stone-500">
            Metadata edits (name / provider / description / notes) update in place. Component /
            election changes create an <strong>effective-dated successor</strong>: the current
            configuration is preserved as history, and enrolments are migrated to the new plan at
            the cutover instant. POSTED payroll is never mutated.
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={props.onClose}>Close</button>
      </div>

      <hr className="my-4" style={{ borderColor: "var(--spectre-border-muted)" }} />

      {/* Metadata form — in-place, always safe */}
      <form action={props.updateMetadataAction} className="space-y-3" data-testid={`benefits-change-metadata-form-${props.plan.id}`}>
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-stone-500">Metadata (safe, in-place)</div>
        <input type="hidden" name="planId" value={props.plan.id} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor={`change-name-${props.plan.id}`}>Plan name</Label>
            <input id={`change-name-${props.plan.id}`} name="name" defaultValue={props.plan.name}
                   className="mt-1 w-full rounded border px-2 py-1 text-sm" />
          </div>
          <div>
            <Label htmlFor={`change-provider-${props.plan.id}`}>Provider</Label>
            <input id={`change-provider-${props.plan.id}`} name="providerName" defaultValue={props.plan.providerName ?? ""}
                   className="mt-1 w-full rounded border px-2 py-1 text-sm" />
          </div>
          <div className="md:col-span-2">
            <Label htmlFor={`change-desc-${props.plan.id}`}>Description</Label>
            <input id={`change-desc-${props.plan.id}`} name="description" defaultValue={props.plan.description ?? ""}
                   className="mt-1 w-full rounded border px-2 py-1 text-sm" />
          </div>
          <div className="md:col-span-2">
            <Label htmlFor={`change-notes-${props.plan.id}`}>Notes</Label>
            <input id={`change-notes-${props.plan.id}`} name="notes" defaultValue={props.plan.notes ?? ""}
                   className="mt-1 w-full rounded border px-2 py-1 text-sm" />
          </div>
        </div>
        <button type="submit" className="btn btn-secondary btn-sm" data-testid={`benefits-change-metadata-submit-${props.plan.id}`}>
          Save metadata
        </button>
      </form>

      <hr className="my-4" style={{ borderColor: "var(--spectre-border-muted)" }} />

      {/* Configuration form — creates successor at cutover */}
      <form action={props.changeConfigAction} className="space-y-3" data-testid={`benefits-change-config-form-${props.plan.id}`}>
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-stone-500">
          Payroll configuration (effective-dated · creates successor)
        </div>
        <input type="hidden" name="planId" value={props.plan.id} />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor={`change-cutover-${props.plan.id}`}>Effective from (cutover date)</Label>
            <input id={`change-cutover-${props.plan.id}`} name="cutover" type="date" required
                   className="mt-1 w-full rounded border px-2 py-1 text-sm"
                   data-testid={`benefits-change-cutover-${props.plan.id}`} />
            <p className="mt-1 text-[10px] text-stone-500">
              Must be after {fmtCivil(props.plan.effectiveFromIso)}. Existing enrolments are ended
              at this date on the current plan and re-opened on the new plan with the same
              election.
            </p>
          </div>
          <div>
            <Label htmlFor={`change-defaultElection-${props.plan.id}`}>Default election</Label>
            <select id={`change-defaultElection-${props.plan.id}`} name="defaultElectionKind"
                    defaultValue={props.plan.defaultElectionKind}
                    className="mt-1 w-full rounded border px-2 py-1 text-sm">
              <option value="FIXED_AMOUNT">{ELECTION_LABEL.FIXED_AMOUNT}</option>
              <option value="PERCENT_OF_ELIGIBLE_EARNINGS">{ELECTION_LABEL.PERCENT_OF_ELIGIBLE_EARNINGS}</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor={`change-ee-${props.plan.id}`}>Employee payroll component</Label>
            <select
              id={`change-ee-${props.plan.id}`}
              name="employeeComponentId"
              value={nextEmployeeId}
              onChange={(e) => setNextEmployeeId(e.target.value)}
              className="mt-1 w-full rounded border px-2 py-1 text-sm"
              data-testid={`benefits-change-ee-${props.plan.id}`}
            >
              <option value="">— none —</option>
              {eeChoices.map((c) => (
                <option key={c.id} value={c.id}>{c.displayName} · {humanCash(c.cashEffect)}</option>
              ))}
            </select>
            {props.currentEmployeeComponent && (
              <div className="mt-2 text-[11px]">
                <div className="text-stone-500">Currently:</div>
                <div className="text-stone-800">{props.currentEmployeeComponent.displayName}</div>
              </div>
            )}
            {nextEE && nextEE.id !== props.plan.employeeComponentId && (
              <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2">
                <div className="text-[11px] font-semibold text-amber-800">New employee treatment (at cutover)</div>
                <ComponentTreatment opt={nextEE} />
              </div>
            )}
          </div>
          <div>
            <Label htmlFor={`change-er-${props.plan.id}`}>Employer payroll component</Label>
            <select
              id={`change-er-${props.plan.id}`}
              name="employerComponentId"
              value={nextEmployerId}
              onChange={(e) => setNextEmployerId(e.target.value)}
              className="mt-1 w-full rounded border px-2 py-1 text-sm"
              data-testid={`benefits-change-er-${props.plan.id}`}
            >
              <option value="">— none —</option>
              {erChoices.map((c) => (
                <option key={c.id} value={c.id}>{c.displayName} · {humanCash(c.cashEffect)}</option>
              ))}
            </select>
            {props.currentEmployerComponent && (
              <div className="mt-2 text-[11px]">
                <div className="text-stone-500">Currently:</div>
                <div className="text-stone-800">{props.currentEmployerComponent.displayName}</div>
              </div>
            )}
            {nextER && nextER.id !== props.plan.employerComponentId && (
              <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2">
                <div className="text-[11px] font-semibold text-amber-800">New employer treatment (at cutover)</div>
                <ComponentTreatment opt={nextER} />
              </div>
            )}
          </div>
        </div>

        <div className="pt-1">
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            data-testid={`benefits-change-config-submit-${props.plan.id}`}
            disabled={!configWillChange}
            title={configWillChange ? undefined : "Select a different component to enable"}
          >
            Apply effective-dated change
          </button>
          <span className="ml-3 text-[10px] text-stone-500">
            Historical plan is preserved; new plan takes effect at the cutover.
          </span>
        </div>
      </form>
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
