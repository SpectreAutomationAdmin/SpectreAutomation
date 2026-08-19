// HR-2B.2 (2026-08-18) — About You · Contact step.

import { redirect } from "next/navigation";
import Link from "next/link";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { prisma } from "@/lib/prisma";
import { saveContactAction } from "../_actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ContactStep() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const employee = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: {
      personalEmail: true,
      mobilePhone: true,
    },
  });
  if (!employee) redirect("/hr/onboarding/expired");

  return (
    <article className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10">
      <h2 className="font-serif text-2xl leading-tight text-stone-900">
        How can we reach you?
      </h2>
      <p className="mt-2 text-sm text-stone-500 leading-relaxed">
        We'll use your personal email for pay statements and important
        notices, and your mobile for time-sensitive scheduling messages
        (like a last-minute shift change).
      </p>

      <form action={saveContactAction} className="mt-8 space-y-6" noValidate>
        <label className="block">
          <span className="block text-sm text-stone-700">Personal email</span>
          <input
            type="email"
            name="personalEmail"
            required
            autoComplete="email"
            inputMode="email"
            defaultValue={employee.personalEmail ?? ""}
            placeholder="you@example.com"
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
          />
        </label>
        <label className="block">
          <span className="block text-sm text-stone-700">Mobile phone</span>
          <input
            type="tel"
            name="mobilePhone"
            required
            autoComplete="tel"
            inputMode="tel"
            defaultValue={employee.mobilePhone ?? ""}
            placeholder="(403) 555-0111"
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
          />
        </label>

        <div className="flex items-center justify-between pt-2">
          <Link
            href="/hr/onboarding/about-you/name"
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
