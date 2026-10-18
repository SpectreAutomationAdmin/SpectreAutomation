// WI-SYNC-1c (2026-10-18) — Spectre-only Dismiss action.
//
// Removes a WI from the active Spectre feed WITHOUT touching the
// source Outlook email.  Distinct from Delete (which moves the
// email to Deleted Items) and from Archive (which moves it to
// Archive).  The user's intent is "I don't need this in my
// Spectre feed; leave Outlook alone."
//
// Blocks future auto-restore: sets userDismissedAt so a later
// reconciliation that detects the message is still in Inbox does
// NOT reactivate the WI.
//
// Does NOT touch APInvoice / ApIntakeSource / JournalEntry /
// Approval / Payment — accounting workflows are a separate domain
// and survive any feed-visibility change.

import { prisma } from "@/lib/prisma";
import type { Principal } from "@/lib/rbac";
import { audit } from "@/lib/audit";

export type DismissOutcome =
  | { status: "DISMISSED"; workIntakeStatusBefore: string }
  | { status: "ALREADY_DISMISSED" }
  | { status: "NOT_FOUND" }
  | { status: "CROSS_TENANT" };

export interface DismissArgs {
  clubId: string;
  workIntakeItemId: string;
  principal: Principal | { id: string } | null;
}

export async function dismissWorkIntakeItem(
  args: DismissArgs,
): Promise<DismissOutcome> {
  const wi = await prisma.workIntakeItem.findUnique({
    where: { id: args.workIntakeItemId },
    select: {
      id: true,
      clubId: true,
      status: true,
      userDismissedAt: true,
    },
  });
  if (!wi) return { status: "NOT_FOUND" };
  if (wi.clubId !== args.clubId) return { status: "CROSS_TENANT" };
  if (wi.userDismissedAt && wi.status === "SUPPRESSED") {
    return { status: "ALREADY_DISMISSED" };
  }

  const workIntakeStatusBefore = wi.status;
  const now = new Date();
  await prisma.$transaction([
    prisma.workIntakeItem.update({
      where: { id: wi.id },
      data: {
        status: "SUPPRESSED",
        // Only overwrite statusBeforeSuppression if not already
        // set — a prior evidence-deletion already recorded the
        // true original state.
        ...(wi.status !== "SUPPRESSED"
          ? { statusBeforeSuppression: workIntakeStatusBefore }
          : {}),
        userDismissedAt: now,
        userDismissedByUserId: args.principal?.id ?? null,
      },
    }),
    prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: wi.id,
        action: "USER_DISMISSED",
        note: "User dismissed from Spectre feed. Outlook email unchanged.",
      },
    }),
  ]);

  await audit(args.principal, {
    action: "work-intake.dismiss",
    entityType: "WorkIntakeItem",
    entityId: args.workIntakeItemId,
    clubId: args.clubId,
    meta: { workIntakeStatusBefore, dismissedAt: now.toISOString() },
  });

  return { status: "DISMISSED", workIntakeStatusBefore };
}
