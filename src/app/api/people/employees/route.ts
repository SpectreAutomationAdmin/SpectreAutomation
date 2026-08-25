// HR-2A (2026-08-16) — POST /api/people/employees.
//
// Composes the canonical HR services into a single "create employee
// → open initial employment period → open onboarding session →
// optionally upload resume → optionally link Member" pipeline.
//
// Discipline:
//   • Every mutation goes through a canonical service in
//     `src/lib/hr/**`. Direct Prisma writes on Employee are
//     forbidden here — mutations flow through the HR services.
//   • Multipart form-data: the resume file rides on the same
//     round-trip as the profile fields. Resume upload is optional.
//   • Cross-club Member linking throws `TenantViolationError` from
//     `linkEmployeeToMember` — bubbled as 403 via `isAppError`.
//   • Cross-club manager assignment throws `TenantViolationError`
//     from `setManager` — same handling.
//   • Payroll readiness stays `NOT_READY` (schema default). Nothing
//     in this route touches banking / SIN / tax.

import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "crypto";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isAppError, ValidationError } from "@/lib/errors";
import {
  createEmployee,
  linkEmployeeToMember,
  setManager,
  setResume,
} from "@/lib/hr/employees";
import { openEmploymentPeriod } from "@/lib/hr/employment-periods";
import { createSession } from "@/lib/hr/onboarding-sessions";
import { changeCompensation } from "@/lib/hr/compensation";
import { hasPermission } from "@/lib/rbac";
import {
  uploadEmployeeDocument,
  UnknownDocumentCategoryError,
} from "@/lib/hr/documents";
import { resolveDocumentStorage } from "@/lib/documents/storage";

const MAX_RESUME_BYTES = 10 * 1024 * 1024; // 10 MB
const ACCEPTED_RESUME_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

