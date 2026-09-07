// Scheduling Foundation · Phase E (2026-09-07) — Employee Portal
// shift-exchange server actions.
//
// Three canonical actions:
//   - offerShiftAction         → Employee A offers up a future ASSIGNED shift
//   - withdrawOpportunityAction → Employee A withdraws an OPEN opportunity
//   - pickUpShiftAction         → Employee B claims an OPEN opportunity
//
// The pickup action ALSO emits the informational manager Work Intake
// notification via notifyShiftReassignment after the pickup tx commits.
// If the notification fails (transient DB error), the pickup itself is
// already durable; a future worker sweep or a subsequent read can
// reconcile — the important invariant (schedule state) is atomic.

"use server";

import { redirect } from "next/navigation";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { offerShift, withdrawOpportunity } from "@/lib/scheduling/shift-opportunities";
import { pickUpShift } from "@/lib/scheduling/shift-pickup";
import { notifyShiftReassignment } from "@/lib/scheduling/shift-reassignment-notification";
import { AppError, ConflictError } from "@/lib/errors";

function withErr(path: string, safeMessage: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}err=${encodeURIComponent(safeMessage)}`;
}

export async function offerShiftAction(formData: FormData): Promise<void> {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");
  const shiftAssignmentId = String(formData.get("shiftAssignmentId") ?? "");
  const reason = (formData.get("reason") ?? "").toString().slice(0, 200);
  const note = (formData.get("note") ?? "").toString().slice(0, 1000);
  if (!shiftAssignmentId) {
    redirect(withErr("/employee/schedule", "Missing shift reference."));
  }
  try {
    await offerShift({
      clubId: principal.clubId,
      employeeId: principal.employeeId,
      shiftAssignmentId,
      reason: reason || null,
      note: note || null,
    });
  } catch (e) {
    if (e instanceof AppError) {
      redirect(withErr("/employee/schedule", e.safeMessage));
    }
    throw e;
  }
  redirect(`/employee/schedule?offered=1`);
}

export async function withdrawOpportunityAction(formData: FormData): Promise<void> {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");
  const opportunityId = String(formData.get("opportunityId") ?? "");
  if (!opportunityId) {
    redirect(withErr("/employee/schedule", "Missing opportunity reference."));
  }
  try {
    await withdrawOpportunity({
      clubId: principal.clubId,
      employeeId: principal.employeeId,
      opportunityId,
    });
  } catch (e) {
    if (e instanceof AppError) {
      redirect(withErr("/employee/schedule", e.safeMessage));
    }
    throw e;
  }
  redirect(`/employee/schedule?withdrawn=1`);
}

export async function pickUpShiftAction(formData: FormData): Promise<void> {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");
  const opportunityId = String(formData.get("opportunityId") ?? "");
  if (!opportunityId) {
    redirect(withErr("/employee/announcements?tab=shifts", "Missing opportunity reference."));
  }
  try {
    const result = await pickUpShift({
      clubId: principal.clubId,
      employeeId: principal.employeeId,
      opportunityId,
    });
    // Phase E §18 — informational manager Work Intake notification.
    // Best-effort: pickup already durable if this throws (rare); a
    // future orchestrator sweep can reconcile. Never blocks the
    // success redirect. The origin's stable referenceId = shiftId
    // gives us §19 idempotency for free — repeated retries update
    // the same canonical WI item, not duplicates.
    try {
      await notifyShiftReassignment({
        clubId: principal.clubId,
        shiftId: result.shiftId,
        departmentId: result.departmentId,
        originalEmployeeId: result.originalEmployeeId,
        newEmployeeId: principal.employeeId,
        opportunityId: result.opportunityId,
      });
    } catch (notifyErr) {
      // Swallow — don't fail the user-visible pickup on notification
      // problems. Log to server console for visibility.
      // eslint-disable-next-line no-console
      console.warn("[notifyShiftReassignment] failed after pickup", notifyErr);
    }
    redirect(`/employee/schedule?picked=${result.newAssignmentId}`);
  } catch (e) {
    if (e instanceof ConflictError) {
      // Friendly conflict message (§16) — never surface raw error text.
      redirect(withErr("/employee/announcements?tab=shifts",
        "This shift was just picked up by someone else."));
    }
    if (e instanceof AppError) {
      redirect(withErr("/employee/announcements?tab=shifts", e.safeMessage));
    }
    throw e;
  }
}
