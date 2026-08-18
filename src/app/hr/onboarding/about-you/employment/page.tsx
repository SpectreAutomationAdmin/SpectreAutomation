// HR-2B.2 (2026-08-18) — About You · Employment confirmation.
//
// The employee CONFIRMS the Club-authoritative employment fields
// (position, department, expected start date) — they cannot overwrite
// them. If something is wrong, they flag a correction, which HR staff
// see in the review UI (HR-2B.5+).

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
        and we'll pass it back to the HR team to fix — you don't need to correct
        it yourself.
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

      <form action={confirmEmploymentAction} className="mt-6 space-y-4" noValidate>
        <fieldset>
          <legend className="text-sm text-stone-700">Is this correct?</legend>
          <div className="mt-3 space-y-2.5">
            <label className="flex items-start gap-3 rounded-md border border-stone-200 px-3 py-2.5 hover:border-stone-300 cursor-pointer">
              <input
                type="radio"
                name="outcome"
                value="correct"
                defaultChecked
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
                className="mt-1 text-emerald-700 focus:ring-emerald-700"
              />
              <span className="text-sm text-stone-800">
                Something needs correcting.
              </span>
            </label>
          </div>
        </fieldset>

        <label className="block">
          <span className="block text-sm text-stone-700">
            What should we change? <span className="text-stone-400 text-xs">(only needed if you chose "needs correcting")</span>
          </span>
          <textarea
            name="correctionNote"
            rows={3}
            maxLength={500}
            placeholder="e.g. I was hired as Golf Shop Attendant, not Assistant Golf Professional."
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
          />
        </label>

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
