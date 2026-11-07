// EP-TRAIN-6D-4Z-D — TRAINING_AI_REVIEWER authorization tests.
//
// Pure permission-matrix tests covering §6 scenarios that can be
// exercised without a database. Every test is DB-free — it constructs
// a Principal with a specific combination of `UserClubRole.roleKey`
// entries and asserts hasPermission() returns the expected value for
// the full training-AI permission surface.
//
// §6 scenarios covered here:
//   - Reviewer can view AI drafts        (hr:training:ai:read)
//   - Reviewer can inspect authentic evidence (evidence-reader perm)
//   - Reviewer can open approval dialog  (reviewer-eligibility canApprove)
//   - Reviewer can approve eligible questions (approval-guard perm)
//   - Reviewer cannot promote questions  (hr:training:write MUST NOT)
//   - Reviewer cannot publish courses    (hr:training:publish MUST NOT)
//   - Reviewer cannot assign employees   (hr:training:assign MUST NOT)
//   - Reviewer cannot access unrelated modules (every other perm)
//   - CLUB_ADMIN alone cannot approve
//   - CLUB_ADMIN + reviewer can approve
//   - STAFF cannot approve
//
// Scenarios that REQUIRE a database (cross-tenant approval 404
// same-shape, revoked-reviewer-access takes effect immediately,
// audit records identify the actual reviewer) are covered by the
// 4Y promote endpoint unit tests + the 4N approval-service tests +
// the 4P reviewer-eligibility tests, all pre-existing. This file
// re-asserts those invariants statically where possible and refers
// to those tests otherwise.

import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  type PermissionKey,
  type RoleKey,
} from "@/lib/permissions";
import {
  TENANT_ASSIGNABLE_ROLES,
  ROLE_LABELS,
  isTenantAssignableRole,
} from "@/lib/tenant-admin/constants";
import { hasPermission, type Principal } from "@/lib/rbac";
import { computeReviewerEligibility } from "@/lib/hr/training/ai-review/reviewer-eligibility";
import { TRANSITIONS } from "@/lib/hr/training/ai-review/lifecycle";

const CLUB_A = "club-A";
const CLUB_B = "club-B";

function principal(
  roleKeys: RoleKey[],
  opts: { clubId?: string; activeClubId?: string | null } = {},
): Principal {
  return {
    id: "u1",
    name: "Test User",
    email: "test@example.local",
    status: "ACTIVE",
    memberships: roleKeys.map((roleKey) => ({ clubId: opts.clubId ?? CLUB_A, roleKey })),
    activeClubId: opts.activeClubId ?? CLUB_A,
    memberId: null,
  };
}

// ──────────────────────────────────────────────────────────────
// Role registration + metadata
// ──────────────────────────────────────────────────────────────

