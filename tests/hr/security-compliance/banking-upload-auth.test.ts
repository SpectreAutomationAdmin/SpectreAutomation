// HR-2B.3.4 (2026-08-18) — Banking-document upload endpoint auth
// invariants + cookie-path regression pin.
//
// Founder blocker on staging: a valid mid-flow employee session
// was being rejected by the /api/hr/onboarding/self/banking-document/upload
// endpoint with "Your onboarding session is no longer active".
//
// Root cause: the `spectre_hr_onboarding` cookie was scoped to
// `path: "/hr"`. The browser never sends it to `/api/…` paths, so
// `resolveEmployeeOnboardingActor()` saw no cookie and refused.
// Fix: broadened path to `/`. iron-session encryption + resolver
// re-validation remain the actual security boundaries.
//
// This suite pins the founder's failure mode as a REGRESSION so a
// future path-narrowing change fails loudly.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import { acquireInvitationContext } from "@/lib/hr/invitations";
import {
  EMPLOYEE_ONBOARDING_SESSION_OPTIONS,
} from "@/lib/hr/employee-onboarding-session";
import { resetDb, seedRbac } from "../../util/db";
import { makeHrFixture } from "./_helpers";

// The route handler resolves the actor via `requireEmployeeOnboardingActor`
// which reads the iron-session cookie via `next/headers::cookies()`.
// That path only works inside a real Next request context. In tests
// we mock the resolver directly — same pattern the invitation-api
// suite uses for `getCurrentPrincipal`.
let currentActor: {
  clubId: string;
  employeeId: string;
  sessionId: string;
  invitationId: string;
  sessionState: "DRAFT" | "INVITED" | "IN_PROGRESS" | "SUBMITTED" | "APPROVED" | "REJECTED" | "REVOKED";
  redeemedAt: string;
} | null = null;

vi.mock("@/lib/hr/employee-actor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hr/employee-actor")>();
  // Simulate the production resolver's DB re-validation of the
  // {clubId, employeeId, sessionId, invitationId} triangle: reject
  // if the session is in a terminal / non-resumable state, if the
  // employee's tenant doesn't match the cookie's clubId, or if the
  // session's employee doesn't match. Uses dynamic import of prisma
  // because vi.mock hoists the factory above the top-level imports.
  const RESUMABLE = new Set(["INVITED", "IN_PROGRESS"]);
  async function resolveWithDbCheck() {
    if (!currentActor) return null;
    const { prisma: p } = await import("@/lib/prisma");
    const session = await p.employeeOnboardingSession.findUnique({
      where: { id: currentActor.sessionId },
      select: { state: true, employeeId: true, clubId: true },
    });
    if (!session) return null;
    if (!RESUMABLE.has(session.state)) return null;
    if (session.clubId !== currentActor.clubId) return null;
    if (session.employeeId !== currentActor.employeeId) return null;
    // Employee's own tenant must also match.
    const emp = await p.employee.findUnique({
      where: { id: currentActor.employeeId },
      select: { clubId: true },
    });
    if (!emp || emp.clubId !== currentActor.clubId) return null;
    return currentActor;
  }
  return {
    ...actual,
    resolveEmployeeOnboardingActor: resolveWithDbCheck,
    requireEmployeeOnboardingActor: async () => {
      const a = await resolveWithDbCheck();
      if (!a) throw new actual.EmployeeOnboardingActorNotAuthenticatedError();
      return a;
    },
  };
});

const IP_HASH = createHash("sha256").update("test|salt", "utf8").digest("hex");

// Minimal valid PDF header — the extractor + persister both accept it.
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n%test synthetic banking document\n%%EOF",
  "utf8",
);

/** Install an active actor for the mock resolver. Emulates a valid
 *  browser flow where the cookie is present + the session is
 *  resumable. */
function installActor(ctx: {
  clubId: string;
  employeeId: string;
  sessionId: string;
  invitationId: string;
}) {
  currentActor = {
    ...ctx,
    sessionState: "INVITED",
    redeemedAt: new Date().toISOString(),
  };
}

