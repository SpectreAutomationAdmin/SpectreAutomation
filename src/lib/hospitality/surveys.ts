// Hospitality feedback workflow — POS receipt-driven member surveys.
//
// Lifecycle
// ---------
//   1. settleCheck / confirmQRPayment trigger the receipt email; the
//      receipts service calls `ensureSurveyInvitationForCheck()` once
//      per check so resends reuse the same token.
//   2. The receipt body embeds five rating links of the form
//      /survey/hospitality/{token}?rating=N. Members click without
//      logging in.
//   3. The public page calls `resolveSurveyInvitation(token)` to
//      validate (not expired, not consumed, not cancelled) and render.
//   4. Submission calls `submitSurveyResponse(...)` which persists the
//      response, marks the invitation RESPONDED, and routes a
//      department-head notification for any rating < threshold.
//   5. Anything <= 2 is also flagged `urgent` for service recovery.
//
// Tokens are random 24-byte base64url strings. Only the SHA-256 hash
// is persisted, so a DB read never reveals an outstanding token.

import crypto from "node:crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { NotFoundError, ValidationError, ConflictError } from "../errors";
import { selectEmailAdapter } from "../integrations/email";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const FOOD_BEVERAGE_DEPT_KEY = "FOOD_BEVERAGE";
export const FOOD_BEVERAGE_DEPT_NAME = "Food & Beverage / Clubhouse";

// Invitations expire after 14 days. Long enough that a member who
// forgets the email until the following weekend can still respond;
// short enough that the data stays current.
const INVITATION_TTL_DAYS = 14;

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------
function generateToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
export function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(ip).digest("hex");
}

function surveyUrl(origin: string, token: string, rating?: number): string {
  const base = `${origin.replace(/\/$/, "")}/survey/hospitality/${encodeURIComponent(token)}`;
  return rating ? `${base}?rating=${rating}` : base;
}

