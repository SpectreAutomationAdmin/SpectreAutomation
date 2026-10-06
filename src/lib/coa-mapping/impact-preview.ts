// COA-MAP-1 (2026-10-06) — reporting impact preview.
//
// Shows the Controller what will change in the live reporting
// preview if a proposed reassignment were applied. For COA-MAP-1 the
// preview surfaces:
//   - the account's current vs proposed FS Group
//   - whether the move stays within a single statement (Net Income
//     invariant preserved)
//   - whether the move crosses the Operating/Capital Fund boundary
//     (reporting consequence surfaced for the Controller)
//
// Dollar-precision impact (full re-projection) will land in a
// follow-up slice; the current scope is confirming the move's
// categorical effect. The structure is designed so the dollar
// calculation can be added additively without changing the UI shape.

import { prisma } from "@/lib/prisma";
import type { ReportingDataSource } from "@/lib/reporting/monthly-package";

export type ImpactPreviewInput = {
  clubId: string;
  accountId: string;
  targetFsGroupId: string;
};

export type ImpactPreviewRow = {
  key: string;
  label: string;
  beforeLabel: string;
  afterLabel: string;
  deltaLabel: string;
};

export type ImpactPreviewResult = {
  accountNumber: string;
  accountName: string;
  currentFsGroup: { id: string; name: string; statement: string } | null;
  targetFsGroup: { id: string; name: string; statement: string };
  rows: ImpactPreviewRow[];
  dataSource: ReportingDataSource;
  note: string;
};

export async function previewAccountReassignmentImpact(input: ImpactPreviewInput): Promise<ImpactPreviewResult> {
  const account = await prisma.account.findUnique({
    where: { id: input.accountId },
    select: {
      id: true, clubId: true, accountNumber: true, name: true, fsGroupId: true,
      type: true, fundApplicability: true,
      fsGroup: { select: { id: true, name: true, statement: true, key: true } },
    },
  });
  if (!account) throw new Error("Account not found");
  if (account.clubId !== input.clubId) throw new Error("Cross-tenant preview refused");

  const targetGroup = await prisma.financialStatementGroup.findUnique({
    where: { id: input.targetFsGroupId },
    select: { id: true, name: true, statement: true, key: true, reportingRole: true },
  });
  if (!targetGroup) throw new Error("Target group not found");

  const rows: ImpactPreviewRow[] = [];

  rows.push({
    key: "assignment",
    label: `${account.accountNumber} ${account.name}`,
    beforeLabel: account.fsGroup?.name ?? "(unmapped)",
    afterLabel: targetGroup.name,
    deltaLabel:
      `Account ${account.accountNumber} will present in ${targetGroup.name} ` +
      `instead of ${account.fsGroup?.name ?? "(unmapped)"}.`,
  });

  // Statement invariant (Net Income is unchanged iff the move stays
  // within the same statement AND the account type is unchanged — the
  // Mapping Studio never changes account type, so same-statement moves
  // preserve NI).
  if (account.fsGroup?.statement === targetGroup.statement) {
    rows.push({
      key: "net-income",
      label: "Net Income",
      beforeLabel: "unchanged",
      afterLabel: "unchanged",
      deltaLabel:
        `Net Income is unchanged — the move is a presentation reclassification ` +
        `within the ${targetGroup.statement.replace(/_/g, " ").toLowerCase()} and ` +
        `does not change the account's accounting type.`,
    });
  } else {
    rows.push({
      key: "statement-change",
      label: "Statement",
      beforeLabel: account.fsGroup?.statement ?? "(unmapped)",
      afterLabel: targetGroup.statement,
      deltaLabel:
        `The move changes the statement the account reports on. Net Income will ` +
        `be affected. Review dependent consumers before applying.`,
    });
  }

  // Fund axis — Operating vs Capital stays owned by fundApplicability
  // per Decision 2 Option A. If the group's reportingRole suggests a
  // partition different from the account's Fund, surface a note.
  if (account.fundApplicability) {
    const funds = account.fundApplicability.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const operatingRoles = new Set(["OPERATING_REVENUE","MEMBERSHIP_DUES","COGS","PAYROLL","OPERATING_EXPENSE","DEPRECIATION"]);
    const capitalRoles = new Set(["CAPITAL_ASSESSMENTS","ENTRANCE_FEES","CAPITAL_FUND_OTHER_REVENUE"]);
    const isCapitalOnly = funds.length > 0 && funds.every((f) => f === "CAPITAL");
    const isOperatingOnly = funds.length > 0 && funds.every((f) => f === "OPERATING");
    const role = targetGroup.reportingRole;
    if (role && isCapitalOnly && operatingRoles.has(role)) {
      rows.push({
        key: "fund-axis-note",
        label: "Fund axis",
        beforeLabel: "CAPITAL",
        afterLabel: "CAPITAL (unchanged)",
        deltaLabel:
          `The account's Fund classification is CAPITAL and stays CAPITAL — ` +
          `moving to a presentation group with an Operating role does NOT change ` +
          `the Operating-vs-Capital partition. Edit the account's Fund assignment ` +
          `separately if that is the intent.`,
      });
    } else if (role && isOperatingOnly && capitalRoles.has(role)) {
      rows.push({
        key: "fund-axis-note",
        label: "Fund axis",
        beforeLabel: "OPERATING",
        afterLabel: "OPERATING (unchanged)",
        deltaLabel:
          `The account's Fund classification is OPERATING and stays OPERATING — ` +
          `moving to a presentation group with a Capital role does NOT change ` +
          `the Operating-vs-Capital partition. Edit the account's Fund assignment ` +
          `separately if that is the intent.`,
      });
    }
  }

  return {
    accountNumber: account.accountNumber,
    accountName: account.name,
    currentFsGroup: account.fsGroup
      ? { id: account.fsGroup.id, name: account.fsGroup.name, statement: account.fsGroup.statement }
      : null,
    targetFsGroup: { id: targetGroup.id, name: targetGroup.name, statement: targetGroup.statement },
    rows,
    dataSource: "live",
    note:
      "Impact preview surfaces categorical consequences (statement, Fund axis). " +
      "Precise dollar re-projection will be added in a follow-up slice using the " +
      "canonical fs-group-projection resolver — no second calculation engine.",
  };
}
