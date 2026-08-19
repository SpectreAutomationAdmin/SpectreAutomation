// HR-1 admin-workflows — EmployeeDocument categories + sensitivity.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import {
  EMPLOYEE_DOCUMENT_CATEGORIES,
  EMPLOYEE_DOCUMENT_SENSITIVE_CATEGORIES,
  UnknownDocumentCategoryError,
  uploadEmployeeDocument,
  listEmployeeDocuments,
  getEmployeeDocument,
  deleteEmployeeDocument,
  isSensitiveCategory,
} from "@/lib/hr/documents";
import { resetDb, seedRbac } from "../../util/db";
import { fakeDocInput, makeAdminHrFixture, latestAuditForAction } from "./_helpers";

describe("HR admin-workflows · EmployeeDocument categories + sensitivity", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("EMPLOYEE_DOCUMENT_CATEGORIES exposes the exact 13-item canonical list", () => {
    expect(EMPLOYEE_DOCUMENT_CATEGORIES).toContain("resume");
    expect(EMPLOYEE_DOCUMENT_CATEGORIES).toContain("profile_photo");
    expect(EMPLOYEE_DOCUMENT_CATEGORIES).toContain("void_cheque");
    expect(EMPLOYEE_DOCUMENT_CATEGORIES).toContain("other");
    expect(EMPLOYEE_DOCUMENT_CATEGORIES.length).toBe(13);
  });

  it("EMPLOYEE_DOCUMENT_SENSITIVE_CATEGORIES is a subset of CATEGORIES", () => {
    for (const c of EMPLOYEE_DOCUMENT_SENSITIVE_CATEGORIES) {
      expect(EMPLOYEE_DOCUMENT_CATEGORIES).toContain(c);
    }
  });

  it("upload with an unknown category throws UnknownDocumentCategoryError", async () => {
    const fx = await makeAdminHrFixture();
    await expect(
      uploadEmployeeDocument(fx.clubAdmin, fx.employee.id, fakeDocInput("not_a_real_category")),
    ).rejects.toBeInstanceOf(UnknownDocumentCategoryError);
  });

  it("standard category upload -> sensitivity=STANDARD", async () => {
    const fx = await makeAdminHrFixture();
    const doc = await uploadEmployeeDocument(
      fx.clubAdmin, fx.employee.id, fakeDocInput("resume"),
    );
    expect(doc.category).toBe("resume");
    expect(doc.sensitivity).toBe("STANDARD");
    const audit = await latestAuditForAction("hr.document.upload.create");
    expect(audit?.entityId).toBe(doc.id);
  });

  it("sensitive category upload -> sensitivity auto-forced to RESTRICTED", async () => {
    const fx = await makeAdminHrFixture();
    // Even if the caller SUPPLIES sensitivity=STANDARD, a sensitive
    // category MUST land as RESTRICTED.
    const doc = await uploadEmployeeDocument(
      fx.clubAdmin, fx.employee.id,
      { ...fakeDocInput("void_cheque"), sensitivity: "STANDARD" },
    );
    expect(isSensitiveCategory("void_cheque")).toBe(true);
    expect(doc.sensitivity).toBe("RESTRICTED");
  });

  it("listEmployeeDocuments hides RESTRICTED rows from a caller without hr:sensitive:read", async () => {
    const fx = await makeAdminHrFixture();
    // Upload one standard + one sensitive.
    await uploadEmployeeDocument(fx.clubAdmin, fx.employee.id, fakeDocInput("resume"));
    await uploadEmployeeDocument(fx.clubAdmin, fx.employee.id, fakeDocInput("void_cheque"));

    // GM has hr:documents:read but NOT hr:sensitive:read.
    const gmVisible = await listEmployeeDocuments(fx.gm, fx.employee.id);
    expect(gmVisible.length).toBe(1);
    expect(gmVisible[0].category).toBe("resume");

    // Auditor has BOTH hr:documents:read + hr:sensitive:read.
    const auditorVisible = await listEmployeeDocuments(fx.auditor, fx.employee.id);
    expect(auditorVisible.length).toBe(2);
  });

  it("getEmployeeDocument on a RESTRICTED row REJECTS without hr:sensitive:read", async () => {
    const fx = await makeAdminHrFixture();
    const doc = await uploadEmployeeDocument(
      fx.clubAdmin, fx.employee.id, fakeDocInput("td1_federal"),
    );
    expect(doc.sensitivity).toBe("RESTRICTED");
    await expect(getEmployeeDocument(fx.gm, doc.id)).rejects.toBeInstanceOf(ForbiddenError);
    // Auditor (has hr:sensitive:read) can read.
    const auditorRead = await getEmployeeDocument(fx.auditor, doc.id);
    expect(auditorRead.id).toBe(doc.id);
  });

  it("deleteEmployeeDocument removes the row + audits", async () => {
    const fx = await makeAdminHrFixture();
    const doc = await uploadEmployeeDocument(fx.clubAdmin, fx.employee.id, fakeDocInput("resume"));
    await deleteEmployeeDocument(fx.clubAdmin, doc.id);
    const audit = await latestAuditForAction("hr.document.delete");
    expect(audit?.entityId).toBe(doc.id);
  });
});