// ---------------------------------------------------------------------------
// Create / reuse an invitation for a settled check.
// Idempotent — settling and then resending the receipt does NOT create
// a second invitation; the same token + URL goes in every email.
// ---------------------------------------------------------------------------
export async function ensureSurveyInvitationForCheck(opts: {
  clubId: string;
  // Nullable for unit testing only — production callers always supply
  // a real POSCheck row id. When null, dedupe-by-check can't apply, so
  // a fresh invitation is created on every call.
  posCheckId: string | null;
  posSaleId: string | null;
  memberId: string | null;
  // Step 8 — split-bill anchor. When set, the invitation is dedup'd by
  // (clubId, posSettlementGroupId) so each settlement group gets its
  // own survey + token. When null (whole-check / merge-all), dedup
  // falls back to (clubId, posCheckId, posSettlementGroupId IS NULL).
  posSettlementGroupId?: string | null;
  origin: string;
  departmentKey?: string;
}): Promise<{
  invitationId: string;
  token: string | null;
  surveyLinks: { rating: number; url: string }[];
  surveyOverviewUrl: string | null;
  expiresAt: Date;
}> {
  // Already created? Reuse it. We can't recover the raw token from a
  // hash, so on reuse we surface the existing invitation without
  // re-rendering rating links into the email. That's fine for resends
  // because the original email already contains the working token; the
  // resend body just keeps the survey overview link.
  //
  // Idempotency keys (both enforced at the app layer because composite
  // unique constraints with nullable columns treat NULLs as distinct):
  //   - split-bill: (clubId, posSettlementGroupId) [also DB-level unique]
  //   - whole-check: (clubId, posCheckId, posSettlementGroupId IS NULL)
  let existing = null as Awaited<ReturnType<typeof prisma.hospitalitySurveyInvitation.findFirst>>;
  if (opts.posSettlementGroupId) {
    existing = await prisma.hospitalitySurveyInvitation.findFirst({
      where: { clubId: opts.clubId, posSettlementGroupId: opts.posSettlementGroupId },
    });
  } else if (opts.posCheckId) {
    existing = await prisma.hospitalitySurveyInvitation.findFirst({
      where: {
        clubId: opts.clubId,
        posCheckId: opts.posCheckId,
        posSettlementGroupId: null,
      },
    });
  }
  if (existing) {
    return {
      invitationId: existing.id,
      token: null,
      surveyLinks: [],
      surveyOverviewUrl: null,
      expiresAt: existing.expiresAt,
    };
  }

  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const invitation = await prisma.hospitalitySurveyInvitation.create({
    data: {
      clubId: opts.clubId,
      posCheckId: opts.posCheckId,
      posSaleId: opts.posSaleId,
      posSettlementGroupId: opts.posSettlementGroupId ?? null,
      memberId: opts.memberId,
      departmentKey: opts.departmentKey ?? FOOD_BEVERAGE_DEPT_KEY,
      tokenHash,
      expiresAt,
      status: "SENT",
    },
  });

  return {
    invitationId: invitation.id,
    token,
    surveyLinks: [1, 2, 3, 4, 5].map((rating) => ({
      rating,
      url: surveyUrl(opts.origin, token, rating),
    })),
    surveyOverviewUrl: surveyUrl(opts.origin, token),
    expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Public token resolver — called by the survey page and submit action.
// Returns the live invitation OR throws with a generic "invalid" reason
// so we don't leak whether the token is unknown vs expired.
// ---------------------------------------------------------------------------
export type ResolvedSurveyInvitation = {
  id: string;
  clubId: string;
  clubName: string;
  memberFirstName: string | null;
  posSaleId: string | null;
  posCheckNumber: string | null;
  departmentKey: string;
  expiresAt: Date;
  status: string;
};

export async function resolveSurveyInvitation(token: string): Promise<ResolvedSurveyInvitation> {
  if (!token || token.length < 16) throw new NotFoundError("HospitalitySurveyInvitation", "token");
  const tokenHash = hashToken(token);
  const inv = await prisma.hospitalitySurveyInvitation.findUnique({
    where: { tokenHash },
    include: {
      club: { select: { name: true } },
      member: { select: { firstName: true } },
      posCheck: { select: { checkNumber: true } },
    },
  });
  if (!inv) throw new NotFoundError("HospitalitySurveyInvitation", "token");
  if (inv.status === "RESPONDED") {
    throw new ConflictError("This survey has already been submitted.");
  }
  if (inv.status === "CANCELLED" || inv.status === "EXPIRED") {
    throw new ConflictError("This survey is no longer available.");
  }
  if (inv.expiresAt.getTime() < Date.now()) {
    // Lazily promote to EXPIRED so future hits short-circuit.
    await prisma.hospitalitySurveyInvitation.update({
      where: { id: inv.id },
      data: { status: "EXPIRED" },
    });
    throw new ConflictError("This survey link has expired.");
  }
  return {
    id: inv.id,
    clubId: inv.clubId,
    clubName: inv.club.name,
    memberFirstName: inv.member?.firstName ?? null,
    posSaleId: inv.posSaleId,
    posCheckNumber: inv.posCheck?.checkNumber ?? null,
    departmentKey: inv.departmentKey,
    expiresAt: inv.expiresAt,
    status: inv.status,
  };
}

export async function markSurveyInvitationOpened(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await prisma.hospitalitySurveyInvitation.updateMany({
    where: { tokenHash, status: "SENT" },
    data: { status: "OPENED" },
  });
}

// ---------------------------------------------------------------------------
// Submit a response. One per invitation; escalation happens here.
// ---------------------------------------------------------------------------
export type SubmitResult = {
  responseId: string;
  rating: number;
  urgent: boolean;
  escalated: boolean;
  notificationRouted: boolean;
  notificationFailure: string | null;
};

export async function submitSurveyResponse(opts: {
  token: string;
  rating: number;
  comment?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
}): Promise<SubmitResult> {
  if (!Number.isInteger(opts.rating) || opts.rating < 1 || opts.rating > 5) {
    throw new ValidationError([{ path: "rating", message: "Rating must be an integer 1-5." }]);
  }
  const comment = opts.comment?.trim() ? opts.comment.trim().slice(0, 2000) : null;
  const invitation = await resolveSurveyInvitation(opts.token);

  // Read the full row (resolveSurveyInvitation projects a subset).
  const full = await prisma.hospitalitySurveyInvitation.findUnique({
    where: { id: invitation.id },
  });
  if (!full) throw new NotFoundError("HospitalitySurveyInvitation", invitation.id);

  // Atomically claim the invitation. Anything other than SENT / OPENED
  // at this point means it was just consumed in a concurrent submit.
  const claim = await prisma.hospitalitySurveyInvitation.updateMany({
    where: { id: full.id, status: { in: ["SENT", "OPENED"] } },
    data: { status: "RESPONDED", respondedAt: new Date() },
  });
  if (claim.count === 0) {
    throw new ConflictError("This survey has already been submitted.");
  }

  // 5/5 ratings need no escalation. Anything below the configured
  // threshold (default 5) triggers a notification. <=2 is "urgent".
  const rule = await getActiveDepartmentRule(full.clubId, full.departmentKey);
  const threshold = rule?.thresholdRating ?? 5;
  const needsEscalation = opts.rating < threshold;
  const urgent = opts.rating <= 2;
  const recoveryStatus = needsEscalation ? "NEEDS_REVIEW" : "NONE";

  const response = await prisma.hospitalitySurveyResponse.create({
    data: {
      clubId: full.clubId,
      invitationId: full.id,
      memberId: full.memberId,
      posCheckId: full.posCheckId,
      posSaleId: full.posSaleId,
      // Split-bill anchor copied from the invitation so dashboards can
      // aggregate by settlement group without re-joining through the
      // invitation row.
      posSettlementGroupId: full.posSettlementGroupId,
      departmentKey: full.departmentKey,
      rating: opts.rating,
      comment,
      ipHash: opts.ipHash ?? null,
      userAgent: opts.userAgent?.slice(0, 300) ?? null,
      serviceRecoveryStatus: recoveryStatus,
      urgent,
    },
  });

  let notificationRouted = false;
  let notificationFailure: string | null = null;
  if (needsEscalation) {
    const escalation = await routeDepartmentEscalation({
      clubId: full.clubId,
      responseId: response.id,
      rule,
      rating: opts.rating,
      urgent,
      comment,
    });
    notificationRouted = escalation.routed;
    notificationFailure = escalation.failure;
    await prisma.hospitalitySurveyResponse.update({
      where: { id: response.id },
      data: { notificationRouted, notificationFailure },
    });
  }

  return {
    responseId: response.id,
    rating: opts.rating,
    urgent,
    escalated: needsEscalation,
    notificationRouted,
    notificationFailure,
  };
}

// ---------------------------------------------------------------------------
// Department-head routing.
// ---------------------------------------------------------------------------
async function getActiveDepartmentRule(clubId: string, departmentKey: string) {
  return prisma.departmentNotificationRule.findFirst({
    where: { clubId, departmentKey, active: true },
  });
}

type RouteResult = { routed: boolean; failure: string | null };

async function routeDepartmentEscalation(opts: {
  clubId: string;
  responseId: string;
  rule: Awaited<ReturnType<typeof getActiveDepartmentRule>>;
  rating: number;
  urgent: boolean;
  comment: string | null;
}): Promise<RouteResult> {
  // Pull the full context so the notification message is useful.
  const response = await prisma.hospitalitySurveyResponse.findUnique({
    where: { id: opts.responseId },
    include: {
      member: { select: { firstName: true, lastName: true } },
      posCheck: { select: { checkNumber: true, closedAt: true } },
      posSale: {
        select: {
          saleNumber: true,
          grandTotal: true,
          saleDate: true,
          createdByUserId: true,
          location: { select: { name: true } },
        },
      },
      club: { select: { name: true } },
    },
  });
  if (!response) return { routed: false, failure: "Response not found" };

  const memberName = response.member ? `${response.member.firstName} ${response.member.lastName}` : "A member";
  const location = response.posSale?.location?.name ?? "the lounge";
  const checkLabel = response.posCheck?.checkNumber
    ? `check ${response.posCheck.checkNumber}`
    : response.posSale?.saleNumber
      ? `sale ${response.posSale.saleNumber}`
      : "their visit";
  const amount = response.posSale ? Number(response.posSale.grandTotal.toString()) : null;

  let serverName: string | null = null;
  if (response.posSale?.createdByUserId) {
    const u = await prisma.user.findUnique({
      where: { id: response.posSale.createdByUserId },
      select: { name: true, email: true },
    });
    serverName = u?.name ?? u?.email ?? null;
  }

  const urgencyTag = opts.urgent ? "[URGENT service recovery] " : "";
  const subject = `${urgencyTag}${opts.rating}/5 member feedback — ${location}`;
  const body = [
    `${memberName} submitted a ${opts.rating}/5 rating for ${location}.`,
    ``,
    `${checkLabel}${response.posCheck?.closedAt ? ` · closed ${response.posCheck.closedAt.toISOString().slice(0, 16).replace("T", " ")}` : ""}${amount !== null ? ` · $${amount.toFixed(2)}` : ""}${serverName ? ` · server: ${serverName}` : ""}`,
    ``,
    opts.comment ? `Comment:` : `(no comment left)`,
    opts.comment ? `  "${opts.comment}"` : ``,
    ``,
    `Review in Spectre: /app/admin/hospitality/feedback?focus=${response.id}`,
    ``,
    `Please follow up with the member directly. Mark this entry resolved once the recovery conversation is complete.`,
  ]
    .filter((s) => s !== "")
    .join("\n");

  if (!opts.rule || !opts.rule.active) {
    // Unrouted: still create the in-app Notification so the
    // dashboard can surface it as "Unrouted service feedback".
    await prisma.notification.create({
      data: {
        clubId: opts.clubId,
        toUserId: null,
        toEmail: null,
        channel: "IN_APP",
        subject: "Unrouted service feedback — configure a department head",
        body,
        triggeredEntityType: "HospitalitySurveyResponse",
        triggeredEntityId: opts.responseId,
        priority: opts.urgent ? "URGENT" : "HIGH",
        status: "QUEUED",
      },
    });
    return { routed: false, failure: "No active DepartmentNotificationRule configured" };
  }

  // Persist a Notification row regardless of email outcome so the
  // recipient list can show "you have outstanding service feedback".
  const notif = await prisma.notification.create({
    data: {
      clubId: opts.clubId,
      toUserId: opts.rule.notifyUserId ?? null,
      toEmail: opts.rule.notifyEmail ?? null,
      channel: opts.rule.notifyEmail ? "EMAIL" : "IN_APP",
      subject,
      body,
      triggeredEntityType: "HospitalitySurveyResponse",
      triggeredEntityId: opts.responseId,
      priority: opts.urgent ? "URGENT" : "HIGH",
      status: "QUEUED",
    },
  });

  // If we have an email target, fire the send through the existing
  // email adapter. Failures don't block: the in-app Notification row
  // still exists and the dashboard surfaces unsent escalations.
  if (opts.rule.notifyEmail) {
    try {
      const adapter = await selectEmailAdapter(opts.clubId);
      const send = await adapter.send({
        clubId: opts.clubId,
        channel: "EMAIL",
        to: { email: opts.rule.notifyEmail, userId: opts.rule.notifyUserId ?? null },
        subject,
        body,
      });
      await prisma.notificationDelivery.create({
        data: {
          clubId: opts.clubId,
          notificationId: notif.id,
          channel: "EMAIL",
          status: send.status,
          providerMessageId: send.providerMessageId ?? null,
          failureReason: send.failureReason ?? null,
        },
      });
      if (send.status !== "SENT") {
        await prisma.notification.update({
          where: { id: notif.id },
          data: { status: "FAILED" },
        });
        return { routed: false, failure: send.failureReason ?? "Provider rejected escalation email" };
      }
      await prisma.notification.update({
        where: { id: notif.id },
        data: { status: "SENT" },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await prisma.notification.update({
        where: { id: notif.id },
        data: { status: "FAILED" },
      });
      return { routed: false, failure: reason };
    }
  } else {
    // In-app only: dashboard owns delivery.
    await prisma.notification.update({
      where: { id: notif.id },
      data: { status: "SENT" },
    });
  }
  return { routed: true, failure: null };
}

// ---------------------------------------------------------------------------
// Admin queries.
// ---------------------------------------------------------------------------

export type FeedbackFilter = {
  from?: Date;
  to?: Date;
  recoveryStatus?: "NONE" | "NEEDS_REVIEW" | "IN_PROGRESS" | "RESOLVED";
  rating?: number;
  urgentOnly?: boolean;
  unroutedOnly?: boolean;
  limit?: number;
};

export async function listSurveyResponses(
  principal: Principal,
  clubId: string,
  filter: FeedbackFilter = {},
) {
  requirePermission(principal, clubId, "settings:read");
  const limit = Math.min(filter.limit ?? 200, 500);
  return prisma.hospitalitySurveyResponse.findMany({
    where: {
      clubId,
      ...(filter.from || filter.to
        ? { submittedAt: { gte: filter.from, lt: filter.to } }
        : {}),
      ...(filter.recoveryStatus ? { serviceRecoveryStatus: filter.recoveryStatus } : {}),
      ...(filter.rating ? { rating: filter.rating } : {}),
      ...(filter.urgentOnly ? { urgent: true } : {}),
      ...(filter.unroutedOnly
        ? { notificationRouted: false, serviceRecoveryStatus: { not: "NONE" } }
        : {}),
    },
    include: {
      member: { select: { firstName: true, lastName: true, memberNumber: true, email: true } },
      posCheck: { select: { checkNumber: true, closedAt: true } },
      posSale: { select: { saleNumber: true, grandTotal: true, createdByUserId: true } },
      // Step 9 — surface settlement-group label so the admin page can
      // disambiguate split-bill responses (Owen vs Margaret on the
      // same check). Null on whole-check / merge-all surveys.
      posSettlementGroup: { select: { id: true, label: true } },
    },
    orderBy: { submittedAt: "desc" },
    take: limit,
  });
}

export async function getFeedbackSummary(
  principal: Principal,
  clubId: string,
  windowDays = 30,
) {
  requirePermission(principal, clubId, "settings:read");
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const responses = await prisma.hospitalitySurveyResponse.findMany({
    where: { clubId, submittedAt: { gte: since } },
    select: { rating: true, serviceRecoveryStatus: true, urgent: true, notificationRouted: true },
  });
  const dist: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  for (const r of responses) {
    sum += r.rating;
    if (r.rating >= 1 && r.rating <= 5) dist[r.rating as 1 | 2 | 3 | 4 | 5] += 1;
  }
  const total = responses.length;
  return {
    windowDays,
    total,
    average: total ? sum / total : null,
    distribution: dist,
    belowFive: responses.filter((r) => r.rating < 5).length,
    urgentOpen: responses.filter((r) => r.urgent && r.serviceRecoveryStatus !== "RESOLVED").length,
    unrouted: responses.filter(
      (r) => !r.notificationRouted && r.serviceRecoveryStatus !== "NONE",
    ).length,
    unresolvedRecovery: responses.filter(
      (r) => r.serviceRecoveryStatus !== "NONE" && r.serviceRecoveryStatus !== "RESOLVED",
    ).length,
  };
}

// ---------------------------------------------------------------------------
// Follow-up actions invoked from the admin dashboard.
// ---------------------------------------------------------------------------
async function loadResponseTenantChecked(principal: Principal, responseId: string) {
  const r = await prisma.hospitalitySurveyResponse.findUnique({ where: { id: responseId } });
  assertTenantOwned(r, principal);
  requirePermission(principal, r.clubId, "settings:write");
  return r;
}

export async function markResponseReviewed(principal: Principal, responseId: string) {
  const r = await loadResponseTenantChecked(principal, responseId);
  const updated = await prisma.hospitalitySurveyResponse.update({
    where: { id: r.id },
    data: {
      serviceRecoveryStatus: r.serviceRecoveryStatus === "NONE" ? "NONE" : "IN_PROGRESS",
      reviewedAt: new Date(),
      reviewedByUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "hospitality.feedback.reviewed",
    entityType: "HospitalitySurveyResponse",
    entityId: r.id,
    clubId: r.clubId,
    after: { serviceRecoveryStatus: updated.serviceRecoveryStatus },
  });
  return updated;
}

export async function setResponseRecoveryStatus(
  principal: Principal,
  responseId: string,
  status: "NEEDS_REVIEW" | "IN_PROGRESS" | "RESOLVED",
) {
  const r = await loadResponseTenantChecked(principal, responseId);
  const updated = await prisma.hospitalitySurveyResponse.update({
    where: { id: r.id },
    data: {
      serviceRecoveryStatus: status,
      ...(status === "RESOLVED"
        ? { resolvedAt: new Date(), resolvedByUserId: principal.id }
        : {}),
    },
  });
  await audit(principal, {
    action: `hospitality.feedback.status.${status.toLowerCase()}`,
    entityType: "HospitalitySurveyResponse",
    entityId: r.id,
    clubId: r.clubId,
    before: { serviceRecoveryStatus: r.serviceRecoveryStatus },
    after: { serviceRecoveryStatus: status },
  });
  return updated;
}

export async function assignResponseFollowUp(
  principal: Principal,
  responseId: string,
  assignedToUserId: string | null,
) {
  const r = await loadResponseTenantChecked(principal, responseId);
  const updated = await prisma.hospitalitySurveyResponse.update({
    where: { id: r.id },
    data: { assignedToUserId },
  });
  await audit(principal, {
    action: "hospitality.feedback.assign",
    entityType: "HospitalitySurveyResponse",
    entityId: r.id,
    clubId: r.clubId,
    after: { assignedToUserId },
  });
  return updated;
}

export async function addResponseInternalNote(
  principal: Principal,
  responseId: string,
  note: string,
) {
  const r = await loadResponseTenantChecked(principal, responseId);
  const trimmed = note.trim().slice(0, 4000);
  if (!trimmed) throw new ValidationError([{ path: "note", message: "Note cannot be empty." }]);
  const stamp = `[${new Date().toISOString().slice(0, 16).replace("T", " ")} ${principal.email}]`;
  const merged = r.internalNotes ? `${r.internalNotes}\n\n${stamp} ${trimmed}` : `${stamp} ${trimmed}`;
  const updated = await prisma.hospitalitySurveyResponse.update({
    where: { id: r.id },
    data: { internalNotes: merged },
  });
  await audit(principal, {
    action: "hospitality.feedback.note",
    entityType: "HospitalitySurveyResponse",
    entityId: r.id,
    clubId: r.clubId,
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Department-rule maintenance.
// ---------------------------------------------------------------------------
export async function upsertDepartmentNotificationRule(
  principal: Principal,
  clubId: string,
  opts: {
    departmentKey: string;
    departmentName: string;
    notifyUserId?: string | null;
    notifyEmail?: string | null;
    thresholdRating?: number;
    active?: boolean;
  },
) {
  requirePermission(principal, clubId, "settings:write");
  if (!opts.departmentKey.trim() || !opts.departmentName.trim()) {
    throw new ValidationError([
      { path: "departmentKey", message: "Department key and name are required." },
    ]);
  }
  // One rule per (club, departmentKey). Upsert keeps history simple.
  const rule = await prisma.departmentNotificationRule.upsert({
    where: { clubId_departmentKey: { clubId, departmentKey: opts.departmentKey } },
    create: {
      clubId,
      departmentKey: opts.departmentKey,
      departmentName: opts.departmentName,
      notifyUserId: opts.notifyUserId ?? null,
      notifyEmail: opts.notifyEmail ?? null,
      active: opts.active ?? true,
      thresholdRating: opts.thresholdRating ?? 5,
    },
    update: {
      departmentName: opts.departmentName,
      notifyUserId: opts.notifyUserId ?? null,
      notifyEmail: opts.notifyEmail ?? null,
      active: opts.active ?? true,
      thresholdRating: opts.thresholdRating ?? 5,
    },
  });
  await audit(principal, {
    action: "hospitality.department-rule.upsert",
    entityType: "DepartmentNotificationRule",
    entityId: rule.id,
    clubId,
    after: { departmentKey: rule.departmentKey, departmentName: rule.departmentName, notifyEmail: rule.notifyEmail },
  });
  return rule;
}
