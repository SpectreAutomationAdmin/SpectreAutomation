// HR-2B.2 final (2026-08-19) — About You · Employment confirmation.
// HR-2B.5 §17-18 (2026-08-19) — Correction UI is now client-gated:
//   • The correction section stays HIDDEN until the employee picks
//     "Something needs correcting."
//   • Individual correction text inputs stay HIDDEN until the
//     employee checks their field's checkbox.
// Presentation moved to `EmploymentConfirmationForm` (client);
// server-side data loading + server action unchanged.
//
// The employee CONFIRMS the Club-authoritative employment fields
// (position, department, employment type, expected start date).
// They cannot overwrite the values themselves.
//
// Outcomes:
//   • "Yes, everything looks right"       → writes a durable
//     EmployeeOnboardingAcknowledgement row (kind=employment_confirmation).
//   • "Something needs correcting"        → for EACH checked field the
//     employee flags, writes ONE EmployeeOnboardingCorrection row
//     carrying the canonical field identifier + the employee's stated
//     value. The Club-authoritative value is never mutated.

import { redirect } from "next/navigation";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { prisma } from "@/lib/prisma";
import { confirmEmploymentAction } from "../_actions";
import EmploymentConfirmationForm, {
  type EmploymentField,
} from "./EmploymentConfirmationForm";

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

  const fields = buildFields(positionLabel, departmentLabel, typeLabel, startLabel);

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

      <EmploymentConfirmationForm
        action={confirmEmploymentAction}
        fields={fields}
        priorByField={Object.fromEntries(priorByField)}
        hadCorrection={hadCorrection}
        backHref="/hr/onboarding/about-you/contact"
      />
    </article>
  );
}

// Extracted so the field metadata lives with the server-side data
// fetch (labels come from the DB), while the toggle behaviour lives
// in the client component.
function buildFields(
  positionLabel: string,
  departmentLabel: string,
  typeLabel: string | null,
  startLabel: string | null,
): EmploymentField[] {
  return [
    { field: "positionId", label: "Position", clubValue: positionLabel, placeholder: "e.g. Golf Shop Attendant" },
    { field: "departmentId", label: "Department", clubValue: departmentLabel, placeholder: "e.g. Food & Beverage" },
    { field: "employmentType", label: "Employment type", clubValue: typeLabel ?? "not set", placeholder: "e.g. Part-time seasonal" },
    { field: "expectedStartDate", label: "Expected start date", clubValue: startLabel ?? "not set", placeholder: "e.g. September 21, 2026" },
  ];
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
