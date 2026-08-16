// HR-1 (2026-08-16) — EmployeeDocument service (upload / list / read /
// delete). Owns the canonical category enum + sensitivity mapping.
//
// Contract:
//   - `EMPLOYEE_DOCUMENT_CATEGORIES` is the authoritative list of
//     valid `EmployeeDocument.category` values. The schema stores it
//     as free-form TEXT — validation is a service-layer obligation.
//   - `EMPLOYEE_DOCUMENT_SENSITIVE_CATEGORIES` is the subset whose
//     `sensitivity` MUST be `RESTRICTED` (auto-applied on upload;
//     reads then require `hr:sensitive:read` in addition to
//     `hr:documents:read`).
//   - `uploadEmployeeDocument`: requires `hr:documents:write` +
//     sensitive-action guard. Auto-sets sensitivity=RESTRICTED for
//     sensitive categories.
//   - `listEmployeeDocuments`: requires `hr:documents:read`. Filters
//     out RESTRICTED rows unless the caller also has
//     `hr:sensitive:read`.
//   - `getEmployeeDocument`: requires `hr:documents:read`.
//     RESTRICTED rows additionally require `hr:sensitive:read`.
//   - `deleteEmployeeDocument`: requires `hr:documents:write` +
//     sensitive-action guard (hard delete — this is an evidentiary
//     store, callers should think twice; profile-photo / resume
//     pointers on Employee are nulled out by service).
//
// Reads are NOT audited. Uploads and deletes are audited with a
// content-safe payload (id, category, sensitivity, sha256, byte
// size — never storageKey plaintext beyond audit necessity).

import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { assertSensitiveActionAllowed } from "../posting-guard";

const DOCUMENT_ENTITY = "EmployeeDocument";

// ---------------------------------------------------------------------------
// Canonical category enum + sensitivity mapping.
// ---------------------------------------------------------------------------
export const EMPLOYEE_DOCUMENT_CATEGORIES = [
  "resume",
  "profile_photo",
  "void_cheque",
  "direct_deposit_form",
  "employment_agreement",
  "td1_federal",
  "td1_provincial",
  "drivers_licence",
  "work_permit",
  "certification",
  "safety_certificate",
  "handbook_acknowledgement",
  "other",
] as const;
export type EmployeeDocumentCategory = (typeof EMPLOYEE_DOCUMENT_CATEGORIES)[number];

export const EMPLOYEE_DOCUMENT_SENSITIVE_CATEGORIES = [
  "void_cheque",
  "direct_deposit_form",
  "td1_federal",
  "td1_provincial",
  "drivers_licence",
  "work_permit",
] as const;
export type EmployeeDocumentSensitiveCategory =
  (typeof EMPLOYEE_DOCUMENT_SENSITIVE_CATEGORIES)[number];

export function isSensitiveCategory(category: string): boolean {
  return (EMPLOYEE_DOCUMENT_SENSITIVE_CATEGORIES as readonly string[]).includes(category);
}

export function isKnownCategory(category: string): category is EmployeeDocumentCategory {
  return (EMPLOYEE_DOCUMENT_CATEGORIES as readonly string[]).includes(category);
}

