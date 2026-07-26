// Monthly Reporting Package — lifecycle (generate → publish → send).
//
// Three operations:
//
//   generateDraftMonthlyPackage(principal, clubId, { year, month })
//     → upsert a DRAFT row for the (clubId, year, month) triple.
//        Idempotent: if a DRAFT or PUBLISHED row already exists for
//        the period, returns it untouched (re-opening the report
//        for review should NOT clobber a published snapshot). If a
//        SENT row exists, returns it too — the operator is just
//        looking at a sent package; nothing changes.
//
//   publishMonthlyPackage(principal, packageId)
//     → freeze the three snapshot JSON fields against the live
//        report payload, flip status to PUBLISHED, record
//        publishedAt + publishedByUserId. Refuses to re-publish a
//        SENT package (its snapshot was already distributed).
//
//   sendMonthlyPackage(principal, packageId, opts?)
//     → flip status to SENT, record sentAt + sentByUserId, and
//        populate the MonthlyPackageRecipient table from the
//        BOARD_READ_ONLY users at the club (plus any explicit
//        recipients the caller supplies). Auto-publishes if the
//        row is still DRAFT — sending implies publish.
//
// Tenant safety: every operation re-resolves clubId from the DB
// row and routes through `ensureBoardReports` so a crafted
// packageId from another tenant cannot succeed.
//
// Email delivery: NOT implemented here per the founder's spec
// ("If email sending is not already supported, do not invent a
// full email system"). The MonthlyPackageRecipient rows are
// created in `PENDING`; a future delivery adapter flips them to
// SENT/OPENED.

import { createHash } from "node:crypto";

import { audit } from "../audit";
import { NotFoundError, ValidationError } from "../errors";
import { isActiveBoardMember } from "../governance/board-roles";
import { prisma } from "../prisma";
import { hasPermission, isSuperAdmin, requirePermission, type Principal } from "../rbac";

import { getMonthlyReportingPackage } from "./monthly-package";
import {
  validateSofPSignInvariants,
  validateCurrentYearEarnings,
} from "./statement-of-financial-position";

// ---------------------------------------------------------------------------
// Status constants — the four-state workflow.
// ---------------------------------------------------------------------------
//
//   DRAFT     never published yet; the controller is working on the
//             first publication.
//   PUBLISHED currently live to the Board for this period; at most
//             ONE PUBLISHED row per (clubId, year, month) at a time.
//   ARCHIVED  was once PUBLISHED, then superseded by a newer
//             publication for the same period (Update Publication).
//             Read-only for admins via the archive; never reachable
//             by the Board.
//   SENT      legacy status from earlier slices; treated as
//             PUBLISHED for visibility + read paths so existing
//             rows don't drop out of the Board surfaces.
export const PACKAGE_STATUS = {
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
  ARCHIVED: "ARCHIVED",
  SENT: "SENT", // legacy
} as const;

const BOARD_VISIBLE_STATUSES = [PACKAGE_STATUS.PUBLISHED, PACKAGE_STATUS.SENT];

/**
 * Canonical hash of the at-a-glance KPI snapshot. We hash the
 * narrow slice the Board actually consumes (the four cover KPIs)
 * rather than the full payload — full payload has timestamps
 * (`preparedAt`) and noisy intermediate fields that would flip the
 * hash even when nothing meaningful changed.
 *
 * Stored on publish (`MonthlyPackage.publishedPayloadHash`),
 * recomputed at render time, and compared. Match → controller sees
 * "Published" (informational). Mismatch → controller sees "Update
 * Publication" (clickable) — they have unpublished edits.
 */
export function computePublishedPayloadHash(atAGlanceKpis: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(atAGlanceKpis ?? []))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Permission gate (shared with the archive surface).
// ---------------------------------------------------------------------------

function ensureBoardReports(principal: Principal, clubId: string) {
  if (isSuperAdmin(principal)) return;
  requirePermission(principal, clubId, "reports:board");
}

// ---------------------------------------------------------------------------
// Period validation
// ---------------------------------------------------------------------------

function isValidPeriod(year: number, month: number): boolean {
  return (
    Number.isInteger(year) &&
    year >= 1900 &&
    year <= 9999 &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12
  );
}

function periodEndDate(year: number, month: number): Date {
  // Last day of the month at 00:00 UTC. `Date.UTC(year, month, 0)`
  // gives day 0 of the NEXT month = last day of the supplied month.
  return new Date(Date.UTC(year, month, 0));
}

// ---------------------------------------------------------------------------
// normalizeLivePointer — the canonical "greatest period wins" enforcer
// ---------------------------------------------------------------------------
//
// The founder's Live Pointer rule (2026-06-28, refined 2026-06-29):
//
//   For each club, the live/published Monthly Reporting Package MUST
//   always be the latest reporting period that exists (any
//   non-DRAFT status). A prior month can never remain Published if
//   a later non-DRAFT month exists.
//
// Concretely:
//   • Among all rows for the club with status in {PUBLISHED, SENT,
//     ARCHIVED}, the row with the greatest (reportingYear,
//     reportingMonth) MUST have status PUBLISHED (or SENT — SENT is
//     a recipient-distribution lifecycle marker that's semantically
//     equivalent to PUBLISHED for the Live pointer).
//   • Every other non-DRAFT row MUST have status ARCHIVED.
//   • DRAFT rows are excluded — they aren't "for Board use" yet.
//
// Triggered after every write that could change which row is the
// greatest: publish, generate (in case the row was new), send,
// resend, and defensively on archive-list load (in case the DB
// drifted out of sync due to a prior bug — like the 2026-06-29
// state with June Archived + May Published the founder reported).
//
// Pure status normalization — does NOT touch snapshots, recipients,
// or audit trail. The CALLER is responsible for refreshing
// recipients on a row that BECOMES the Live one (see
// `publishMonthlyPackage` for that flow).
//
// Returns the id of the row that is now the Live, or null if the
// club has no non-DRAFT rows at all.
//
// Pass a transaction client (`tx`) when calling from within an
// existing `$transaction` block so the normalization sees the
// uncommitted writes from this transaction.
type LiveCandidateClient = {
  monthlyPackage: {
    findMany: typeof prisma.monthlyPackage.findMany;
    update: typeof prisma.monthlyPackage.update;
    updateMany: typeof prisma.monthlyPackage.updateMany;
  };
};

