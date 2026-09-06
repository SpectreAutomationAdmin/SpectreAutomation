// Payroll MVP posting (2026-09-05) — Mission Control loader that
// surfaces Payroll-domain Work Intake cards (PAYROLL_ADMIN_PROCESSING,
// PAYROLL_REVIEW, PAYROLL_FINAL_APPROVAL) in the founder's feed.
//
// Reads only WorkIntakeItems owned by the signed-in user with
// workDomain = "PAYROLL", excluding RESOLVED / SUPPRESSED items.
// Projects each row into the canonical WorkItem shape used by
// <FeedItem>, with the primary action's `href` computed via
// resolvePayrollWorkIntakeDeepLink so the click lands on the correct
// Payroll surface.

import { prisma } from "../prisma";
import type { WorkItem } from "./index";
import { resolvePayrollWorkIntakeDeepLink } from "../payroll/work-intake-deep-link";
import type { Principal } from "../rbac";

export interface LoadPayrollAdminIntakeArgs {
  principal: Principal;
  clubId: string;
  now: Date;
}

const HIDDEN_STATUSES = ["RESOLVED", "SUPPRESSED"];

function relTime(now: Date, then: Date): string {
  const diffMs = now.getTime() - then.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return then.toLocaleDateString();
}

/**
 * Load Payroll-domain Work Intake cards the signed-in user owns.
 * Emits one WorkItem per card, projected into the shape <FeedItem>
 * consumes. The primary action's href routes the click to the
 * correct payroll surface via the canonical deep-link resolver.
 */
export async function loadPayrollAdminIntakeItems(
  args: LoadPayrollAdminIntakeArgs,
): Promise<WorkItem[]> {
  const { principal, clubId, now } = args;

  const items = await prisma.workIntakeItem.findMany({
    where: {
      clubId,
      workDomain: "PAYROLL",
      ownerUserId: principal.id,
      status: { notIn: HIDDEN_STATUSES },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  if (items.length === 0) return [];

  // Look up the origin references so we can build correct deep-links.
  const originByItem = new Map<string, { kind: string; referenceId: string }>();
  const origins = await prisma.workIntakeOrigin.findMany({
    where: {
      clubId,
      role: "PRIMARY",
      workIntakeItemId: { in: items.map((i) => i.id) },
    },
    select: { workIntakeItemId: true, kind: true, referenceId: true },
  });
  for (const o of origins) originByItem.set(o.workIntakeItemId, { kind: o.kind, referenceId: o.referenceId });

  return items.map((wi): WorkItem => {
    const origin = originByItem.get(wi.id) ?? null;
    const deep = origin
      ? resolvePayrollWorkIntakeDeepLink(wi.workSubtype ?? origin.kind, origin.referenceId)
      : null;

    const state: WorkItem["state"] = wi.workIntent === "APPROVE" ? "approval" : "judgment";
    return {
      id: `wi-${wi.id}`,
      state,
      idTag: `PAY-${wi.id.slice(0, 6).toUpperCase()}`,
      title: wi.displaySubject,
      sender: {
        from: wi.displaySender,
        ctx: `Received ${relTime(now, wi.displayReceivedAt)}`,
      },
      timestamp: wi.createdAt.toISOString(),
      timestampLabel: relTime(now, wi.createdAt),
      recommendation: undefined,
      readout: [],
      actions: [
        deep
          ? { key: "review_payroll", label: deep.label, kind: "primary" as const, href: deep.href }
          : { key: "review_payroll", label: "Open payroll", kind: "primary" as const },
      ],
      workIntakeItemId: wi.id,
      workDomain: "PAYROLL",
      workIntent: wi.workIntent ?? undefined,
      workSubtype: wi.workSubtype ?? undefined,
      workIntakeStatus: wi.status,
      workIntakeCreatedAt: wi.createdAt.toISOString(),
      sortTimestamp: wi.createdAt.toISOString(),
    };
  });
}