// ---------------------------------------------------------------------------
// Typed errors.
// ---------------------------------------------------------------------------
export class UnknownDocumentCategoryError extends AppError {
  constructor(category: string) {
    super(
      "HR_UNKNOWN_DOCUMENT_CATEGORY",
      `Unknown employee document category: ${category}`,
      422,
      "Unknown document category",
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
async function loadEmployee(principal: Principal, employeeId: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new NotFoundError("Employee", employeeId);
  assertTenantOwned(employee, principal);
  return employee;
}

// ---------------------------------------------------------------------------
// Upload.
// ---------------------------------------------------------------------------
export interface UploadEmployeeDocumentInput {
  category: string;
  storageKey: string;
  contentSha256: string;
  sizeBytes: number;
  mimeType: string;
  displayName?: string | null;
  /** Only honoured when the category is NOT already in the sensitive
   *  list; sensitive categories always end up RESTRICTED regardless. */
  sensitivity?: "STANDARD" | "RESTRICTED";
}

export async function uploadEmployeeDocument(
  principal: Principal,
  employeeId: string,
  input: UploadEmployeeDocumentInput,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:documents:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.document.upload.create",
    DOCUMENT_ENTITY,
    employeeId,
  );

  if (!isKnownCategory(input.category)) {
    throw new UnknownDocumentCategoryError(input.category);
  }
  const storageKey = (input.storageKey ?? "").trim();
  if (!storageKey) {
    throw new ValidationError([{ path: "storageKey", message: "storageKey is required" }]);
  }
  const contentSha256 = (input.contentSha256 ?? "").trim();
  if (!/^[a-f0-9]{64}$/i.test(contentSha256)) {
    throw new ValidationError([{ path: "contentSha256", message: "contentSha256 must be a 64-char hex digest" }]);
  }
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new ValidationError([{ path: "sizeBytes", message: "sizeBytes must be a non-negative integer" }]);
  }
  const mimeType = (input.mimeType ?? "").trim();
  if (!mimeType || mimeType.length > 200) {
    throw new ValidationError([{ path: "mimeType", message: "mimeType is required" }]);
  }

  // Sensitive category => sensitivity=RESTRICTED unconditionally.
  // Everything else honours the caller-supplied override, defaulting
  // to STANDARD.
  const sensitivity: "STANDARD" | "RESTRICTED" =
    isSensitiveCategory(input.category)
      ? "RESTRICTED"
      : (input.sensitivity ?? "STANDARD");

  const created = await prisma.employeeDocument.create({
    data: {
      clubId: employee.clubId,
      employeeId,
      storageKey,
      contentSha256,
      sizeBytes: input.sizeBytes,
      mimeType,
      category: input.category,
      sensitivity,
      displayName: input.displayName ?? null,
      uploadedByUserId: principal.id,
    },
  });

  await audit(principal, {
    action: "hr.document.upload.create",
    entityType: DOCUMENT_ENTITY,
    entityId: created.id,
    clubId: employee.clubId,
    after: {
      id: created.id,
      category: created.category,
      sensitivity: created.sensitivity,
      sizeBytes: created.sizeBytes,
      contentSha256Prefix: created.contentSha256.slice(0, 12),
    },
  });

  return created;
}

// ---------------------------------------------------------------------------
// List.
// ---------------------------------------------------------------------------
export async function listEmployeeDocuments(
  principal: Principal,
  employeeId: string,
  opts: { includeRestricted?: boolean } = {},
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:documents:read");
  const canSeeRestricted = hasPermission(principal, employee.clubId, "hr:sensitive:read");
  const includeRestricted = (opts.includeRestricted ?? true) && canSeeRestricted;

  const rows = await prisma.employeeDocument.findMany({
    where: {
      employeeId,
      ...(includeRestricted ? {} : { sensitivity: "STANDARD" }),
    },
    orderBy: { uploadedAt: "desc" },
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Get one.
// ---------------------------------------------------------------------------
export async function getEmployeeDocument(
  principal: Principal,
  documentId: string,
) {
  const doc = await prisma.employeeDocument.findUnique({ where: { id: documentId } });
  if (!doc) throw new NotFoundError(DOCUMENT_ENTITY, documentId);
  assertTenantOwned(doc, principal);
  requirePermission(principal, doc.clubId, "hr:documents:read");
  if (doc.sensitivity === "RESTRICTED") {
    if (!hasPermission(principal, doc.clubId, "hr:sensitive:read")) {
      throw new ForbiddenError("Missing permission: hr:sensitive:read");
    }
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Delete.
// ---------------------------------------------------------------------------
export async function deleteEmployeeDocument(
  principal: Principal,
  documentId: string,
) {
  const doc = await prisma.employeeDocument.findUnique({ where: { id: documentId } });
  if (!doc) throw new NotFoundError(DOCUMENT_ENTITY, documentId);
  assertTenantOwned(doc, principal);
  requirePermission(principal, doc.clubId, "hr:documents:write");
  await assertSensitiveActionAllowed(
    principal,
    doc.clubId,
    "hr.document.delete",
    DOCUMENT_ENTITY,
    documentId,
  );

  // Null-out any Employee back-pointers so the delete doesn't dangle.
  const employee = await prisma.employee.findFirst({
    where: {
      OR: [
        { profilePhotoDocumentId: documentId },
        { resumeDocumentId: documentId },
      ],
    },
  });
  if (employee) {
    await prisma.employee.update({
      where: { id: employee.id },
      data: {
        profilePhotoDocumentId:
          employee.profilePhotoDocumentId === documentId ? null : employee.profilePhotoDocumentId,
        resumeDocumentId:
          employee.resumeDocumentId === documentId ? null : employee.resumeDocumentId,
      },
    });
  }

  await prisma.employeeDocument.delete({ where: { id: documentId } });

  await audit(principal, {
    action: "hr.document.delete",
    entityType: DOCUMENT_ENTITY,
    entityId: documentId,
    clubId: doc.clubId,
    before: {
      id: doc.id,
      category: doc.category,
      sensitivity: doc.sensitivity,
      sizeBytes: doc.sizeBytes,
      contentSha256Prefix: doc.contentSha256.slice(0, 12),
    },
    after: null,
  });
}