export async function normalizeLivePointer(
  clubId: string,
  client: LiveCandidateClient = prisma,
): Promise<{ liveId: string | null; promotedId: string | null; demotedIds: string[] }> {
  const candidates = await client.monthlyPackage.findMany({
    where: {
      clubId,
      status: { in: [PACKAGE_STATUS.PUBLISHED, PACKAGE_STATUS.SENT, PACKAGE_STATUS.ARCHIVED] },
    },
    orderBy: [{ reportingYear: "desc" }, { reportingMonth: "desc" }],
    select: { id: true, status: true, reportingYear: true, reportingMonth: true },
  });
  if (candidates.length === 0) {
    return { liveId: null, promotedId: null, demotedIds: [] };
  }
  const greatest = candidates[0];
  const others = candidates.slice(1);

  let promotedId: string | null = null;
  // Promote the greatest to PUBLISHED if needed. SENT is left
  // untouched when greatest — it's semantically Live (and we want
  // to preserve the recipient-distribution history on the row).
  if (
    greatest.status !== PACKAGE_STATUS.PUBLISHED &&
    greatest.status !== PACKAGE_STATUS.SENT
  ) {
    await client.monthlyPackage.update({
      where: { id: greatest.id },
      data: { status: PACKAGE_STATUS.PUBLISHED },
    });
    promotedId = greatest.id;
  }

  // Demote any non-greatest row that's still PUBLISHED or SENT.
  const toArchive = others
    .filter((c) => c.status !== PACKAGE_STATUS.ARCHIVED)
    .map((c) => c.id);
  if (toArchive.length > 0) {
    await client.monthlyPackage.updateMany({
      where: { id: { in: toArchive } },
      data: { status: PACKAGE_STATUS.ARCHIVED },
    });
  }

  return { liveId: greatest.id, promotedId, demotedIds: toArchive };
}

