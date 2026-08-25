// HR mobile-hotfix (2026-08-30) §1 — About You · Address step.
//
// Sits between Contact and Employment. Prefills from whatever the
// admin optionally captured at Employee creation OR the employee's
// own prior submission if they're resuming the step. The employee
// confirms or edits and taps Continue; the durable
// `about_you_address_confirmation` ack row is what the continuation
// resolver reads to move past this step.

import { redirect } from "next/navigation";
import Link from "next/link";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { getOnboardingHomeAddress } from "@/lib/hr/employee-self-service";
import { saveAddressAction } from "../_actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AddressStep({
  searchParams,
}: {
  searchParams?: Promise<{ err?: string }>;
}) {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");
  const sp = (await (searchParams ?? Promise.resolve({}))) as { err?: string };

  const address = await getOnboardingHomeAddress(actor);
  const hasPrefill = Boolean(address.homeAddressLine1 || address.homeCity);

  return (
    <article className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10">
      <h2 className="font-serif text-2xl leading-tight text-stone-900">
        Where do you live?
      </h2>
      <p className="mt-2 text-sm text-stone-500 leading-relaxed">
        {hasPrefill
          ? "The Club noted this address when they added you. Please confirm it's correct or make any changes."
          : "We use this for your T4, pay statements, and any mail we send you."}
      </p>

      {sp.err && (
        <div
          className="mt-4 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-sm text-amber-900"
          role="alert"
          data-testid="address-error"
        >
          {sp.err}
        </div>
      )}

      <form action={saveAddressAction} className="mt-8 space-y-5" noValidate>
        <label className="block">
          <span className="block text-sm text-stone-700">Street address</span>
          <input
            type="text"
            name="homeAddressLine1"
            required
            autoComplete="address-line1"
            defaultValue={address.homeAddressLine1 ?? ""}
            placeholder="123 Fairway Lane"
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
            data-testid="address-line1"
          />
        </label>
        <label className="block">
          <span className="block text-sm text-stone-700">Suite / apt (optional)</span>
          <input
            type="text"
            name="homeAddressLine2"
            autoComplete="address-line2"
            defaultValue={address.homeAddressLine2 ?? ""}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
            data-testid="address-line2"
          />
        </label>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <label className="block">
            <span className="block text-sm text-stone-700">City</span>
            <input
              type="text"
              name="homeCity"
              required
              autoComplete="address-level2"
              defaultValue={address.homeCity ?? ""}
              placeholder="Calgary"
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
              data-testid="address-city"
            />
          </label>
          <label className="block">
            <span className="block text-sm text-stone-700">Province / state</span>
            <input
              type="text"
              name="homeProvince"
              autoComplete="address-level1"
              defaultValue={address.homeProvince ?? ""}
              placeholder="AB"
              maxLength={32}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 uppercase focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
              data-testid="address-province"
            />
          </label>
        </div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <label className="block">
            <span className="block text-sm text-stone-700">Postal / ZIP code</span>
            <input
              type="text"
              name="homePostalCode"
              autoComplete="postal-code"
              defaultValue={address.homePostalCode ?? ""}
              placeholder="T2P 3H7"
              maxLength={16}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 uppercase focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
              data-testid="address-postal"
            />
          </label>
          <label className="block">
            <span className="block text-sm text-stone-700">Country</span>
            <input
              type="text"
              name="homeCountry"
              autoComplete="country"
              defaultValue={address.homeCountry ?? "CA"}
              placeholder="CA"
              maxLength={2}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 uppercase focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
              data-testid="address-country"
            />
          </label>
        </div>

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
            data-testid="address-continue"
          >
            {hasPrefill ? "Confirm & continue" : "Continue"}
          </button>
        </div>
      </form>
    </article>
  );
}
