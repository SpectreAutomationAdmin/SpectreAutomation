// HR-2C Portal Refinement (2026-08-24 / expanded 2026-08-28) —
// Employee Portal Profile self-service server actions.

"use server";

import { revalidatePath } from "next/cache";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import {
  updateSelfPersonalContact,
  upsertSelfPrimaryEmergencyContact,
  updateSelfHomeAddress,
  submitSelfBankReplacement,
  type UpdateHomeAddressInput,
} from "@/lib/hr/portal-self-service-profile";
import { isAppError, ValidationError } from "@/lib/errors";

interface Ok<T = void> { ok: true; result?: T }
interface Err { ok: false; error: string }

function toErr(e: unknown): Err {
  if (e instanceof ValidationError) return { ok: false, error: e.issues[0]?.message ?? e.safeMessage };
  if (isAppError(e)) return { ok: false, error: e.safeMessage };
  return { ok: false, error: "Something went wrong. Please try again." };
}

async function requirePortal() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) throw new Error("PORTAL_REQUIRED");
  return principal;
}

// ---------------------------------------------------------------------------
// Personal contact — email + mobile phone
// ---------------------------------------------------------------------------

export async function updatePersonalContactAction(
  input: { personalEmail?: string | null; mobilePhone?: string | null },
): Promise<Ok | Err> {
  try {
    const principal = await requirePortal();
    await updateSelfPersonalContact(principal, {
      personalEmail: input.personalEmail ?? undefined,
      mobilePhone: input.mobilePhone ?? undefined,
    });
    revalidatePath("/employee/profile");
    return { ok: true };
  } catch (e) { return toErr(e); }
}

// ---------------------------------------------------------------------------
// Home / mailing address
// ---------------------------------------------------------------------------

export async function updateHomeAddressAction(
  input: UpdateHomeAddressInput,
): Promise<Ok | Err> {
  try {
    const principal = await requirePortal();
    await updateSelfHomeAddress(principal, input);
    revalidatePath("/employee/profile");
    return { ok: true };
  } catch (e) { return toErr(e); }
}

// ---------------------------------------------------------------------------
// Emergency contact — primary
// ---------------------------------------------------------------------------

export async function upsertPrimaryEmergencyContactAction(
  input: { name: string; relation: string; phone: string; email?: string | null },
): Promise<Ok | Err> {
  try {
    const principal = await requirePortal();
    await upsertSelfPrimaryEmergencyContact(principal, {
      name: input.name,
      relation: input.relation,
      phone: input.phone,
      email: input.email ?? null,
    });
    revalidatePath("/employee/profile");
    return { ok: true };
  } catch (e) { return toErr(e); }
}

// ---------------------------------------------------------------------------
// Direct deposit — secure replacement via canonical HR-1H writer
// ---------------------------------------------------------------------------
//
// This delegates to the canonical `submitSelfBankAccount` in
// `employee-self-service.ts` — the SAME writer the onboarding flow
// uses. History semantics are guaranteed identical:
//   - no current row → create fresh PENDING_PENNY_TEST;
//   - PENDING → update in place;
//   - VERIFIED → move to INACTIVE + create new PENDING_PENNY_TEST.
// The employee CANNOT set status VERIFIED — that's an admin
// `hr:banking:approve` action guarded by assertSensitiveActionAllowed.

export async function submitDirectDepositAction(
  input: { holderName: string; institutionNumber: string; transitNumber: string; accountNumber: string },
): Promise<Ok | Err> {
  try {
    const principal = await requirePortal();
    await submitSelfBankReplacement(principal, input);
    revalidatePath("/employee/profile");
    return { ok: true };
  } catch (e) { return toErr(e); }
}
