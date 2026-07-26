import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  ensureClubCollectionsSeed,
  generateNoticeFromTemplate,
  markNoticeSent,
  markNoticeResolved,
  applyAccessAction,
  renderTemplate,
  DEFAULT_NOTICE_TEMPLATES,
} from "@/lib/services/collections";
import { db, makeClub, makeMember, makeUser, resetDb, seedRbac, principalFor } from "./util/db";
import { ConflictError } from "@/lib/errors";

describe("Collections — templates, notices, access", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("ensureClubCollectionsSeed creates default templates + stages once", async () => {
    const club = await makeClub("Seed");
    await ensureClubCollectionsSeed(club.id);
    await ensureClubCollectionsSeed(club.id); // idempotent
    const templates = await db().collectionNoticeTemplate.findMany({ where: { clubId: club.id } });
    const stages = await db().collectionStage.findMany({ where: { clubId: club.id } });
    expect(templates.length).toBe(DEFAULT_NOTICE_TEMPLATES.length);
    expect(stages.length).toBeGreaterThan(0);
  });

  it("renders templates with simple variable substitution", () => {
    const body = "Dear {{firstName}}, balance {{currentBalance}}.";
    expect(renderTemplate(body, { firstName: "Ada", currentBalance: "$100.00" })).toBe("Dear Ada, balance $100.00.");
  });

  it("generates a DRAFT notice from a template, sends it, then resolves it", async () => {
    const club = await makeClub("Notice");
    await ensureClubCollectionsSeed(club.id);
    await makeUser({ email: "admin@example.com", role: "CLUB_ADMIN", clubId: club.id });
    const p = await principalFor("admin@example.com");
    const m = await makeMember(club.id);

    const notice = await generateNoticeFromTemplate(p, m.id, "OVER_30", "STAGE_30");
    expect(notice.status).toBe("DRAFT");
    expect(notice.message).toContain(m.firstName);

    const sent = await markNoticeSent(p, notice.id);
    expect(sent.status).toBe("SENT");
    await expect(markNoticeSent(p, notice.id)).rejects.toBeInstanceOf(ConflictError);

    const resolved = await markNoticeResolved(p, notice.id);
    expect(resolved.status).toBe("RESOLVED");
  });

  it("access actions update Member.accessStatus and write a CollectionAction", async () => {
    const club = await makeClub("Access");
    await ensureClubCollectionsSeed(club.id);
    await makeUser({ email: "admin@example.com", role: "CLUB_ADMIN", clubId: club.id });
    const p = await principalFor("admin@example.com");
    const m = await makeMember(club.id);

    await applyAccessAction(p, m.id, "SUSPEND_CHARGE");
    const m2 = await db().member.findUnique({ where: { id: m.id } });
    expect(m2?.accessStatus).toBe("CHARGE_ACCOUNT_SUSPENDED");
    const actions = await db().collectionAction.findMany({ where: { memberId: m.id } });
    expect(actions.length).toBe(1);
    expect(actions[0].action).toBe("SUSPENDED_CHARGE");

    await applyAccessAction(p, m.id, "RESTORE");
    const m3 = await db().member.findUnique({ where: { id: m.id } });
    expect(m3?.accessStatus).toBe("FULL_ACCESS");
  });
});
