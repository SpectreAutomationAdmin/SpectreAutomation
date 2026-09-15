// Payroll Admin Slice 3E (2026-09-12) — Submit + Return server
// actions for the Payroll Overview surface. Delegates to canonical
// domain services. Preserves `payGroupId` in the redirect (§3D lesson).
//
// v-slice-1-followup-3 (2026-09-15) — §9 error UX: Submit failures
// now flow back to the payroll page with a `?err=<safeMessage>` query
// param instead of throwing a raw Next.js server-action error.
// PayrollAdminOverview renders that param as a founder-visible banner.
// Every domain error type maps to specific, actionable copy per the
// founder directive.

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { submitPayrollBatch, SubmitConcurrencyConflictError } from "@/lib/payroll/submit-payroll-batch";
import { returnPayrollBatch } from "@/lib/payroll/return-payroll-batch";
import { isAppError, ValidationError, ConflictError } from "@/lib/errors";

async function context() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/app/admin");
  return { principal, clubId };
}

function back(payPeriodId: string, payGroupId: string | null, err?: string, ok?: string): never {
  const q = new URLSearchParams();
  if (payGroupId) q.set("payGroupId", payGroupId);
  if (payPeriodId) q.set("payPeriodId", payPeriodId);
  if (err) q.set("err", err);
  if (ok) q.set("ok", ok);
  redirect(`/app/admin/payroll?${q.toString()}`);
}

// Founder-readable message extraction — every branch matches a
// specific error class produced by `submitPayrollBatch` so the
// banner explains what to do next, not what internally broke.
function submitErrorMessage(err: unknown): string {
  if (err instanceof SubmitConcurrencyConflictError) {
    return "Another submission of this payroll happened at the same time. Reload the page and check the current status before retrying.";
  }
  if (err instanceof ValidationError) {
    const issues = err.issues ?? [];
    if (issues.length > 0) return issues[0].message ?? err.safeMessage;
    return err.safeMessage;
  }
  if (err instanceof ConflictError) return err.safeMessage;
  if (isAppError(err)) return err.safeMessage;
  return "Submit failed for an unexpected reason. Reload the page and try again — if it keeps failing, contact Spectre support.";
}

export async function submitPayrollAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const payPeriodId = String(formData.get("payPeriodId") ?? "").trim();
  const payGroupId  = String(formData.get("payGroupId")  ?? "").trim() || null;
  const batchId     = String(formData.get("batchId")     ?? "").trim();
  const note        = String(formData.get("note")        ?? "").trim() || null;
  if (!batchId) back(payPeriodId, payGroupId, "Submit failed: no batch id was provided.");
  try {
    await submitPayrollBatch(principal, clubId, batchId, { note });
  } catch (err) {
    // `redirect()` inside a try/catch is trapped by the caught Error
    // because Next.js throws a NEXT_REDIRECT sentinel — rethrow it.
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    back(payPeriodId, payGroupId, submitErrorMessage(err));
  }
  revalidatePath("/app/admin/payroll");
  back(payPeriodId, payGroupId, undefined, "Submitted for Controller approval.");
}

export async function returnPayrollFromAdminAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const payPeriodId = String(formData.get("payPeriodId") ?? "").trim();
  const payGroupId  = String(formData.get("payGroupId")  ?? "").trim() || null;
  const batchId     = String(formData.get("batchId")     ?? "").trim();
  const reason      = String(formData.get("reason")      ?? "").trim();
  if (!batchId || !reason) back(payPeriodId, payGroupId);
  await returnPayrollBatch(principal, clubId, batchId, reason);
  revalidatePath("/app/admin/payroll");
  back(payPeriodId, payGroupId);
}
