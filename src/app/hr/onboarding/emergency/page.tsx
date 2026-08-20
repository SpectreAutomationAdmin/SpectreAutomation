// HR-2B.4 (2026-08-19) — Emergency contact step.
//
// Founder-approved conversational framing: three plain questions
// (Who / Relationship / Phone) with an optional email. No large form,
// no gratuitous fields. The employee can save, revisit, and update.

import { redirect } from "next/navigation";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { getSelfEmergencyContact } from "@/lib/hr/employee-self-service";
import { saveEmergencyContactAction } from "../_hr2b4-actions";
import PostPayrollShell from "../_post-payroll-shell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EmergencyContactStep() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const existing = await getSelfEmergencyContact(actor);

  return (
    <PostPayrollShell
      actor={actor}
      currentSection="emergency"
      headline="Someone we can call, {name}."
      subhead="If we ever need to reach someone on your behalf, this is who we'll contact. One person is enough."
    >
      <article className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10">
        <h2 className="font-serif text-2xl leading-tight text-stone-900">
          Emergency contact.
        </h2>
        <p className="mt-2 text-sm text-stone-500 leading-relaxed">
          Your Club uses this only if there's an urgent reason to reach someone
          you trust. It's not visible to other members and only authorized
          HR staff can see it.
        </p>

        <form
          action={saveEmergencyContactAction}
          className="mt-8 space-y-6"
          noValidate
        >
          <label className="block">
            <span className="block text-sm text-stone-700">
              Who should we contact in an emergency?
            </span>
            <input
              type="text"
              name="name"
              required
              maxLength={200}
              defaultValue={existing?.name ?? ""}
              placeholder="e.g. Jamie Whitfield"
              autoComplete="name"
              data-testid="emergency-name"
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
            />
          </label>

          <label className="block">
            <span className="block text-sm text-stone-700">
              What's their relationship to you?
            </span>
            <input
              type="text"
              name="relation"
              required
              maxLength={100}
              defaultValue={existing?.relation ?? ""}
              placeholder="e.g. Spouse, Parent, Sibling"
              data-testid="emergency-relation"
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
            />
          </label>

          <label className="block">
            <span className="block text-sm text-stone-700">
              What&apos;s the best phone number to reach them?
            </span>
            <input
              type="tel"
              name="phone"
              required
              maxLength={40}
              defaultValue={existing?.phone ?? ""}
              placeholder="(403) 555-0123"
              autoComplete="tel"
              inputMode="tel"
              data-testid="emergency-phone"
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
            />
          </label>

          <label className="block">
            <span className="block text-sm text-stone-700">
              Email <span className="text-stone-400 text-xs">(optional)</span>
            </span>
            <input
              type="email"
              name="email"
              maxLength={254}
              defaultValue={existing?.email ?? ""}
              placeholder="optional"
              autoComplete="email"
              data-testid="emergency-email"
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
            />
          </label>

          {existing && (
            <p className="text-xs text-stone-500" data-testid="emergency-existing-notice">
              You&apos;ve already added a contact. Saving will update this record.
            </p>
          )}

          <div className="flex items-center justify-end pt-2">
            <button
              type="submit"
              data-testid="emergency-save"
              className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
            >
              {existing ? "Save changes" : "Save contact"}
            </button>
          </div>
        </form>
      </article>
    </PostPayrollShell>
  );
}
