// HR-2B.2 final (2026-08-19) — About You · Employment confirmation.
//
// The employee CONFIRMS the Club-authoritative employment fields
// (position, department, employment type, expected start date).
// They cannot overwrite the values themselves.
//
// Outcomes:
//   • "Yes — that's right"                → writes a durable
//     EmployeeOnboardingAcknowledgement row (kind=employment_confirmation).
//   • "Something needs correcting"        → for EACH checked field the
//     employee flags, writes ONE EmployeeOnboardingCorrection row
//     carrying the canonical field identifier + the employee's stated
//     value. The Club-authoritative value is never mutated.

import { redirect } from "next/navigation";
import Link from "next/link";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { prisma } from "@/lib/prisma";
import { confirmEmploymentAction } from "../_actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EmploymentStep() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const employee = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: {
      expectedStartDate: true,
      employmentType: true,
      department: { select: { name: true } },
      position: { select: { name: true } },
      club: { select: { name: true } },
    },
  });
  if (!employee) redirect("/hr/onboarding/expired");

  // Load any prior corrections so the form can pre-fill the employee's
  // last-stated values on refresh / back navigation.
  const priorCorrections = await prisma.employeeOnboardingCorrection.findMany({
    where: {
      sessionId: actor.sessionId,
      clubId: actor.clubId,
      field: { in: ["positionId", "departmentId", "expectedStartDate", "employmentType"] },
    },
    orderBy: { createdAt: "asc" },
  });
  const priorByField = new Map<string, string>();
  for (const c of priorCorrections) priorByField.set(c.field, c.employeeStatedValue);
  const hadCorrection = priorCorrections.length > 0;

  const positionLabel = employee.position?.name ?? "your role";
  const departmentLabel = employee.department?.name ?? "our team";
  const startLabel = employee.expectedStartDate
    ? formatDate(employee.expectedStartDate)
    : null;
  const typeLabel = formatEmploymentType(employee.employmentType);

  return (
    <article className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10">
      <h2 className="font-serif text-2xl leading-tight text-stone-900">
        Let's confirm your role.
      </h2>
      <p className="mt-2 text-sm text-stone-500 leading-relaxed">
        Your Club has recorded the following. If anything is off, let us know
        which item is wrong and what it should be — we'll pass it back to the HR
        team.
      </p>

      <dl className="mt-6 divide-y divide-stone-200 border border-stone-200 rounded-md">
        <div className="grid grid-cols-3 gap-4 px-4 py-3">
          <dt className="text-sm text-stone-500">Position</dt>
          <dd className="col-span-2 text-sm text-stone-900">{positionLabel}</dd>
        </div>
        <div className="grid grid-cols-3 gap-4 px-4 py-3">
          <dt className="text-sm text-stone-500">Department</dt>
          <dd className="col-span-2 text-sm text-stone-900">{departmentLabel}</dd>
        </div>
        {typeLabel && (
          <div className="grid grid-cols-3 gap-4 px-4 py-3">
            <dt className="text-sm text-stone-500">Employment type</dt>
            <dd className="col-span-2 text-sm text-stone-900">{typeLabel}</dd>
          </div>
        )}
        {startLabel && (
          <div className="grid grid-cols-3 gap-4 px-4 py-3">
            <dt className="text-sm text-stone-500">Expected start date</dt>
            <dd className="col-span-2 text-sm text-stone-900">{startLabel}</dd>
          </div>
        )}
      </dl>

      <form action={confirmEmploymentAction} className="mt-6 space-y-5" noValidate>
        <fieldset>
          <legend className="text-sm text-stone-700">Is this correct?</legend>
          <div className="mt-3 space-y-2.5">
            <label className="flex items-start gap-3 rounded-md border border-stone-200 px-3 py-2.5 hover:border-stone-300 cursor-pointer">
              <input
                type="radio"
                name="outcome"
                value="correct"
                defaultChecked={!hadCorrection}
                data-testid="employment-outcome-correct"
                className="mt-1 text-emerald-700 focus:ring-emerald-700"
              />
              <span className="text-sm text-stone-800">
                Yes — that's right.
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-md border border-stone-200 px-3 py-2.5 hover:border-stone-300 cursor-pointer">
              <input
                type="radio"
                name="outcome"
                value="needs_correction"
                defaultChecked={hadCorrection}
                data-testid="employment-outcome-correction"
                className="mt-1 text-emerald-700 focus:ring-emerald-700"
              />
              <span className="text-sm text-stone-800">
                Something needs correcting.
              </span>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm text-stone-700">
            Which item(s) need correcting?
          </legend>
          <p className="mt-1 text-xs text-stone-400">
            Only fill this in if you chose "Something needs correcting" above.
            For each item you check, tell us what it should be.
          </p>

          <div className="mt-3 space-y-3">
            {(
              [
                { field: "positionId", label: "Position", clubValue: positionLabel, placeholder: "e.g. Golf Shop Attendant" },
                { field: "departmentId", label: "Department", clubValue: departmentLabel, placeholder: "e.g. Food & Beverage" },
                { field: "employmentType", label: "Employment type", clubValue: typeLabel ?? "not set", placeholder: "e.g. Part-time seasonal" },
                { field: "expectedStartDate", label: "Expected start date", clubValue: startLabel ?? "not set", placeholder: "e.g. September 21, 2026" },
              ] as const
            ).map((f) => {
              const prior = priorByField.get(f.field) ?? "";
              return (
                <div key={f.field} className="rounded-md border border-stone-200 px-3 py-2.5">
                  <label className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      name={`correction:${f.field}:enabled`}
                      value="1"
                      defaultChecked={Boolean(prior)}
                      data-testid={`correction-${f.field}-enabled`}
                      className="text-emerald-700 focus:ring-emerald-700"
                    />
                    <span className="text-sm text-stone-800">
                      {f.label}{" "}
                      <span className="text-stone-400">— Club record: {f.clubValue}</span>
                    </span>
                  </label>
                  <label className="mt-2 block">
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
                </div>
              );
            })}
          </div>
        </fieldset>

        <div className="flex items-center justify-between pt-2">
          <Link
            href="/hr/onboarding/about-you/contact"
            className="text-sm text-stone-500 hover:text-stone-800"
          >
            ← Back
          </Link>
          <button
            type="submit"
            className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
          >
            Continue
          </button>
        </div>
      </form>
    </article>
  );
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function formatEmploymentType(t: string | null): string | null {
  if (!t) return null;
  const map: Record<string, string> = {
    FULL_TIME: "Full-time",
    PART_TIME: "Part-time",
    SEASONAL: "Seasonal",
    CONTRACT: "Contract",
  };
  return map[t] ?? t;
}
