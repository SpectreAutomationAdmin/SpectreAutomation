// HR-2B.4 (2026-08-19) — Employee self-service upload for a
// requirement-linked document.
//
// Contract:
//   POST /api/hr/onboarding/self/requirement-document/upload
//
//   Body (multipart/form-data):
//     requirementId: string   — id of an active OnboardingRequirement
//                                belonging to the actor's Club.
//     document:      File     — PDF / JPG / PNG / HEIC.
//
//   Response 201:
//     {
//       documentId: string,
//       requirementCode: string,
//       credentialId: string | null,
//       uploadedAt: string (ISO)
//     }
//
//   Response 400 — bad multipart body / missing fields.
//   Response 401 — no valid onboarding actor (`SESSION_INVALID`).
//   Response 404 — requirement id not found in caller's Club.
//   Response 413 — file too large.
//   Response 422 — validation (mime / empty / requirement kind).
//
// Auth: `requireEmployeeOnboardingActor()`. Same-origin only.
// Persistence flows through the canonical `uploadSelfRequirementDocument`
// adapter which auto-stamps sensitivity from
// `EMPLOYEE_DOCUMENT_SENSITIVE_CATEGORIES`, links the resulting
// EmployeeDocument to an upserted EmployeeCredential when the
// requirement kind is CREDENTIAL_WITH_EXPIRY, and audits with
// `hr.document.upload.create` (sha256-prefix + size only in the payload).

import { NextRequest, NextResponse } from "next/server";
import { requireEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { uploadSelfRequirementDocument } from "@/lib/hr/employee-self-service";
import { isAppError, ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024;
const ACCEPTED_MIMES = new Set<string>([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
]);

function err(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ errorCode: code, error: message, ...extra }, { status });
}

export async function POST(req: NextRequest) {
  let actor;
  try {
    actor = await requireEmployeeOnboardingActor();
  } catch {
    return err(401, "SESSION_INVALID", "Your onboarding session is no longer active");
  }

  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return err(400, "BAD_REQUEST", "Expected multipart/form-data body");
  }

  const requirementId = ((fd.get("requirementId") as string | null) ?? "").trim();
  if (!requirementId) {
    return err(400, "BAD_REQUEST", "Missing requirementId");
  }
  const entry = fd.get("document");
  if (!(entry instanceof File)) {
    return err(422, "VALIDATION", "Please choose a file to upload.");
  }
  if (entry.size === 0) {
    return err(422, "VALIDATION", "The uploaded file is empty.");
  }
  if (entry.size > MAX_BYTES) {
    return err(413, "TOO_LARGE", `File exceeds ${MAX_BYTES / (1024 * 1024)} MB limit.`);
  }
  const mimeType = (entry.type || "").toLowerCase();
  if (!ACCEPTED_MIMES.has(mimeType)) {
    return err(422, "VALIDATION", "Please upload a PDF or image (JPG, PNG, or HEIC).");
  }

  const bytes = Buffer.from(await entry.arrayBuffer());
  try {
    const result = await uploadSelfRequirementDocument(actor, {
      requirementId,
      bytes,
      mimeType,
      displayName: entry.name || null,
    });
    return NextResponse.json(
      {
        documentId: result.document.id,
        requirementCode: result.requirement.code,
        credentialId: result.credentialId,
        uploadedAt: result.document.uploadedAt.toISOString(),
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof ValidationError) {
      return err(e.httpStatus, "VALIDATION", e.issues[0]?.message ?? e.safeMessage, { issues: e.issues });
    }
    if (isAppError(e)) {
      return err(e.httpStatus, e.httpStatus === 404 ? "NOT_FOUND" : "PERSISTENCE", e.safeMessage);
    }
    return err(500, "PERSISTENCE", "We couldn't save that document. Your onboarding progress is safe. Please try again.");
  }
}
