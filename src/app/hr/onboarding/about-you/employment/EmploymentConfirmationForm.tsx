"use client";

// HR-2B.5 §17-18 — Employment confirmation form with conditional
// correction reveal.
//
// Initial state:
//   • "Yes — that's right" radio is selected.
//   • The correction section is HIDDEN.
//
// When the employee selects "Something needs correcting":
//   • A field-picker (four checkboxes) appears.
//   • For each field the employee checks, its individual correction
//     text input appears below its checkbox.
//   • Unchecked fields keep their correction input HIDDEN — the form
//     stays quiet until the employee tells us what's off.
//
// The server action `confirmEmploymentAction` is unchanged; it already
// handles "correct" vs "needs_correction" branches correctly. The
// difference here is purely presentational — the checkbox+value fields
// still submit with the same names when visible; hiding them means
// their `enabled` checkbox goes unchecked, which the server treats as
// "not corrected."

import Link from "next/link";
import { useState, useMemo } from "react";

export interface EmploymentField {
  field: "positionId" | "departmentId" | "employmentType" | "expectedStartDate";
  label: string;
  clubValue: string;
  placeholder: string;
}

interface Props {
  action: (formData: FormData) => Promise<void> | void;
  fields: EmploymentField[];
  priorByField: Record<string, string>;
  hadCorrection: boolean;
  backHref: string;
}

export default function EmploymentConfirmationForm({
  action,
  fields,
  priorByField,
  hadCorrection,
  backHref,
}: Props) {
  const [outcome, setOutcome] = useState<"correct" | "needs_correction">(
    hadCorrection ? "needs_correction" : "correct",
  );

  const initialChecked = useMemo(() => {
    const seed: Record<string, boolean> = {};
    for (const f of fields) seed[f.field] = Boolean(priorByField[f.field]);
    return seed;
  }, [fields, priorByField]);

  const [checkedFields, setCheckedFields] = useState<Record<string, boolean>>(initialChecked);

  const showCorrectionSection = outcome === "needs_correction";

  return (
    <form action={action} className="mt-6 space-y-5" noValidate>
      <fieldset>
        <legend className="text-sm text-stone-700">Does everything above look correct?</legend>
        <div className="mt-3 space-y-2.5">
          <label className="flex items-start gap-3 rounded-md border border-stone-200 px-3 py-2.5 hover:border-stone-300 cursor-pointer">
            <input
              type="radio"
              name="outcome"
              value="correct"
              checked={outcome === "correct"}
              onChange={() => setOutcome("correct")}
              data-testid="employment-outcome-correct"
              className="mt-1 text-emerald-700 focus:ring-emerald-700"
            />
            <span className="text-sm text-stone-800">
              Yes, everything looks right.
            </span>
          </label>
          <label className="flex items-start gap-3 rounded-md border border-stone-200 px-3 py-2.5 hover:border-stone-300 cursor-pointer">
            <input
              type="radio"
              name="outcome"
              value="needs_correction"
              checked={outcome === "needs_correction"}
              onChange={() => setOutcome("needs_correction")}
              data-testid="employment-outcome-correction"
              className="mt-1 text-emerald-700 focus:ring-emerald-700"
            />
            <span className="text-sm text-stone-800">
              Something needs correcting.
            </span>
          </label>
        </div>
      </fieldset>

      {showCorrectionSection && (
        <fieldset data-testid="correction-section">
          <legend className="text-sm text-stone-700">
            What needs correcting?
          </legend>
          <p className="mt-1 text-xs text-stone-500">
            Check each item that's wrong, then tell us what it should be.
            Your Club will review the correction — we won't change your
            record until they do.
          </p>

          <div className="mt-3 space-y-3">
            {fields.map((f) => {
              const checked = checkedFields[f.field] ?? false;
              const prior = priorByField[f.field] ?? "";
              return (
                <div
                  key={f.field}
                  className="rounded-md border border-stone-200 px-3 py-2.5"
                  data-testid={`correction-row-${f.field}`}
                >
                  <label className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      name={`correction:${f.field}:enabled`}
                      value="1"
                      checked={checked}
                      onChange={(e) =>
                        setCheckedFields((prev) => ({
                          ...prev,
                          [f.field]: e.target.checked,
                        }))
                      }
                      data-testid={`correction-${f.field}-enabled`}
                      className="text-emerald-700 focus:ring-emerald-700"
                    />
                    <span className="text-sm text-stone-800">
                      {f.label}{" "}
                      <span className="text-stone-400">— Club record: {f.clubValue}</span>
                    </span>
                  </label>
                  {checked && (
                    <label className="mt-2 block" data-testid={`correction-value-wrapper-${f.field}`}>
                      <span className="sr-only">Correct value for {f.label}</span>
                      <input
                        type="text"
                        name={`correction:${f.field}:value`}
                        defaultValue={prior}
                        placeholder={f.placeholder}
                        maxLength={500}
                        data-testid={`correction-${f.field}-value`}
                        className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
                      />
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="flex items-center justify-between pt-2">
        <Link
          href={backHref}
          className="text-sm text-stone-500 hover:text-stone-800"
        >
          &larr; Back
        </Link>
        <button
          type="submit"
          className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
        >
          Continue
        </button>
      </div>
    </form>
  );
}
