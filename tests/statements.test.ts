import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { postCharge, postPayment } from "@/lib/services/ar";
import { generateStatement, readStatement } from "@/lib/services/statements";
import { ForbiddenError } from "@/lib/errors";
import { db, makeClub, makeMember, makeUser, resetDb, seedRbac, principalFor } from "./util/db";

describe("Statements", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("issues a statement that snapshots period activity and aging", async () => {
    const club = await makeClub("Stmt");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const m = await makeMember(club.id);

    // Before the period
    await postCharge(p, m.id, { description: "Old dues", category: "DUES", amount: 100, transactionDate: "2025-01-15" });
    // Within the period
    await postCharge(p, m.id, { description: "Feb dues", category: "DUES", amount: 410, transactionDate: "2025-02-05" });
    await postPayment(p, m.id, { method: "CREDIT_CARD", amount: 100, paymentDate: "2025-02-10" });

    const s = await generateStatement(p, m.id, { periodStart: "2025-02-01", periodEnd: "2025-02-28" });

    expect(s.openingBalance).toBe(100);
    expect(s.totalCharges).toBe(410);
    expect(s.totalPayments).toBe(100);
    expect(s.closingBalance).toBe(410); // 100 + 410 - 100
    const lines = JSON.parse(s.linesJson) as Array<{ runningBalance: number }>;
    expect(lines.length).toBe(2);
    expect(lines[lines.length - 1].runningBalance).toBe(410);
  });

  it("MEMBER can read own statement; another principal at same club is also allowed via ar:read but not without", async () => {
    const club = await makeClub("StmtAuth");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const m = await makeMember(club.id);
    await makeUser({ email: "self@example.com", role: "MEMBER", clubId: club.id, memberId: m.id });
    const ctl = await principalFor("ctl@example.com");
    const self = await principalFor("self@example.com");

    await postCharge(ctl, m.id, { description: "Dues", category: "DUES", amount: 100, transactionDate: "2025-02-05" });
    const s = await generateStatement(ctl, m.id, { periodStart: "2025-02-01", periodEnd: "2025-02-28" });

    // Member reads their own
    const r = await readStatement(self, s.id);
    expect(r.id).toBe(s.id);

    // Another member at the same club shouldn't see it.
    const m2 = await makeMember(club.id);
    await makeUser({ email: "other@example.com", role: "MEMBER", clubId: club.id, memberId: m2.id });
    const other = await principalFor("other@example.com");
    await expect(readStatement(other, s.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