function periodTitle(year: number, month: number): string {
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${names[month - 1]} ${year} Monthly Reporting Package`;
}

// ---------------------------------------------------------------------------
// generateDraftMonthlyPackage
// ---------------------------------------------------------------------------

export type GenerateDraftResult = {
  package: {
    id: string;
    clubId: string;
    reportingYear: number;
    reportingMonth: number;
    status: string;
    title: string;
  };
  /** True when this call created a new row; false when an existing
   *  row was returned. The launcher uses this to surface "Created a
   *  new draft" vs "Re-opened the existing draft" in the UI. */
  created: boolean;
};

/**
 * Find-or-create a MonthlyPackage row for the (clubId, year, month)
 * period. Returns the existing row when present so re-opening the
 * report for review doesn't clobber snapshot state. Audit-logs only
 * on actual creation.
 */
export async function generateDraftMonthlyPackage(
  principal: Principal,
  clubId: string,
  args: { reportingYear: number; reportingMonth: number },
): Promise<GenerateDraftResult> {
  ensureBoardReports(principal, clubId);

  if (!isValidPeriod(args.reportingYear, args.reportingMonth)) {
    throw new ValidationError([
      { path: "reportingYear", message: "Year must be 1900..9999" },
      { path: "reportingMonth", message: "Month must be 1..12" },
    ]);
  }

  // Idempotent. The unique constraint on
  // (clubId, reportingYear, reportingMonth) guarantees at most ONE
  // row per period, so we return whatever row exists — DRAFT,
  // PUBLISHED, SENT, or ARCHIVED. The report page's
  // PublishHeaderButton inspects the row's status to pick the
  // right action label + dialog (DRAFT → "Publish"; PUBLISHED →
  // "Published"/"Overwrite Package"; ARCHIVED → "Overwrite
  // Package" with the founder's historical-correction copy).
  const existing = await prisma.monthlyPackage.findUnique({
    where: {
      clubId_reportingYear_reportingMonth: {
        clubId,
        reportingYear: args.reportingYear,
        reportingMonth: args.reportingMonth,
      },
    },
  });
  if (existing) {
    return {
      package: {
        id: existing.id,
        clubId: existing.clubId,
        reportingYear: existing.reportingYear,
        reportingMonth: existing.reportingMonth,
        status: existing.status,
        title: existing.title,
      },
      created: false,
    };
  }

  const created = await prisma.monthlyPackage.create({
    data: {
      clubId,
      reportingYear: args.reportingYear,
      reportingMonth: args.reportingMonth,
      periodEndDate: periodEndDate(args.reportingYear, args.reportingMonth),
      status: "DRAFT",
      title: periodTitle(args.reportingYear, args.reportingMonth),
      generatedByUserId: principal.id,
    },
  });
  // Defensive: re-normalize after a generate. A new DRAFT row
  // doesn't change which row is the greatest non-DRAFT (because
  // DRAFTs are excluded), so this is a no-op in the happy path —
  // but if the DB drifted out of sync from an earlier bug, this
  // re-converges it before the operator sees the report page.
  await normalizeLivePointer(clubId);
  await audit(principal, {
    action: "reporting.monthly-package.generate-draft",
    entityType: "MonthlyPackage",
    entityId: created.id,
    clubId,
    after: {
      reportingYear: created.reportingYear,
      reportingMonth: created.reportingMonth,
      title: created.title,
    },
  });
  return {
    package: {
      id: created.id,
      clubId: created.clubId,
      reportingYear: created.reportingYear,
      reportingMonth: created.reportingMonth,
      status: created.status,
      title: created.title,
    },
    created: true,
  };
}

// ---------------------------------------------------------------------------
// publishMonthlyPackage
// ---------------------------------------------------------------------------

/**
 * Capture the snapshot JSON fields against the LIVE reporting
 * service output for the period this row covers, then apply the
 * founder's Live Package rule:
 *
 *   • Exactly ONE MonthlyPackage row per reporting period per club
 *     (enforced by the unique constraint on
 *     `(clubId, reportingYear, reportingMonth)`). Re-publishing the
 *     same period OVERWRITES that row in place — never creates a
 *     duplicate.
 *
 *   • The "Live Package" for a club is the newest reporting period
 *     that holds status PUBLISHED. The Board dashboard tile + read-
 *     only board view track THIS package.
 *
 *   • Publishing a period NEWER than the current Live advances the
 *     Live pointer: the new row becomes PUBLISHED, the prior Live
 *     row (a different period) is ARCHIVED. This is the only
 *     scenario where the Live pointer moves automatically.
 *
 *   • Re-publishing the CURRENT Live period refreshes its snapshot
 *     in place; the row stays PUBLISHED, the pointer doesn't move.
 *
 *   • Re-publishing an OLDER period (one that's currently ARCHIVED
 *     because a newer Live exists) refreshes its snapshot in place
 *     but keeps the row ARCHIVED. The Board dashboard does NOT
 *     regress — historical corrections never overwrite what the
 *     Board is currently reading.
 *
 * Snapshot fields (`executiveOpeningSnapshotJson`,
 * `atAGlanceKpisJson`, `packagePayloadJson`, `publishedPayloadHash`)
 * are ALWAYS rewritten — that's the point of the publish action.
 * `publishedAt` + `publishedByUserId` record the most-recent publish
 * event whether or not the row's status changed.
 *
 * Recipients are only refreshed when the row becomes / stays the
 * Live row. Overwriting an archived historical period does NOT
 * touch recipient rows or fire fresh NEW badges — the Board's
 * notifications track the Live package, not the archive.
 *
 * The supplied package row may be in ANY status. SENT is treated
 * as a legacy alias of PUBLISHED (historical recipient-side
 * lifecycle). DRAFT rows take the "first publish" path.
 */
export async function publishMonthlyPackage(
  principal: Principal,
  packageId: string,
): Promise<{
  packageId: string;
  /** Always equal to `packageId` under the new model — publish
   *  overwrites the same row, never creates a successor. */
  publishedPackageId: string;
  publishedAt: Date;
  recipientCount: number;
  /** The row's status AFTER the publish call. PUBLISHED when this
   *  period IS the Live row; ARCHIVED when an older period was
   *  overwritten without disturbing the Live pointer. */
  resultingStatus: "PUBLISHED" | "ARCHIVED";
  /** True when this publish moved the Live pointer to a new
   *  reporting period (i.e. a different period was previously
   *  Live, and a newer one is being published now). False for
   *  first-publish-into-empty, current-Live-overwrite, and
   *  historical-archived-overwrite. */
  liveAdvanced: boolean;
  /** True when the publish call OVERWROTE an existing snapshot
   *  (the row was previously PUBLISHED/SENT/ARCHIVED). False on
   *  the first-ever publish of a DRAFT row. The UI uses this to
   *  decide whether to show the founder-spec overwrite dialog. */
  overwroteExisting: boolean;
  /** "DRAFT->PUBLISHED"        : first publish ever for this period.
   *  "OVERWRITE_LIVE"          : current Live re-published in place.
   *  "OVERWRITE_HISTORICAL"    : an older archived period was
   *                              refreshed; Live pointer untouched.
   *  "ADVANCE_LIVE"            : newer period published; prior Live
   *                              (different period) was archived. */
  transition:
    | "DRAFT->PUBLISHED"
    | "OVERWRITE_LIVE"
    | "OVERWRITE_HISTORICAL"
    | "ADVANCE_LIVE";
}> {
  const pkg = await prisma.monthlyPackage.findUnique({
    where: { id: packageId },
    select: {
      id: true,
      clubId: true,
      status: true,
      reportingYear: true,
      reportingMonth: true,
      periodEndDate: true,
      title: true,
      generatedByUserId: true,
    },
  });
  if (!pkg) throw new NotFoundError("MonthlyPackage", packageId);
  ensureBoardReports(principal, pkg.clubId);

  const periodStart = new Date(
    Date.UTC(pkg.reportingYear, pkg.reportingMonth - 1, 1),
  );
  const periodEnd = pkg.periodEndDate;

  // Live build of the package for this period. The service returns
  // the canonical structured payload the report renders from; we
  // serialise the whole thing into `packagePayloadJson` for full
  // historical re-render fidelity, then pluck the two
  // founder-specified slices out for cheap-read access.
  // Founder rule 2026-07-13 v15.14 — the publish path MUST NEVER
  // request drill-down detail. The serialised `packagePayloadJson`
  // is later re-read by Board / member viewers (see
  // getBoardPackageView() below), and account-level data must never
  // leak into a frozen snapshot for anyone without `coa:read`.
  const liveReport = await getMonthlyReportingPackage(pkg.clubId, {
    period: { start: periodStart, end: periodEnd },
    viewerCanDrillDown: false,
  });

  // Founder rule 2026-07-13 v15.16 — an out-of-balance Statement of
  // Financial Position may never enter the archive. `packagePayloadJson`
  // is what Board / member / PDF viewers re-render from; publishing a
  // mismatched snapshot would freeze a defect into governance-visible
  // history. Refuse the publish with a clear diagnostic instead — the
  // administrator must fix the underlying classification and retry.
  // Founder rule 2026-07-14 v15.23 — Current-Year Earnings guard runs
  // BEFORE the generic reconciliation guard so administrators receive
  // the more specific diagnostic when the imbalance is caused by a
  // missing YTD line (the most common cause after v15.22 shipped).
  if (liveReport.statementOfFinancialPositionV2) {
    const ytdFailures = validateCurrentYearEarnings(
      liveReport.statementOfFinancialPositionV2,
    );
    if (ytdFailures.length > 0) {
      throw new Error(
        `${ytdFailures[0].split(":")[0]}: Publication blocked. ` +
          `${ytdFailures.join("\n  - ")}`,
      );
    }
  }

  const sofpReconciliation = liveReport.statementOfFinancialPositionV2?.reconciliation;
  if (sofpReconciliation && !sofpReconciliation.balances) {
    throw new Error(
      `BALANCE_SHEET_OUT_OF_BALANCE: Statement of Financial Position does not ` +
        `reconcile to the Trial Balance. ` +
        `Total Assets $${Math.round(sofpReconciliation.totalAssetsCurrent).toLocaleString("en-US")}, ` +
        `Total Liabilities + Members' Equity $${Math.round(sofpReconciliation.totalLiabilitiesAndEquityCurrent).toLocaleString("en-US")}, ` +
        `Difference $${Math.round(sofpReconciliation.difference ?? 0).toLocaleString("en-US")}. ` +
        `Publication blocked. Review the reconciliation diagnostics in the admin preview and retry after fixing the projection.`,
    );
  }

  // Founder rule 2026-07-13 v15.21 — sign-pipeline invariants.
  // Every drill-down must sum to its FS-Group parent. When this
  // diverges, an account-level sign convention has drifted from
  // the parent — the exact failure mode that produced account 2017
  // being added instead of deducted from Accounts Payable.
  // Publication is blocked on ANY mismatch across the entire
  // Statement of Financial Position.
  if (liveReport.statementOfFinancialPositionV2) {
    const invariantFailures = validateSofPSignInvariants(
      liveReport.statementOfFinancialPositionV2,
    );
    if (invariantFailures.length > 0) {
      throw new Error(
        `FS_GROUP_DETAIL_MISMATCH: sign-pipeline invariants failed. ` +
          `Publication blocked. Failures:\n  - ${invariantFailures.join("\n  - ")}`,
      );
    }
  }

  // Executive Opening snapshot — cover identity, period eyebrows,
  // executive summary headline + KPI cards. Together these power
  // the cover band the board sees first.
  const executiveOpening = {
    club: liveReport.club,
    period: liveReport.period,
    preparedFor: liveReport.preparedFor,
    preparedAt: liveReport.preparedAt,
    executiveSummary: liveReport.executiveSummary,
  };

  // At-a-Glance KPIs — same four canonical KPI keys the cover's
  // lower-left block renders (ytd-revenue / noi / capital-income /
  // reserve-coverage). Stored as the full KpiCard objects (label,
  // value, comparison, tone) so the archive can re-render the
  // tiles identically without re-running the reporting service.
  const COVER_AT_A_GLANCE_KEYS = [
    "ytd-revenue",
    "noi",
    "capital-income",
    "reserve-coverage",
  ];
  const atAGlanceKpis = COVER_AT_A_GLANCE_KEYS.map((key) =>
    liveReport.executiveSummary.kpis.find((k) => k.key === key),
  ).filter(Boolean);

  // Full payload — gives the archive the option to re-render the
  // entire document in its frozen state.
  const packagePayload = liveReport;

  const publishedAt = new Date();
  const publishedPayloadHash = computePublishedPayloadHash(atAGlanceKpis);
  const recipients = await defaultBoardRecipients(pkg.clubId);
  const overwroteExisting = pkg.status !== PACKAGE_STATUS.DRAFT;

  // ─── Capture pre-write Live state ───────────────────────────────
  //
  // We need to know what was Live BEFORE we touch anything so we
  // can classify the transition correctly for the audit log:
  //   • If no Live existed → DRAFT->PUBLISHED (first ever).
  //   • If Live was this very row → OVERWRITE_LIVE.
  //   • If Live was a DIFFERENT row + we end up Live → ADVANCE_LIVE.
  //   • If we don't end up Live → OVERWRITE_HISTORICAL.
  const priorLiveRow = await prisma.monthlyPackage.findFirst({
    where: {
      clubId: pkg.clubId,
      status: { in: [PACKAGE_STATUS.PUBLISHED, PACKAGE_STATUS.SENT] },
    },
    orderBy: [{ reportingYear: "desc" }, { reportingMonth: "desc" }],
    select: { id: true, reportingYear: true, reportingMonth: true },
  });

  // ─── Persist + normalize in a single transaction ────────────────
  //
  // 1. Update the row's snapshot fields + set status tentatively
  //    to PUBLISHED. (Tentative — `normalizeLivePointer` below
  //    will demote it back to ARCHIVED if a newer period exists.)
  // 2. Run the canonical normalization so the greatest period for
  //    this club ends up PUBLISHED and every other non-DRAFT row
  //    ends up ARCHIVED — the founder's greatest-period-wins rule.
  // 3. Re-read the row's final status to know whether THIS publish
  //    landed it as the Live or as an Archived historical row.
  const { resultingStatus, liveId } = await prisma.$transaction(async (tx) => {
    await tx.monthlyPackage.update({
      where: { id: pkg.id },
      data: {
        // Tentative — normalizeLivePointer below decides the final
        // status by comparing periods.
        status: PACKAGE_STATUS.PUBLISHED,
        publishedAt,
        publishedByUserId: principal.id,
        executiveOpeningSnapshotJson: JSON.stringify(executiveOpening),
        atAGlanceKpisJson: JSON.stringify(atAGlanceKpis),
        packagePayloadJson: JSON.stringify(packagePayload),
        publishedPayloadHash,
      },
    });
    const norm = await normalizeLivePointer(pkg.clubId, tx);
    const final = await tx.monthlyPackage.findUnique({
      where: { id: pkg.id },
      select: { status: true },
    });
    return {
      resultingStatus: (final?.status ?? PACKAGE_STATUS.ARCHIVED) as
        | "PUBLISHED"
        | "ARCHIVED",
      liveId: norm.liveId,
    };
  });

  const becameLive = liveId === pkg.id;

  // Classify the transition. Uses the pre-write `priorLiveRow`
  // snapshot, not the post-normalize state, so the audit log
  // captures what the operator's action MEANT.
  let transition:
    | "DRAFT->PUBLISHED"
    | "OVERWRITE_LIVE"
    | "OVERWRITE_HISTORICAL"
    | "ADVANCE_LIVE";
  if (becameLive) {
    if (!priorLiveRow) {
      transition = "DRAFT->PUBLISHED";
    } else if (priorLiveRow.id === pkg.id) {
      transition = "OVERWRITE_LIVE";
    } else {
      transition = "ADVANCE_LIVE";
    }
  } else {
    transition = "OVERWRITE_HISTORICAL";
  }
  const priorLiveArchivedId =
    transition === "ADVANCE_LIVE" && priorLiveRow ? priorLiveRow.id : null;

  // ─── Recipient refresh ──────────────────────────────────────────
  //
  // Only refresh recipients when this row is now the Live row.
  // Overwriting a historical (archived) period does NOT touch
  // recipients — nobody reads the archive, and we must not re-fire
  // NEW badges on the Live row for an unrelated historical
  // correction.
  let recipientCount = 0;
  if (becameLive) {
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
    recipientCount = recipients.length;
  }

  await audit(principal, {
    action: "reporting.monthly-package.publish",
    entityType: "MonthlyPackage",
    entityId: pkg.id,
    clubId: pkg.clubId,
    after: {
      publishedAt: publishedAt.toISOString(),
      transition,
      priorStatus: pkg.status,
      resultingStatus,
      becameLive,
      liveAdvanced: transition === "ADVANCE_LIVE",
      priorLiveArchivedId,
      kpiCount: atAGlanceKpis.length,
      recipientCount,
    },
  });
  return {
    packageId: pkg.id,
    publishedPackageId: pkg.id,
    publishedAt,
    recipientCount,
    resultingStatus,
    liveAdvanced: transition === "ADVANCE_LIVE",
    overwroteExisting,
    transition,
  };
}

