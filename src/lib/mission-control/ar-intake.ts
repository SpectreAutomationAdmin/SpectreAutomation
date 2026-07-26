// Sprint 3 Checkpoint 15B (2026-07-24) — AR Work Intake loader.
//
// READ-ONLY. This module renders persisted AR-aging Work Intake
// situations into the common Mission Control WorkItem shape. It
// does NOT write, materialise, or refresh anything on page load —
// the founder's Correction §"Do not write during page load" is
// enforced by making this loader the ONLY MC-side surface, and
// making it strictly a Prisma read.
//
// Materialisation happens only via bin/intelligence-ar-aging-materialise.ts.

import { prisma } from "@/lib/prisma";
import type { WorkItem, WorkItemEvidenceCell } from "./index";
import { composeArAgingRecommendation } from "@/lib/intelligence/analysers/ar-aging";
import type { FindingInput } from "@/lib/intelligence/types";

const AR_INTAKE_CAP = 12;

/** Load AR-derived operational situations for the feed. Read-only. */
export async function loadArIntakeItems(args: {
  clubId: string;
  now: Date;
}): Promise<WorkItem[]> {
  const items = await prisma.workIntakeItem.findMany({
    where: {
      clubId: args.clubId,
      status: { notIn: ["SUPPRESSED"] },
      // Presence of a MEMBER_ACCOUNT PRIMARY origin identifies an AR
      // intake, distinguishing from email-derived and other future
      // intakes.
      origins: {
        some: {
          kind: "MEMBER_ACCOUNT",
          role: "PRIMARY",
        },
      },
    },
    orderBy: [{ displayReceivedAt: "desc" }],
    take: AR_INTAKE_CAP,
    include: {
      origins: true,
      findings: {
        where: { state: { in: ["CONFIRMED", "OBSERVED"] } },
        orderBy: [{ severity: "desc" }, { createdAt: "asc" }],
      },
    },
  });

  return items.map((it) => toArWorkItem(it, args.now));
}

function toArWorkItem(
  it: Awaited<ReturnType<typeof prisma.workIntakeItem.findMany>>[number] & {
    origins: Array<{ kind: string; referenceId: string; role: string }>;
    findings: Array<{
      key: string;
      statement: string;
      state: string;
      severity: string;
      materialityCents: bigint | null;
      ruleKey: string;
      ruleVersion: number;
      evidenceRefsJson: string;
    }>;
  },
  now: Date,
): WorkItem {
  const state: WorkItem["state"] = it.judgmentRequired ? "judgment" : "info";

  // Reproduce a Recommendation shape from persisted findings for the
  // synopsis + recommendation line. This is a client-side derivation,
  // never persisted.
  const findingInputs: FindingInput[] = it.findings.map((f) => ({
    key: f.key,
    statement: f.statement,
    state: f.state as FindingInput["state"],
    severity: f.severity as FindingInput["severity"],
    materialityCents: f.materialityCents,
    ruleKey: f.ruleKey,
    ruleVersion: f.ruleVersion,
    evidenceRefs: [], // not needed for recommendation composition
  }));
  const recommendation = composeArAgingRecommendation(findingInputs);

  // Compose the synopsis by chaining the active findings' statements.
  // Every clause traces to a persisted finding row.
  const primaryBreach = findingInputs.find((f) =>
    f.key.startsWith("ar.policy.")
  );
  const recentPayment = findingInputs.find((f) => f.key === "ar.member.recent_payment");
  const recentNotice = findingInputs.find((f) => f.key === "ar.member.recent_notice");
  const paymentStale = findingInputs.find((f) => f.key === "ar.member.payment_stale");
  const parts: string[] = [];
  if (primaryBreach) parts.push(primaryBreach.statement);
  if (recentNotice) parts.push(recentNotice.statement);
  else if (recentPayment) parts.push(recentPayment.statement);
  else if (paymentStale) parts.push(paymentStale.statement);
  const synopsis =
    parts.join(" ") ||
    "Spectre AR-aging operational rule v1 identified this account; findings are pending.";

  // Evidence strip — 4 cells for the AR card.
  const evidence: WorkItemEvidenceCell[] = arEvidenceCells(findingInputs);

  const memberAccountRef =
    it.origins.find((o) => o.kind === "MEMBER_ACCOUNT" && o.role === "PRIMARY")?.referenceId ??
    "";

  return {
    id: `wi_${it.id}`,
    state,
    idTag: `AR-${it.id.slice(-4).toUpperCase()}`,
    title: it.displaySubject || "Aged receivable requires review",
    sender: {
      from: `${it.displaySender} · Accounts receivable · Spectre AR-aging operational rule v1`,
    },
    timestamp: it.displayReceivedAt.toISOString(),
    timestampLabel: relTimeLocal(now, it.displayReceivedAt),
    recommendation: recommendation?.statement,
    workIntakeItemId: it.id,
    isUnread: false,
    isHighImportance:
      primaryBreach?.severity === "CRITICAL" || primaryBreach?.severity === "HIGH",
    synopsisText: synopsis,
    evidence,
    conversationMessageCount: 1,
    actions: [
      {
        key: "ar.review_collection_notice",
        label: "Review collection notice",
        kind: "primary",
        iconKey: "mail",
        onClickAction: "expand-view",
      },
      // Preserve existing Work Intake lifecycle actions.
      // These trigger the existing POST /api/work-intake/action
      // (assign_self / defer / mark_informational / resolve).
      { key: "assign_self", label: "Assign to me", kind: "secondary", iconKey: "user-plus" },
      { key: "defer", label: "Defer", kind: "tertiary", iconKey: "clock" },
    ],
    // Auxiliary — the card client uses these for the inline evidence panel.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...({
      arOriginMemberAccountId: memberAccountRef,
      arLastAnalysedAt: it.lastAnalysedAt?.toISOString() ?? null,
    } as any),
  };
}

