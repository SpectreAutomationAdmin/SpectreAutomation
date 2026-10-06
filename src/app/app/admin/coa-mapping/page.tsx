// COA-MAP-1 (2026-10-06) — Mapping Studio workspace.
// COA-MAP-2 (2026-10-06) — Spectre-grade header + status strip +
// attention computation; passes activeStatement from URL into the
// client island so the statement switcher reflects the deep-link.
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

export default async function CoaMappingPage(props: {
  searchParams?: Promise<{ statement?: string }>;
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  if (!hasPermission(principal, clubId, "settings:write")) redirect("/app/admin");

  const sp = (await props.searchParams) ?? {};
  const requestedStatement = (sp.statement ?? "").toLowerCase();
  const activeStatement: "INCOME_STATEMENT" | "BALANCE_SHEET" | "CASH_FLOW" =
    requestedStatement === "bs" ? "BALANCE_SHEET"
    : requestedStatement === "cf" ? "CASH_FLOW"
    : "INCOME_STATEMENT";

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

  // Attention computation — groups that participate in reporting
  // but have no reportingRole (the role backfill left them null
  // and no Controller has classified them yet). Default seeded
  // groups all have roles; this surfaces only tenant-created groups
  // that need classification OR unmapped accounts.
  const attentionGroups = groupsWithAccounts.filter(
    (g) =>
      g.isTenantCreated &&
      g.reportingRole === null &&
      (g.statement === "INCOME_STATEMENT" || g.statement === "BALANCE_SHEET"),
  );
  const needsAttentionCount = attentionGroups.length + unmapped.length;

  const stats = {
    totalAccounts: accounts.length,
    mappedAccounts: accounts.length - unmapped.length,
    unmappedAccounts: unmapped.length,
    needsAttention: needsAttentionCount,
  };

  return (
    <div className="space-y-8">
      <header className="space-y-5" data-testid="coa-mapping-header">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
            Chart of Accounts
          </p>
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-stone-900">
            Financial Statement Mapping
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-stone-600">
            Organize how your accounts flow into financial reporting. Drag an
            account between Financial Statement Groups, create a group for a
            classification that doesn&apos;t exist, and see exactly what will
            change before you apply.
          </p>
        </div>

        <dl
          className="flex flex-wrap items-end gap-x-10 gap-y-3 border-t border-stone-200/80 pt-4"
          data-testid="coa-mapping-status-strip"
        >
          <StatItem label="Accounts" value={stats.totalAccounts.toString()} />
          <StatItem label="Mapped" value={stats.mappedAccounts.toString()} />
          <StatItem
            label="Unmapped"
            value={stats.unmappedAccounts.toString()}
            tone={stats.unmappedAccounts > 0 ? "amber" : "neutral"}
            testid="coa-mapping-stat-unmapped"
          />
          <StatItem
            label="Needs review"
            value={stats.needsAttention.toString()}
            tone={stats.needsAttention > 0 ? "amber" : "neutral"}
            testid="coa-mapping-stat-attention"
          />
        </dl>
      </header>

      <MappingWorkspaceClient
        clubId={clubId}
        activeStatement={activeStatement}
        incomeStatement={incomeStatementGroups}
        balanceSheet={balanceSheetGroups}
        cashFlow={cashFlowGroups}
        other={otherGroups}
        unmapped={unmapped}
        attentionGroupIds={attentionGroups.map((g) => g.id)}
      />
    </div>
  );
}

function StatItem(props: {
  label: string;
  value: string;
  tone?: "neutral" | "amber";
  testid?: string;
}) {
  const valueTone =
    props.tone === "amber" ? "text-amber-700" : "text-stone-900";
  return (
    <div className="flex flex-col gap-0.5" data-testid={props.testid}>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-500">
        {props.label}
      </dt>
      <dd className={`text-xl font-semibold tabular-nums ${valueTone}`}>
        {props.value}
      </dd>
    </div>
  );
}