// ---------------------------------------------------------------------------
// sendMonthlyPackage
// ---------------------------------------------------------------------------

export type SendRecipientInput = {
  /** Spectre user id, if the recipient has an account. */
  userId?: string | null;
  email: string;
  role?: string | null;
};

/**
 * Distribute a package: status → SENT, populate the recipient
 * table. If the package is still DRAFT, publishes first (capturing
 * the snapshot) so the recipients ALWAYS get a frozen snapshot,
 * not live ledger data.
 *
 * Recipient resolution:
 *   1. Explicit `opts.recipients` from the caller (manual list).
 *   2. Otherwise: every active user at the club with the
 *      BOARD_READ_ONLY role. (The roster is intentionally narrow —
 *      we don't auto-spam admins; only people whose role exists
 *      explicitly to receive board reporting.)
 *
 * Email dispatch is NOT performed here. Recipients are written in
 * `deliveryStatus: PENDING`. A future delivery adapter flips them
 * to SENT / OPENED.
 */
export async function sendMonthlyPackage(
  principal: Principal,
  packageId: string,
  opts?: { recipients?: ReadonlyArray<SendRecipientInput> },
): Promise<{ packageId: string; sentAt: Date; recipientCount: number }> {
  const pkg = await prisma.monthlyPackage.findUnique({
    where: { id: packageId },
    select: {
      id: true,
      clubId: true,
      status: true,
    },
  });
  if (!pkg) throw new NotFoundError("MonthlyPackage", packageId);
  ensureBoardReports(principal, pkg.clubId);

  // DRAFT → publish first so the snapshot exists before send.
  if (pkg.status === "DRAFT") {
    await publishMonthlyPackage(principal, pkg.id);
  }

  // Build the recipient list.
  const recipients: SendRecipientInput[] = opts?.recipients
    ? Array.from(opts.recipients)
    : await defaultBoardRecipients(pkg.clubId);

  // Wipe + recreate. Resend semantics: every send distributes the
  // CURRENT recipient list; prior recipients aren't carried forward
  // unless the caller explicitly includes them.
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

  const sentAt = new Date();
  await prisma.monthlyPackage.update({
    where: { id: pkg.id },
    data: {
      status: "SENT",
      sentAt,
      sentByUserId: principal.id,
    },
  });
  // Re-normalize: if the operator sent an OLDER period than the
  // current Live, the SENT row is demoted back to ARCHIVED so the
  // greatest-period-wins invariant holds. (If the sent period IS
  // the greatest, the SENT status is preserved — it carries the
  // recipient-distribution history.)
  await normalizeLivePointer(pkg.clubId);
  await audit(principal, {
    action: "reporting.monthly-package.send",
    entityType: "MonthlyPackage",
    entityId: pkg.id,
    clubId: pkg.clubId,
    after: {
      sentAt: sentAt.toISOString(),
      recipientCount: recipients.length,
    },
  });
  return { packageId: pkg.id, sentAt, recipientCount: recipients.length };
}