function arEvidenceCells(findings: FindingInput[]): WorkItemEvidenceCell[] {
  const breach =
    findings.find((f) => f.key === "ar.policy.120_day_breach") ??
    findings.find((f) => f.key === "ar.policy.90_day_breach") ??
    findings.find((f) => f.key === "ar.policy.60_day_breach");
  const notice = findings.find((f) => f.key === "ar.member.recent_notice");
  const payment = findings.find((f) => f.key === "ar.member.recent_payment");
  const stale = findings.find((f) => f.key === "ar.member.payment_stale");

  const bucketCell: WorkItemEvidenceCell = {
    label: "VENDOR", // repurpose slot 1 as "member bucket" — see UI comment below
    value: breach?.key === "ar.policy.120_day_breach"
      ? "120-day"
      : breach?.key === "ar.policy.90_day_breach"
        ? "90-day"
        : breach?.key === "ar.policy.60_day_breach"
          ? "60-day"
          : "—",
    state: breach ? "found" : "not_found",
  };
  const amountCell: WorkItemEvidenceCell = {
    label: "AMOUNT",
    value: breach?.materialityCents != null ? formatCents(breach.materialityCents) : "—",
    state: breach?.materialityCents != null ? "extracted" : "not_extracted",
  };
  const noticeCell: WorkItemEvidenceCell = {
    label: "AP STATUS", // repurposed as "Notice"
    value: notice ? "Sent" : "None recent",
    state: notice ? "found" : "not_found",
  };
  const paymentCell: WorkItemEvidenceCell = {
    label: "INVOICE", // repurposed as "Payment"
    value: payment ? "Recent" : stale ? "Stale" : "—",
    state: payment ? "found" : stale ? "not_found" : "not_extracted",
  };
  return [bucketCell, paymentCell, noticeCell, amountCell];
}

function formatCents(cents: bigint): string {
  const dollars = Number(cents) / 100;
  return `$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function relTimeLocal(now: Date, then: Date): string {
  const diff = now.getTime() - then.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return then.toLocaleDateString();
}