function readString(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function readOptionalString(fd: FormData, key: string): string | null {
  const s = readString(fd, key);
  return s.length > 0 ? s : null;
}

export async function POST(req: NextRequest) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });

  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data body" }, { status: 400 });
  }

  const firstName = readString(fd, "firstName");
  const lastName = readString(fd, "lastName");
  const personalEmail = readOptionalString(fd, "personalEmail");
  const mobilePhone = readOptionalString(fd, "mobilePhone");
  const expectedStartDateRaw = readString(fd, "expectedStartDate");
  const employmentType = readOptionalString(fd, "employmentType") ?? "FULL_TIME";

  const errors: Array<{ path: string; message: string }> = [];
  if (!firstName) errors.push({ path: "firstName", message: "required" });
  if (!lastName) errors.push({ path: "lastName", message: "required" });
  if (!personalEmail) errors.push({ path: "personalEmail", message: "required" });
  if (!mobilePhone) errors.push({ path: "mobilePhone", message: "required" });
  if (!expectedStartDateRaw) errors.push({ path: "expectedStartDate", message: "required" });
  if (errors.length > 0) {
    return NextResponse.json({ error: "Validation failed", issues: errors }, { status: 422 });
  }

  const expectedStartDate = new Date(expectedStartDateRaw);
  if (Number.isNaN(expectedStartDate.getTime())) {
    return NextResponse.json(
      { error: "expectedStartDate is not a valid date" },
      { status: 422 },
    );
  }

  const middleName = readOptionalString(fd, "middleName");
  const preferredName = readOptionalString(fd, "preferredName");
  const departmentId = readOptionalString(fd, "departmentId");
  const positionId = readOptionalString(fd, "positionId");
  const managerEmployeeId = readOptionalString(fd, "managerEmployeeId");
  const memberId = readOptionalString(fd, "memberId");
  // HR mobile-hotfix (2026-08-30) §1 — optional admin prefill of the
  // new hire's home address. All six fields are optional; a blank
  // submission means the employee will supply the address during the
  // onboarding Address step.
  const homeAddressLine1 = readOptionalString(fd, "homeAddressLine1");
  const homeAddressLine2 = readOptionalString(fd, "homeAddressLine2");
  const homeCity = readOptionalString(fd, "homeCity");
  const homeProvince = readOptionalString(fd, "homeProvince");
  const homePostalCode = readOptionalString(fd, "homePostalCode");
  const homeCountry = readOptionalString(fd, "homeCountry");

  // HR-2B.5 §11-13 — Initial compensation. Presence of these fields
  // means the operator has hr:compensation:write and the form rendered
  // the compensation section; absence means either the permission is
  // missing OR the form was submitted from a stale build. In either
  // case the compensation call is skipped and the employee lands
  // without a rate row — an admin with the permission can set it later
  // via the compensation surface (deferred to HR-2B.6+).
  const compensationCadence = readOptionalString(fd, "compensationCadence");
  const compensationAmountRaw = readOptionalString(fd, "compensationAmount");
  const wantsCompensation = compensationCadence !== null && compensationAmountRaw !== null;
  if (wantsCompensation) {
    if (compensationCadence !== "HOURLY" && compensationCadence !== "SALARY") {
      return NextResponse.json(
        { error: "compensationCadence must be HOURLY or SALARY" },
        { status: 422 },
      );
    }
    if (Number(compensationAmountRaw) <= 0 || Number.isNaN(Number(compensationAmountRaw))) {
      return NextResponse.json(
        { error: "compensationAmount must be a positive number" },
        { status: 422 },
      );
    }
    if (!hasPermission(principal, clubId, "hr:compensation:write")) {
      return NextResponse.json(
        { error: "You do not have permission to set compensation." },
        { status: 403 },
      );
    }
  }

  // Resume — optional. Rejected pre-upload if the MIME doesn't sit on
  // the allowlist; the storage layer never sees an unknown type.
  const resumeEntry = fd.get("resume");
  const hasResume =
    resumeEntry instanceof File && resumeEntry.size > 0 && resumeEntry.name.length > 0;
  if (hasResume) {
    const file = resumeEntry as File;
    if (file.size > MAX_RESUME_BYTES) {
      return NextResponse.json(
        { error: `Resume exceeds ${MAX_RESUME_BYTES / (1024 * 1024)} MB limit.` },
        { status: 413 },
      );
    }
    if (!ACCEPTED_RESUME_MIME.has(file.type)) {
      return NextResponse.json(
        { error: "Resume must be a PDF, DOC, or DOCX." },
        { status: 415 },
      );
    }
  }

  let createdEmployeeId: string | null = null;
  try {
    // 1. Employee row. Lifecycle defaults to PRE_HIRE — do NOT
    // pass "ACTIVE" here; new hires enter through PRE_HIRE.
    const employee = await createEmployee(principal, clubId, {
      firstName,
      lastName,
      middleName,
      preferredName,
      personalEmail,
      mobilePhone,
      departmentId,
      positionId,
      expectedStartDate,
      employmentType,
      // HR mobile-hotfix (2026-08-30) §1 — optional admin prefill.
      // Any subset may be blank; the service persists whatever the
      // admin provided. The onboarding Address step prefills from
      // these fields when set, otherwise it prompts for input.
      homeAddressLine1,
      homeAddressLine2,
      homeCity,
      homeProvince,
      homePostalCode,
      homeCountry,
    });
    createdEmployeeId = employee.id;

    // 2. Reports-to link via canonical setManager — enforces
    // same-tenant on the target manager row.
    if (managerEmployeeId) {
      await setManager(principal, employee.id, managerEmployeeId);
    }

    // 3. Initial employment period — half-open interval, HIRE reason.
    await openEmploymentPeriod(principal, employee.id, {
      effectiveFrom: expectedStartDate,
      employmentType,
      reason: "HIRE",
      positionId,
      departmentId,
      managerEmployeeId,
    });

    // 3.5. HR-2B.5 §11-15 — Initial compensation. Effective on the
    // expected start date so payroll history begins at the hire date.
    // Uses the canonical EmployeeCompensation writer, which shadow-
    // writes legacy Employee.payRate in the same transaction.
    if (wantsCompensation) {
      await changeCompensation(principal, employee.id, {
        effectiveFrom: expectedStartDate,
        amount: compensationAmountRaw!,
        cadence: compensationCadence!,
      });
    }

    // 4. DRAFT onboarding session. Invitation is issued later, from
    // the profile shell's "Invite to complete onboarding" action.
    await createSession(principal, employee.id);

    // 5. Optional resume upload. The MIME + size were already
    // validated above; here we persist to storage + register the
    // EmployeeDocument row + wire the Employee.resumeDocumentId
    // pointer through the canonical setResume service.
    if (hasResume) {
      const file = resumeEntry as File;
      const buf = Buffer.from(await file.arrayBuffer());
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const storage = await resolveDocumentStorage({ clubId });
      const storageKey = `hr/employees/${employee.id}/resume/${sha256}`;
      await storage.put({ storageKey, body: buf, mimeType: file.type });
      try {
        const doc = await uploadEmployeeDocument(principal, employee.id, {
          category: "resume",
          storageKey,
          contentSha256: sha256,
          sizeBytes: file.size,
          mimeType: file.type,
          displayName: file.name,
        });
        await setResume(principal, employee.id, doc.id);
      } catch (err) {
        if (err instanceof UnknownDocumentCategoryError) {
          return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
        }
        throw err;
      }
    }

    // 6. Optional Member link — canonical service enforces
    // same-tenant invariant and throws TenantViolationError on
    // cross-club attempts.
    if (memberId) {
      await linkEmployeeToMember(principal, employee.id, memberId);
    }

    return NextResponse.json({ employeeId: employee.id }, { status: 201 });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(
        { error: err.safeMessage, issues: err.issues },
        { status: err.httpStatus },
      );
    }
    if (isAppError(err)) {
      return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    }
    // Unexpected — do not leak internal detail.
    return NextResponse.json({ error: "Server error", employeeId: createdEmployeeId }, { status: 500 });
  }
}