/**
 * Resolve the current Board recipient roster for a club. This is
 * the SINGLE SOURCE OF TRUTH used by every recipient-creation
 * surface (publish, send, resend) — keeping these paths aligned
 * fixes the founder's 2026-06-29 bug where the dashboard tile
 * showed an active Board member (James Whitfield = President) but
 * the package archive had Recipients (0) because resend wasn't
 * rebuilding from the live roster.
 *
 * Unions TWO sources, deduplicated by `userId`:
 *
 *   1. `UserClubRole.roleKey = BOARD_READ_ONLY` — the historical
 *      permission-based path (a User explicitly granted the
 *      board-perm role). Used when a finance staffer or an
 *      external board contact has a dedicated User account whose
 *      sole purpose is to receive board distributions.
 *
 *   2. Active `BoardRole` rows from Governance → Board & Committees
 *      whose Member has a linked User. This is the path used by
 *      members elected to the board (President / VP / Treasurer
 *      / Director / etc.) who hold a regular MEMBER role; their
 *      board access is granted by the term, not by a separate
 *      permission grant. The `roleTitle` (President / Treasurer /
 *      etc.) is preserved on the recipient row.
 *
 * Eligibility filter:
 *   • Active term window: `termStartDate <= now <= termEndDate`.
 *   • Stored status not EXPIRED (so a manually-revoked role is
 *     excluded even if the date window still covers today).
 *   • Linked User is ACTIVE.
 *   • User email is non-empty (enforced by the schema's
 *     `User.email` NOT NULL constraint — we trust it).
 *
 * Empty when the club has no eligible Board members yet (publish/
 * send still succeed with an empty recipient set; the audit log
 * records `recipientCount: 0`).
 *
 * Exported so the archive surface's resend action can share this
 * resolver — see `resendMonthlyPackage` in
 * `monthly-package-archive.ts`.
 */
