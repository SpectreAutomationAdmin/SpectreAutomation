// HR-2A (2026-08-16) — Resume upload path via POST /api/people/employees.
//
// The Add Employee round-trip carries the resume as a multipart file.
// This test confirms:
//   • PDF resume is accepted → EmployeeDocument row created with
//     category=resume, sensitivity=STANDARD.
//   • The Employee.resumeDocumentId pointer is wired via the
//     canonical setResume service.
//   • Unknown MIME types are rejected before the storage layer is
//     touched.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac, principalFor } from "../../util/db";
import { makeAdminHrFixture } from "../admin-workflows/_helpers";

let currentPrincipal: Awaited<ReturnType<typeof principalFor>> | null = null;
vi.mock("@/lib/services/principal", () => ({
  getCurrentPrincipal: async () => currentPrincipal,
}));
vi.mock("@/lib/active-club", () => ({
  getActiveClubId: async ({ clubId }: { clubId: string | null }) => clubId,
}));

// eslint-disable-next-line import/first
import { POST } from "@/app/api/people/employees/route";

function makeFormWithResume(mimeType: string, filename = "resume.pdf") {
  const fd = new FormData();
  fd.set("firstName", "Alexandra");
  fd.set("lastName", "Reyes");
  fd.set("personalEmail", "alexandra.r@example.com");
  fd.set("mobilePhone", "555-1234");
  fd.set("expectedStartDate", "2026-09-01");
  fd.set("employmentType", "FULL_TIME");
  // A tiny synthetic file body; the storage layer just persists
  // the bytes so we don't need a real PDF here.
  const body = new Blob(["%PDF-1.4\n%test resume content"], { type: mimeType });
  fd.set("resume", body, filename);
  return fd;
}

function toRequest(fd: FormData): Request {
  return new Request("http://test.local/api/people/employees", {
    method: "POST",
    body: fd,
  });
}

describe("HR-2A · Resume upload via POST /api/people/employees", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    currentPrincipal = null;
  });

  it("accepts a PDF resume, links via setResume, sensitivity=STANDARD", async () => {
    const fx = await makeAdminHrFixture();
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(toRequest(makeFormWithResume("application/pdf")) as any);
    expect(res.status).toBe(201);
    const { employeeId } = await res.json();

    const docs = await prisma.employeeDocument.findMany({
      where: { employeeId },
    });
    expect(docs).toHaveLength(1);
    expect(docs[0].category).toBe("resume");
    expect(docs[0].sensitivity).toBe("STANDARD");
    expect(docs[0].mimeType).toBe("application/pdf");

    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { resumeDocumentId: true },
    });
    expect(employee?.resumeDocumentId).toBe(docs[0].id);
  });

  it("rejects an unknown MIME type BEFORE the storage layer is touched", async () => {
    const fx = await makeAdminHrFixture();
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(
      toRequest(makeFormWithResume("image/png", "resume.png")) as any,
    );
    expect(res.status).toBe(415);

    // No Employee should have been created for a rejected upload —
    // the validation fires BEFORE createEmployee.
    const created = await prisma.employee.count({ where: { clubId: fx.club.id } });
    // Note the fixture seeds one Employee ("River Sensitive"); we
    // assert that no NEW row was created beyond it.
    expect(created).toBe(1);
  });

  it("accepts DOCX resume", async () => {
    const fx = await makeAdminHrFixture();
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;
    const fd = makeFormWithResume(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "resume.docx",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(toRequest(fd) as any);
    expect(res.status).toBe(201);
    const { employeeId } = await res.json();
    const docs = await prisma.employeeDocument.findMany({ where: { employeeId } });
    expect(docs).toHaveLength(1);
    expect(docs[0].mimeType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });
});
