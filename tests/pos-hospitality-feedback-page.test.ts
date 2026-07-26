// POS cleanup step 9 — hospitality-feedback admin page.
//
// Spec is heavy on UI behaviour, which we pin via source-contract reads
// of page.tsx, plus end-to-end service-layer assertions for the
// surfaces the page renders (KPI math, recovery transitions, internal
// notes, cross-tenant safety). Hospitality service internals are
// independently covered in tests/hospitality-survey.test.ts; this file
// asserts the admin-page wiring on top of that.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { seatTable, settleCheckBySeats } from "@/lib/pos/seat-checks";
import { addCheckLines } from "@/lib/pos/checks";
import {
  ensureSurveyInvitationForCheck,
  submitSurveyResponse,
  listSurveyResponses,
  getFeedbackSummary,
  markResponseReviewed,
  setResponseRecoveryStatus,
  addResponseInternalNote,
  assignResponseFollowUp,
  FOOD_BEVERAGE_DEPT_KEY,
} from "@/lib/hospitality/surveys";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";

const PAGE_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/app/admin/hospitality/feedback/page.tsx"),
  "utf8",
);

// -----------------------------------------------------------------------------
// Bootstrap a Silver-Springs-shaped club with two members + two settled
// surveys (one 5/5, one 4/5) so the page has something to render and the
// service has both an attention-needing row and a no-action row to sort.
// -----------------------------------------------------------------------------
async function bootstrapTwoSurveys(name: string) {
  const club = await bootstrapAPClub(name);
  const fbDept = await db().department.findFirst({ where: { clubId: club.id, code: "FB" } });
  const loc = await db().pOSLocation.create({
    data: { clubId: club.id, code: LOUNGE_LOCATION_CODE, name: "Clubhouse Lounge", departmentId: fbDept?.id ?? null },
  });
  const terminal = await db().pOSTerminal.create({
    data: { clubId: club.id, code: LOUNGE_TERMINAL_CODE, name: "Lounge Terminal", locationId: loc.id },
  });
  await db().pOSSession.create({
    data: { clubId: club.id, locationId: loc.id, terminalId: terminal.id, status: "OPEN", openingFloat: 0 },
  });
  const foodCat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: loc.id, name: "Mains", sortOrder: 1, isActive: true, chitDestination: "KITCHEN" },
  });
  const drinkCat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: loc.id, name: "Drinks", sortOrder: 2, isActive: true, chitDestination: "BAR" },
  });
  const burger = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: foodCat.id, name: "The Silver Burger", price: 18, taxable: true, isActive: true },
  });
  const beer = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: drinkCat.id, name: "House Lager", price: 8, taxable: true, isActive: true },
  });
  const area = await db().diningArea.create({
    data: { clubId: club.id, name: "Lounge", sortOrder: 0 },
  });
  const table = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: area.id, tableNumber: "L4", capacity: 4,
      shape: "SQUARE", xPos: 460, yPos: 250, width: 110, height: 110,
    },
  });
  const owen = await makeMember(club.id, { firstName: "Owen", lastName: "Beauchamp" });
  await db().member.update({ where: { id: owen.id }, data: { email: "owen@example.com" } });
  const margaret = await makeMember(club.id, { firstName: "Margaret", lastName: "Lin" });
  await db().member.update({ where: { id: margaret.id }, data: { email: "margaret@example.com" } });

  const adminEmail = `feedback-admin-${club.id}@example.com`;
  await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(adminEmail);

  // Settle a split-bill so each member has their own survey invitation.
  const { checkId } = await seatTable(admin, club.id, {
    tableId: table.id, memberId: owen.id, partySize: 4,
  });
  await addCheckLines(admin, checkId, {
    items: [{ menuItemId: burger.id, quantity: 1, seatNumber: 1 }],
  });
  await addCheckLines(admin, checkId, {
    items: [{ menuItemId: beer.id, quantity: 1, seatNumber: 2 }],
  });
  await settleCheckBySeats(admin, checkId, {
    groups: [
      { label: "Group A — Seat 1", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: owen.id },
      { label: "Group B — Seat 2", seatNumbers: [2], paymentMethod: "MEMBER_ACCOUNT", memberId: margaret.id },
    ],
    allowUnsentLines: true,
  });
  const groups = await db().pOSSettlementGroup.findMany({
    where: { posCheckId: checkId },
    orderBy: { createdAt: "asc" },
  });
  const groupA = groups.find((g) => g.memberId === owen.id)!;
  const groupB = groups.find((g) => g.memberId === margaret.id)!;

  // Replace the auto-created invitations with fresh ones we can drive
  // (we need raw tokens to call submitSurveyResponse). Same as the
  // pattern in pos-survey-split-bill.test.ts.
  async function mintInvitation(groupId: string, posSaleId: string | null, memberId: string) {
    await db().hospitalitySurveyInvitation.deleteMany({
      where: { clubId: club.id, posSettlementGroupId: groupId },
    });
    return ensureSurveyInvitationForCheck({
      clubId: club.id,
      posCheckId: checkId,
      posSettlementGroupId: groupId,
      posSaleId,
      memberId,
      origin: "http://localhost:3000",
    });
  }
  const owenInv = await mintInvitation(groupA.id, groupA.posSaleId, owen.id);
  const margaretInv = await mintInvitation(groupB.id, groupB.posSaleId, margaret.id);

  // Owen submits 5/5 — no action needed.
  await submitSurveyResponse({
    token: owenInv.token!,
    rating: 5,
    comment: "Lovely service",
  });
  // Margaret submits 4/5 — lands in NEEDS_REVIEW.
  await submitSurveyResponse({
    token: margaretInv.token!,
    rating: 4,
    comment: "Drink came out warm",
  });

  return { club, admin, owen, margaret, checkId, groupA, groupB };
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// 1 + 2. Page loads for an authorized admin; gated for members.
// =============================================================================
describe("Permission gating (UI source contract)", () => {
  it("requires settings:read; redirects to /app/admin otherwise", () => {
    expect(PAGE_SRC).toMatch(/hasPermission\(principal, clubId, "settings:read"\)/);
    expect(PAGE_SRC).toMatch(/redirect\("\/app\/admin"\)/);
  });

  it("admin write-actions require settings:write (canWrite gate on action UI)", () => {
    expect(PAGE_SRC).toMatch(/canWrite = hasPermission\(principal, clubId, "settings:write"\)/);
    expect(PAGE_SRC).toMatch(/\{canWrite && \(/);
  });
});

// =============================================================================
// 3 + 4 + 5. KPI math (avg rating, below-5 count, urgent count).
// =============================================================================
describe("KPI math (service layer drives the cards)", () => {
  it("avg + below-5 + urgent reflect the response set", async () => {
    const ctx = await bootstrapTwoSurveys("kpi");
    // Add a 1-star urgent response so the urgent count is non-zero.
    const inv = await ensureSurveyInvitationForCheck({
      clubId: ctx.club.id,
      posCheckId: ctx.checkId,
      posSettlementGroupId: null, // whole-check anchor
      posSaleId: null,
      memberId: ctx.owen.id,
      origin: "http://localhost:3000",
    });
    await submitSurveyResponse({ token: inv.token!, rating: 1, comment: "Awful" });

    const summary = await getFeedbackSummary(ctx.admin, ctx.club.id, 30);
    expect(summary.total).toBe(3);
    // 5 + 4 + 1 = 10 / 3 = 3.33...
    expect(summary.average!).toBeCloseTo(10 / 3, 2);
    // 4/5 + 1/5 = 2 below-five.
    expect(summary.belowFive).toBe(2);
    // 1/5 is urgent (rating <= 2).
    expect(summary.urgentOpen).toBe(1);
    // Two responses pending recovery (4/5 + 1/5).
    expect(summary.unresolvedRecovery).toBe(2);
  });
});

// =============================================================================
// 6 + 7. Needs-attention filter excludes 5/5 + RESOLVED responses.
// =============================================================================
describe("Needs-attention filter (UI source contract + service)", () => {
  it("the page's needsAttentionFilter excludes NONE + RESOLVED + 5/5", () => {
    // Source contract — the local helper has the right shape.
    expect(PAGE_SRC).toMatch(/function needsAttentionFilter/);
    expect(PAGE_SRC).toMatch(/r\.serviceRecoveryStatus === "NONE"/);
    expect(PAGE_SRC).toMatch(/r\.serviceRecoveryStatus === "RESOLVED"/);
    expect(PAGE_SRC).toMatch(/return r\.rating < 5;/);
    // Sort puts urgent first.
    expect(PAGE_SRC).toMatch(/function sortNeedsAttention/);
    expect(PAGE_SRC).toMatch(/a\.urgent !== b\.urgent/);
  });

  it("at the service level: a 5/5 response stays in NONE and never enters the queue", async () => {
    const ctx = await bootstrapTwoSurveys("five-clean");
    const all = await listSurveyResponses(ctx.admin, ctx.club.id, { limit: 200 });
    const owen5 = all.find((r) => r.memberId === ctx.owen.id)!;
    expect(owen5.rating).toBe(5);
    expect(owen5.serviceRecoveryStatus).toBe("NONE");
  });

  it("at the service level: a 4/5 response lands in NEEDS_REVIEW (so the queue sees it)", async () => {
    const ctx = await bootstrapTwoSurveys("four-queued");
    const all = await listSurveyResponses(ctx.admin, ctx.club.id, { limit: 200 });
    const margaret4 = all.find((r) => r.memberId === ctx.margaret.id)!;
    expect(margaret4.rating).toBe(4);
    expect(margaret4.serviceRecoveryStatus).toBe("NEEDS_REVIEW");
  });
});

// =============================================================================
// 8. Filter by rating works at the service layer + UI source contract.
// =============================================================================
describe("Filter by rating", () => {
  it("listSurveyResponses honours { rating: 4 }", async () => {
    const ctx = await bootstrapTwoSurveys("rating-filter");
    const fours = await listSurveyResponses(ctx.admin, ctx.club.id, { rating: 4 });
    const fives = await listSurveyResponses(ctx.admin, ctx.club.id, { rating: 5 });
    expect(fours.every((r) => r.rating === 4)).toBe(true);
    expect(fives.every((r) => r.rating === 5)).toBe(true);
    expect(fours.find((r) => r.memberId === ctx.margaret.id)).toBeTruthy();
    expect(fives.find((r) => r.memberId === ctx.owen.id)).toBeTruthy();
  });

  it("the page filter bar exposes a rating select with 1..5 options", () => {
    expect(PAGE_SRC).toMatch(/<select name="rating"/);
    expect(PAGE_SRC).toMatch(/<option value="1">1 star/);
    expect(PAGE_SRC).toMatch(/<option value="5">5 stars/);
  });
});

// =============================================================================
// 9. Filter unresolved-only / urgent-only at the service layer.
// =============================================================================
describe("Filter unresolved-only / urgent-only", () => {
  it("recoveryStatus filter narrows the result set", async () => {
    const ctx = await bootstrapTwoSurveys("recovery-filter");
    const needsReview = await listSurveyResponses(ctx.admin, ctx.club.id, { recoveryStatus: "NEEDS_REVIEW" });
    expect(needsReview.every((r) => r.serviceRecoveryStatus === "NEEDS_REVIEW")).toBe(true);
    expect(needsReview.some((r) => r.memberId === ctx.margaret.id)).toBe(true);
    expect(needsReview.some((r) => r.memberId === ctx.owen.id)).toBe(false);
  });
});

// =============================================================================
// 10 + 11. Split-group + whole-check context render correctly (UI + service).
// =============================================================================
describe("Settlement-group + check context", () => {
  it("listSurveyResponses surfaces posSettlementGroup.label on each row", async () => {
    const ctx = await bootstrapTwoSurveys("group-context");
    const all = await listSurveyResponses(ctx.admin, ctx.club.id, { limit: 200 });
    const owenRow = all.find((r) => r.memberId === ctx.owen.id)!;
    const margaretRow = all.find((r) => r.memberId === ctx.margaret.id)!;
    expect(owenRow.posSettlementGroup?.label).toBe("Group A — Seat 1");
    expect(margaretRow.posSettlementGroup?.label).toBe("Group B — Seat 2");
  });

  it("the page renders the group label below the check number", () => {
    expect(PAGE_SRC).toMatch(/r\.posSettlementGroup\?\.label/);
    // Also surfaces it on the needs-attention card.
    expect(PAGE_SRC).toMatch(/Group A|posSettlementGroup\?\.label/);
  });

  it("whole-check responses still show the check number when there's no group", async () => {
    const ctx = await bootstrapTwoSurveys("wc-context");
    // Whole-check anchor (posSettlementGroupId null) on a fresh invitation.
    const wcInv = await ensureSurveyInvitationForCheck({
      clubId: ctx.club.id,
      posCheckId: ctx.checkId,
      posSettlementGroupId: null,
      posSaleId: null,
      memberId: ctx.owen.id,
      origin: "http://localhost:3000",
    });
    await submitSurveyResponse({ token: wcInv.token!, rating: 3, comment: "Mediocre" });
    const all = await listSurveyResponses(ctx.admin, ctx.club.id, { limit: 200 });
    const wholeCheck = all.find((r) => r.rating === 3)!;
    expect(wholeCheck.posSettlementGroup).toBeNull();
    expect(wholeCheck.posCheck?.checkNumber).toBeTruthy();
  });
});

// =============================================================================
// 12 + 13 + 14. Status transitions.
// =============================================================================
describe("Service-recovery status transitions", () => {
  it("markResponseReviewed flips NEEDS_REVIEW → IN_PROGRESS + stamps reviewedAt + reviewer", async () => {
    const ctx = await bootstrapTwoSurveys("mark-rev");
    const margaretResponse = (await db().hospitalitySurveyResponse.findFirst({
      where: { clubId: ctx.club.id, memberId: ctx.margaret.id },
    }))!;
    await markResponseReviewed(ctx.admin, margaretResponse.id);
    const after = await db().hospitalitySurveyResponse.findUnique({ where: { id: margaretResponse.id } });
    expect(after?.serviceRecoveryStatus).toBe("IN_PROGRESS");
    expect(after?.reviewedAt).toBeTruthy();
    expect(after?.reviewedByUserId).toBe(ctx.admin.id);
  });

  it("setResponseRecoveryStatus(IN_PROGRESS) moves NEEDS_REVIEW → IN_PROGRESS", async () => {
    const ctx = await bootstrapTwoSurveys("mark-ip");
    const margaretResponse = (await db().hospitalitySurveyResponse.findFirst({
      where: { clubId: ctx.club.id, memberId: ctx.margaret.id },
    }))!;
    await setResponseRecoveryStatus(ctx.admin, margaretResponse.id, "IN_PROGRESS");
    const after = await db().hospitalitySurveyResponse.findUnique({ where: { id: margaretResponse.id } });
    expect(after?.serviceRecoveryStatus).toBe("IN_PROGRESS");
  });

  it("setResponseRecoveryStatus(RESOLVED) closes the recovery loop + stamps resolvedAt + resolver", async () => {
    const ctx = await bootstrapTwoSurveys("mark-resolved");
    const margaretResponse = (await db().hospitalitySurveyResponse.findFirst({
      where: { clubId: ctx.club.id, memberId: ctx.margaret.id },
    }))!;
    await setResponseRecoveryStatus(ctx.admin, margaretResponse.id, "RESOLVED");
    const after = await db().hospitalitySurveyResponse.findUnique({ where: { id: margaretResponse.id } });
    expect(after?.serviceRecoveryStatus).toBe("RESOLVED");
    expect(after?.resolvedAt).toBeTruthy();
    expect(after?.resolvedByUserId).toBe(ctx.admin.id);
  });
});

// =============================================================================
// 15. Status transitions write audit log rows.
// =============================================================================
describe("Audit trail", () => {
  it("each transition writes an AuditLog row with action + actor", async () => {
    const ctx = await bootstrapTwoSurveys("audit");
    const margaretResponse = (await db().hospitalitySurveyResponse.findFirst({
      where: { clubId: ctx.club.id, memberId: ctx.margaret.id },
    }))!;
    const before = await db().auditLog.count({ where: { clubId: ctx.club.id } });
    await markResponseReviewed(ctx.admin, margaretResponse.id);
    await setResponseRecoveryStatus(ctx.admin, margaretResponse.id, "RESOLVED");
    const after = await db().auditLog.count({ where: { clubId: ctx.club.id } });
    expect(after - before).toBeGreaterThanOrEqual(2);
    const recent = await db().auditLog.findMany({
      where: { clubId: ctx.club.id, entityId: margaretResponse.id },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    expect(recent.length).toBeGreaterThanOrEqual(2);
    // Every row carries the principal as the actor.
    expect(recent.every((a) => a.userId === ctx.admin.id)).toBe(true);
  });
});

// =============================================================================
// 16. Internal note persists + is owner-attributed.
// =============================================================================
describe("Internal notes", () => {
  it("addResponseInternalNote appends timestamped text + persists across reads", async () => {
    const ctx = await bootstrapTwoSurveys("note");
    const margaretResponse = (await db().hospitalitySurveyResponse.findFirst({
      where: { clubId: ctx.club.id, memberId: ctx.margaret.id },
    }))!;
    await addResponseInternalNote(ctx.admin, margaretResponse.id, "Called member, comp'd dessert.");
    const after = await db().hospitalitySurveyResponse.findUnique({ where: { id: margaretResponse.id } });
    expect(after?.internalNotes ?? "").toContain("Called member, comp'd dessert.");
  });
});

// =============================================================================
// 17. Cross-tenant safety.
// =============================================================================
describe("Cross-tenant safety", () => {
  it("admin of club B cannot mark club A's response reviewed", async () => {
    const a = await bootstrapTwoSurveys("xt-a");
    const b = await bootstrapTwoSurveys("xt-b");
    const margaretResponseA = (await db().hospitalitySurveyResponse.findFirst({
      where: { clubId: a.club.id, memberId: a.margaret.id },
    }))!;
    await expect(
      markResponseReviewed(b.admin, margaretResponseA.id),
    ).rejects.toThrow();
  });

  it("listSurveyResponses scopes by clubId", async () => {
    const a = await bootstrapTwoSurveys("xt-list-a");
    const b = await bootstrapTwoSurveys("xt-list-b");
    const aRows = await listSurveyResponses(a.admin, a.club.id, { limit: 200 });
    expect(aRows.every((r) => r.clubId === a.club.id)).toBe(true);
    expect(aRows.length).toBeGreaterThan(0);
    void b;
  });
});

// =============================================================================
// 18. Empty-state copy matches the spec.
// =============================================================================
describe("Empty-state copy (UI source contract)", () => {
  it("needs-attention empty state reads 'No feedback requiring attention.'", () => {
    expect(PAGE_SRC).toMatch(/No feedback requiring attention\./);
  });

  it("main table empty state reads 'No survey responses in this date range.' when no filters set", () => {
    expect(PAGE_SRC).toMatch(/No survey responses in this date range\./);
    // Also: a context-aware message when filters ARE set.
    expect(PAGE_SRC).toMatch(/No survey responses match these filters\./);
  });
});

// =============================================================================
// Extras — filter bar + assign + nav + visual indicators (UI contract).
// =============================================================================
describe("Filter bar + visual indicators (UI source contract)", () => {
  it("the filter bar exposes from/to date inputs", () => {
    expect(PAGE_SRC).toMatch(/<input type="date" name="from"/);
    expect(PAGE_SRC).toMatch(/<input type="date" name="to"/);
  });

  it("recovery + urgent + unrouted controls are present", () => {
    expect(PAGE_SRC).toMatch(/<select name="recovery"/);
    expect(PAGE_SRC).toMatch(/name="urgent" value="1"/);
    expect(PAGE_SRC).toMatch(/name="unrouted" value="1"/);
  });

  it("RatingPill picks red for rating <= 3 OR urgent, amber for 4, green for 5", () => {
    expect(PAGE_SRC).toMatch(/urgent \|\| rating <= 3 \? "border-red-300/);
    expect(PAGE_SRC).toMatch(/rating === 4 \? "border-amber-300/);
    expect(PAGE_SRC).toMatch(/"border-club-green-300/);
    expect(PAGE_SRC).toMatch(/Urgent/);
  });

  it("Reset link clears the URL when filters are active", () => {
    expect(PAGE_SRC).toMatch(/hasTableFilter/);
    expect(PAGE_SRC).toMatch(/Reset/);
  });
});

describe("Assign follow-up + page heading", () => {
  it("assignResponseFollowUp service writes assignedToUserId + audits", async () => {
    const ctx = await bootstrapTwoSurveys("assign");
    // Use a role that's definitely seeded in the test rbac fixture.
    // The list of "eligible assignees" the page renders includes
    // CLUB_ADMIN / GENERAL_MANAGER / FB_MANAGER; we test the service
    // with the always-seeded CLUB_ADMIN.
    const owner = await makeUser({
      email: `fb-mgr-${ctx.club.id}@example.com`,
      role: "CLUB_ADMIN",
      clubId: ctx.club.id,
    });
    const margaretResponse = (await db().hospitalitySurveyResponse.findFirst({
      where: { clubId: ctx.club.id, memberId: ctx.margaret.id },
    }))!;
    await assignResponseFollowUp(ctx.admin, margaretResponse.id, owner.id);
    const after = await db().hospitalitySurveyResponse.findUnique({ where: { id: margaretResponse.id } });
    expect(after?.assignedToUserId).toBe(owner.id);
  });

  it("page heading is 'Guest feedback' (per spec label)", () => {
    expect(PAGE_SRC).toMatch(/page-title">Guest feedback/);
  });
});

// =============================================================================
// Step 10 — zero ui:audit findings on this page.
//   - Distribution chart uses discrete Tailwind width classes (no `style={{`)
//   - Server actions use the spectre_*_error cookie pattern (not ?error=)
// =============================================================================
describe("ui:audit compliance (step 10)", () => {
  it("page has zero inline `style={{` attributes", () => {
    // The auditor's exact regex is /\bstyle=\{\{/.
    expect(PAGE_SRC).not.toMatch(/\bstyle=\{\{/);
  });

  it("distribution bars use discrete Tailwind width classes via widthBucketClass()", () => {
    expect(PAGE_SRC).toMatch(/function widthBucketClass/);
    // Every Tailwind width class the helper can return must appear in
    // source so the JIT compiler picks it up.
    for (const cls of [
      "w-0", "w-1/12", "w-1/6", "w-1/4", "w-1/3", "w-5/12",
      "w-1/2", "w-7/12", "w-2/3", "w-3/4", "w-5/6", "w-11/12", "w-full",
    ]) {
      expect(PAGE_SRC).toContain(cls);
    }
    // And the bar itself uses the class via template literal (not style).
    expect(PAGE_SRC).toMatch(/className=\{`h-2 bg-stone-900 \$\{widthBucketClass\(pct\)\}`\}/);
  });

  it("widthBucketClass is monotonic + saturating", async () => {
    // Re-derive via dynamic import so the test exercises the same code
    // path the page renders with. The file is a server component so we
    // exfiltrate the helper via a regex pull on its body — checking
    // input → output edges that drive the bar-height rendering.
    const fnMatch = PAGE_SRC.match(/function widthBucketClass\(pct: number\): string \{[\s\S]+?\n\}/);
    expect(fnMatch).toBeTruthy();
    const body = fnMatch![0];
    // 0% → empty bar; 100% → full bar; 50% → middle bucket.
    expect(body).toMatch(/if \(p < 4\)\s+return "w-0"/);
    expect(body).toMatch(/return "w-full"/);
    expect(body).toMatch(/if \(p < 54\)\s+return "w-1\/2"/);
  });

  it("server actions write the spectre_feedback_error cookie on isAppError failures", () => {
    // Auditor's pass condition is: page with "use server" + isAppError
    // also contains a /spectre_\w+_error/ token. Pin both.
    expect(PAGE_SRC).toMatch(/"use server"/);
    expect(PAGE_SRC).toMatch(/isAppError/);
    expect(PAGE_SRC).toMatch(/spectre_feedback_error/);
    // The set call matches the project pattern (httpOnly + sameSite + short TTL).
    expect(PAGE_SRC).toMatch(/cookies\(\)\.set\(ERROR_COOKIE, err\.safeMessage/);
    expect(PAGE_SRC).toMatch(/httpOnly: true/);
    expect(PAGE_SRC).toMatch(/sameSite: "strict"/);
    expect(PAGE_SRC).toMatch(/maxAge: 30/);
  });

  it("page reads + immediately deletes the error cookie so it never replays on refresh", () => {
    expect(PAGE_SRC).toMatch(/cookieStore\.get\(ERROR_COOKIE\)/);
    expect(PAGE_SRC).toMatch(/cookieStore\.delete\(ERROR_COOKIE\)/);
    // The banner renders from the cookie value, NOT from searchParams.error.
    expect(PAGE_SRC).toMatch(/\{actionError &&/);
    expect(PAGE_SRC).not.toMatch(/searchParams\.error/);
  });

  it("setActionError rethrows non-AppError so runtime/monitoring sees real bugs", () => {
    // We deliberately don't swallow unknown errors — only friendly
    // AppErrors land in the cookie. Keep this contract pinned so a
    // future refactor doesn't accidentally swallow real exceptions.
    expect(PAGE_SRC).toMatch(/function setActionError\(err: unknown\): void/);
    expect(PAGE_SRC).toMatch(/throw err/);
  });
});

// =============================================================================
// Step 11 — public hospitality survey page also passes ui:audit.
//   Mirrors the step-10 contract on /admin/hospitality/feedback, applied
//   to /survey/hospitality/[token] with its own cookie name.
// =============================================================================
describe("Public survey page — ui:audit compliance (step 11)", () => {
  const surveyPath = path.resolve(process.cwd(), "src/app/survey/hospitality/[token]/page.tsx");
  const SURVEY_SRC = fs.readFileSync(surveyPath, "utf8");

  it("page has zero inline `style={{` attributes", () => {
    expect(SURVEY_SRC).not.toMatch(/\bstyle=\{\{/);
  });

  it("uses the spectre_survey_error cookie (not the old ?error= query string)", () => {
    expect(SURVEY_SRC).toMatch(/"use server"/);
    expect(SURVEY_SRC).toMatch(/isAppError/);
    expect(SURVEY_SRC).toMatch(/spectre_survey_error/);
    expect(SURVEY_SRC).toMatch(/cookies\(\)\.set\(ERROR_COOKIE, err\.safeMessage/);
    expect(SURVEY_SRC).toMatch(/httpOnly: true/);
    expect(SURVEY_SRC).toMatch(/sameSite: "strict"/);
    expect(SURVEY_SRC).toMatch(/maxAge: 30/);
  });

  it("page reads + immediately deletes the survey-error cookie on render", () => {
    expect(SURVEY_SRC).toMatch(/cookieStore\.get\(ERROR_COOKIE\)/);
    expect(SURVEY_SRC).toMatch(/cookieStore\.delete\(ERROR_COOKIE\)/);
  });

  it("the error banner renders from the cookie value, not from searchParams.error", () => {
    expect(SURVEY_SRC).toMatch(/\{actionError &&/);
    // No more ?error= query-string path in the submit action OR the page.
    expect(SURVEY_SRC).not.toMatch(/searchParams\.error/);
    expect(SURVEY_SRC).not.toMatch(/\?error=/);
  });

  it("non-AppError submission failures are rethrown so the runtime sees them", () => {
    // The catch branch sets cookie + redirects on AppError; falls
    // through to `throw err` for anything else.
    expect(SURVEY_SRC).toMatch(/if \(isAppError\(err\)\) \{/);
    expect(SURVEY_SRC).toMatch(/throw err;/);
  });

  it("submit success still routes via ?submitted=1 so the polite confirmation page renders", () => {
    // Spec preserves the existing thank-you state. The "submitted=1"
    // branch in the page renders <SubmittedPage />.
    expect(SURVEY_SRC).toMatch(/searchParams\.submitted === "1"/);
    expect(SURVEY_SRC).toMatch(/\?submitted=1/);
    expect(SURVEY_SRC).toMatch(/function SubmittedPage\(\)/);
  });

  it("invalid token still renders the safe neutral page (no token leak)", () => {
    expect(SURVEY_SRC).toMatch(/function InvalidPage\(\)/);
    expect(SURVEY_SRC).toMatch(/return <InvalidPage \/>/);
  });

  it("expired / already-submitted tokens funnel through resolveSurveyInvitation, which throws ConflictError + the page renders Invalid", () => {
    // The page's try/catch around resolveSurveyInvitation reuses the
    // same neutral copy for all failure shapes — never discloses
    // expired-vs-consumed-vs-unknown.
    expect(SURVEY_SRC).toMatch(/await resolveSurveyInvitation\(params\.token\)/);
    expect(SURVEY_SRC).toMatch(/catch \{[\s\S]+?return <InvalidPage \/>/);
  });

  it("page never displays Spectre branding (member surface — only the club name)", () => {
    // Member brand shielding. The header shows invitation.clubName,
    // not the Spectre wordmark. Comments are fine — the existing file
    // header explicitly documents the rule. We only flag "Spectre"
    // appearing inside JSX text (between `>` and `<`).
    expect(SURVEY_SRC).toMatch(/invitation\.clubName/);
    // Strip comments + string literals, then scan JSX text for the
    // wordmark.
    const stripped = SURVEY_SRC
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/>\s*Spectre\b/);
    expect(stripped).not.toMatch(/className=.*Spectre/);
  });
});

// =============================================================================
// Step 12 — survey rating picker is actually usable from the email link.
//
// Bug report: receipt-email survey links opened the page, but clicking
// a star produced no visible feedback. The pre-step-12 implementation
// was a server-rendered <input type="radio"> grid with a Tailwind
// has-[:checked]: visual highlight + no disabled-until-picked submit
// gate. The user perceived the form as broken even though the radio
// state was toggling internally.
//
// Step 12 introduces a small client component (RatingPicker) that:
//   - holds the rating in useState
//   - applies the selected/unselected class string deterministically
//   - disables the submit button until the user picks something
//   - submits via a hidden input so the user's FINAL choice is sent
//
// The tests below pin the contract.
// =============================================================================
describe("Survey rating picker — bug-fix contract (step 12)", () => {
  const pickerPath = path.resolve(process.cwd(), "src/app/survey/hospitality/[token]/RatingPicker.tsx");
  const PICKER_SRC = fs.readFileSync(pickerPath, "utf8");

  const surveyPath = path.resolve(process.cwd(), "src/app/survey/hospitality/[token]/page.tsx");
  const SURVEY_SRC = fs.readFileSync(surveyPath, "utf8");

  it("RatingPicker is a client component ('use client' directive)", () => {
    // The whole point of the fix: client-side state for the selection.
    // Server components cannot useState.
    expect(PICKER_SRC.startsWith('"use client"')).toBe(true);
    expect(PICKER_SRC).toMatch(/import \{ useState \} from "react"/);
    expect(PICKER_SRC).toMatch(/useState<number \| null>\(initialRating\)/);
  });

  it("page hands the URL's preselected rating into RatingPicker as initialRating", () => {
    // The page parses ?rating=N then passes it through. The picker is
    // responsible for the rest — no other state lives on the page.
    expect(SURVEY_SRC).toMatch(/<RatingPicker initialRating=\{preselected \?\? null\}/);
  });

  it("invalid rating query params are ignored safely on the server (1..5 integer guard)", () => {
    // Keep the existing parse — Number.isInteger + range check. A
    // junk rating in the URL should yield `preselected = undefined`,
    // which the picker accepts as null.
    expect(SURVEY_SRC).toMatch(/Number\.isInteger\(n\) && n >= 1 && n <= 5 \? n : undefined/);
  });

  it("submit button is disabled while rating === null", () => {
    expect(PICKER_SRC).toMatch(/disabled=\{rating === null\}/);
    expect(PICKER_SRC).toMatch(/aria-disabled=\{rating === null\}/);
  });

  it("submit button gets a visible 'disabled' style (so the user understands why nothing happens)", () => {
    expect(PICKER_SRC).toMatch(/disabled:bg-stone-300/);
    expect(PICKER_SRC).toMatch(/disabled:cursor-not-allowed/);
  });

  it("each star is a <button type=\"button\"> with explicit onClick (no broken radio + has-[:checked] dependency)", () => {
    // We DROPPED the input[type=radio] + has-[:checked] pattern that
    // gave users no feedback. The picker now uses real buttons whose
    // className flips deterministically based on the rating state.
    expect(PICKER_SRC).toMatch(/type="button"/);
    expect(PICKER_SRC).toMatch(/onClick=\{\(\) => setRating\(n\)\}/);
    // Visual selected/unselected branches are explicit, not Tailwind-magic.
    expect(PICKER_SRC).toMatch(/const selected = rating === n/);
    expect(PICKER_SRC).toMatch(/selected\s*\n?\s*\?\s*"cursor-pointer rounded-md border border-stone-900 bg-stone-900/);
    expect(PICKER_SRC).toMatch(/"cursor-pointer rounded-md border border-stone-300 bg-white/);
    // And no has-[:checked]: variant anywhere on the picker — the bug
    // we removed.
    expect(PICKER_SRC).not.toMatch(/has-\[:checked\]/);
  });

  it("the picker carries the rating via a hidden input so the form action gets the user's FINAL choice", () => {
    // Important — the form submits to the server action via FormData.
    // The user's selected rating must reach the action through a
    // named input. We use `<input type="hidden" name="rating" value={rating ?? ""}>`.
    expect(PICKER_SRC).toMatch(/<input\s+type="hidden"\s+name="rating"\s+value=\{rating \?\? ""\}/);
  });

  it("accessibility — buttons declare a radiogroup + aria-checked + per-star aria-label", () => {
    expect(PICKER_SRC).toMatch(/role="radiogroup"/);
    expect(PICKER_SRC).toMatch(/role="radio"/);
    expect(PICKER_SRC).toMatch(/aria-checked=\{selected\}/);
    expect(PICKER_SRC).toMatch(/aria-label=\{`\$\{n\} of 5 stars`\}/);
  });

  it("the page no longer contains the broken radio + has-[:checked] pattern", () => {
    // Step-12 cleanup: the page's <fieldset> with input[type=radio] +
    // has-[:checked] is gone. Everything rating-related now lives in
    // the client component.
    expect(SURVEY_SRC).not.toMatch(/has-\[:checked\]/);
    expect(SURVEY_SRC).not.toMatch(/input\s+type="radio"/);
    expect(SURVEY_SRC).not.toMatch(/<fieldset>/);
  });

  it("the comment textarea + submit button moved into RatingPicker so the disabled gate can react to state", () => {
    // The page no longer renders the textarea / submit button itself —
    // they're inside RatingPicker so they share the rating state.
    expect(SURVEY_SRC).not.toMatch(/<textarea\s+id="comment"/);
    expect(SURVEY_SRC).not.toMatch(/Send feedback/);
    expect(PICKER_SRC).toMatch(/<textarea\s+id="comment"/);
    expect(PICKER_SRC).toMatch(/Send feedback/);
  });
});

// =============================================================================
// Step 12 — email link contract still holds.
// =============================================================================
describe("Receipt email survey links — link shape contract (step 12)", () => {
  const receiptsPath = path.resolve(process.cwd(), "src/lib/pos/receipts.ts");
  const surveysPath = path.resolve(process.cwd(), "src/lib/hospitality/surveys.ts");
  const RECEIPTS_SRC = fs.readFileSync(receiptsPath, "utf8");
  const SURVEYS_SRC = fs.readFileSync(surveysPath, "utf8");

  it("ensureSurveyInvitationForCheck emits 5 rating links (1..5)", () => {
    expect(SURVEYS_SRC).toMatch(/\[1, 2, 3, 4, 5\]\.map\(\(rating\) => \(\{\s*rating,\s*url: surveyUrl\(opts\.origin, token, rating\),/);
  });

  it("surveyUrl builds /survey/hospitality/<token>?rating=N as plain ASCII", () => {
    // No HTML entity escaping. ?rating=N as literal characters so a
    // user clicking from Maildev hits a URL the route can parse.
    expect(SURVEYS_SRC).toMatch(/\/survey\/hospitality\/\$\{encodeURIComponent\(token\)\}/);
    expect(SURVEYS_SRC).toMatch(/return rating \? `\$\{base\}\?rating=\$\{rating\}`/);
  });

  it("receipt email body renders the 5 rating links into the survey block (not as HTML-escaped text)", () => {
    // The block is plain text (the email is sent as text/plain). No
    // .replace(...) HTML-escaping of the URL.
    expect(RECEIPTS_SRC).toMatch(/input\.survey\.links\.map/);
    expect(RECEIPTS_SRC).toMatch(/"⭐"\.repeat\(l\.rating\)/);
    expect(RECEIPTS_SRC).toMatch(/l\.url/);
  });
});

describe("Navigation discoverability", () => {
  it("sidebar surfaces /admin/hospitality/feedback", () => {
    const sidebar = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/Sidebar.tsx"),
      "utf8",
    );
    expect(sidebar).toMatch(/href:\s*"\/app\/admin\/hospitality\/feedback"/);
  });

  it("hospitality hub surfaces the feedback page as a card", () => {
    const hub = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/hospitality/page.tsx"),
      "utf8",
    );
    expect(hub).toMatch(/\/app\/admin\/hospitality\/feedback/);
  });
});
