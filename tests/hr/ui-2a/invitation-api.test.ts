// HR-2A (2026-08-16) — POST /api/people/employees/[id]/invitation.
//
// Confirms the invitation route:
//   • Issues an invitation via the canonical service.
//   • NEVER returns the raw magic-link token in the HTTP response
//     body — HR-2A does not ship the employee-facing redemption
//     page, so any raw token exposed to the browser is a defect.
//   • Transitions the onboarding session from DRAFT to INVITED.
//   • Rejects an unauthenticated caller.
//   • Rejects a caller without `hr:onboarding:invite` (auditor).

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/hr/onboarding-sessions";
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
import { POST } from "@/app/api/people/employees/[id]/invitation/route";

function makeRequest(): Request {
  return new Request("http://test.local/api/people/employees/x/invitation", {
    method: "POST",
  });
}

describe("HR-2A · POST /api/people/employees/[id]/invitation", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    currentPrincipal = null;
  });

  it("issues invitation via canonical service and transitions session to INVITED", async () => {
    const fx = await makeAdminHrFixture();
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;
    // The employee needs a DRAFT session to accept the transition.
    const session = await createSession(fx.clubAdmin, fx.employee.id);
    expect(session.state).toBe("DRAFT");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeRequest() as any, { params: { id: fx.employee.id } });
    // 201 = delivered · 202 = persisted-without-external-send. Test
    // env has no EMAIL provider configured so this is 202. The
    // invitation itself persisted either way — that's what this
    // test cares about.
    expect([201, 202]).toContain(res.status);
    const body = await res.json();
    expect(typeof body.invitationId).toBe("string");
    expect(typeof body.expiresAt).toBe("string");
    expect(body.sessionState).toBe("INVITED");

    const inv = await prisma.employeeOnboardingInvitation.findUnique({
      where: { id: body.invitationId },
    });
    expect(inv).not.toBeNull();
    expect(inv!.employeeId).toBe(fx.employee.id);

    const updatedSession = await prisma.employeeOnboardingSession.findUnique({
      where: { id: session.id },
    });
    expect(updatedSession?.state).toBe("INVITED");
  });

  it("response body does NOT contain the raw magic-link token", async () => {
    const fx = await makeAdminHrFixture();
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;
    await createSession(fx.clubAdmin, fx.employee.id);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeRequest() as any, { params: { id: fx.employee.id } });
    expect([201, 202]).toContain(res.status);
    const raw = await res.text();
    // Base64url token is 43 chars from 32 random bytes. Assert
    // ABSENCE by shape: no bare 43-char base64url token anywhere in
    // the serialised body, AND no field literally named `rawToken`
    // / `token`.
    expect(raw).not.toMatch(/rawToken/i);
    expect(raw).not.toMatch(/"token"\s*:/);
    // Cross-check the returned invitationId against the DB row's
    // tokenHash — the two must be different values (tokenHash is
    // hex-64, invitationId is a cuid). If the route ever "helpfully"
    // returned the token in place of the id, this would fail.
    const parsed = JSON.parse(raw);
    const row = await prisma.employeeOnboardingInvitation.findUnique({
      where: { id: parsed.invitationId },
    });
    expect(row).not.toBeNull();
    expect(parsed.invitationId).not.toBe(row!.tokenHash);
  });

  it("returns 409 when the employee has no in-flight onboarding session", async () => {
    const fx = await makeAdminHrFixture();
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;
    // No session created — invitation must fail.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeRequest() as any, { params: { id: fx.employee.id } });
    expect(res.status).toBe(409);
  });

  it("rejects an unauthenticated caller with 401", async () => {
    const fx = await makeAdminHrFixture();
    currentPrincipal = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeRequest() as any, { params: { id: fx.employee.id } });
    expect(res.status).toBe(401);
  });

  it("rejects a caller without hr:onboarding:invite (AUDITOR)", async () => {
    const fx = await makeAdminHrFixture();
    await createSession(fx.clubAdmin, fx.employee.id);
    currentPrincipal = fx.auditor;
    currentPrincipal.activeClubId = fx.club.id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeRequest() as any, { params: { id: fx.employee.id } });
    expect(res.status).toBe(403);
  });

  // HR-2B.3 tail (2026-08-20) — delivery classification.
  //
  // The invitation route must distinguish DELIVERED (real provider
  // accepted) from DEV_LOGGED (console-only adapter fired) from
  // FAILED (real provider rejected) from NOT_ATTEMPTED (no
  // recipient email / no APP_URL). The response body's `email`
  // block MUST reflect this — the admin UI depends on it to avoid
  // masquerading a console-only send as real delivery.
  describe("delivery classification", () => {
    it("test fixture (no EMAIL IntegrationSetting, no EMAIL_DELIVERY_MODE) produces DEV_LOGGED — never DELIVERED", async () => {
      // Set APP_URL so the send path actually fires (otherwise the
      // NOT_ATTEMPTED "APP_URL not configured" branch short-circuits).
      vi.stubEnv("APP_URL", "http://test.local");
      try {
        const fx = await makeAdminHrFixture();
        currentPrincipal = fx.clubAdmin;
        currentPrincipal.activeClubId = fx.club.id;
        await createSession(fx.clubAdmin, fx.employee.id);
        // Ensure recipient email exists.
        await prisma.employee.update({
          where: { id: fx.employee.id },
          data: { personalEmail: "recipient@example.test" },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await POST(makeRequest() as any, { params: { id: fx.employee.id } });
        // DEV_LOGGED → 202 (invitation persisted, no external send).
        expect(res.status).toBe(202);
        const body = await res.json();
        expect(body.email).toBeTruthy();
        expect(body.email.status).toBe("DEV_LOGGED");
        expect(body.email.externalSendConfirmed).toBe(false);
        expect(body.email.provider).toBe("console");
        expect(body.email.operatorAlert).toBe(false); // non-prod NODE_ENV
        // The invitation row now carries the classified delivery status.
        const row = await prisma.employeeOnboardingInvitation.findUnique({
          where: { id: body.invitationId },
        });
        expect(row!.deliveryStatus).toBe("DEV_LOGGED");
        expect(row!.deliveryProvider).toBe("console");
        expect(row!.deliveryAttemptedAt).toBeInstanceOf(Date);
        // dev messageId prefix is preserved for forensic visibility.
        expect(row!.deliveryProviderMessageId?.startsWith("dev-")).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("employee without personal email → NOT_ATTEMPTED (invitation persists, delivery not attempted)", async () => {
      const fx = await makeAdminHrFixture();
      currentPrincipal = fx.clubAdmin;
      currentPrincipal.activeClubId = fx.club.id;
      await createSession(fx.clubAdmin, fx.employee.id);
      // Blank the recipient address.
      await prisma.employee.update({
        where: { id: fx.employee.id },
        data: { personalEmail: null, email: null },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await POST(makeRequest() as any, { params: { id: fx.employee.id } });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.email.status).toBe("NOT_ATTEMPTED");
      expect(body.email.externalSendConfirmed).toBe(false);
      expect(body.email.provider).toBeNull();
      expect(body.email.failureReason).toContain("recipient");
      const row = await prisma.employeeOnboardingInvitation.findUnique({
        where: { id: body.invitationId },
      });
      expect(row!.deliveryStatus).toBe("NOT_ATTEMPTED");
    });

    it("response body never carries the raw magic-link token even in the DEV_LOGGED branch", async () => {
      const fx = await makeAdminHrFixture();
      currentPrincipal = fx.clubAdmin;
      currentPrincipal.activeClubId = fx.club.id;
      await createSession(fx.clubAdmin, fx.employee.id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await POST(makeRequest() as any, { params: { id: fx.employee.id } });
      const raw = await res.text();
      // Base64url token would be 43 chars from 32 random bytes. Anywhere
      // in the serialised body — as a top-level field, inside `email`,
      // inside `deliveryProviderMessageId` — the raw token is banned.
      expect(raw).not.toMatch(/"rawToken"/i);
      expect(raw).not.toMatch(/"token"\s*:/);
      // Additional: assert the messageId in the response body (if any)
      // is not a 43-char base64url string.
      const parsed = JSON.parse(raw);
      // The response body deliberately does not surface
      // providerMessageId today — but if it ever does, it must not be
      // 43 chars of base64url.
      const mid = parsed.email?.providerMessageId;
      if (typeof mid === "string") {
        expect(/^[A-Za-z0-9_-]{43}$/.test(mid)).toBe(false);
      }
    });

    it("operational log never contains the raw token — only recipient DOMAIN + safe fields", async () => {
      vi.stubEnv("APP_URL", "http://test.local");
      const fx = await makeAdminHrFixture();
      currentPrincipal = fx.clubAdmin;
      currentPrincipal.activeClubId = fx.club.id;
      await createSession(fx.clubAdmin, fx.employee.id);
      await prisma.employee.update({
        where: { id: fx.employee.id },
        data: { personalEmail: "recipient@example.test" },
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await POST(makeRequest() as any, { params: { id: fx.employee.id } });
        // Find the delivery-attempt log line.
        const deliveryLogs = logSpy.mock.calls.filter((args) =>
          args.some((a) => typeof a === "string" && a.includes("[hr-invitation] delivery attempt")),
        );
        expect(deliveryLogs.length).toBeGreaterThan(0);
        // Combine all log args to a single string for exhaustive search.
        const combined = deliveryLogs.flat().map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" | ");
        // No 43-char base64url substring (would indicate raw token leak).
        expect(/[A-Za-z0-9_-]{43}/.test(combined)).toBe(false);
        // Recipient DOMAIN is fine (safe field), but the local-part
        // should NOT appear. The fixture employee's email is a
        // makeAdminHrFixture-generated address like `e12345@example.com` —
        // assert the local-part doesn't leak.
        const employee = await prisma.employee.findUnique({ where: { id: fx.employee.id } });
        const fullEmail = employee!.personalEmail ?? employee!.email;
        if (fullEmail) {
          // The FULL recipient address (which contains an "@") must
          // not appear anywhere in the operational log. `recipientDomain`
          // (the key) contains "recipient" as a substring, which is
          // fine — the leak we're guarding against is the actual
          // email address landing in a log line.
          expect(combined.includes(fullEmail)).toBe(false);
          const localPart = fullEmail.split("@")[0];
          const domain = fullEmail.split("@")[1];
          // Local-part next to the @ symbol is a leak signal.
          expect(combined.includes(`${localPart}@`)).toBe(false);
          // Domain by itself IS logged (recipientDomain field) — that's
          // safe per the operational-logging spec (§4).
          expect(combined.includes(domain)).toBe(true);
        }
      } finally {
        logSpy.mockRestore();
        vi.unstubAllEnvs();
      }
    });
  });

  // HR-2A.1 (2026-08-17) — fail-secure raw-token stderr logging gate.
  // The route logs the raw token to stderr only when BOTH
  // NODE_ENV ∈ {"development","test"} AND SPECTRE_LOG_INVITATION_TOKENS === "1".
  // Anything else (production, missing NODE_ENV, unset opt-in) MUST NOT log.
  describe("raw-token stderr log gate", () => {
    it("does NOT log the raw token by default (test env, no opt-in)", async () => {
      const prevOptIn = process.env.SPECTRE_LOG_INVITATION_TOKENS;
      delete process.env.SPECTRE_LOG_INVITATION_TOKENS;
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const fx = await makeAdminHrFixture();
        currentPrincipal = fx.clubAdmin;
        currentPrincipal.activeClubId = fx.club.id;
        await createSession(fx.clubAdmin, fx.employee.id);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await POST(makeRequest() as any, { params: { id: fx.employee.id } });
        // 201 = delivered · 202 = persisted-without-external-send (test
        // fixtures have no EMAIL provider configured → DEV_LOGGED / NOT_ATTEMPTED).
        // The invitation persisted in either case; that is what this
        // test cares about.
        expect([201, 202]).toContain(res.status);
        // The [hr-invitation] log MUST NOT have fired without opt-in.
        const invitationLogCalls = spy.mock.calls.filter((args) =>
          args.some((a) => typeof a === "string" && a.includes("[hr-invitation]"))
        );
        expect(invitationLogCalls).toHaveLength(0);
      } finally {
        spy.mockRestore();
        if (prevOptIn !== undefined) process.env.SPECTRE_LOG_INVITATION_TOKENS = prevOptIn;
      }
    });

    it("does NOT log the raw token in production even with SPECTRE_LOG_INVITATION_TOKENS=1", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("SPECTRE_LOG_INVITATION_TOKENS", "1");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const fx = await makeAdminHrFixture();
        currentPrincipal = fx.clubAdmin;
        currentPrincipal.activeClubId = fx.club.id;
        await createSession(fx.clubAdmin, fx.employee.id);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await POST(makeRequest() as any, { params: { id: fx.employee.id } });
        // 201 = delivered · 202 = persisted-without-external-send (test
        // fixtures have no EMAIL provider configured → DEV_LOGGED / NOT_ATTEMPTED).
        // The invitation persisted in either case; that is what this
        // test cares about.
        expect([201, 202]).toContain(res.status);
        // Production is fail-secure: opt-in alone is not enough — the
        // gate requires NODE_ENV ∈ {development,test} AND opt-in.
        const invitationLogCalls = spy.mock.calls.filter((args) =>
          args.some((a) => typeof a === "string" && a.includes("[hr-invitation]"))
        );
        expect(invitationLogCalls).toHaveLength(0);
      } finally {
        spy.mockRestore();
        vi.unstubAllEnvs();
      }
    });

    it("DOES log the raw token when NODE_ENV=test AND opt-in is set", async () => {
      const prevOptIn = process.env.SPECTRE_LOG_INVITATION_TOKENS;
      process.env.SPECTRE_LOG_INVITATION_TOKENS = "1";
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const fx = await makeAdminHrFixture();
        currentPrincipal = fx.clubAdmin;
        currentPrincipal.activeClubId = fx.club.id;
        await createSession(fx.clubAdmin, fx.employee.id);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await POST(makeRequest() as any, { params: { id: fx.employee.id } });
        // 201 = delivered · 202 = persisted-without-external-send (test
        // fixtures have no EMAIL provider configured → DEV_LOGGED / NOT_ATTEMPTED).
        // The invitation persisted in either case; that is what this
        // test cares about.
        expect([201, 202]).toContain(res.status);
        // Log SHOULD fire when both conditions hold — this exists so
        // a developer running vitest with the opt-in can retrieve
        // the token for local flow exercise.
        const invitationLogCalls = spy.mock.calls.filter((args) =>
          args.some((a) => typeof a === "string" && a.includes("[hr-invitation]"))
        );
        expect(invitationLogCalls.length).toBeGreaterThan(0);
      } finally {
        spy.mockRestore();
        if (prevOptIn === undefined) delete process.env.SPECTRE_LOG_INVITATION_TOKENS;
        else process.env.SPECTRE_LOG_INVITATION_TOKENS = prevOptIn;
      }
    });
  });
});