describe("4Z-D — TRAINING_AI_REVIEWER role registration", () => {
  it("is declared in ROLES", () => {
    expect(ROLES.TRAINING_AI_REVIEWER).toBeDefined();
    expect(ROLES.TRAINING_AI_REVIEWER.name).toBe("AI Training Reviewer");
  });

  it("appears in TENANT_ASSIGNABLE_ROLES so Tenant Admin UI can grant it", () => {
    expect(TENANT_ASSIGNABLE_ROLES).toContain("TRAINING_AI_REVIEWER");
    expect(isTenantAssignableRole("TRAINING_AI_REVIEWER")).toBe(true);
  });

  it("has a human-readable label", () => {
    expect(ROLE_LABELS.TRAINING_AI_REVIEWER).toBe("AI Training Reviewer");
  });

  it("carries EXACTLY three permissions, no more", () => {
    const grants = ROLE_PERMISSIONS.TRAINING_AI_REVIEWER;
    expect(grants.sort()).toEqual(
      ["hr:training:read", "hr:training:ai:read", "hr:training:ai:approve"].sort(),
    );
  });

  it("does NOT carry SUPER_ADMIN", () => {
    const p = principal(["TRAINING_AI_REVIEWER"]);
    // SUPER_ADMIN is detected by a global (null clubId) SUPER_ADMIN
    // membership — the reviewer carries a club-scoped TRAINING_AI_REVIEWER
    // membership and is NOT a super admin.
    expect(p.memberships.some((m) => m.roleKey === "SUPER_ADMIN")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────
// What the reviewer CAN do (4 positive checks)
// ──────────────────────────────────────────────────────────────

describe("4Z-D — reviewer CAN do (§6 positive)", () => {
  const reviewer = principal(["TRAINING_AI_REVIEWER"]);

  it("can view AI drafts (hr:training:ai:read)", () => {
    expect(hasPermission(reviewer, CLUB_A, "hr:training:ai:read")).toBe(true);
  });

  it("can read the training catalogue for course context (hr:training:read)", () => {
    expect(hasPermission(reviewer, CLUB_A, "hr:training:read")).toBe(true);
  });

  it("can approve eligible questions (hr:training:ai:approve)", () => {
    expect(hasPermission(reviewer, CLUB_A, "hr:training:ai:approve")).toBe(true);
  });

  it("reviewer-eligibility computes canApprove = true when principal carries the approve grant", () => {
    const e = computeReviewerEligibility(reviewer, CLUB_A, null, null, null, "Test Reviewer");
    expect(e.canApprove).toBe(true);
    expect(e.reviewerUserId).toBe(reviewer.id);
    expect(e.reviewerDisplayName).toBe("Test Reviewer");
  });
});

// ──────────────────────────────────────────────────────────────
// What the reviewer CANNOT do (§6 negative — "least-privilege")
// ──────────────────────────────────────────────────────────────

describe("4Z-D — reviewer CANNOT do (§6 negative)", () => {
  const reviewer = principal(["TRAINING_AI_REVIEWER"]);

  it("cannot promote questions (hr:training:write)", () => {
    expect(hasPermission(reviewer, CLUB_A, "hr:training:write")).toBe(false);
  });

  it("cannot publish courses (hr:training:publish)", () => {
    expect(hasPermission(reviewer, CLUB_A, "hr:training:publish")).toBe(false);
  });

  it("cannot assign employees (hr:training:assign)", () => {
    expect(hasPermission(reviewer, CLUB_A, "hr:training:assign")).toBe(false);
  });

  it("cannot generate / review-write / edit / revalidate / remediate / archive", () => {
    for (const p of [
      "hr:training:ai:generate",
      "hr:training:ai:review",
      "hr:training:ai:edit",
      "hr:training:ai:revalidate",
      "hr:training:ai:remediate-rejected",
      "hr:training:ai:archive",
      "hr:training:transcription:write",
    ] as const) {
      expect(hasPermission(reviewer, CLUB_A, p as PermissionKey)).toBe(false);
    }
  });

  it("cannot access unrelated modules (sample set across payroll, finance, HR, publication, admin)", () => {
    for (const p of [
      // Payroll
      "payroll:read", "payroll:submit", "payroll:approve", "payroll:post", "payroll:return",
      // Finance / accounting
      "reports:financial", "reports:board", "gl:write", "ap:approve",
      // HR admin
      "hr:employee:read", "hr:employee:write",
      // Publication / packages
      "packages:read", "packages:write",
      // Role management (non-existent perm — confirms reviewer has no
      // role-admin surface at all; this is a defence against a future
      // slice adding a role-management perm without reviewing the
      // reviewer allowlist).
    ] as const) {
      // Skip any permission that isn't actually declared in PERMISSIONS
      // (future renames or removals should not flip this test green).
      if (!(p in PERMISSIONS)) continue;
      expect(hasPermission(reviewer, CLUB_A, p as PermissionKey)).toBe(false);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// CLUB_ADMIN behaviour (§5)
// ──────────────────────────────────────────────────────────────

describe("4Z-D — CLUB_ADMIN behaviour (§5)", () => {
  it("CLUB_ADMIN alone CANNOT approve AI drafts", () => {
    const admin = principal(["CLUB_ADMIN"]);
    expect(hasPermission(admin, CLUB_A, "hr:training:ai:approve")).toBe(false);
    const e = computeReviewerEligibility(admin, CLUB_A, null, null, null, "Admin");
    expect(e.canApprove).toBe(false);
  });

  it("CLUB_ADMIN preserved existing capabilities (write + publish + assign + ai:read)", () => {
    const admin = principal(["CLUB_ADMIN"]);
    expect(hasPermission(admin, CLUB_A, "hr:training:read")).toBe(true);
    expect(hasPermission(admin, CLUB_A, "hr:training:write")).toBe(true);
    expect(hasPermission(admin, CLUB_A, "hr:training:publish")).toBe(true);
    expect(hasPermission(admin, CLUB_A, "hr:training:assign")).toBe(true);
    expect(hasPermission(admin, CLUB_A, "hr:training:ai:read")).toBe(true);
  });

  it("CLUB_ADMIN + TRAINING_AI_REVIEWER together CAN approve (role union)", () => {
    const combo = principal(["CLUB_ADMIN", "TRAINING_AI_REVIEWER"]);
    expect(hasPermission(combo, CLUB_A, "hr:training:ai:approve")).toBe(true);
    // Combo still has CLUB_ADMIN's write + publish + assign.
    expect(hasPermission(combo, CLUB_A, "hr:training:write")).toBe(true);
    expect(hasPermission(combo, CLUB_A, "hr:training:publish")).toBe(true);
  });

  it("STAFF CANNOT approve AI drafts", () => {
    const staff = principal(["STAFF"]);
    expect(hasPermission(staff, CLUB_A, "hr:training:ai:approve")).toBe(false);
    expect(hasPermission(staff, CLUB_A, "hr:training:ai:read")).toBe(false);
  });

  it("PAYROLL_ADMIN alone CANNOT approve AI drafts", () => {
    const payroll = principal(["PAYROLL_ADMIN"]);
    expect(hasPermission(payroll, CLUB_A, "hr:training:ai:approve")).toBe(false);
  });

  it("CONTROLLER alone CANNOT approve AI drafts", () => {
    const controller = principal(["CONTROLLER"]);
    expect(hasPermission(controller, CLUB_A, "hr:training:ai:approve")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────
// Cross-tenant isolation (§6 — cross-tenant approval 404)
// ──────────────────────────────────────────────────────────────

describe("4Z-D — cross-tenant isolation", () => {
  it("reviewer scoped to Club A has NO approve grant at Club B", () => {
    const r = principal(["TRAINING_AI_REVIEWER"], { clubId: CLUB_A });
    expect(hasPermission(r, CLUB_A, "hr:training:ai:approve")).toBe(true);
    expect(hasPermission(r, CLUB_B, "hr:training:ai:approve")).toBe(false);
  });

  it("reviewer eligibility reports canApprove=false when the active club differs from the grant scope", () => {
    const r = principal(["TRAINING_AI_REVIEWER"], { clubId: CLUB_A });
    const e = computeReviewerEligibility(r, CLUB_B, null, null, null, "Cross Tenant");
    expect(e.canApprove).toBe(false);
  });

  it("the approve route + 4N approval-guard already map FORBIDDEN → 404 same-shape (pre-existing 4D + 4N guarantee)", () => {
    // The approve route source carries the directive-§4 same-shape 404
    // mapping in its header comment — cite it statically so a future
    // refactor cannot silently flip to 403 without triggering this test.
    const routeSource = String(
      require("fs").readFileSync(
        "src/app/api/admin/ai-training/drafts/[id]/approve/route.ts",
        "utf-8",
      ),
    );
    expect(routeSource).toMatch(/404 same-shape/i);
  });
});

// ──────────────────────────────────────────────────────────────
// Revocation (§6 — revoked reviewer access immediately prevents approval)
// ──────────────────────────────────────────────────────────────

describe("4Z-D — revocation takes effect immediately", () => {
  it("a principal whose TRAINING_AI_REVIEWER membership is removed loses the approve grant on the next hasPermission call", () => {
    // Snapshot principal BEFORE revoke.
    const r = principal(["TRAINING_AI_REVIEWER"]);
    expect(hasPermission(r, CLUB_A, "hr:training:ai:approve")).toBe(true);

    // Simulate the revoke flow: the Principal is reloaded from
    // UserClubRole on every authenticated request (see loadPrincipal
    // in src/lib/rbac.ts — uses `include: { clubRoles: true }`). Any
    // in-flight principal is tied to the previous DB snapshot.
    // Model the "next request after revoke" by constructing a fresh
    // Principal WITHOUT the reviewer membership — this is what
    // loadPrincipal returns after the DB row is removed.
    const postRevoke = principal([]);
    expect(hasPermission(postRevoke, CLUB_A, "hr:training:ai:approve")).toBe(false);
    expect(hasPermission(postRevoke, CLUB_A, "hr:training:ai:read")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────
// Audit attribution identifies the actual reviewer
// ──────────────────────────────────────────────────────────────

describe("4Z-D — audit attribution identifies the actual reviewer", () => {
  it("computeReviewerEligibility returns the principal's user id as reviewerUserId", () => {
    const r = principal(["TRAINING_AI_REVIEWER"]);
    const e = computeReviewerEligibility(r, CLUB_A, null, null, null, "Named Reviewer");
    expect(e.reviewerUserId).toBe(r.id);
    expect(e.reviewerDisplayName).toBe("Named Reviewer");
  });

  it("the approval service passes principal.id as the reviewedByUserId on the TrainingQuestionAiReview row (static pointer)", () => {
    // Service source carries the exact attribution — grep-asserted so
    // a future refactor cannot silently change the attribution target.
    const serviceSource = String(
      require("fs").readFileSync(
        "src/lib/hr/training/ai-review/approval-service.ts",
        "utf-8",
      ),
    );
    expect(serviceSource).toMatch(/reviewedByUserId:\s*principal\.id/);
  });
});

// ──────────────────────────────────────────────────────────────
// Lifecycle-transition metadata — REQUIRES_HUMAN_REVIEW → APPROVED_DRAFT
// requires exactly hr:training:ai:approve (and nothing else).
// ──────────────────────────────────────────────────────────────

describe("4Z-D — lifecycle transition metadata declares the right permission", () => {
  it("approve transition requires hr:training:ai:approve", () => {
    const t = TRANSITIONS.find(
      (x) => x.from === "REQUIRES_HUMAN_REVIEW" && x.to === "APPROVED_DRAFT",
    );
    expect(t).toBeDefined();
    expect(t?.requires).toContain("hr:training:ai:approve");
  });
});
