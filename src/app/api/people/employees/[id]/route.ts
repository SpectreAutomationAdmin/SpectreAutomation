// Post-onboarding-admin hotfix (2026-09-13) — PATCH /api/people/employees/[id].
//
// Admin-side edit endpoint for ordinary HR profile maintenance. Wraps
// the canonical `updateEmployee` service; permission + sensitive-action
// guards are enforced inside the service.
//
// Accepted fields (mirrors UpdateEmployeeInput):
//   * preferredName, personalEmail, email, phone, mobilePhone
//   * homeAddressLine1..homeCountry
//   * firstName, middleName, lastName (audited)
//   * departmentId, positionId (legacy — new writes go through the
//     Employment tab which uses orgPositionId directly)
//   * expectedStartDate, employmentType
//
// Explicitly NOT accepted here (per §24):
//   * SIN, banking, tax profile — those have dedicated sensitive-data
//     workflows with their own permission/reveal/audit rules.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isAppError, ValidationError } from "@/lib/errors";
import { updateEmployee } from "@/lib/hr/employees";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Allowlist of accepted field names — silently drops anything else so
// a malformed client cannot smuggle sensitive fields through.
const ALLOWED_FIELDS = new Set<string>([
  "firstName", "middleName", "lastName", "preferredName",
  "email", "personalEmail", "phone", "mobilePhone",
  "homeAddressLine1", "homeAddressLine2", "homeCity",
  "homeProvince", "homePostalCode", "homeCountry",
  "departmentId", "positionId",
  "expectedStartDate", "employmentType",
]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  let body: Record<string, unknown> = {};
  try {
    const raw = await req.json();
    if (raw && typeof raw === "object") body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected JSON body" }, { status: 400 });
  }

  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (ALLOWED_FIELDS.has(k)) filtered[k] = v;
  }

  try {
    const updated = await updateEmployee(principal, params.id, filtered);
    return NextResponse.json({
      id: updated.id,
      // Return the fields the client rerenders — keep the response
      // minimal so callers don't accidentally start reading sensitive
      // data they didn't ask for.
      firstName: updated.firstName,
      middleName: updated.middleName ?? null,
      lastName: updated.lastName,
      preferredName: updated.preferredName ?? null,
      email: updated.email ?? null,
      personalEmail: updated.personalEmail ?? null,
      phone: updated.phone ?? null,
      mobilePhone: updated.mobilePhone ?? null,
      homeAddressLine1: updated.homeAddressLine1 ?? null,
      homeAddressLine2: updated.homeAddressLine2 ?? null,
      homeCity: updated.homeCity ?? null,
      homeProvince: updated.homeProvince ?? null,
      homePostalCode: updated.homePostalCode ?? null,
      homeCountry: updated.homeCountry ?? null,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.safeMessage, issues: err.issues }, { status: err.httpStatus });
    }
    if (isAppError(err)) {
      return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    }
    // eslint-disable-next-line no-console
    console.error("[people.employees.patch] internal error", {
      employeeId: params.id,
      raw: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Server error while updating employee." }, { status: 500 });
  }
}
