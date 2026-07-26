// Monthly Reporting Package archive — service layer.
//
// Backs the archive surface at
// /app/admin/governance/monthly-package/archive. Three operations
// today:
//
//   • listArchivedMonthlyPackages — tenant-scoped reverse-chronological
//     listing of every MonthlyPackage row for a club, with summary
//     counts (recipient total, viewed total) ready for the table view.
//
//   • deleteDraftMonthlyPackage — operator wipes an abandoned DRAFT
//     before it's ever published. Refuses to touch PUBLISHED or SENT
//     packages (snapshots are immutable audit history).
//
//   • resendMonthlyPackage — bumps the `sentAt` timestamp + status to
//     SENT for a PUBLISHED or already-SENT package. No actual email
//     adapter wired here yet; this records the operator's intent
//     against the audit trail so the eventual sender can replay.
//
// Tenant safety: every operation re-resolves the package's clubId
// from the DB and passes it through `ensureWrite` so a crafted POST
// with another club's package id cannot succeed.

import { audit } from "../audit";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { prisma } from "../prisma";
import { isSuperAdmin, requirePermission, type Principal } from "../rbac";
import {
  defaultBoardRecipients,
  normalizeLivePointer,
} from "./monthly-package-lifecycle";

// ---------------------------------------------------------------------------
// Permission gate (shared with the rest of the reporting surface).
// ---------------------------------------------------------------------------

function ensureBoardReports(principal: Principal, clubId: string) {
  if (isSuperAdmin(principal)) return;
  requirePermission(principal, clubId, "reports:board");
}

// ---------------------------------------------------------------------------
// listArchivedMonthlyPackages
// ---------------------------------------------------------------------------

export type ArchivedPackageRow = {
  id: string;
  reportingYear: number;
  reportingMonth: number;
  periodEndDate: Date;
  status: "DRAFT" | "PUBLISHED" | "SENT" | string;
  title: string;
  generatedAt: Date;
  generatedByUserId: string | null;
  generatedByName: string | null;
  publishedAt: Date | null;
  publishedByUserId: string | null;
  publishedByName: string | null;
  sentAt: Date | null;
  sentByUserId: string | null;
  sentByName: string | null;
  recipientCount: number;
  /** Recipients with status SENT or OPENED. */
  recipientDeliveredCount: number;
  /** Recipients with status OPENED. */
  recipientViewedCount: number;
};

/**
 * Return every MonthlyPackage row for the club, sorted by
 * periodEndDate DESC (most recent month first) and then generatedAt
 * DESC as a tiebreaker for periods with multiple generated packages
 * (e.g. an operator regenerated May three times before publishing).
 *
 * Each row carries recipient roll-ups so the table can render
 * "12 sent · 7 viewed" without a second query per row.
 */
export async function listArchivedMonthlyPackages(
  principal: Principal,
  clubId: string,
): Promise<ArchivedPackageRow[]> {
  ensureBoardReports(principal, clubId);

  // Defensive cleanup: enforce the greatest-period-wins rule
  // before reading. Cheap no-op when the DB is already consistent;
  // self-heals if a prior bug (or a manual data change) left
  // the archive with a stale Published row at an older period.
  // The founder's 2026-06-29 spec calls this out explicitly:
  //   "Enforce this normalization after [...] loading the archive
  //    if needed as a defensive cleanup."
  await normalizeLivePointer(clubId);

  const rows = await prisma.monthlyPackage.findMany({
    where: { clubId },
    orderBy: [
      { periodEndDate: "desc" },
      { generatedAt: "desc" },
    ],
    include: {
      generatedBy: { select: { id: true, name: true } },
      publishedBy: { select: { id: true, name: true } },
      sentBy: { select: { id: true, name: true } },
      recipients: { select: { id: true, deliveryStatus: true } },
    },
  });

  return rows.map((r) => {
    const recipientCount = r.recipients.length;
    const recipientDeliveredCount = r.recipients.filter(
      (x) => x.deliveryStatus === "SENT" || x.deliveryStatus === "OPENED",
    ).length;
    const recipientViewedCount = r.recipients.filter(
      (x) => x.deliveryStatus === "OPENED",
    ).length;
    return {
      id: r.id,
      reportingYear: r.reportingYear,
      reportingMonth: r.reportingMonth,
      periodEndDate: r.periodEndDate,
      status: r.status,
      title: r.title,
      generatedAt: r.generatedAt,
      generatedByUserId: r.generatedByUserId,
      generatedByName: r.generatedBy?.name ?? null,
      publishedAt: r.publishedAt,
      publishedByUserId: r.publishedByUserId,
      publishedByName: r.publishedBy?.name ?? null,
      sentAt: r.sentAt,
      sentByUserId: r.sentByUserId,
      sentByName: r.sentBy?.name ?? null,
      recipientCount,
      recipientDeliveredCount,
      recipientViewedCount,
    };
  });
}

