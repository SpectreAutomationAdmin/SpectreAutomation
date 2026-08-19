// HR-1 security-compliance slice — EmployeeOnboardingInvitation
// lifecycle tests.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createHash } from "crypto";
import {
  issueInvitation,
  redeemInvitation,
  revokeInvitation,
  hashToken,
  InvitationNotFoundError,
  InvitationExpiredError,
  InvitationRevokedError,
  InvitationAlreadyRedeemedError,
} from "@/lib/hr/invitations";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import { makeHrFixture } from "./_helpers";

const IP_HASH = createHash("sha256").update("127.0.0.1|salt", "utf8").digest("hex");

describe("HR EmployeeOnboardingInvitation lifecycle", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("issueInvitation returns a 43-char base64url raw token", async () => {
    const { employee, clubAdmin } = await makeHrFixture();
    const { invitationId, rawToken, expiresAt } = await issueInvitation(clubAdmin, employee.id);
    expect(invitationId).toBeTruthy();
    expect(typeof rawToken).toBe("string");
    // 32 bytes -> 43 base64url chars, no padding.
    expect(rawToken.length).toBe(43);
    expect(/^[A-Za-z0-9_-]+$/.test(rawToken)).toBe(true);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("tokenHash in DB is SHA-256 of the raw token; raw token is NOT stored", async () => {
    const { employee, clubAdmin } = await makeHrFixture();
    const { invitationId, rawToken } = await issueInvitation(clubAdmin, employee.id);
    const row = await prisma.employeeOnboardingInvitation.findUnique({
      where: { id: invitationId },
    });
    expect(row).toBeTruthy();
    expect(row!.tokenHash).toBe(hashToken(rawToken));
    // Explicit — the raw token must NOT be persisted anywhere on the row.
    const serialised = JSON.stringify(row);
    expect(serialised.includes(rawToken)).toBe(false);
  });

  it("redeemInvitation with a valid, unredeemed token succeeds and returns invitation's clubId/employeeId", async () => {
    const { club, employee, clubAdmin } = await makeHrFixture();
    const { invitationId, rawToken } = await issueInvitation(clubAdmin, employee.id);
    const result = await redeemInvitation(rawToken, { ipHash: IP_HASH });
    expect(result.invitationId).toBe(invitationId);
    expect(result.clubId).toBe(club.id);
    expect(result.employeeId).toBe(employee.id);

    const row = await prisma.employeeOnboardingInvitation.findUnique({
      where: { id: invitationId },
    });
    expect(row!.redeemedAt).toBeInstanceOf(Date);
    expect(row!.redeemedByIpHash).toBe(IP_HASH);
  });

  it("redeemInvitation with an unknown token throws InvitationNotFoundError", async () => {
    await expect(
      redeemInvitation("nonexistent-token-value-that-is-not-in-db", { ipHash: IP_HASH }),
    ).rejects.toBeInstanceOf(InvitationNotFoundError);
  });

  it("redeemInvitation with an expired token throws InvitationExpiredError", async () => {
    const { employee, clubAdmin } = await makeHrFixture();
    const { invitationId, rawToken } = await issueInvitation(clubAdmin, employee.id);
    // Force expiry.
    await prisma.employeeOnboardingInvitation.update({
      where: { id: invitationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(redeemInvitation(rawToken, { ipHash: IP_HASH })).rejects.toBeInstanceOf(
      InvitationExpiredError,
    );
  });

  it("redeemInvitation for a revoked invitation throws InvitationRevokedError", async () => {
    const { employee, clubAdmin } = await makeHrFixture();
    const { invitationId, rawToken } = await issueInvitation(clubAdmin, employee.id);
    await revokeInvitation(clubAdmin, invitationId);
    await expect(redeemInvitation(rawToken, { ipHash: IP_HASH })).rejects.toBeInstanceOf(
      InvitationRevokedError,
    );
  });

  it("redeemInvitation for an already-redeemed invitation throws InvitationAlreadyRedeemedError", async () => {
    const { employee, clubAdmin } = await makeHrFixture();
    const { rawToken } = await issueInvitation(clubAdmin, employee.id);
    await redeemInvitation(rawToken, { ipHash: IP_HASH });
    await expect(redeemInvitation(rawToken, { ipHash: IP_HASH })).rejects.toBeInstanceOf(
      InvitationAlreadyRedeemedError,
    );
  });

  it("multiple issueInvitation calls for the same employee produce distinct tokens", async () => {
    // Regression harness for the collision-retry path — even without
    // forcing a hash collision, we verify the service can safely
    // issue N invitations back-to-back and each carries its own
    // unique tokenHash (@unique constraint would surface a bug).
    const { employee, clubAdmin } = await makeHrFixture();
    const a = await issueInvitation(clubAdmin, employee.id);
    const b = await issueInvitation(clubAdmin, employee.id);
    const c = await issueInvitation(clubAdmin, employee.id);
    const ids = [a.invitationId, b.invitationId, c.invitationId];
    expect(new Set(ids).size).toBe(3);
    const tokens = [a.rawToken, b.rawToken, c.rawToken];
    expect(new Set(tokens).size).toBe(3);
    const hashes = tokens.map(hashToken);
    expect(new Set(hashes).size).toBe(3);
  });

  it("revokeInvitation rejects a redeemed invitation", async () => {
    const { employee, clubAdmin } = await makeHrFixture();
    const { invitationId, rawToken } = await issueInvitation(clubAdmin, employee.id);
    await redeemInvitation(rawToken, { ipHash: IP_HASH });
    await expect(revokeInvitation(clubAdmin, invitationId)).rejects.toThrow();
  });
});
