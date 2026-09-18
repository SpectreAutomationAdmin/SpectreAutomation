"use server";

// Slice C closeout (2026-09-18) — Payroll Settings → Benefits server actions.
// Every action re-resolves the caller principal and forwards to the
// canonical `benefit-plans.ts` service. Permissions live on the service.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";
import {
  createBenefitPlan,
  deactivateBenefitPlan,
  updateBenefitPlanMetadata,
  changeBenefitPlanConfiguration,
  type BenefitPlanKind,
  type ElectionKind,
  type EligibleEarningsBasis,
} from "@/lib/payroll/benefit-plans";
import { ValidationError, ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";

function toStr(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v.trim() : "";
}

function orNull(v: FormDataEntryValue | null): string | null {
  const s = toStr(v);
  return s.length === 0 ? null : s;
}

function toErrorMessage(e: unknown): string {
  if (e instanceof ValidationError) {
    return e.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
  }
  if (e instanceof ConflictError || e instanceof ForbiddenError || e instanceof NotFoundError) {
    return e.message;
  }
  return e instanceof Error ? e.message : "Unexpected error";
}

/**
 * Create a benefit plan. All fields arrive via FormData.
 * Redirects back to the Benefits page on success with an `ok` query param;
 * on failure passes `err`.
 */
export async function createBenefitPlanAction(form: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  const kind = toStr(form.get("kind")) as BenefitPlanKind;
  const code = toStr(form.get("code"));
  const name = toStr(form.get("name"));
  const description = orNull(form.get("description"));
  const providerName = orNull(form.get("providerName"));
  const effectiveFrom = toStr(form.get("effectiveFrom"));
  const effectiveToRaw = orNull(form.get("effectiveTo"));
  const employeeComponentId = orNull(form.get("employeeComponentId"));
  const employerComponentId = orNull(form.get("employerComponentId"));
  const defaultElectionKind = (toStr(form.get("defaultElectionKind")) || "FIXED_AMOUNT") as ElectionKind;
  const eligibleEarningsBasisRaw = orNull(form.get("eligibleEarningsBasis"));

  try {
    await createBenefitPlan(principal, clubId, {
      kind, code, name,
      description, providerName,
      effectiveFrom,
      effectiveTo: effectiveToRaw,
      employeeComponentId,
      employerComponentId,
      defaultElectionKind,
      eligibleEarningsBasis: eligibleEarningsBasisRaw as EligibleEarningsBasis | null,
    });
  } catch (e) {
    const err = encodeURIComponent(toErrorMessage(e));
    redirect(`/app/admin/payroll/setup/benefits?err=${err}`);
  }
  revalidatePath("/app/admin/payroll/setup/benefits");
  redirect("/app/admin/payroll/setup/benefits?ok=Plan+created");
}

export async function updatePlanMetadataAction(form: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const planId = toStr(form.get("planId"));
  if (!planId) redirect("/app/admin/payroll/setup/benefits?err=Missing+planId");
  try {
    await updateBenefitPlanMetadata(principal, clubId, planId, {
      name: toStr(form.get("name")) || undefined,
      description: form.has("description") ? orNull(form.get("description")) : undefined,
      providerName: form.has("providerName") ? orNull(form.get("providerName")) : undefined,
      notes: form.has("notes") ? orNull(form.get("notes")) : undefined,
    });
  } catch (e) {
    const err = encodeURIComponent(toErrorMessage(e));
    redirect(`/app/admin/payroll/setup/benefits?err=${err}`);
  }
  revalidatePath("/app/admin/payroll/setup/benefits");
  redirect("/app/admin/payroll/setup/benefits?ok=Plan+metadata+updated");
}

export async function changePlanConfigAction(form: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const planId = toStr(form.get("planId"));
  const cutover = toStr(form.get("cutover"));
  if (!planId || !cutover) redirect("/app/admin/payroll/setup/benefits?err=Missing+planId+or+cutover");
  try {
    await changeBenefitPlanConfiguration(principal, clubId, planId, {
      cutover,
      employeeComponentId: form.has("employeeComponentId") ? orNull(form.get("employeeComponentId")) : undefined,
      employerComponentId: form.has("employerComponentId") ? orNull(form.get("employerComponentId")) : undefined,
      defaultElectionKind: form.has("defaultElectionKind")
        ? (toStr(form.get("defaultElectionKind")) as ElectionKind || undefined)
        : undefined,
      eligibleEarningsBasis: form.has("eligibleEarningsBasis")
        ? (orNull(form.get("eligibleEarningsBasis")) as EligibleEarningsBasis | null)
        : undefined,
    });
  } catch (e) {
    const err = encodeURIComponent(toErrorMessage(e));
    redirect(`/app/admin/payroll/setup/benefits?err=${err}`);
  }
  revalidatePath("/app/admin/payroll/setup/benefits");
  redirect("/app/admin/payroll/setup/benefits?ok=Plan+configuration+changed");
}

export async function endBenefitPlanAction(form: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const planId = toStr(form.get("planId"));
  if (!planId) redirect("/app/admin/payroll/setup/benefits?err=Missing+planId");
  try {
    await deactivateBenefitPlan(principal, clubId, planId);
  } catch (e) {
    const err = encodeURIComponent(toErrorMessage(e));
    redirect(`/app/admin/payroll/setup/benefits?err=${err}`);
  }
  revalidatePath("/app/admin/payroll/setup/benefits");
  redirect("/app/admin/payroll/setup/benefits?ok=Plan+ended");
}
