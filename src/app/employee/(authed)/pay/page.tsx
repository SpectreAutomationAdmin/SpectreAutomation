// Pay area — HR-2B.5 §34.
//
// Payroll processing has not been built (founder authorisation).
// Empty state is truthful, no developer-facing copy.

import { redirect } from "next/navigation";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EmployeePortalPayPage() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  return (
    <div data-testid="portal-pay">
      <h1 className="font-serif text-3xl text-club-ink">Pay</h1>
      <p className="mt-2 text-sm text-stone-500">
        Your pay statements and payroll history will appear here.
      </p>
      <div
        className="mt-8 rounded-lg border border-dashed border-stone-300 bg-white px-6 py-10 text-center"
        data-testid="portal-pay-empty"
      >
        <p className="text-sm text-stone-600">
          No pay statements are available yet.
        </p>
        <p className="mt-2 text-xs text-stone-500">
          Once your Club processes your first pay period, your statement
          will appear here.
        </p>
      </div>
    </div>
  );
}