async function actorForFixture(name = "UploadAuth") {
  const { club, employee, clubAdmin } = await makeHrFixture(`${name} ${Math.random().toString(36).slice(2, 6)}`);
  const session = await createSession(clubAdmin, employee.id);
  const result = await transitionSession(clubAdmin, session.id, "INVITED", { actorSource: "STAFF" });
  const ctx = await acquireInvitationContext(result.invitation!.rawToken, { ipHash: IP_HASH });
  return {
    club,
    employee,
    clubAdmin,
    ctx,
    sessionRow: session,
  };
}

// eslint-disable-next-line import/first
import { POST } from "@/app/api/hr/onboarding/self/banking-document/upload/route";

function makeMultipartRequest(opts: {
  document?: File | null;
  category?: string | null;
} = {}): Request {
  const fd = new FormData();
  // Use `in`-check instead of `??` so passing `null` explicitly omits
  // the field rather than falling through to the default.
  const category = "category" in opts ? opts.category : "void_cheque";
  if (category !== null && category !== undefined) fd.set("category", category);
  const doc = "document" in opts
    ? opts.document
    : new File([PDF_BYTES], "cheque.pdf", { type: "application/pdf" });
  if (doc) fd.set("document", doc);
  return new Request("http://test.local/api/hr/onboarding/self/banking-document/upload", {
    method: "POST",
    body: fd,
  });
}