// ---------------------------------------------------------------------------
// deleteDraftMonthlyPackage
// ---------------------------------------------------------------------------

/**
 * Delete a DRAFT MonthlyPackage. Refuses to delete PUBLISHED, SENT,
 * or any other status — those carry immutable snapshot history.
 *
 * Cascading delete of `MonthlyPackageRecipient` rows is enforced at
 * the schema layer (`onDelete: Cascade`), so a single delete call
 * cleans up the recipient table too.
 */
export async function deleteDraftMonthlyPackage(
  principal: Principal,
  packageId: string,
) {
  const pkg = await prisma.monthlyPackage.findUnique({
    where: { id: packageId },
    select: {
      id: true,
      clubId: true,
      status: true,
      reportingYear: true,
      reportingMonth: true,
      title: true,
    },
  });
  if (!pkg) throw new NotFoundError("MonthlyPackage", packageId);
  ensureBoardReports(principal, pkg.clubId);
  if (pkg.status !== "DRAFT") {
    throw new ConflictError(
      `Only DRAFT packages can be deleted. This package is ${pkg.status}; its snapshot is part of the board audit trail.`,
    );
  }
  await prisma.monthlyPackage.delete({ where: { id: pkg.id } });
  await audit(principal, {
    action: "reporting.monthly-package.delete-draft",
    entityType: "MonthlyPackage",
    entityId: pkg.id,
    clubId: pkg.clubId,
    before: {
      reportingYear: pkg.reportingYear,
      reportingMonth: pkg.reportingMonth,
      title: pkg.title,
      status: pkg.status,
    },
  });
  return { deleted: true, packageId: pkg.id };
}

// ---------------------------------------------------------------------------
// resendMonthlyPackage
// ---------------------------------------------------------------------------

/**
 * "Re-send / notify Board" action on the archive row.
 *
 * Refuses DRAFT (nothing to send yet — operator publishes first).
 * Otherwise:
 *
 *   1. Flips status to SENT and refreshes `sentAt`.
 *   2. Re-normalizes the Live pointer (older-period resends get
 *      demoted back to ARCHIVED so the greatest-period-wins
 *      invariant holds).
 *   3. **REBUILDS the recipient list from the CURRENT Board
 *      roster** via `defaultBoardRecipients`. This is the
 *      founder's 2026-06-29 fix: prior to this slice, resend
 *      preserved whatever recipients were on the row at the time
 *      of the original publish, so a package published BEFORE a
 *      Board member was assigned would never include that
 *      member even after a resend. Rebuilding from the live
 *      roster guarantees current Board members (e.g. an active
 *      President / Treasurer / Director from Governance → Board
 *      & Committees) appear in the recipient list — regardless
 *      of when the package was originally published.
 *   4. Resets `viewedAt` to null on every newly-issued recipient
 *      row so the NEW badge fires again for each Board member
 *      until they personally open the package.
 *
 * The snapshot JSON is left untouched — a resend distributes the
 * same frozen document the recipients saw the first time.
 */
