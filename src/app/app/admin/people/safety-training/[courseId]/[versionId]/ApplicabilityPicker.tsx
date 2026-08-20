"use client";

// HR-2C B2 §applicability UX (2026-08-20) — clear three-way picker
// (Everyone / Specific departments+positions / Assign individually)
// with progressive-disclosure of the scoped selectors. Never
// combines confusing overlapping controls.
//
// The three radio values map 1:1 to the server action's
// `applicabilityMode` field — the action translates them to the
// underlying flags on the version.

import { useState } from "react";

type Mode = "everyone" | "scoped" | "explicit";

interface Props {
  initialMode: Mode;
  departments: Array<{ id: string; name: string }>;
  positions: Array<{ id: string; name: string; departmentId: string | null }>;
  selectedDeptIds: string[];
  selectedPosIds: string[];
  disabled?: boolean;
}

export default function ApplicabilityPicker({
  initialMode,
  departments,
  positions,
  selectedDeptIds,
  selectedPosIds,
  disabled,
}: Props) {
  const [mode, setMode] = useState<Mode>(initialMode);

  return (
    <div className="space-y-3" data-testid="applicability-picker" data-mode={mode}>
      <label className="flex items-start gap-3">
        <input
          type="radio"
          name="applicabilityMode"
          value="everyone"
          className="mt-1"
          checked={mode === "everyone"}
          onChange={() => setMode("everyone")}
          disabled={disabled}
          data-testid="applicability-everyone"
        />
        <span>
          <span className="text-sm text-club-ink font-medium">Everyone</span>
          <span className="block text-xs text-stone-500">Every active employee at the Club is required to complete this.</span>
        </span>
      </label>
      <label className="flex items-start gap-3">
        <input
          type="radio"
          name="applicabilityMode"
          value="scoped"
          className="mt-1"
          checked={mode === "scoped"}
          onChange={() => setMode("scoped")}
          disabled={disabled}
          data-testid="applicability-scoped"
        />
        <span className="flex-1">
          <span className="text-sm text-club-ink font-medium">Specific departments or positions</span>
          <span className="block text-xs text-stone-500 mb-2">Employees in the selected departments or positions are required to complete this.</span>
          {mode === "scoped" && (
            <div className="space-y-3 border-l-2 border-emerald-200 pl-4" data-testid="applicability-scoped-picker">
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500 mb-1">Departments</div>
                <div className="flex flex-wrap gap-2">
                  {departments.map((d) => (
                    <label key={d.id} className="flex items-center gap-1.5 rounded border border-stone-200 px-2 py-1 text-xs">
                      <input
                        type="checkbox"
                        name="appliesToDeptIds"
                        value={d.id}
                        defaultChecked={selectedDeptIds.includes(d.id)}
                        disabled={disabled}
                        data-testid={`applicability-dept-${d.id}`}
                      />
                      {d.name}
                    </label>
                  ))}
                  {departments.length === 0 && <span className="text-xs text-stone-500">No departments yet.</span>}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500 mb-1">Positions</div>
                <div className="flex flex-wrap gap-2">
                  {positions.map((p) => (
                    <label key={p.id} className="flex items-center gap-1.5 rounded border border-stone-200 px-2 py-1 text-xs">
                      <input
                        type="checkbox"
                        name="appliesToPositionIds"
                        value={p.id}
                        defaultChecked={selectedPosIds.includes(p.id)}
                        disabled={disabled}
                        data-testid={`applicability-position-${p.id}`}
                      />
                      {p.name}
                    </label>
                  ))}
                  {positions.length === 0 && <span className="text-xs text-stone-500">No positions yet.</span>}
                </div>
              </div>
            </div>
          )}
        </span>
      </label>
      <label className="flex items-start gap-3">
        <input
          type="radio"
          name="applicabilityMode"
          value="explicit"
          className="mt-1"
          checked={mode === "explicit"}
          onChange={() => setMode("explicit")}
          disabled={disabled}
          data-testid="applicability-explicit"
        />
        <span>
          <span className="text-sm text-club-ink font-medium">Assign individually</span>
          <span className="block text-xs text-stone-500">
            The course applies only to employees you assign one at a time. Useful for remedial or role-specific training.
          </span>
        </span>
      </label>
    </div>
  );
}
