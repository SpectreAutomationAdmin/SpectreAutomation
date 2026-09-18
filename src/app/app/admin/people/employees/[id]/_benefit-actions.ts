"use server";

// Slice C closeout (2026-09-18) — employee-scoped Benefit enrolment
// server actions. Every mutation forwards to the canonical
// `benefit-enrolments.ts` service. Permissions live on the service:
// `payroll:benefit_enrolment:write` (Payroll Admin, Controller, Club
// Admin, Super Admin).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";
import {
  enrolEmployeeInBenefitPlan,
  changeEnrolment,
  endEnrolment,
} from "@/lib/payroll/benefit-enrolments";
import {
  ValidationError, ConflictError, ForbiddenError, NotFoundError,
} from "@/lib/errors";

function toStr(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v.trim() : "";
}
function orNull(v: FormDataEntryValue | null): string | null {
  const s = toStr(v);
  return s.length === 0 ? null : s;
}
function toErrorMessage(e: unknown): string {
  if (e instanceof ValidationError) return e.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
  if (e instanceof ConflictError || e instanceof ForbiddenError || e instanceof NotFoundError) return e.message;
  return e instanceof Error ? e.message : "Unexpected error";
}

async function baseCtx(): Promise<{ clubId: string; principal: NonNullable<Awaited<ReturnType<typeof getCurrentPrincipal>>>; }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  return { clubId, principal };
}

function backTo(employeeId: string, qs: string): never {
  redirect(`/app/admin/people/employees/${employeeId}?${qs}#benefits`);
}

export async function enrolAction(form: FormData): Promise<void> {
  const { clubId, principal } = await baseCtx();
  const employeeId = toStr(form.get("employeeId"));
  const planId = toStr(form.get("planId"));
  const effectiveFrom = toStr(form.get("effectiveFrom"));
  const electionKind = toStr(form.get("electionKind")) || "FIXED_AMOUNT";
  const amount = orNull(form.get("amount"));
  const percentRaw = orNull(form.get("percent"));
  const notes = orNull(form.get("notes"));
  try {
    await enrolEmployeeInBenefitPlan(principal, clubId, {
      employeeId, planId, effectiveFrom,
      electionKind: electionKind as "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS",
      amount, percentBps: percentRaw ? Math.round(Number(percentRaw) * 100) : null,
      notes,
    });
  } catch (e) {
    backTo(employeeId, `benefitsErr=${encodeURIComponent(toErrorMessage(e))}`);
  }
  revalidatePath(`/app/admin/people/employees/${employeeId}`);
  backTo(employeeId, "benefitsOk=Enrolled");
}

export async function changeAction(form: FormData): Promise<void> {
  const { clubId, principal } = await baseCtx();
  const employeeId = toStr(form.get("employeeId"));
  const enrolmentId = toStr(form.get("enrolmentId"));
  const effectiveFrom = toStr(form.get("effectiveFrom"));
  const amount = orNull(form.get("amount"));
  const percentRaw = orNull(form.get("percent"));
  const electionKind = toStr(form.get("electionKind")) || "FIXED_AMOUNT";
  const notes = orNull(form.get("notes"));
  try {
    await changeEnrolment(principal, clubId, {
      enrolmentId, effectiveFrom,
      electionKind: electionKind as "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS",
      amount, percentBps: percentRaw ? Math.round(Number(percentRaw) * 100) : null,
      notes,
    });
  } catch (e) {
    backTo(employeeId, `benefitsErr=${encodeURIComponent(toErrorMessage(e))}`);
  }
  revalidatePath(`/app/admin/people/employees/${employeeId}`);
  backTo(employeeId, "benefitsOk=Change+applied");
}

export async function endAction(form: FormData): Promise<void> {
  const { clubId, principal } = await baseCtx();
  const employeeId = toStr(form.get("employeeId"));
  const enrolmentId = toStr(form.get("enrolmentId"));
  const effectiveTo = toStr(form.get("effectiveTo"));
  const endReason = orNull(form.get("endReason"));
  try {
    await endEnrolment(principal, clubId, enrolmentId, { effectiveTo, endReason });
  } catch (e) {
    backTo(employeeId, `benefitsErr=${encodeURIComponent(toErrorMessage(e))}`);
  }
  revalidatePath(`/app/admin/people/employees/${employeeId}`);
  backTo(employeeId, "benefitsOk=Enrolment+ended");
}
