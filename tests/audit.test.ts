import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { approveApplication, denyApplication, submitApplication } from "@/lib/services/applications";
import { db, makeClub, makeUser, resetDb, seedRbac, principalFor } from "./util/db";

describe("Audit log", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });

  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("records before/after state on application.approve", async () => {
    const club = await makeClub("A");
    await makeUser({ email: "admin@example.com", role: "CLUB_ADMIN", clubId: club.id });
    const p = await principalFor("admin@example.com");
    const a = await submitApplication(club.id, {
      firstName: "A", lastName: "B", email: "ab@example.com", consentCreditCheck: false, consentBackgroundCheck: false,
    });

    await approveApplication(p, a.id);

    const logs = await db().auditLog.findMany({
      where: { entityType: "Applicant", entityId: a.id },
      orderBy: { createdAt: "asc" },
    });
    const approve = logs.find((l) => l.action === "application.approve");
    expect(approve).toBeDefined();
    expect(approve?.userId).toBe(p.id);
    expect(approve?.clubId).toBe(club.id);
    expect(approve?.beforeJson).toContain("SUBMITTED");
    expect(approve?.afterJson).toContain("APPROVED");
  });

  it("records the actor on application.deny including the reason", async () => {
    const club = await makeClub("A");
    await makeUser({ email: "admin@example.com", role: "CLUB_ADMIN", clubId: club.id });
    const p = await principalFor("admin@example.com");
    const a = await submitApplication(club.id, {
      firstName: "D", lastName: "E", email: "de@example.com", consentCreditCheck: false, consentBackgroundCheck: false,
    });

    await denyApplication(p, a.id, "thanks but no");

    const log = await db().auditLog.findFirst({
      where: { entityType: "Applicant", entityId: a.id, action: "application.deny" },
    });
    expect(log?.metaJson).toContain("thanks but no");
  });

  it("public application submission is audited with userId=null", async () => {
    const club = await makeClub("Z");
    const a = await submitApplication(club.id, {
      firstName: "Anonymous", lastName: "Apply", email: "anon@example.com", consentCreditCheck: true, consentBackgroundCheck: true,
    });
    const log = await db().auditLog.findFirst({
      where: { entityType: "Applicant", entityId: a.id, action: "application.submit" },
    });
    expect(log).toBeDefined();
    expect(log?.userId).toBeNull();
    expect(log?.metaJson).toContain("public_form");
  });
});
