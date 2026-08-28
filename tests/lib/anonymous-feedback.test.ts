// HR-2C Anonymous Feedback (2026-08-27) — service tests.
// Covers §33/§34 of the ticket: no author fields stored, tenant
// isolation, admin status transitions gated, validation.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import {
  submitAnonymousFeedback,
  listAnonymousFeedback,
  setFeedbackStatus,
} from "@/lib/anonymous-feedback";

describe("anonymous feedback — tenant + anonymity", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  async function setup() {
    const clubA = await makeClub("Feedback Club A");
    const clubB = await makeClub("Feedback Club B");
    const admin = await makeUser({ email: "adminA@feedback.test", role: "CLUB_ADMIN", clubId: clubA.id });
    const adminP = await principalFor(admin.email);
    return { clubA, clubB, adminP };
  }

  it("persists message + category + clubId only — no author fields", async () => {
    const { clubA } = await setup();
    const submitted = await submitAnonymousFeedback(clubA.id, {
      message: "The dining room could use better lighting.",
      category: "Facilities",
    });
    expect(submitted.message).toBe("The dining room could use better lighting.");
    expect(submitted.category).toBe("Facilities");
    expect(submitted.clubId).toBe(clubA.id);
    expect(submitted.status).toBe("NEW");
    // Direct DB inspection — the stored row must NOT carry any
    // author identifier column.
    const raw = await db().anonymousFeedback.findFirstOrThrow({ where: { id: submitted.id } });
    const keys = Object.keys(raw);
    for (const forbidden of ["employeeId", "userId", "authorId", "email", "name", "employeeNumber"]) {
      expect(keys, `${forbidden} must not appear on AnonymousFeedback`).not.toContain(forbidden);
    }
  });

  it("tenant isolation — Club A feedback is invisible to Club B", async () => {
    const { clubA, clubB } = await setup();
    await submitAnonymousFeedback(clubA.id, { message: "A only" });
    const forB = await listAnonymousFeedback(clubB.id);
    expect(forB.length).toBe(0);
    const forA = await listAnonymousFeedback(clubA.id);
    expect(forA.length).toBe(1);
    expect(forA[0]!.message).toBe("A only");
  });

  it("category is optional", async () => {
    const { clubA } = await setup();
    const r = await submitAnonymousFeedback(clubA.id, { message: "No category" });
    expect(r.category).toBeNull();
  });

  it("validation — empty message rejected, oversized message rejected", async () => {
    const { clubA } = await setup();
    await expect(submitAnonymousFeedback(clubA.id, { message: "" })).rejects.toThrow();
    await expect(submitAnonymousFeedback(clubA.id, { message: "   " })).rejects.toThrow();
    await expect(submitAnonymousFeedback(clubA.id, {
      message: "x".repeat(4001),
    })).rejects.toThrow();
  });

  it("admin can mark reviewed / archived / restore", async () => {
    const { clubA, adminP } = await setup();
    const row = await submitAnonymousFeedback(clubA.id, { message: "review me" });
    expect(row.status).toBe("NEW");
    const reviewed = await setFeedbackStatus(adminP, clubA.id, row.id, "REVIEWED");
    expect(reviewed.status).toBe("REVIEWED");
    expect(reviewed.reviewedAt).not.toBeNull();
    const archived = await setFeedbackStatus(adminP, clubA.id, row.id, "ARCHIVED");
    expect(archived.status).toBe("ARCHIVED");
    const restored = await setFeedbackStatus(adminP, clubA.id, row.id, "NEW");
    expect(restored.status).toBe("NEW");
    expect(restored.reviewedAt).toBeNull();
  });

  it("admin without settings:write cannot change status", async () => {
    const { clubA, adminP } = await setup();
    const row = await submitAnonymousFeedback(clubA.id, { message: "protected" });
    const staff = await makeUser({ email: "staff@feedback.test", role: "STAFF", clubId: clubA.id });
    const staffP = await principalFor(staff.email);
    await expect(setFeedbackStatus(staffP, clubA.id, row.id, "REVIEWED")).rejects.toThrow();
  });

  it("cross-tenant admin cannot change another club's feedback", async () => {
    const { clubA, clubB } = await setup();
    const row = await submitAnonymousFeedback(clubA.id, { message: "A only" });
    // Admin scoped to club B tries to touch club A's row.
    const adminB = await makeUser({ email: "adminB@feedback.test", role: "CLUB_ADMIN", clubId: clubB.id });
    const adminBP = await principalFor(adminB.email);
    await expect(setFeedbackStatus(adminBP, clubA.id, row.id, "REVIEWED")).rejects.toThrow();
  });
});
