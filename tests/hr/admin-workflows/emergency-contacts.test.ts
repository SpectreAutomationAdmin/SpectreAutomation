// HR-1 admin-workflows — EmployeeEmergencyContact CRUD + one-primary
// invariant + tenant isolation.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import {
  createEmergencyContact,
  updateEmergencyContact,
  deleteEmergencyContact,
  listEmergencyContacts,
} from "@/lib/hr/emergency-contacts";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "./_helpers";

describe("HR admin-workflows · EmployeeEmergencyContact", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("createEmergencyContact + listEmergencyContacts", async () => {
    const fx = await makeAdminHrFixture();
    const c = await createEmergencyContact(fx.clubAdmin, fx.employee.id, {
      name: "Grace Sensitive", relation: "Spouse", phone: "555-0101",
      isPrimary: true,
    });
    expect(c.name).toBe("Grace Sensitive");
    expect(c.isPrimary).toBe(true);
    const list = await listEmergencyContacts(fx.clubAdmin, fx.employee.id);
    expect(list.map((r) => r.id)).toContain(c.id);
  });

  it("only one primary contact per employee — creating a second primary demotes the first", async () => {
    const fx = await makeAdminHrFixture();
    const c1 = await createEmergencyContact(fx.clubAdmin, fx.employee.id, {
      name: "Grace Sensitive", relation: "Spouse", phone: "555-0101", isPrimary: true,
    });
    const c2 = await createEmergencyContact(fx.clubAdmin, fx.employee.id, {
      name: "Uncle Bob", relation: "Guardian", phone: "555-0202", isPrimary: true,
    });
    const list = await listEmergencyContacts(fx.clubAdmin, fx.employee.id);
    const rowC1 = list.find((r) => r.id === c1.id)!;
    const rowC2 = list.find((r) => r.id === c2.id)!;
    expect(rowC1.isPrimary).toBe(false);
    expect(rowC2.isPrimary).toBe(true);
  });

  it("updateEmergencyContact toggling isPrimary demotes previous primary", async () => {
    const fx = await makeAdminHrFixture();
    const c1 = await createEmergencyContact(fx.clubAdmin, fx.employee.id, {
      name: "First", relation: "Spouse", phone: "555-0101", isPrimary: true,
    });
    const c2 = await createEmergencyContact(fx.clubAdmin, fx.employee.id, {
      name: "Second", relation: "Guardian", phone: "555-0202", isPrimary: false,
    });
    await updateEmergencyContact(fx.clubAdmin, c2.id, { isPrimary: true });
    const list = await listEmergencyContacts(fx.clubAdmin, fx.employee.id);
    expect(list.find((r) => r.id === c1.id)?.isPrimary).toBe(false);
    expect(list.find((r) => r.id === c2.id)?.isPrimary).toBe(true);
  });

  it("createEmergencyContact rejects a caller without hr:emergency:write (auditor)", async () => {
    const fx = await makeAdminHrFixture();
    await expect(
      createEmergencyContact(fx.auditor, fx.employee.id, {
        name: "X", relation: "Y", phone: "555",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("required fields — missing name throws ValidationError", async () => {
    const fx = await makeAdminHrFixture();
    await expect(
      createEmergencyContact(fx.clubAdmin, fx.employee.id, {
        name: "", relation: "Spouse", phone: "555",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("deleteEmergencyContact removes the row", async () => {
    const fx = await makeAdminHrFixture();
    const c = await createEmergencyContact(fx.clubAdmin, fx.employee.id, {
      name: "Grace", relation: "Spouse", phone: "555-0101",
    });
    await deleteEmergencyContact(fx.clubAdmin, c.id);
    const list = await listEmergencyContacts(fx.clubAdmin, fx.employee.id);
    expect(list.find((r) => r.id === c.id)).toBeUndefined();
  });

  it("tenant isolation — foreign-club admin cannot read primary-club emergency contacts", async () => {
    const fx = await makeAdminHrFixture();
    await expect(listEmergencyContacts(fx.foreignClubAdmin, fx.employee.id)).rejects.toThrow();
  });
});
