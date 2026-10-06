// COA-MAP-1 (2026-10-06) — Mapping Studio workspace.
//
// Server component: loads the hierarchy of Financial Statement Groups
// + Accounts, groups accounts by their current `Account.fsGroupId`.
// The client island below handles drag/drop + Account Inspector.

import { redirect } from "next/navigation";

import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { prisma } from "@/lib/prisma";

import MappingWorkspaceClient from "./mapping-workspace-client";

export const dynamic = "force-dynamic";

export default async function CoaMappingPage() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  if (!hasPermission(principal, clubId, "settings:write")) redirect("/app/admin");

  const groups = await prisma.financialStatementGroup.findMany({
    where: { clubId },
    orderBy: [{ statement: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      key: true,
      name: true,
      statement: true,
      parentGroupId: true,
      reportingRole: true,
      isTenantCreated: true,
      sortOrder: true,
    },
  });

  const accounts = await prisma.account.findMany({
    where: { clubId, isActive: true },
    orderBy: { accountNumber: "asc" },
    select: {
      id: true,
      accountNumber: true,
      name: true,
      type: true,
      normalBalance: true,
      fsGroupId: true,
      fundApplicability: true,
    },
  });

  const accountsByGroup = new Map<string | null, typeof accounts>();
  for (const a of accounts) {
    const bucket = accountsByGroup.get(a.fsGroupId) ?? [];
    bucket.push(a);
    accountsByGroup.set(a.fsGroupId, bucket);
  }

  const groupsWithAccounts = groups.map((g) => ({
    ...g,
    accounts: accountsByGroup.get(g.id) ?? [],
  }));
  const unmapped = accountsByGroup.get(null) ?? [];

  const incomeStatementGroups = groupsWithAccounts.filter((g) => g.statement === "INCOME_STATEMENT");
  const balanceSheetGroups    = groupsWithAccounts.filter((g) => g.statement === "BALANCE_SHEET");
  const cashFlowGroups        = groupsWithAccounts.filter((g) => g.statement === "CASH_FLOW");
  const otherGroups           = groupsWithAccounts.filter(
    (g) => g.statement !== "INCOME_STATEMENT" && g.statement !== "BALANCE_SHEET" && g.statement !== "CASH_FLOW",
  );

  return (
    <div className="space-y-6">
      <header data-testid="coa-mapping-header">
        <h1 className="page-title">Chart of Accounts — Financial Statement Mapping</h1>
        <p className="mt-1 max-w-3xl text-sm text-stone-500">
          Teach Spectre how your club&apos;s finances should be presented. Drag an
          account between Financial Statement Groups to change where it reports,
          or create a new group for a classification that doesn&apos;t exist yet.
          Changes are effective-dated and audit-logged. Published Board packages
          remain immutable; live admin previews restate from the as-of date you
          select.
        </p>
      </header>

      <MappingWorkspaceClient
        clubId={clubId}
        incomeStatement={incomeStatementGroups}
        balanceSheet={balanceSheetGroups}
        cashFlow={cashFlowGroups}
        other={otherGroups}
        unmapped={unmapped}
      />
    </div>
  );
}
