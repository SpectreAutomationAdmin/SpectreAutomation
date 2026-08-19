// HR-2B.3.2 §1 (2026-08-18) — Employee self-service banking-document
// upload + extraction endpoint.
//
// Replaces the previous server-action-as-form-target flow. The prior
// flow POSTed to `uploadBankingDocumentAction`, redirected back to
// `/hr/onboarding/payroll/direct-deposit`, and the client's `choice`
// state reset to "manual" on the re-render — the founder observed
// this as "no observable action" after clicking Upload.
//
// Contract:
//
//   POST /api/hr/onboarding/self/banking-document/upload
//
//   Body (multipart/form-data):
//     document: File          — the void cheque / DD form (PDF /
//                               JPG / PNG / HEIC / HEIF).
//     category: string        — "void_cheque" | "direct_deposit_form".
//
//   Response 200:
//     {
//       documentId: string,
//       uploadedAt: string (ISO),
//       category: "void_cheque" | "direct_deposit_form",
//       extraction: {
//         holderName: { value, confidence },
//         institutionNumber: { value, confidence },
//         transitNumber: { value, confidence },
//         accountNumber: { value, confidence },
//         meta: { pages?, mimeType, sha256Prefix, readOutcome }
//       }
//     }
//
//   Response 401 — no valid onboarding actor.
//   Response 400 — bad multipart body.
//   Response 422 — validation failure (missing file, wrong MIME,
//                  empty bytes, over 15 MB, cross-tenant probe).
//
// Security invariants (never break):
//   * Auth via `requireEmployeeOnboardingActor()` — NOT `Principal`.
//   * Persistence via canonical `uploadSelfBankingDocument` which
//     auto-stamps `sensitivity: "RESTRICTED"` from
//     `EMPLOYEE_DOCUMENT_SENSITIVE_CATEGORIES` and audits
//     via `hr.document.upload.create` with only sha256 prefix +
//     byte size in the payload.
//   * Extraction fields NEVER hit `EmployeeBankAccount`. They are
//     handed to the client for confirmation only. Canonical
//     encrypted persistence remains `submitSelfBankAccount`.
//   * Extraction fields NEVER hit `logger` or the audit log.

import { NextRequest, NextResponse } from "next/server";
import { requireEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import {
  uploadSelfBankingDocument,
  type SelfBankingDocumentCategory,
} from "@/lib/hr/employee-self-service";
import { extractBankingFieldsFromDocument } from "@/lib/hr/banking-extraction";
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

function normaliseCategory(raw: string | null): SelfBankingDocumentCategory | null {
  if (raw === "void_cheque" || raw === "direct_deposit_form") return raw;
  return null;
}

export async function POST(req: NextRequest) {
  // -- Auth ----------------------------------------------------------------
  let actor;
  try {
    actor = await requireEmployeeOnboardingActor();
  } catch {
    return NextResponse.json(
      { error: "Your onboarding session is no longer active" },
      { status: 401 },
    );
  }

  // -- Body parse ----------------------------------------------------------
  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data body" },
      { status: 400 },
    );
  }

  const rawCategory = (fd.get("category") as string | null) ?? "void_cheque";
  const category = normaliseCategory(rawCategory);
  if (!category) {
    return NextResponse.json(
      { error: "Category must be void_cheque or direct_deposit_form" },
      { status: 422 },
    );
  }

  const entry = fd.get("document");
  if (!(entry instanceof File)) {
    return NextResponse.json(
      { error: "Please choose a file to upload." },
      { status: 422 },
    );
  }
  if (entry.size === 0) {
    return NextResponse.json(
      { error: "The uploaded file is empty." },
      { status: 422 },
    );
  }
  if (entry.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File exceeds ${MAX_BYTES / (1024 * 1024)} MB limit.` },
      { status: 413 },
    );
  }
  const mimeType = (entry.type || "").toLowerCase();
  if (!ACCEPTED_MIMES.has(mimeType)) {
    return NextResponse.json(
      { error: "Please upload a PDF or image (JPG, PNG, or HEIC)." },
      { status: 422 },
    );
  }

  const bytes = Buffer.from(await entry.arrayBuffer());

  // -- Persist -------------------------------------------------------------
  //
  // Canonical persistence path. Auto-stamps sensitivity=RESTRICTED
  // and writes the `hr.document.upload.create` audit row.
  let created;
  try {
    created = await uploadSelfBankingDocument(actor, {
      bytes,
      mimeType,
      category,
      displayName: entry.name || null,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(
        { error: err.issues[0]?.message ?? err.safeMessage, issues: err.issues },
        { status: err.httpStatus },
      );
    }
    if (isAppError(err)) {
      return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }

  // -- Extract -------------------------------------------------------------
  //
  // Best-effort. Failure to extract MUST NOT unwind the persisted
  // upload — the employee will simply see the manual form pre-
  // populated with `null`s and a "we couldn't read your document"
  // hint. Extraction errors are swallowed here (with a safe fallback
  // result) so the client always renders a coherent next step.
  let extraction;
  try {
    extraction = await extractBankingFieldsFromDocument({
      bytes,
      mimeType,
      clubId: actor.clubId,
      employeeId: actor.employeeId,
      documentId: created.id,
    });
  } catch {
    extraction = {
      holderName: { value: null, confidence: "missing" as const },
      institutionNumber: { value: null, confidence: "missing" as const },
      transitNumber: { value: null, confidence: "missing" as const },
      accountNumber: { value: null, confidence: "missing" as const },
      meta: {
        mimeType,
        sha256Prefix: "",
        readOutcome: "PDF_PARSE_ERROR" as const,
      },
    };
  }

  return NextResponse.json(
    {
      documentId: created.id,
      uploadedAt: created.uploadedAt.toISOString(),
      category: created.category,
      extraction,
    },
    { status: 201 },
  );
}
