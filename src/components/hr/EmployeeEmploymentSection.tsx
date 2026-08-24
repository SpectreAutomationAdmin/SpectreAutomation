"use client";

// HR-2C Employment (2026-08-24) — Employee Profile Employment tab section.
//
// Presentation grammar reuses the founder-approved `spectre-person-*`
// classes. Not a giant collection of cards: a single dense section per
// concern (Primary role · Additional roles · Compensation history ·
// Allowances). Each section carries subtle inline actions.
//
// Every mutation delegates to server actions in
// `src/app/app/admin/people/employees/[id]/_employment-actions.ts` —
// this file is presentation + form state only. Server-side gates
// (permission, tenant, posting-guard, audit) live in the canonical
// services those actions wrap.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

// ---------------------------------------------------------------------------
// Types (mirror the service views, serialised).
// ---------------------------------------------------------------------------

export interface AssignmentRow {
  id: string;
  role: "PRIMARY" | "ADDITIONAL";
  departmentId: string | null;
  departmentName: string | null;
  positionId: string | null;
  positionName: string | null;
  managerEmployeeId: string | null;
  managerName: string | null;
  employmentType: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isCurrent: boolean;
  notes: string | null;
}

export interface CompensationRow {
  id: string;
  cadence: string;
  amount: string;
  currency: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  assignmentId: string | null;
  notes: string | null;
}

export interface AllowanceRow {
  id: string;
  allowanceType: string;
  description: string | null;
  amount: string;
  currency: string | null;
  frequency: string;
  taxable: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  isCurrent: boolean;
  assignmentId: string | null;
}

export interface DepartmentOption { id: string; name: string; code: string }
export interface PositionOption { id: string; name: string; code: string; departmentId: string | null }
export interface ManagerOption { id: string; label: string }

type ActionResult = { ok: true } | { ok: true; id: string } | { ok: false; error: string }

interface Actions {
  addAssignment: (employeeId: string, input: {
    role: "PRIMARY" | "ADDITIONAL";
    departmentId?: string | null;
    positionId?: string | null;
    managerEmployeeId?: string | null;
    employmentType: string;
    effectiveFrom: string;
    notes?: string | null;
  }) => Promise<ActionResult>;
  endAssignment: (employeeId: string, assignmentId: string, input: { effectiveTo: string; notes?: string | null }) => Promise<ActionResult>;
  changeCompensation: (employeeId: string, input: {
    cadence: string; amount: string; effectiveFrom: string;
    currency?: string | null; notes?: string | null;
    assignmentId?: string | null;
  }) => Promise<ActionResult>;
  addAllowance: (employeeId: string, input: {
    allowanceType: string; description?: string | null;
    amount: string; currency?: string | null;
    frequency: string; taxable: boolean;
    effectiveFrom: string; assignmentId?: string | null;
    notes?: string | null;
  }) => Promise<ActionResult>;
  endAllowance: (employeeId: string, allowanceId: string, input: { effectiveTo: string; notes?: string | null }) => Promise<ActionResult>;
}

interface Props {
  employeeId: string;
  assignments: AssignmentRow[];
  compensationHistory: CompensationRow[];
  allowances: AllowanceRow[];
  departments: DepartmentOption[];
  positions: PositionOption[];
  managers: ManagerOption[];
  canReadCompensation: boolean;
  canWriteCompensation: boolean;
  canReadAllowance: boolean;
  canWriteAllowance: boolean;
  canWriteEmployment: boolean;
  actions: Actions;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "SEASONAL", "CONTRACT"] as const;
const CADENCES = ["HOURLY", "SALARY", "COMMISSION", "PIECE_RATE"] as const;
const ALLOWANCE_TYPES = ["CELL_PHONE", "UNIFORM", "VEHICLE", "PROFESSIONAL_DUES", "OTHER"] as const;
const ALLOWANCE_FREQUENCIES = ["PER_PAY_PERIOD", "MONTHLY", "ANNUAL"] as const;

function humaniseEnum(v: string | null | undefined) {
  if (!v) return "—";
  return v.replace(/_/g, " ").toLowerCase().replace(/(^| )(\w)/g, (_, s, c) => s + c.toUpperCase());
}

