// HR-2B.2 (2026-08-18) — About You hub.
//
// Every entry into /hr/onboarding/about-you resolves to the FIRST
// incomplete step. On complete flows, redirects to the completion
// screen. Keeps the URL semantic — the employee never sees this
// route render its own content.

import { redirect } from "next/navigation";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AboutYouHub() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const employee = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: { preferredName: true, personalEmail: true, mobilePhone: true, profilePhotoDocumentId: true },
  });
  if (!employee) redirect("/hr/onboarding/expired");

  const nameDone = Boolean(employee.preferredName?.trim());
  const contactDone = Boolean(employee.personalEmail?.trim() || employee.mobilePhone?.trim());
  const photoDone = Boolean(employee.profilePhotoDocumentId);
  const employmentDone = photoDone; // proxy — see layout note

  if (!nameDone) redirect("/hr/onboarding/about-you/name");
  if (!contactDone) redirect("/hr/onboarding/about-you/contact");
  if (!employmentDone) redirect("/hr/onboarding/about-you/employment");
  if (!photoDone) redirect("/hr/onboarding/about-you/photo");
  redirect("/hr/onboarding/about-you/complete");
}
