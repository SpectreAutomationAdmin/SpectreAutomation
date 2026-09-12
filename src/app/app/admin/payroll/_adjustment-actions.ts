// Payroll Admin Slice 3C (2026-09-12) — server actions for the
// one-time adjustment + recurring-component surfaces on the
// Payroll Overview. Every action delegates to a canonical domain
// service and adds nothing more than route-level auth resolution
// + `revalidatePath("/app/admin/payroll")` + redirect back to the
// Adjustments tab so the drawer closes into an in-place refresh.
//
// No new domain rules are introduced by this file. Batch-status
// gating (§10, §27) is enforced by `assertBatchAcceptsAdjustments`
// inside the domain services; the surface guards are ONLY a
// pre-check for button visibility, never for correctness.

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import {
  addOneTimeAdjustment,
  removeOneTimeAdjustment,
} from "@/lib/payroll/adjustments";
import {
  createRecurringComponentAssignment,
  endRecurringComponentAssignment,
} from "@/lib/payroll/components-catalogue";

async function context() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/app/admin");
  return { principal, clubId };
}

function backToAdjustments(payPeriodId: string): never {
  redirect(`/app/admin/payroll?payPeriodId=${encodeURIComponent(payPeriodId)}&tab=adjustments`);
}

/** Add a one-time adjustment to a PREPARED batch. Refuses on any
 *  other status via `assertBatchAcceptsAdjustments`. */
export async function addAdjustmentAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const payPeriodId    = String(formData.get("payPeriodId")    ?? "").trim();
  const batchId        = String(formData.get("batchId")        ?? "").trim();
  const batchEmployeeId = String(formData.get("batchEmployeeId") ?? "").trim();
  const componentCode  = String(formData.get("componentCode")  ?? "").trim();
  const amountRaw      = String(formData.get("amount")         ?? "").trim();
  const reason         = String(formData.get("reason")         ?? "").trim();
  if (!batchId || !batchEmployeeId || !componentCode || !amountRaw || !reason) {
    redirect(`/app/admin/payroll?payPeriodId=${encodeURIComponent(payPeriodId)}&tab=adjustments&err=missing-field`);
  }
  await addOneTimeAdjustment(principal, clubId, batchId, {
    batchEmployeeId, componentCode, amount: amountRaw, reason,
  });
  revalidatePath("/app/admin/payroll");
  backToAdjustments(payPeriodId);
}

/** Remove a one-time adjustment. Only permitted while the batch is
 *  PREPARED — enforced by the service. */
export async function removeAdjustmentAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const payPeriodId = String(formData.get("payPeriodId") ?? "").trim();
  const snapshotId  = String(formData.get("snapshotId")  ?? "").trim();
  if (!snapshotId) backToAdjustments(payPeriodId);
  await removeOneTimeAdjustment(principal, clubId, { snapshotId });
  revalidatePath("/app/admin/payroll");
  backToAdjustments(payPeriodId);
}

/** Create a recurring-component assignment on an employee. Effect
 *  on the CURRENT batch: NONE — recurring source changes never
 *  silently mutate a prepared batch (§25). The change flows into
 *  the next Prepare via `snapshotEmployeeComponentsForBatch`. */
export async function createRecurringAssignmentAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const payPeriodId    = String(formData.get("payPeriodId")    ?? "").trim();
  const employeeId     = String(formData.get("employeeId")     ?? "").trim();
  const componentId    = String(formData.get("componentId")    ?? "").trim();
  const amountRaw      = String(formData.get("amount")         ?? "").trim();
  const effectiveFromISO = String(formData.get("effectiveFrom") ?? "").trim();
  if (!employeeId || !componentId || !amountRaw || !effectiveFromISO) {
    redirect(`/app/admin/payroll?payPeriodId=${encodeURIComponent(payPeriodId)}&tab=adjustments&err=missing-field`);
  }
  const effectiveFrom = new Date(`${effectiveFromISO}T00:00:00.000Z`);
  if (Number.isNaN(effectiveFrom.getTime())) {
    redirect(`/app/admin/payroll?payPeriodId=${encodeURIComponent(payPeriodId)}&tab=adjustments&err=bad-date`);
  }
  await createRecurringComponentAssignment(principal, clubId, {
    employeeId, componentId, amount: amountRaw, effectiveFrom,
  });
  revalidatePath("/app/admin/payroll");
  backToAdjustments(payPeriodId);
}

/** End a recurring-component assignment (sets effectiveTo + inactive).
 *  Does NOT touch existing batch snapshots — same audit-safe rule
 *  as add (§19 immutability of prepared snapshots). */
export async function endRecurringAssignmentAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const payPeriodId    = String(formData.get("payPeriodId")    ?? "").trim();
  const assignmentId   = String(formData.get("assignmentId")   ?? "").trim();
  const effectiveToISO = String(formData.get("effectiveTo")    ?? "").trim();
  if (!assignmentId || !effectiveToISO) backToAdjustments(payPeriodId);
  const effectiveTo = new Date(`${effectiveToISO}T00:00:00.000Z`);
  if (Number.isNaN(effectiveTo.getTime())) {
    redirect(`/app/admin/payroll?payPeriodId=${encodeURIComponent(payPeriodId)}&tab=adjustments&err=bad-date`);
  }
  await endRecurringComponentAssignment(principal, clubId, assignmentId, effectiveTo);
  revalidatePath("/app/admin/payroll");
  backToAdjustments(payPeriodId);
}