export async function defaultBoardRecipients(clubId: string): Promise<SendRecipientInput[]> {
  const now = new Date();
  // Two recipient paths, unioned by userId:
  //
  //   1. UserClubRole.roleKey = BOARD_READ_ONLY — the historical
  //      permission-based path.
  //   2. BoardRole rows currently within their term window AND
  //      NOT manually revoked (stored status != EXPIRED) — the
  //      Governance → Board & Committees module's roster. This
  //      pulls in members elected to the board (President / VP /
  //      Treasurer / etc.) who hold a regular MEMBER role; their
  //      board access is granted by the term, not by a separate
  //      permission grant.
  //
  // A member who appears in BOTH paths is included once.
  const [roleMemberships, activeBoardRoles] = await Promise.all([
    prisma.userClubRole.findMany({
      where: { clubId, roleKey: "BOARD_READ_ONLY" },
      include: {
        user: { select: { id: true, email: true, status: true } },
      },
    }),
    prisma.boardRole.findMany({
      where: {
        clubId,
        status: { not: "EXPIRED" },
        termStartDate: { lte: now },
        termEndDate: { gte: now },
      },
      include: {
        member: {
          select: {
            email: true,
            user: { select: { id: true, email: true, status: true } },
          },
        },
      },
    }),
  ]);

  const byUserId = new Map<string, SendRecipientInput>();

  for (const m of roleMemberships) {
    if (!m.user || m.user.status !== "ACTIVE") continue;
    byUserId.set(m.user.id, {
      userId: m.user.id,
      email: m.user.email,
      role: "Board Member",
    });
  }

  for (const r of activeBoardRoles) {
    const linkedUser = r.member.user;
    if (!linkedUser || linkedUser.status !== "ACTIVE") continue;
    // Already added via UserClubRole path → no duplicate; keep the
    // first-seen entry (which uses role label "Board Member").
    if (byUserId.has(linkedUser.id)) continue;
    byUserId.set(linkedUser.id, {
      userId: linkedUser.id,
      email: linkedUser.email,
      // Use the actual board title from the role for clarity in
      // the recipient list (President, Treasurer, etc.).
      role: r.roleTitle,
    });
  }

  return Array.from(byUserId.values());
}

// ---------------------------------------------------------------------------
// listSentPackagesForBoard
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// getMostRecentBoardPackageForUser
// ---------------------------------------------------------------------------

/** Shape consumed by the Board dashboard tile.
 *
 *  `atAGlanceKpis` carries whatever shape the snapshot was captured
 *  with — typically a `KpiCard[]` from the reporting service. The
 *  tile renders the four canonical cover KPIs (ytd-revenue / noi /
 *  capital-income / reserve-coverage) but the shape is left loose
 *  here because the snapshot is JSON and we don't want to crash the
 *  dashboard if the reporting service's KpiCard type ever changes.
 */
export type BoardTilePackage = {
  id: string;
  reportingYear: number;
  reportingMonth: number;
  periodEndDate: Date;
  periodKey: string;        // "YYYY-MM" — URL-ready
  periodLabel: string;      // "May 2026"
  title: string;
  status: string;           // PUBLISHED | SENT
  publishedAt: Date | null;
  sentAt: Date | null;
  atAGlanceKpis: ReadonlyArray<{
    key?: string;
    label?: string;
    value?: string | number | null;
    /** Often a string like "+3.2% vs. budget" — present on cover KPIs. */
    variance?: string | null;
    tone?: string | null;
  }>;
  /**
   * True when the current user is a recipient of this package AND
   * they have NOT yet opened it. Drives the "NEW" badge on the tile.
   *
   * False when:
   *   • the user has already opened it (their `viewedAt` is set), OR
   *   • the user has board-perm but no recipient row (they're not a
   *     "notified" board member — they have permission to see the
   *     package but it wasn't explicitly distributed to them).
   *
   * The badge is removed per-user, not globally — one board member
   * opening the package does NOT clear the NEW badge for every
   * other board member.
   */
  isNewForUser: boolean;
};

const BOARD_TILE_STATUSES = ["PUBLISHED", "SENT"];

/**
 * Resolve the package the Board Dashboard tile should show for this
 * user. Visibility rules:
 *
 *   1. SUPER_ADMIN or any role carrying `reports:board` on this
 *      club → sees the most-recent PUBLISHED/SENT package for the
 *      whole club.
 *   2. Otherwise (regular member, finance staff without board perm,
 *      etc.) → only sees a package WHERE THEY ARE A RECIPIENT
 *      (`recipientUserId === principal.id`). Returns the most-
 *      recent such package by period end.
 *   3. Otherwise → returns null. The dashboard hides the tile.
 *
 * The returned `atAGlanceKpis` come from
 * `MonthlyPackage.atAGlanceKpisJson` — the snapshot captured at
 * publish time. NEVER from the live reporting service, so a board
 * recipient always sees the numbers they were given even if the
 * ledger has shifted since.
 */