function formatDate(iso: string | null) {
  if (!iso) return "current";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function formatMoney(amount: string, cadence: string, currency: string | null) {
  const c = currency ?? "CAD";
  const n = Number(amount);
  const nice = Number.isFinite(n)
    ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : amount;
  const suffix = cadence === "HOURLY" ? "/hour"
    : cadence === "SALARY" ? "/year"
    : cadence === "COMMISSION" ? " commission"
    : cadence === "PIECE_RATE" ? "/unit" : "";
  return `${c} $${nice}${suffix}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function EmployeeEmploymentSection(props: Props) {
  const primary = props.assignments.find((a) => a.role === "PRIMARY" && a.isCurrent) ?? null;
  const additional = props.assignments.filter((a) => a.role === "ADDITIONAL" && a.isCurrent);
  const historical = props.assignments.filter((a) => !a.isCurrent);
  const currentComp = props.compensationHistory
    .filter((c) => c.assignmentId === null)
    .find((c) => c.effectiveTo === null) ?? null;
  const compHistoryEmployeeWide = props.compensationHistory.filter((c) => c.assignmentId === null);
  const activeAllowances = props.allowances.filter((a) => a.isCurrent);

  return (
    <section className="spectre-person-body" data-testid="employee-tab-body-employment">
      {/* Primary role */}
      <div className="spectre-person-section" data-testid="employment-primary-section">
        <div className="spectre-person-section-head">
          <h3 className="spectre-person-eyebrow">Primary role</h3>
        </div>
        {primary ? (
          <PrimaryRoleBlock
            employeeId={props.employeeId}
            assignment={primary}
            currentComp={currentComp}
            canReadCompensation={props.canReadCompensation}
            canWriteCompensation={props.canWriteCompensation}
            canWriteEmployment={props.canWriteEmployment}
            departments={props.departments}
            positions={props.positions}
            managers={props.managers}
            addAssignment={props.actions.addAssignment}
            changeCompensation={props.actions.changeCompensation}
          />
        ) : (
          <NoPrimaryBlock
            employeeId={props.employeeId}
            departments={props.departments}
            positions={props.positions}
            managers={props.managers}
            canWriteEmployment={props.canWriteEmployment}
            addAssignment={props.actions.addAssignment}
          />
        )}
      </div>

      {/* Additional roles */}
      <div className="spectre-person-section" data-testid="employment-additional-section">
        <div className="spectre-person-section-head">
          <h3 className="spectre-person-eyebrow">Additional roles</h3>
        </div>
        {additional.length === 0 ? (
          <p className="text-sm text-stone-500 mt-2" data-testid="employment-additional-empty">
            No additional roles.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {additional.map((a) => (
              <li key={a.id} data-testid={`employment-additional-${a.id}`}>
                <AdditionalRoleRow
                  employeeId={props.employeeId}
                  assignment={a}
                  canWriteEmployment={props.canWriteEmployment}
                  endAssignment={props.actions.endAssignment}
                />
              </li>
            ))}
          </ul>
        )}
        {props.canWriteEmployment && (
          <AddAdditionalRoleForm
            employeeId={props.employeeId}
            departments={props.departments}
            positions={props.positions}
            managers={props.managers}
            addAssignment={props.actions.addAssignment}
          />
        )}
      </div>

      {/* Compensation history */}
      {props.canReadCompensation && (
        <div className="spectre-person-section" data-testid="employment-comp-history">
          <div className="spectre-person-section-head">
            <h3 className="spectre-person-eyebrow">Compensation history</h3>
          </div>
          {compHistoryEmployeeWide.length === 0 ? (
            <p className="text-sm text-stone-500 mt-2">No compensation history yet.</p>
          ) : (
            <table className="table-base mt-2">
              <thead>
                <tr><th>From</th><th>To</th><th>Cadence</th><th className="text-right">Amount</th></tr>
              </thead>
              <tbody>
                {compHistoryEmployeeWide.map((c) => (
                  <tr key={c.id} data-testid={`comp-history-${c.id}`}>
                    <td>{formatDate(c.effectiveFrom)}</td>
                    <td>{formatDate(c.effectiveTo)}</td>
                    <td className="text-stone-600 text-xs">{humaniseEnum(c.cadence)}</td>
                    <td className="text-right tabular-nums">
                      {formatMoney(c.amount, c.cadence, c.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Allowances */}
      {props.canReadAllowance && (
        <div className="spectre-person-section" data-testid="employment-allowances-section">
          <div className="spectre-person-section-head">
            <h3 className="spectre-person-eyebrow">Recurring allowances</h3>
          </div>
          {activeAllowances.length === 0 ? (
            <p className="text-sm text-stone-500 mt-2" data-testid="employment-allowances-empty">
              No active allowances.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {activeAllowances.map((a) => (
                <AllowanceRowView
                  key={a.id}
                  employeeId={props.employeeId}
                  allowance={a}
                  canWrite={props.canWriteAllowance}
                  endAllowance={props.actions.endAllowance}
                />
              ))}
            </ul>
          )}
          {props.canWriteAllowance && (
            <AddAllowanceForm
              employeeId={props.employeeId}
              addAllowance={props.actions.addAllowance}
            />
          )}
        </div>
      )}

      {/* Historical assignments (collapsed) */}
      {historical.length > 0 && (
        <div className="spectre-person-section" data-testid="employment-history-section">
          <div className="spectre-person-section-head">
            <h3 className="spectre-person-eyebrow">Role history</h3>
          </div>
          <table className="table-base mt-2">
            <thead>
              <tr><th>Role</th><th>Position</th><th>Department</th><th>From</th><th>To</th></tr>
            </thead>
            <tbody>
              {historical.map((a) => (
                <tr key={a.id} data-testid={`employment-history-${a.id}`}>
                  <td className="text-xs text-stone-600">{humaniseEnum(a.role)}</td>
                  <td>{a.positionName ?? "—"}</td>
                  <td>{a.departmentName ?? "—"}</td>
                  <td>{formatDate(a.effectiveFrom)}</td>
                  <td>{formatDate(a.effectiveTo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PrimaryRoleBlock({
  employeeId, assignment, currentComp,
  canReadCompensation, canWriteCompensation, canWriteEmployment,
  departments, positions, managers,
  addAssignment, changeCompensation,
}: {
  employeeId: string;
  assignment: AssignmentRow;
  currentComp: CompensationRow | null;
  canReadCompensation: boolean;
  canWriteCompensation: boolean;
  canWriteEmployment: boolean;
  departments: DepartmentOption[];
  positions: PositionOption[];
  managers: ManagerOption[];
  addAssignment: Actions["addAssignment"];
  changeCompensation: Actions["changeCompensation"];
}) {
  const [showChangePrimary, setShowChangePrimary] = useState(false);
  const [showChangeComp, setShowChangeComp] = useState(false);
  return (
    <div className="mt-2 space-y-1">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-stone-500">Position</dt><dd data-testid="primary-position">{assignment.positionName ?? "—"}</dd>
        <dt className="text-stone-500">Department</dt><dd data-testid="primary-department">{assignment.departmentName ?? "—"}</dd>
        <dt className="text-stone-500">Type</dt><dd>{humaniseEnum(assignment.employmentType)}</dd>
        <dt className="text-stone-500">Reports to</dt><dd>{assignment.managerName ?? "—"}</dd>
        {canReadCompensation && (
          <>
            <dt className="text-stone-500">Compensation</dt>
            <dd data-testid="primary-compensation">
              {currentComp
                ? `${humaniseEnum(currentComp.cadence)} · ${formatMoney(currentComp.amount, currentComp.cadence, currentComp.currency)}`
                : <span className="text-stone-500">Not set</span>}
            </dd>
          </>
        )}
        {!canReadCompensation && (
          <>
            <dt className="text-stone-500">Compensation</dt>
            <dd className="text-stone-500 italic">Restricted</dd>
          </>
        )}
        <dt className="text-stone-500">Effective</dt><dd>{formatDate(assignment.effectiveFrom)}</dd>
      </dl>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
        {canWriteEmployment && (
          <button
            type="button"
            className="underline underline-offset-4 hover:text-stone-800"
            onClick={() => setShowChangePrimary((v) => !v)}
            data-testid="btn-change-primary-role"
          >
            {showChangePrimary ? "Cancel" : "Edit role"}
          </button>
        )}
        {canWriteCompensation && (
          <button
            type="button"
            className="underline underline-offset-4 hover:text-stone-800"
            onClick={() => setShowChangeComp((v) => !v)}
            data-testid="btn-change-compensation"
          >
            {showChangeComp ? "Cancel" : "Change compensation"}
          </button>
        )}
      </div>
      {showChangePrimary && canWriteEmployment && (
        <ChangePrimaryRoleForm
          employeeId={employeeId}
          departments={departments}
          positions={positions}
          managers={managers}
          addAssignment={addAssignment}
          onDone={() => setShowChangePrimary(false)}
        />
      )}
      {showChangeComp && canWriteCompensation && (
        <ChangeCompensationForm
          employeeId={employeeId}
          currentComp={currentComp}
          changeCompensation={changeCompensation}
          onDone={() => setShowChangeComp(false)}
        />
      )}
    </div>
  );
}

function NoPrimaryBlock({
  employeeId, departments, positions, managers, canWriteEmployment, addAssignment,
}: {
  employeeId: string;
  departments: DepartmentOption[];
  positions: PositionOption[];
  managers: ManagerOption[];
  canWriteEmployment: boolean;
  addAssignment: Actions["addAssignment"];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <p className="text-sm text-stone-500" data-testid="employment-primary-empty">
        No primary role assigned yet.
      </p>
      {canWriteEmployment && (
        <div className="mt-2">
          {open ? (
            <ChangePrimaryRoleForm
              employeeId={employeeId}
              departments={departments}
              positions={positions}
              managers={managers}
              addAssignment={addAssignment}
              onDone={() => setOpen(false)}
            />
          ) : (
            <button
              type="button"
              className="text-xs underline underline-offset-4 hover:text-stone-800"
              onClick={() => setOpen(true)}
              data-testid="btn-add-primary-role"
            >
              Set primary role
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AdditionalRoleRow({
  employeeId, assignment, canWriteEmployment, endAssignment,
}: {
  employeeId: string;
  assignment: AssignmentRow;
  canWriteEmployment: boolean;
  endAssignment: Actions["endAssignment"];
}) {
  const [showEnd, setShowEnd] = useState(false);
  const [effectiveTo, setEffectiveTo] = useState(todayIso());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <div className="rounded-md border border-stone-200 bg-white px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-club-ink">
            {assignment.positionName ?? "—"}
            <span className="text-stone-500"> · {assignment.departmentName ?? "—"}</span>
          </div>
          <div className="mt-0.5 text-xs text-stone-500">
            {humaniseEnum(assignment.employmentType)} · Since {formatDate(assignment.effectiveFrom)}
          </div>
        </div>
        {canWriteEmployment && (
          <button
            type="button"
            className="text-xs underline underline-offset-4 text-stone-500 hover:text-stone-800"
            onClick={() => setShowEnd((v) => !v)}
            data-testid={`btn-end-role-${assignment.id}`}
          >
            {showEnd ? "Cancel" : "End role"}
          </button>
        )}
      </div>
      {showEnd && canWriteEmployment && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              setError(null);
              const result = await endAssignment(employeeId, assignment.id, { effectiveTo });
              if (result.ok) {
                setShowEnd(false);
                router.refresh();
              } else {
                setError(result.error);
              }
            });
          }}
        >
          <label className="text-xs text-stone-500">
            Effective through
            <input
              type="date"
              className="input ml-2"
              value={effectiveTo}
              onChange={(e) => setEffectiveTo(e.target.value)}
              required
              data-testid={`end-role-date-${assignment.id}`}
            />
          </label>
          <button
            type="submit"
            className="btn btn-secondary btn-sm"
            disabled={pending}
            data-testid={`end-role-confirm-${assignment.id}`}
          >
            {pending ? "Ending…" : "End role"}
          </button>
          {error && (
            <p role="alert" className="text-xs text-red-700 basis-full">{error}</p>
          )}
        </form>
      )}
    </div>
  );
}

function ChangePrimaryRoleForm({
  employeeId, departments, positions, managers, addAssignment, onDone,
}: {
  employeeId: string;
  departments: DepartmentOption[];
  positions: PositionOption[];
  managers: ManagerOption[];
  addAssignment: Actions["addAssignment"];
  onDone: () => void;
}) {
  const [departmentId, setDepartmentId] = useState<string>("");
  const [positionId, setPositionId] = useState<string>("");
  const [managerId, setManagerId] = useState<string>("");
  const [employmentType, setEmploymentType] = useState<string>("FULL_TIME");
  const [effectiveFrom, setEffectiveFrom] = useState<string>(todayIso());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const filteredPositions = positions.filter((p) => !departmentId || p.departmentId === departmentId || p.departmentId === null);
  return (
    <form
      className="mt-3 rounded-md border border-stone-200 bg-stone-50 px-4 py-3 space-y-2"
      data-testid="change-primary-role-form"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          setError(null);
          const result = await addAssignment(employeeId, {
            role: "PRIMARY",
            departmentId: departmentId || null,
            positionId: positionId || null,
            managerEmployeeId: managerId || null,
            employmentType,
            effectiveFrom,
          });
          if (result.ok) { onDone(); router.refresh(); } else { setError(result.error); }
        });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-stone-500">
          Department
          <select className="input mt-1" value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setPositionId(""); }} data-testid="primary-department-select">
            <option value="">—</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-stone-500">
          Position
          <select className="input mt-1" value={positionId} onChange={(e) => setPositionId(e.target.value)} data-testid="primary-position-select">
            <option value="">—</option>
            {filteredPositions.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-stone-500">
          Employment type
          <select className="input mt-1" value={employmentType} onChange={(e) => setEmploymentType(e.target.value)} data-testid="primary-type-select">
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t}>{humaniseEnum(t)}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-stone-500">
          Reports to
          <select className="input mt-1" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
            <option value="">—</option>
            {managers.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-stone-500 col-span-2">
          Effective from
          <input type="date" className="input mt-1" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required data-testid="primary-effective-from" />
        </label>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button type="button" className="text-xs text-stone-500 underline" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending} data-testid="primary-submit">
          {pending ? "Saving…" : "Save primary role"}
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </form>
  );
}

function AddAdditionalRoleForm({
  employeeId, departments, positions, managers, addAssignment,
}: {
  employeeId: string;
  departments: DepartmentOption[];
  positions: PositionOption[];
  managers: ManagerOption[];
  addAssignment: Actions["addAssignment"];
}) {
  const [open, setOpen] = useState(false);
  const [departmentId, setDepartmentId] = useState<string>("");
  const [positionId, setPositionId] = useState<string>("");
  const [managerId, setManagerId] = useState<string>("");
  const [employmentType, setEmploymentType] = useState<string>("PART_TIME");
  const [effectiveFrom, setEffectiveFrom] = useState<string>(todayIso());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const filteredPositions = positions.filter((p) => !departmentId || p.departmentId === departmentId || p.departmentId === null);
  if (!open) {
    return (
      <div className="mt-3">
        <button
          type="button"
          className="text-xs underline underline-offset-4 hover:text-stone-800"
          onClick={() => setOpen(true)}
          data-testid="btn-add-additional-role"
        >
          + Add another role
        </button>
      </div>
    );
  }
  return (
    <form
      className="mt-3 rounded-md border border-stone-200 bg-stone-50 px-4 py-3 space-y-2"
      data-testid="add-additional-role-form"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          setError(null);
          const result = await addAssignment(employeeId, {
            role: "ADDITIONAL",
            departmentId: departmentId || null,
            positionId: positionId || null,
            managerEmployeeId: managerId || null,
            employmentType,
            effectiveFrom,
          });
          if (result.ok) {
            setOpen(false);
            setPositionId(""); setDepartmentId("");
            router.refresh();
          } else {
            setError(result.error);
          }
        });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-stone-500">
          Department
          <select className="input mt-1" value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setPositionId(""); }} data-testid="additional-department-select">
            <option value="">—</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-stone-500">
          Position
          <select className="input mt-1" value={positionId} onChange={(e) => setPositionId(e.target.value)} data-testid="additional-position-select">
            <option value="">—</option>
            {filteredPositions.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-stone-500">
          Employment type
          <select className="input mt-1" value={employmentType} onChange={(e) => setEmploymentType(e.target.value)} data-testid="additional-type-select">
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t}>{humaniseEnum(t)}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-stone-500">
          Reports to
          <select className="input mt-1" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
            <option value="">—</option>
            {managers.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-stone-500 col-span-2">
          Effective from
          <input type="date" className="input mt-1" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required data-testid="additional-effective-from" />
        </label>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button type="button" className="text-xs text-stone-500 underline" onClick={() => setOpen(false)}>Cancel</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending} data-testid="additional-submit">
          {pending ? "Saving…" : "Add role"}
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </form>
  );
}

function ChangeCompensationForm({
  employeeId, currentComp, changeCompensation, onDone,
}: {
  employeeId: string;
  currentComp: CompensationRow | null;
  changeCompensation: Actions["changeCompensation"];
  onDone: () => void;
}) {
  const [cadence, setCadence] = useState<string>(currentComp?.cadence ?? "HOURLY");
  const [amount, setAmount] = useState<string>(currentComp?.amount ?? "");
  const [effectiveFrom, setEffectiveFrom] = useState<string>(todayIso());
  const [notes, setNotes] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <form
      className="mt-3 rounded-md border border-stone-200 bg-stone-50 px-4 py-3 space-y-2"
      data-testid="change-compensation-form"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          setError(null);
          const result = await changeCompensation(employeeId, {
            cadence, amount, effectiveFrom,
            notes: notes.trim() || null,
          });
          if (result.ok) { onDone(); router.refresh(); } else { setError(result.error); }
        });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-stone-500">
          Cadence
          <select className="input mt-1" value={cadence} onChange={(e) => setCadence(e.target.value)} data-testid="comp-cadence-select">
            {CADENCES.map((c) => <option key={c} value={c}>{humaniseEnum(c)}</option>)}
          </select>
        </label>
        <label className="text-xs text-stone-500">
          Amount
          <input
            type="number" step="0.01" min="0"
            className="input mt-1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            data-testid="comp-amount"
            placeholder={cadence === "SALARY" ? "78000" : "24.00"}
          />
        </label>
        <label className="text-xs text-stone-500 col-span-2">
          Effective from
          <input type="date" className="input mt-1" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required data-testid="comp-effective-from" />
        </label>
        <label className="text-xs text-stone-500 col-span-2">
          Reason / note (optional)
          <input type="text" className="input mt-1" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Annual wage review" />
        </label>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button type="button" className="text-xs text-stone-500 underline" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending} data-testid="comp-submit">
          {pending ? "Saving…" : "Save compensation"}
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </form>
  );
}

function AllowanceRowView({
  employeeId, allowance, canWrite, endAllowance,
}: {
  employeeId: string;
  allowance: AllowanceRow;
  canWrite: boolean;
  endAllowance: Actions["endAllowance"];
}) {
  const [showEnd, setShowEnd] = useState(false);
  const [effectiveTo, setEffectiveTo] = useState(todayIso());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <li className="rounded-md border border-stone-200 bg-white px-4 py-3" data-testid={`allowance-${allowance.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-club-ink">
            {humaniseEnum(allowance.allowanceType)}
            {allowance.description && <span className="text-stone-500"> · {allowance.description}</span>}
          </div>
          <div className="mt-0.5 text-xs text-stone-500 tabular-nums">
            ${Number(allowance.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            {" · "}{humaniseEnum(allowance.frequency)}
            {" · "}{allowance.taxable ? "Taxable" : "Non-taxable"}
            {" · Since "}{formatDate(allowance.effectiveFrom)}
          </div>
        </div>
        {canWrite && (
          <button
            type="button"
            className="text-xs underline underline-offset-4 text-stone-500 hover:text-stone-800"
            onClick={() => setShowEnd((v) => !v)}
            data-testid={`btn-end-allowance-${allowance.id}`}
          >
            {showEnd ? "Cancel" : "End"}
          </button>
        )}
      </div>
      {showEnd && canWrite && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              setError(null);
              const result = await endAllowance(employeeId, allowance.id, { effectiveTo });
              if (result.ok) { setShowEnd(false); router.refresh(); } else { setError(result.error); }
            });
          }}
        >
          <label className="text-xs text-stone-500">
            Effective through
            <input type="date" className="input ml-2" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} required />
          </label>
          <button type="submit" className="btn btn-secondary btn-sm" disabled={pending}>
            {pending ? "Ending…" : "End allowance"}
          </button>
          {error && <p role="alert" className="text-xs text-red-700 basis-full">{error}</p>}
        </form>
      )}
    </li>
  );
}

