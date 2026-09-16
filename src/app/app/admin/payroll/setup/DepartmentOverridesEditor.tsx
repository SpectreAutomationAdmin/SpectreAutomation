"use client";

// Phase 3 (2026-09-15) — Payroll GL department-override editor.
//
// Shows one row per active Department. Each row exposes three
// dropdowns (salary / employer CPP / employer EI) plus a status
// column indicating whether the row is "Inherits global" or
// "Explicit override".
//
// Any field left as "Inherit global (…)" resolves at post time to
// the Section 6 default. Setting even one field to a concrete
// Account creates an override row for that department; unmapping
// all three fields deletes the row (server-side).
//
// Save is per-department (one row at a time) so a Controller can
// confidently change one department's expense mapping without
// touching the others. Historical journals are not affected —
// changes apply to the NEXT payroll post.

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Department { id: string; code: string; name: string }
interface ExpenseAccount { id: string; accountNumber: string; name: string }
interface OverrideRow {
  id: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  salaryExpenseAccountId: string | null;
  employerCppExpenseAccountId: string | null;
  employerEiExpenseAccountId: string | null;
  updatedAt: string;
}

interface Props {
  clubId: string;
  canWrite: boolean;
  departments: Department[];
  expenseAccounts: ExpenseAccount[];
  globalDefaults: {
    salaryExpenseAccountId: string | null;
    employerCppExpenseAccountId: string | null;
    employerEiExpenseAccountId: string | null;
  };
  initialOverrides: OverrideRow[];
}

interface RowState {
  salaryExpenseAccountId: string | null;
  employerCppExpenseAccountId: string | null;
  employerEiExpenseAccountId: string | null;
}

const ROW_FIELDS: Array<{ key: keyof RowState; label: string; hint: string }> = [
  { key: "salaryExpenseAccountId",      label: "Salary / wage expense",  hint: "Base salary + regular hours + OT" },
  { key: "employerCppExpenseAccountId", label: "Employer CPP expense",   hint: "Employer share of CPP + CPP2" },
  { key: "employerEiExpenseAccountId",  label: "Employer EI expense",    hint: "Employer share of EI" },
];

export default function DepartmentOverridesEditor(props: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  // Local per-department form state seeded from initialOverrides.
  const [rows, setRows] = useState<Record<string, RowState>>(() => {
    const m: Record<string, RowState> = {};
    for (const d of props.departments) {
      const ov = props.initialOverrides.find((o) => o.departmentId === d.id);
      m[d.id] = {
        salaryExpenseAccountId:      ov?.salaryExpenseAccountId      ?? null,
        employerCppExpenseAccountId: ov?.employerCppExpenseAccountId ?? null,
        employerEiExpenseAccountId:  ov?.employerEiExpenseAccountId  ?? null,
      };
    }
    return m;
  });

  const acctById = new Map(props.expenseAccounts.map((a) => [a.id, a]));
  const globalLabel = (fieldId: string | null): string => {
    if (!fieldId) return "not configured";
    const a = acctById.get(fieldId);
    return a ? `${a.accountNumber} — ${a.name}` : "not configured";
  };

  async function saveRow(departmentId: string) {
    setSaving(departmentId);
    setMessage(null);
    try {
      const row = rows[departmentId];
      const res = await fetch(`/api/clubs/${props.clubId}/payroll/gl-department-overrides`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentId, ...row }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setMessage({ tone: "error", text: `Save failed: ${body.error ?? res.statusText}` });
        return;
      }
      const allNull =
        row.salaryExpenseAccountId == null &&
        row.employerCppExpenseAccountId == null &&
        row.employerEiExpenseAccountId == null;
      setMessage({
        tone: "success",
        text: allNull
          ? "Override cleared — this department will inherit the global default on the next payroll post."
          : "Override saved — applies to the next payroll post. Journals already posted are unchanged.",
      });
      router.refresh();
    } finally {
      setSaving(null);
    }
  }

  return (
    <div data-testid="dept-overrides-editor">
      {props.departments.length === 0 ? (
        <p className="text-[13px]" style={{ color: "var(--spectre-text-secondary)" }}>
          No active departments. Add departments in Chart of Accounts → Departments before configuring per-department payroll overrides.
        </p>
      ) : (
        <div className="space-y-4">
          {props.departments.map((d) => {
            const state = rows[d.id];
            const hasAnyOverride =
              state.salaryExpenseAccountId != null ||
              state.employerCppExpenseAccountId != null ||
              state.employerEiExpenseAccountId != null;
            return (
              <div
                key={d.id}
                className="rounded-md border px-4 py-3"
                style={{ background: "#fbfaf7", borderColor: "var(--spectre-border-muted)" }}
                data-testid={`dept-override-row-${d.id}`}
              >
                <header className="mb-2 flex items-baseline justify-between gap-3">
                  <div>
                    <p className="text-[13.5px] font-semibold text-stone-800">{d.name}</p>
                    <p className="text-[11.5px] text-stone-500">{d.code}</p>
                  </div>
                  <span
                    className="rounded-full px-2 py-0.5 text-[10.5px] font-medium"
                    style={
                      hasAnyOverride
                        ? { background: "#eff6ff", color: "#1e40af" }
                        : { background: "#f5f5f4", color: "#78716c" }
                    }
                    data-testid={`dept-override-status-${d.id}`}
                    data-state={hasAnyOverride ? "override" : "inherit"}
                  >
                    {hasAnyOverride ? "Explicit override" : "Inherits global"}
                  </span>
                </header>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {ROW_FIELDS.map((f) => (
                    <label key={f.key} className="text-[12.5px]">
                      <span className="mb-0.5 block font-medium text-stone-700">{f.label}</span>
                      <span className="mb-1 block text-[10.5px] text-stone-500">{f.hint}</span>
                      <select
                        className="input w-full text-[12.5px]"
                        value={state[f.key] ?? ""}
                        disabled={!props.canWrite || saving === d.id}
                        onChange={(e) =>
                          setRows({
                            ...rows,
                            [d.id]: { ...state, [f.key]: e.target.value || null },
                          })
                        }
                        data-testid={`dept-override-select-${d.id}-${f.key}`}
                      >
                        <option value="">
                          Inherit global ({globalLabel(props.globalDefaults[f.key])})
                        </option>
                        {props.expenseAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.accountNumber} — {a.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={!props.canWrite || saving === d.id}
                    onClick={() => saveRow(d.id)}
                    data-testid={`dept-override-save-${d.id}`}
                  >
                    {saving === d.id ? "Saving…" : hasAnyOverride ? "Save override" : "Clear override"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {message ? (
        <p
          className="mt-4 text-[12.5px]"
          data-testid="dept-overrides-message"
          style={{ color: message.tone === "success" ? "#0f5d3a" : "#8a2f00" }}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