export async function getMostRecentBoardPackageForUser(
  principal: Principal,
  clubId: string,
): Promise<BoardTilePackage | null> {
  const canSeeAll =
    isSuperAdmin(principal) || hasPermission(principal, clubId, "reports:board");
  // Members who hold an effectively-ACTIVE BoardRole today are
  // granted the same "see all" view as users with the
  // reports:board role permission. This is the access path the
  // Board & Committees admin module creates — a member assigned
  // President / Director / Treasurer etc. with a current term
  // sees the board tile + can open published packages without
  // also being granted BOARD_READ_ONLY in UserClubRole.
  const isActiveBoardRoleHolder = canSeeAll
    ? false
    : await isActiveBoardMember(principal, clubId);

  const grantedFullAccess = canSeeAll || isActiveBoardRoleHolder;

  const row = grantedFullAccess
    ? await prisma.monthlyPackage.findFirst({
        where: { clubId, status: { in: BOARD_TILE_STATUSES } },
        orderBy: [{ periodEndDate: "desc" }, { generatedAt: "desc" }],
      })
    : await prisma.monthlyPackage.findFirst({
        where: {
          clubId,
          status: { in: BOARD_TILE_STATUSES },
          recipients: {
            some: { recipientUserId: principal.id },
          },
        },
        orderBy: [{ periodEndDate: "desc" }, { generatedAt: "desc" }],
      });

  if (!row) return null;

  // Parse the at-a-glance snapshot. The captured shape is a JSON
  // array of KpiCard objects (or whatever the reporting service's
  // structure was at publish time). Failing to parse must not blow
  // up the dashboard — return an empty array and let the tile
  // render its "no KPIs captured" state.
  let atAGlanceKpis: BoardTilePackage["atAGlanceKpis"] = [];
  if (row.atAGlanceKpisJson) {
    try {
      const parsed = JSON.parse(row.atAGlanceKpisJson);
      if (Array.isArray(parsed)) atAGlanceKpis = parsed;
    } catch {
      // Bad JSON — treat as no snapshot.
    }
  }

  // Per-user "NEW" tracking. The badge appears for board members
  // who have a recipient row AND haven't opened the package yet.
  // Once they click through to the full view, `viewedAt` is set
  // (see `markPackageViewedByUser`) and the badge disappears for
  // THEM. Other board members still see NEW until they personally
  // open it.
  const myRecipient = await prisma.monthlyPackageRecipient.findFirst({
    where: { monthlyPackageId: row.id, recipientUserId: principal.id },
    select: { viewedAt: true },
  });
  const isNewForUser = myRecipient ? myRecipient.viewedAt === null : false;

  const monthLong = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ][row.reportingMonth - 1];
  const periodKey = `${row.reportingYear}-${String(row.reportingMonth).padStart(2, "0")}`;
  const periodLabel = `${monthLong} ${row.reportingYear}`;

  return {
    id: row.id,
    reportingYear: row.reportingYear,
    reportingMonth: row.reportingMonth,
    periodEndDate: row.periodEndDate,
    periodKey,
    periodLabel,
    title: row.title,
    status: row.status,
    publishedAt: row.publishedAt,
    sentAt: row.sentAt,
    atAGlanceKpis,
    isNewForUser,
  };
}

// ---------------------------------------------------------------------------
// markPackageViewedByUser
// ---------------------------------------------------------------------------

/**
 * Mark a package as viewed by the current user. Sets `viewedAt` on
 * the user's `MonthlyPackageRecipient` row to now (only if it's
 * currently null — re-opens after the first view are no-ops).
 *
 * Called from the board view page (/app/reports/monthly-package/[id])
 * on render, after authorisation has succeeded. The page does NOT
 * call this for users who reached the package via board-perm
 * without being a recipient — those users aren't tracked because
 * they aren't a "notified" board member.
 *
 * Tenant safety: the `WHERE` clause requires both
 * `monthlyPackageId` AND `recipientUserId`, so a crafted call from
 * another tenant cannot mark someone else's recipient row.
 */
export async function markPackageViewedByUser(
  principal: Principal,
  packageId: string,
): Promise<{ updated: number }> {
  const result = await prisma.monthlyPackageRecipient.updateMany({
    where: {
      monthlyPackageId: packageId,
      recipientUserId: principal.id,
      viewedAt: null,
    },
    data: {
      viewedAt: new Date(),
      // Match the existing PackageDistribution convention: a viewed
      // row is implicitly delivered too. Without flipping this, a
      // recipient who lands on the page directly (e.g. via a URL
      // shared by another board member) would still show as
      // PENDING in the archive's recipients listing.
      deliveryStatus: "OPENED",
    },
  });
  return { updated: result.count };
}

// ---------------------------------------------------------------------------
// getBoardPackageView
// ---------------------------------------------------------------------------

/**
 * Shape consumed by the dedicated read-only Board package view at
 * `/app/reports/monthly-package/[id]`. Carries the parsed snapshot
 * JSON fields verbatim so the renderer can show what the recipient
 * was given at publish/send time, even if the underlying ledger has
 * moved since.
 */
