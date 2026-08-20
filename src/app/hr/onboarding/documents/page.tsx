// HR-2B.4 (2026-08-19) — Documents & Credentials step.
//
// Only requirements applicable to this employee's Club/department/
// position appear (see resolveApplicableRequirements). Fulfillment is
// queried through EXISTING canonical rows keyed on the requirement's
// code (EmployeeDocument category / EmployeeCredential.credentialCode /
// EmployeeOnboardingAcknowledgement kind). Completion is server-derived
// and only REQUIRED requirements block progression.

import { redirect } from "next/navigation";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { resolveRequirementStatus } from "@/lib/hr/onboarding-requirements";
import {
  saveCredentialDetailsAction,
  confirmRequirementAction,
  continueFromDocumentsAction,
} from "../_hr2b4-actions";
import PostPayrollShell from "../_post-payroll-shell";
import DocumentsRequirementList, {
  type RequirementItem,
  type RequirementKind,
} from "./DocumentsRequirementList";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function DocumentsStep() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const { requirements } = await resolveRequirementStatus(actor);

  const items: RequirementItem[] = requirements.map(({ requirement, fulfillment }) => ({
    id: requirement.id,
    code: requirement.code,
    displayName: requirement.displayName,
    explanation: requirement.explanation,
    kind: requirement.kind as RequirementKind,
    documentCategory: requirement.documentCategory,
    required: requirement.required,
    requireExpiry: requirement.requireExpiry,
    satisfied: fulfillment.satisfied,
    documentId: fulfillment.documentId ?? null,
    expiresAt: fulfillment.expiresAt ? fulfillment.expiresAt.toISOString().slice(0, 10) : null,
    acknowledgedAt: fulfillment.acknowledgedAt ? fulfillment.acknowledgedAt.toISOString() : null,
  }));

  const allRequiredSatisfied = items
    .filter((r) => r.required)
    .every((r) => r.satisfied);

  return (
    <PostPayrollShell
      actor={actor}
      currentSection="documents"
      headline="A couple of documents, {name}."
      subhead="Just the documents your Club needs on file for your role. You can upload PDFs or photos of physical certificates."
    >
      <DocumentsRequirementList
        requirements={items}
        saveCredentialDetailsAction={saveCredentialDetailsAction}
        confirmRequirementAction={confirmRequirementAction}
        continueFromDocumentsAction={continueFromDocumentsAction}
        allRequiredSatisfied={allRequiredSatisfied}
      />
    </PostPayrollShell>
  );
}
