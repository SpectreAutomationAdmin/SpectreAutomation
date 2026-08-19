// HR-1 admin-workflows — EmployeeCredential CRUD + tenant isolation.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import {
  createCredential,
  updateCredential,
  deleteCredential,
  listCredentials,
} from "@/lib/hr/credentials";
import { uploadEmployeeDocument } from "@/lib/hr/documents";
import { createEmployee } from "@/lib/hr/employees";
import { resetDb, seedRbac } from "../../util/db";
import { fakeDocInput, makeAdminHrFixture } from "./_helpers";

describe("HR admin-workflows · EmployeeCredential", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("createCredential + listCredentials round trip", async () => {
    const fx = await makeAdminHrFixture();
    const created = await createCredential(fx.clubAdmin, fx.employee.id, {
      credentialCode: "SMART_SERVE",
      displayName: "Smart Serve Certification",
      issuer: "AGCO",
      reference: "SS-123456",
      issuedAt: new Date("2024-05-01"),
      expiresAt: new Date("2027-05-01"),
    });
    expect(created.credentialCode).toBe("SMART_SERVE");
    const list = await listCredentials(fx.clubAdmin, fx.employee.id);
    expect(list.map((r) => r.id)).toContain(created.id);
  });

  it("createCredential rejects a caller without hr:credentials:write", async () => {
    const fx = await makeAdminHrFixture();
    await expect(
      createCredential(fx.gm, fx.employee.id, {
        credentialCode: "FOOD_HANDLERS",
        displayName: "Food Handlers",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("createCredential enforces same-employee for optional documentId", async () => {
    const fx = await makeAdminHrFixture();
    const otherEmployee = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Other", lastName: "Person",
    });
    const otherDoc = await uploadEmployeeDocument(
      fx.clubAdmin, otherEmployee.id, fakeDocInput("certification"),
    );
    await expect(
      createCredential(fx.clubAdmin, fx.employee.id, {
        credentialCode: "PGA_MEMBER",
        displayName: "PGA Membership",
        documentId: otherDoc.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("updateCredential + deleteCredential", async () => {
    const fx = await makeAdminHrFixture();
    const created = await createCredential(fx.clubAdmin, fx.employee.id, {
      credentialCode: "FOOD_HANDLERS", displayName: "Food Handlers",
    });
    const updated = await updateCredential(fx.clubAdmin, created.id, {
      displayName: "Food Handlers (Ontario)",
    });
    expect(updated.displayName).toBe("Food Handlers (Ontario)");
    await deleteCredential(fx.clubAdmin, created.id);
    const list = await listCredentials(fx.clubAdmin, fx.employee.id);
    expect(list.find((r) => r.id === created.id)).toBeUndefined();
  });

  it("tenant isolation — foreign-club admin cannot list credentials at the primary club", async () => {
    const fx = await makeAdminHrFixture();
    await expect(listCredentials(fx.foreignClubAdmin, fx.employee.id)).rejects.toThrow();
  });
});
