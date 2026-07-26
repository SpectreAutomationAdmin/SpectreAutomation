// Sprint 3 Checkpoint 15B (2026-07-24) — AR intake inline evidence endpoint.
//
// GET /api/mission-control/work-intake/[id]/ar-evidence
//
// Returns the evidence panel data for an AR-derived Work Intake
// situation. READ-ONLY. No writes. No sends. No autonomous
// communication. The response includes:
//
//   - member display name
//   - account aging breakdown (30/60/90/120/current/credit)
//   - last payment (if any)
//   - prior collection notices (bounded, most recent 5)
//   - active findings (from persisted rows)
//   - all superseded + USER_REJECTED findings for audit expansion
//   - the proposed notice template (from the analyser's
//     recommendation), if one exists — text only, no send action
//
// Authorization: session + active club scope + intake must have a
// MEMBER_ACCOUNT PRIMARY origin belonging to the same club.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { readActiveFindings, readAllFindings } from "@/lib/intelligence/persistence";
import { composeArAgingRecommendation } from "@/lib/intelligence/analysers/ar-aging";
import type { FindingInput } from "@/lib/intelligence/types";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });

  const workIntakeItemId = params.id;
  if (!workIntakeItemId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const intake = await prisma.workIntakeItem.findFirst({
    where: { id: workIntakeItemId, clubId },
    select: {
      id: true,
      status: true,
      displaySender: true,
      displaySubject: true,
      lastAnalysedAt: true,
      classification: true,
      origins: { select: { kind: true, referenceId: true, role: true } },
    },
  });
  if (!intake) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Locate the AR account this intake represents.
  const memberAccountOrigin = intake.origins.find(
    (o) => o.kind === "MEMBER_ACCOUNT" && o.role === "PRIMARY",
  );
  if (!memberAccountOrigin) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const account = await prisma.memberAccount.findFirst({
    where: { id: memberAccountOrigin.referenceId, clubId },
    include: {
      member: {
        select: { id: true, firstName: true, lastName: true, memberNumber: true },
      },
    },
  });
  if (!account || !account.member) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const recentPayments = await prisma.payment.findMany({
    where: { clubId, accountId: account.id, status: "SUCCESS" },
    orderBy: { paymentDate: "desc" },
    take: 3,
    select: { id: true, paymentDate: true, amount: true, method: true },
  });

  const recentNotices = await prisma.collectionNotice.findMany({
    where: { clubId, memberId: account.memberId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      noticeType: true,
      stageKey: true,
      status: true,
      sentAt: true,
      createdAt: true,
    },
  });

  const activeFindings = await readActiveFindings(intake.id);
  const allFindings = await readAllFindings(intake.id);
  const supersededFindings = allFindings.filter((f) => f.state === "SUPERSEDED");
  const rejectedFindings = allFindings.filter((f) => f.state === "USER_REJECTED");

  // Reconstruct the recommendation from persisted active findings
  // (matches the loader's derivation path exactly).
  const recommendation = composeArAgingRecommendation(
    activeFindings.map<FindingInput>((f) => ({
      key: f.key,
      statement: f.statement,
      state: f.state,
      severity: f.severity,
      materialityCents: f.materialityCents,
      ruleKey: f.ruleKey,
      ruleVersion: f.ruleVersion,
      evidenceRefs: [],
    })),
  );

  // Proposed notice template — deterministic pick from
  // CollectionNoticeTemplate. Template's natural key is `key`
  // (e.g. "OVER_60"); the CollectionNotice's `stageKey`
  // (e.g. "STAGE_60") is a separate concept used by the notice
  // engine downstream. We only need to pick the template here.
  const dominantBreach = activeFindings.find((f) => f.key.startsWith("ar.policy."));
  const proposedStageKey =
    dominantBreach?.key === "ar.policy.120_day_breach"
      ? "STAGE_FINAL"
      : dominantBreach?.key === "ar.policy.90_day_breach"
        ? "STAGE_90"
        : dominantBreach?.key === "ar.policy.60_day_breach"
          ? "STAGE_60"
          : null;
  const proposedTemplateKey =
    dominantBreach?.key === "ar.policy.120_day_breach"
      ? "FINAL_NOTICE"
      : dominantBreach?.key === "ar.policy.90_day_breach"
        ? "OVER_90"
        : dominantBreach?.key === "ar.policy.60_day_breach"
          ? "OVER_60"
          : null;
  const proposedTemplate = proposedTemplateKey
    ? await prisma.collectionNoticeTemplate.findFirst({
        where: { clubId, key: proposedTemplateKey },
        select: { id: true, name: true, key: true, body: true },
      })
    : null;

  return NextResponse.json({
    intake: {
      id: intake.id,
      status: intake.status,
      title: intake.displaySubject,
      lastAnalysedAt: intake.lastAnalysedAt?.toISOString() ?? null,
      classification: intake.classification,
      ruleSource: "Spectre AR-aging operational rule v1",
    },
    member: {
      id: account.member.id,
      displayName: `${account.member.firstName} ${account.member.lastName}`,
      memberNumber: account.member.memberNumber,
    },
    account: {
      id: account.id,
      currentBalance: account.currentBalance,
      thirtyDayBalance: account.thirtyDayBalance,
      sixtyDayBalance: account.sixtyDayBalance,
      ninetyDayBalance: account.ninetyDayBalance,
      oneTwentyDayBalance: account.oneTwentyDayBalance,
      creditBalance: account.creditBalance,
      lastPaymentDate: account.lastPaymentDate?.toISOString() ?? null,
    },
    recentPayments: recentPayments.map((p) => ({
      id: p.id,
      paymentDate: p.paymentDate.toISOString(),
      amount: p.amount,
      method: p.method,
    })),
    recentNotices: recentNotices.map((n) => ({
      id: n.id,
      noticeType: n.noticeType,
      stageKey: n.stageKey,
      status: n.status,
      sentAt: n.sentAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    })),
    findings: {
      active: activeFindings,
      superseded: supersededFindings,
      rejected: rejectedFindings,
    },
    recommendation,
    proposedNotice: proposedTemplate
      ? {
          templateId: proposedTemplate.id,
          templateName: proposedTemplate.name,
          templateKey: proposedTemplate.key,
          stageKey: proposedStageKey,
          bodyLength: (proposedTemplate.body ?? "").length,
          // Return the body text; the UI decides what to render. Never
          // sends anywhere — this is preview only.
          body: proposedTemplate.body,
          // Send action explicitly gated in this checkpoint.
          sendActionAvailable: false,
          sendActionReason:
            "Direct notice sending requires a separate controlled authorization checkpoint.",
        }
      : {
          templateId: null,
          templateName: null,
          stageKey: proposedStageKey,
          bodyLength: 0,
          body: null,
          sendActionAvailable: false,
          sendActionReason:
            proposedStageKey
              ? `No CollectionNoticeTemplate for stage ${proposedStageKey} exists on this club yet.`
              : "No qualifying breach to send a notice for.",
        },
  });
}
