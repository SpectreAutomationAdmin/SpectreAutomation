// HR-2B.2 (2026-08-18) — About You · Name step.

import { redirect } from "next/navigation";
import Link from "next/link";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { prisma } from "@/lib/prisma";
import { saveNameAction } from "../_actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function NameStep() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const employee = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: {
      firstName: true,
      middleName: true,
      lastName: true,
      preferredName: true,
    },
  });
  if (!employee) redirect("/hr/onboarding/expired");

  return (
    <article className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10">
      <h2 className="font-serif text-2xl leading-tight text-stone-900">
        Let's start with your name.
      </h2>
      <p className="mt-2 text-sm text-stone-500 leading-relaxed">
        Your Club has you as{" "}
        <span className="text-stone-800 font-medium">
          {[employee.firstName, employee.middleName, employee.lastName].filter(Boolean).join(" ")}
        </span>
        . Please confirm this matches your government identification exactly,
        and tell us what you'd like us to call you day-to-day.
      </p>

      <form action={saveNameAction} className="mt-8 space-y-6" noValidate>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block">
            <span className="block text-sm text-stone-700">Legal first name</span>
            <input
              type="text"
              name="firstName"
              required
              autoComplete="given-name"
              defaultValue={employee.firstName ?? ""}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
            />
          </label>
          <label className="block">
            <span className="block text-sm text-stone-700">Middle name <span className="text-stone-400 text-xs">(optional)</span></span>
            <input
              type="text"
              name="middleName"
              autoComplete="additional-name"
              defaultValue={employee.middleName ?? ""}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
            />
          </label>
        </div>
        <label className="block">
          <span className="block text-sm text-stone-700">Legal last name</span>
          <input
            type="text"
            name="lastName"
            required
            autoComplete="family-name"
            defaultValue={employee.lastName ?? ""}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
          />
        </label>
        <label className="block">
          <span className="block text-sm text-stone-700">Preferred name <span className="text-stone-400 text-xs">(what your team calls you)</span></span>
          <input
            type="text"
            name="preferredName"
            autoComplete="nickname"
            defaultValue={employee.preferredName ?? ""}
            placeholder={employee.firstName ?? ""}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
          />
        </label>

        <div className="flex items-center justify-between pt-2">
          <Link
            href="/hr/onboarding/about-you"
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
