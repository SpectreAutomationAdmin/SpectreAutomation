// AR-HIST-1 §12 — staging-only diagnostic: enumerate every ASSET
// account in the Jan 31 BS snapshot whose fsGroupKey is in the
// AR family, with natural balances. The founder uses this output
// to deterministically identify the correct AR control account for
// the January AR subledger reconciliation.
//
// Zero writes.

import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { reportingAccountBalances } from "@/lib/accounting/reporting-balances";
import { consolidateAccountBalances } from "@/lib/accounting/balance";
import { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

function isStaging(): boolean {
  const env = (process.env.SPECTRE_ENV ?? process.env.NEXT_PUBLIC_ENVIRONMENT ?? "").toLowerCase();
  if (env === "staging") return true;
  return env !== "production" && (process.env.NODE_ENV ?? "") !== "production";
}
function hasClubAccess(p: Principal, clubId: string): boolean {
  if (isSuperAdmin(p)) return true;
  return p.memberships.some((m) => m.clubId === clubId);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const clubId = (req.nextUrl.searchParams.get("clubId") ?? "").trim();
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const asOf = new Date(Date.UTC(2026, 0, 31, 23, 59, 59, 999));
  const result = await reportingAccountBalances(clubId, { asOf }, { allowCarryForward: true });
  const consolidated = consolidateAccountBalances(result.balances);

  const AR_FS_GROUPS = new Set(["BS_AR", "BS_MEMBER_AR", "BS_OTHER_ASSETS"]);
  const accountIds = new Set<string>();
  for (const b of consolidated) {
    if (!b.accountId) continue;
    if (b.fsGroupKey && AR_FS_GROUPS.has(b.fsGroupKey)) accountIds.add(b.accountId);
  }
  const accounts = accountIds.size > 0
    ? await prisma.account.findMany({
        where: { id: { in: Array.from(accountIds) } },
        select: {
          id: true,
          accountNumber: true,
          name: true,
          type: true,
          isControlAccount: true,
          category: { select: { key: true, name: true } },
          fsGroup: { select: { key: true, name: true } },
          parent: { select: { accountNumber: true, name: true } },
        },
      })
    : [];

  const sumBy = (fsGroupKey: string) => {
    let total = new Prisma.Decimal(0);
    for (const b of consolidated) {
      if (b.fsGroupKey === fsGroupKey && b.accountType === "ASSET") {
        total = total.plus(b.naturalBalance);
      }
    }
    return total.toString();
  };

  // For each account in these groups, surface account natural balance.
  const perAccount = accounts.map((a) => {
    const row = consolidated.find((b) => b.accountId === a.id);
    return {
      accountNumber: a.accountNumber,
      name: a.name,
      type: a.type,
      isControlAccount: a.isControlAccount,
      categoryKey: a.category?.key ?? null,
      fsGroupKey: a.fsGroup?.key ?? null,
      fsGroupName: a.fsGroup?.name ?? null,
      parentAccountNumber: a.parent?.accountNumber ?? null,
      parentName: a.parent?.name ?? null,
      naturalBalance: row?.naturalBalance?.toString() ?? "0",
    };
  });
  // Sort by fsGroupKey then accountNumber.
  perAccount.sort((a, b) =>
    (a.fsGroupKey ?? "").localeCompare(b.fsGroupKey ?? "") ||
    (a.accountNumber ?? "").localeCompare(b.accountNumber ?? ""),
  );

  return NextResponse.json({
    asOf: asOf.toISOString().slice(0, 10),
    source: result.source,
    perFsGroupTotal: {
      BS_AR: sumBy("BS_AR"),
      BS_MEMBER_AR: sumBy("BS_MEMBER_AR"),
      BS_OTHER_ASSETS: sumBy("BS_OTHER_ASSETS"),
    },
    accounts: perAccount,
    expectedArSubledgerTotal: "3585590.56",
  });
}