describe("HR-2B.3.4 · Banking-document upload endpoint auth", () => {
  beforeEach(async () => {
    await prisma.club.updateMany({ data: { outboundMailboxConnectionId: null } }).catch(() => {});
    await prisma.emailMessage.deleteMany().catch(() => {});
    await prisma.mailboxSyncRun.deleteMany().catch(() => {});
    await prisma.graphSubscription.deleteMany().catch(() => {});
    await prisma.mailboxAccess.deleteMany().catch(() => {});
    await prisma.mailboxOAuthTransaction.deleteMany().catch(() => {});
    await prisma.mailboxConnection.deleteMany().catch(() => {});
    await resetDb();
    await seedRbac();
  });

  // ==== §9 direct regression: active session succeeds ====================

  it("active employee onboarding cookie → 201 + extraction result", async () => {
    const { ctx } = await actorForFixture("ActiveOk");
    installActor(ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeMultipartRequest() as any);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.documentId).toBe("string");
    expect(body.category).toBe("void_cheque");
    // Extraction returns SOMETHING (may be all-missing for a bare PDF).
    expect(body.extraction).toBeTruthy();
    expect(body.extraction.holderName).toHaveProperty("confidence");
    expect(body.extraction.institutionNumber).toHaveProperty("confidence");
    // Document is persisted with RESTRICTED sensitivity via the
    // canonical adapter.
    const row = await prisma.employeeDocument.findUnique({
      where: { id: body.documentId },
      select: { category: true, sensitivity: true, employeeId: true, clubId: true },
    });
    expect(row!.category).toBe("void_cheque");
    expect(row!.sensitivity).toBe("RESTRICTED");
    expect(row!.employeeId).toBe(ctx.employeeId);
    expect(row!.clubId).toBe(ctx.clubId);
  });

  // ==== §7 error UX: distinct errorCode for each failure class ============

  it("no cookie at all → 401 + errorCode SESSION_INVALID", async () => {
    currentActor = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeMultipartRequest() as any);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.errorCode).toBe("SESSION_INVALID");
    // The prose is the ONE place we intentionally show
    // "onboarding session is no longer active" — never for
    // upload/extraction failures.
    expect(body.error).toMatch(/onboarding session is no longer active/);
  });

  it("valid cookie but malformed multipart → 400 + errorCode BAD_REQUEST", async () => {
    const { ctx } = await actorForFixture("BadMultipart");
    installActor(ctx);
    const req = new Request("http://test.local/api/hr/onboarding/self/banking-document/upload", {
      method: "POST",
      body: "not-multipart-data",
      headers: { "content-type": "text/plain" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(req as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe("BAD_REQUEST");
  });

  it("valid cookie but missing document field → 422 + errorCode VALIDATION", async () => {
    const { ctx } = await actorForFixture("MissingField");
    installActor(ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeMultipartRequest({ document: null }) as any);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errorCode).toBe("VALIDATION");
    expect(body.error).not.toMatch(/onboarding session is no longer active/);
  });

  it("valid cookie but unsupported MIME (text/plain) → 422 + errorCode VALIDATION", async () => {
    const { ctx } = await actorForFixture("BadMime");
    installActor(ctx);
    const badFile = new File([Buffer.from("hello")], "notes.txt", { type: "text/plain" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeMultipartRequest({ document: badFile }) as any);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errorCode).toBe("VALIDATION");
    // The prose describes the MIME issue, NOT the session state.
    expect(body.error).toMatch(/PDF or image/);
  });

  it("valid cookie but empty file → 422 + errorCode VALIDATION", async () => {
    const { ctx } = await actorForFixture("EmptyFile");
    installActor(ctx);
    const empty = new File([Buffer.alloc(0)], "empty.pdf", { type: "application/pdf" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeMultipartRequest({ document: empty }) as any);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errorCode).toBe("VALIDATION");
    expect(body.error).toMatch(/empty/);
  });

  it("valid cookie but unknown category → 422 + errorCode VALIDATION", async () => {
    const { ctx } = await actorForFixture("BadCategory");
    installActor(ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeMultipartRequest({ category: "attacker_category" }) as any);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errorCode).toBe("VALIDATION");
  });

  // ==== §3+§9 session-state refusals =====================================

  it("REVOKED session → 401 + errorCode SESSION_INVALID (actor tombstoned)", async () => {
    const { ctx, sessionRow, clubAdmin } = await actorForFixture("Revoked");
    // Move session to REVOKED via canonical staff path.
    await transitionSession(clubAdmin, sessionRow.id, "REVOKED", { actorSource: "STAFF" });
    installActor(ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeMultipartRequest() as any);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.errorCode).toBe("SESSION_INVALID");
    // No document persisted.
    const rows = await prisma.employeeDocument.count({ where: { employeeId: ctx.employeeId } });
    expect(rows).toBe(0);
  });

  it("SUBMITTED session → 401 (session past the resumable window)", async () => {
    const { ctx, sessionRow, clubAdmin } = await actorForFixture("Submitted");
    await prisma.employeeOnboardingSession.update({
      where: { id: sessionRow.id },
      data: { state: "IN_PROGRESS" },
    });
    await transitionSession(clubAdmin, sessionRow.id, "SUBMITTED", {
      actorSource: "EMPLOYEE",
      actorEmployeeId: ctx.employeeId,
    });
    installActor(ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeMultipartRequest() as any);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.errorCode).toBe("SESSION_INVALID");
  });

  it("cross-tenant probe: Club A cookie shape targeting Club B session → 401", async () => {
    const a = await actorForFixture("XtenantA");
    const b = await actorForFixture("XtenantB");
    // Forge a cookie carrying A's clubId + A's employeeId but B's
    // sessionId. Resolver's row lookup is scoped by ALL three fields
    // simultaneously, so the tuple resolves to null.
    installActor({
      clubId: a.ctx.clubId,
      employeeId: a.ctx.employeeId,
      sessionId: b.ctx.sessionId,
      invitationId: a.ctx.invitationId,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeMultipartRequest() as any);
    expect(res.status).toBe(401);
    // No document persisted for either club.
    const rows = await prisma.employeeDocument.count();
    expect(rows).toBe(0);
  });

  // ==== §1 cookie-path regression pin ====================================

  it("cookie path is `/` — sends to /api/hr/* endpoints (the founder's failure)", () => {
    // The path is the exact root cause of the founder's staging
    // failure. A future change back to `/hr` would silently reintroduce
    // the bug (any /api/hr/* endpoint would 401 for otherwise-valid
    // sessions). Pin the fix as a source-level invariant.
    expect(EMPLOYEE_ONBOARDING_SESSION_OPTIONS.cookieOptions?.path).toBe("/");
  });

  it("cookie is httpOnly + SameSite=Lax + Secure-in-production (protection preserved)", () => {
    const opts = EMPLOYEE_ONBOARDING_SESSION_OPTIONS.cookieOptions!;
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    // `secure` depends on NODE_ENV; the field must be present so
    // production sees `true`.
    expect(Object.keys(opts)).toContain("secure");
  });
});