function AddAllowanceForm({
  employeeId, addAllowance,
}: {
  employeeId: string;
  addAllowance: Actions["addAllowance"];
}) {
  const [open, setOpen] = useState(false);
  const [allowanceType, setAllowanceType] = useState<string>("CELL_PHONE");
  const [customType, setCustomType] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [frequency, setFrequency] = useState<string>("MONTHLY");
  const [taxable, setTaxable] = useState<boolean>(true);
  const [effectiveFrom, setEffectiveFrom] = useState<string>(todayIso());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const resolvedType = allowanceType === "OTHER" && customType.trim() ? customType.trim().toUpperCase() : allowanceType;
  if (!open) {
    return (
      <div className="mt-3">
        <button
          type="button"
          className="text-xs underline underline-offset-4 hover:text-stone-800"
          onClick={() => setOpen(true)}
          data-testid="btn-add-allowance"
        >
          + Add allowance
        </button>
      </div>
    );
  }
  return (
    <form
      className="mt-3 rounded-md border border-stone-200 bg-stone-50 px-4 py-3 space-y-2"
      data-testid="add-allowance-form"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          setError(null);
          const result = await addAllowance(employeeId, {
            allowanceType: resolvedType,
            description: description.trim() || null,
            amount, frequency, taxable, effectiveFrom,
          });
          if (result.ok) {
            setOpen(false);
            setAllowanceType("CELL_PHONE"); setCustomType(""); setDescription(""); setAmount("");
            router.refresh();
          } else {
            setError(result.error);
          }
        });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-stone-500">
          Type
          <select className="input mt-1" value={allowanceType} onChange={(e) => setAllowanceType(e.target.value)} data-testid="allowance-type-select">
            {ALLOWANCE_TYPES.map((t) => <option key={t} value={t}>{humaniseEnum(t)}</option>)}
          </select>
        </label>
        {allowanceType === "OTHER" && (
          <label className="text-xs text-stone-500">
            Custom type
            <input type="text" className="input mt-1" value={customType} onChange={(e) => setCustomType(e.target.value)} placeholder="TOOL_ALLOWANCE" />
          </label>
        )}
        <label className="text-xs text-stone-500 col-span-2">
          Description (optional)
          <input type="text" className="input mt-1" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Personal phone reimbursement" />
        </label>
        <label className="text-xs text-stone-500">
          Amount
          <input type="number" step="0.01" min="0" className="input mt-1" value={amount} onChange={(e) => setAmount(e.target.value)} required data-testid="allowance-amount" />
        </label>
        <label className="text-xs text-stone-500">
          Frequency
          <select className="input mt-1" value={frequency} onChange={(e) => setFrequency(e.target.value)} data-testid="allowance-frequency-select">
            {ALLOWANCE_FREQUENCIES.map((f) => <option key={f} value={f}>{humaniseEnum(f)}</option>)}
          </select>
        </label>
        <label className="text-xs text-stone-500 flex items-center gap-2 mt-4">
          <input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} data-testid="allowance-taxable" />
          Taxable
        </label>
        <label className="text-xs text-stone-500">
          Effective from
          <input type="date" className="input mt-1" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required data-testid="allowance-effective-from" />
        </label>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button type="button" className="text-xs text-stone-500 underline" onClick={() => setOpen(false)}>Cancel</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending} data-testid="allowance-submit">
          {pending ? "Saving…" : "Add allowance"}
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </form>
  );
}