export type BoardPackageView = {
  id: string;
  reportingYear: number;
  reportingMonth: number;
  periodEndDate: Date;
  periodKey: string;       // "YYYY-MM"
  periodLabel: string;     // "May 2026"
  title: string;
  status: string;          // PUBLISHED | SENT (DRAFT is never returned)
  publishedAt: Date | null;
  sentAt: Date | null;

  /** Snapshot — `MonthlyPackage.executiveOpeningSnapshotJson`
   *  parsed. Carries `club`, `period`, `preparedFor`, `preparedAt`,
   *  `executiveSummary` (headline + KPIs + board consideration). */
  executiveOpening: Record<string, unknown> | null;

  /** Snapshot — `MonthlyPackage.atAGlanceKpisJson` parsed. */
  atAGlanceKpis: ReadonlyArray<Record<string, unknown>>;

  /** Snapshot — `MonthlyPackage.packagePayloadJson` parsed.
   *  Carries the full structured payload (every chapter / scorecard
   *  the reporting service returned at publish). The renderer pulls
   *  high-level chapter summaries out of this; full chapter-by-
   *  chapter parity with the admin route is not required (admin
   *  controls + publish bar are absent). */
  fullPayload: Record<string, unknown> | null;
};

/**
 * Resolve a single MonthlyPackage and check the caller is authorised
 * to view it. Visibility rules — the SAME as the dashboard tile:
 *
 *   1. SUPER_ADMIN or `reports:board` on the package's club → can
 *      view ANY PUBLISHED / SENT package for that club.
 *   2. Non-board user (regular member, finance staff without board
 *      perm, etc.) → can view ONLY when they hold a
 *      `MonthlyPackageRecipient` row pointing at their userId on
 *      THIS specific package.
 *   3. Otherwise → returns null. The page renders a 404 so we never
 *      leak the existence of a package the caller can't see.
 *
 * Tenant safety: clubId is re-resolved from the package row, so a
 * crafted packageId from another tenant cannot bypass the gate.
 */
export async function getBoardPackageView(
  principal: Principal,
  packageId: string,
): Promise<BoardPackageView | null> {
  const row = await prisma.monthlyPackage.findUnique({
    where: { id: packageId },
    select: {
      id: true,
      clubId: true,
      reportingYear: true,
      reportingMonth: true,
      periodEndDate: true,
      title: true,
      status: true,
      publishedAt: true,
      sentAt: true,
      executiveOpeningSnapshotJson: true,
      atAGlanceKpisJson: true,
      packagePayloadJson: true,
    },
  });
  if (!row) return null;

  const hasBoardPerm =
    isSuperAdmin(principal) || hasPermission(principal, row.clubId, "reports:board");
  // packages:write is held by CLUB_ADMIN / GENERAL_MANAGER / CONTROLLER
  // / FINANCE_ADMIN but NOT by BOARD_READ_ONLY. This is the gate we
  // use specifically for ARCHIVED access — the founder's spec says
  // "Board Members should never access archived revisions unless
  // that functionality is intentionally added in the future." Admins
  // / controllers reach archived packages through the archive list.
  const hasArchiveAccess =
    isSuperAdmin(principal) || hasPermission(principal, row.clubId, "packages:write");

  // Status visibility:
  //   • DRAFT     → never viewable on this surface.
  //   • PUBLISHED / SENT (legacy) → viewable by anyone authorised.
  //   • ARCHIVED  → viewable ONLY by admins/controllers (packages:write).
  //                 Board members + recipients are blocked.
  if (row.status === "DRAFT") return null;
  if (row.status === "ARCHIVED" && !hasArchiveAccess) return null;

  if (!hasBoardPerm) {
    // Members who hold an effectively-ACTIVE BoardRole at this
    // club today get the same access as users with the
    // reports:board permission — this is the Board & Committees
    // module's access path. Checked BEFORE the recipient-link
    // gate so an active board member who happens to NOT also
    // appear in the recipient table can still open the package.
    const isBoardMember = await isActiveBoardMember(principal, row.clubId);
    if (!isBoardMember) {
      // Recipient gate for PUBLISHED/SENT — must hold a row on THIS
      // package. (ARCHIVED was already blocked above for non-admins.)
      const isRecipient = await prisma.monthlyPackageRecipient.findFirst({
        where: { monthlyPackageId: row.id, recipientUserId: principal.id },
        select: { id: true },
      });
      if (!isRecipient) return null;
    }
  }

  const safeParse = (s: string | null) => {
    if (!s) return null;
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" ? v : null;
    } catch {
      return null;
    }
  };

  const executiveOpening = safeParse(row.executiveOpeningSnapshotJson);
  const fullPayload = safeParse(row.packagePayloadJson);
  let atAGlanceKpis: ReadonlyArray<Record<string, unknown>> = [];
  if (row.atAGlanceKpisJson) {
    try {
      const parsed = JSON.parse(row.atAGlanceKpisJson);
      if (Array.isArray(parsed)) atAGlanceKpis = parsed;
    } catch { /* fall through to empty */ }
  }

  const monthLong = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ][row.reportingMonth - 1];
  const periodKey = `${row.reportingYear}-${String(row.reportingMonth).padStart(2, "0")}`;
  const periodLabel = `${monthLong} ${row.reportingYear}`;

  return {
    id: row.id,
    reportingYear: row.reportingYear,
    reportingMonth: row.reportingMonth,
    periodEndDate: row.periodEndDate,
    periodKey,
    periodLabel,
    title: row.title,
    status: row.status,
    publishedAt: row.publishedAt,
    sentAt: row.sentAt,
    executiveOpening,
    atAGlanceKpis,
    fullPayload,
  };
}

/**
 * Board-user read surface. Returns SENT packages for the club in
 * reverse chronological order — what's been distributed to the
 * board. DRAFT + PUBLISHED rows are excluded (they're internal to
 * the controller's prep workflow).
 */
export async function listSentPackagesForBoard(
  principal: Principal,
  clubId: string,
) {
  ensureBoardReports(principal, clubId);
  const rows = await prisma.monthlyPackage.findMany({
    where: { clubId, status: "SENT" },
    orderBy: [{ periodEndDate: "desc" }, { sentAt: "desc" }],
    select: {
      id: true,
      reportingYear: true,
      reportingMonth: true,
      periodEndDate: true,
      title: true,
      sentAt: true,
      sentBy: { select: { name: true } },
    },
  });
  return rows;
}