export async function resendMonthlyPackage(
  principal: Principal,
  packageId: string,
) {
  const pkg = await prisma.monthlyPackage.findUnique({
    where: { id: packageId },
    select: { id: true, clubId: true, status: true, atAGlanceKpisJson: true },
  });
  if (!pkg) throw new NotFoundError("MonthlyPackage", packageId);
  ensureBoardReports(principal, pkg.clubId);
  if (pkg.status === "DRAFT") {
    throw new ConflictError(
      "Cannot resend a DRAFT package — publish it first, then send.",
    );
  }
  // The snapshot must exist before a resend is meaningful. If a
  // PUBLISHED row somehow has no snapshot (legacy data, partial
  // import), refuse rather than send an empty package.
  if (!pkg.atAGlanceKpisJson) {
    throw new ValidationError([
      { path: "atAGlanceKpisJson", message: "Snapshot is empty; republish before resending." },
    ]);
  }
  const sentAt = new Date();
  const updated = await prisma.monthlyPackage.update({
    where: { id: pkg.id },
    data: {
      status: "SENT",
      sentAt,
      sentByUserId: principal.id,
    },
  });
  // Re-normalize: if the operator resent an OLDER period than the
  // current Live, the SENT row is demoted back to ARCHIVED so the
  // greatest-period-wins invariant holds.
  await normalizeLivePointer(pkg.clubId);

  // Rebuild the recipient list from the CURRENT Board roster.
  // Wipe + recreate so:
  //   • Members elected to the Board AFTER the original publish
  //     are now included (the founder's James Whitfield case).
  //   • Members whose term has since expired are excluded.
  //   • Every fresh row has `viewedAt = null`, so the NEW badge
  //     fires again on the dashboard tile for each Board member
  //     until they personally open the package.
  const recipients = await defaultBoardRecipients(pkg.clubId);
  await prisma.monthlyPackageRecipient.deleteMany({
    where: { monthlyPackageId: pkg.id },
  });
  if (recipients.length > 0) {
    await prisma.monthlyPackageRecipient.createMany({
      data: recipients.map((r) => ({
        monthlyPackageId: pkg.id,
        recipientUserId: r.userId ?? null,
        recipientEmail: r.email,
        recipientRole: r.role ?? null,
        deliveryStatus: "PENDING",
      })),
    });
  }
  await audit(principal, {
    action: "reporting.monthly-package.resend",
    entityType: "MonthlyPackage",
    entityId: pkg.id,
    clubId: pkg.clubId,
    after: {
      sentAt: sentAt.toISOString(),
      priorStatus: pkg.status,
      recipientCount: recipients.length,
      // Audit who was on the rebuilt roster — useful when
      // investigating "why was X notified / not notified" later.
      recipientUserIds: recipients.map((r) => r.userId).filter(Boolean),
    },
  });
  return {
    resent: true,
    packageId: pkg.id,
    sentAt: updated.sentAt,
    recipientCount: recipients.length,
  };
}

// ---------------------------------------------------------------------------
// getMonthlyPackageRecipients
// ---------------------------------------------------------------------------

export type RecipientRow = {
  id: string;
  recipientUserId: string | null;
  recipientUserName: string | null;
  recipientEmail: string;
  recipientRole: string | null;
  sentAt: Date | null;
  viewedAt: Date | null;
  deliveryStatus: string;
  createdAt: Date;
};

/**
 * Recipients for a single package — used by the
 * /archive/[id]/recipients detail surface.
 */
export async function getMonthlyPackageRecipients(
  principal: Principal,
  packageId: string,
): Promise<{
  pkg: {
    id: string;
    title: string;
    reportingYear: number;
    reportingMonth: number;
    periodEndDate: Date;
    status: string;
    sentAt: Date | null;
  };
  recipients: RecipientRow[];
}> {
  const pkg = await prisma.monthlyPackage.findUnique({
    where: { id: packageId },
    select: {
      id: true,
      clubId: true,
      title: true,
      reportingYear: true,
      reportingMonth: true,
      periodEndDate: true,
      status: true,
      sentAt: true,
    },
  });
  if (!pkg) throw new NotFoundError("MonthlyPackage", packageId);
  ensureBoardReports(principal, pkg.clubId);

  const recipients = await prisma.monthlyPackageRecipient.findMany({
    where: { monthlyPackageId: pkg.id },
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
    include: {
      recipientUser: { select: { id: true, name: true } },
    },
  });

  return {
    pkg: {
      id: pkg.id,
      title: pkg.title,
      reportingYear: pkg.reportingYear,
      reportingMonth: pkg.reportingMonth,
      periodEndDate: pkg.periodEndDate,
      status: pkg.status,
      sentAt: pkg.sentAt,
    },
    recipients: recipients.map((r) => ({
      id: r.id,
      recipientUserId: r.recipientUserId,
      recipientUserName: r.recipientUser?.name ?? null,
      recipientEmail: r.recipientEmail,
      recipientRole: r.recipientRole,
      sentAt: r.sentAt,
      viewedAt: r.viewedAt,
      deliveryStatus: r.deliveryStatus,
      createdAt: r.createdAt,
    })),
  };
}
