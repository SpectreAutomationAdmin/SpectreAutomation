// AR-HIST-1A §2-5 (2026-10-03) — read-only January AR residual
// diagnostics. One endpoint, zero writes.
//
//   §2 Account 1201 diagnostic   + Dec→Jan movement for 1200 & 1201
//   §3 MISC A/R overlap          — 299 UNKNOWN profiles vs 728 AR rows
//   §4 AR composition by source  — grouping by sourceStatus etc.
//   §5 Bill-to analysis          — SELF / RESOLVED / UNRESOLVED split
//                                  for the 728 AR-represented Members
//
// Staging-only; rejected in production. Returns aggregates only
// (no synthetic names, no per-member rows).

import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { reportingAccountBalances } from "@/lib/accounting/reporting-balances";
import { consolidateAccountBalances } from "@/lib/accounting/balance";
import { toMoney } from "@/lib/accounting/decimal";

export const dynamic = "force-dynamic";
const ZERO_D = new Prisma.Decimal(0);
const TOL = toMoney("0.001");

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

  // -------------------------------------------------------------
  // §2 Account 1200 + 1201 Dec→Jan diagnostic
  // -------------------------------------------------------------
  const dec = new Date(Date.UTC(2025, 11, 31, 23, 59, 59, 999));
  const jan = new Date(Date.UTC(2026, 0, 31, 23, 59, 59, 999));

  async function readBalances(asOf: Date) {
    const r = await reportingAccountBalances(clubId, { asOf }, { allowCarryForward: true });
    return consolidateAccountBalances(r.balances);
  }
  const [decBalances, janBalances] = await Promise.all([readBalances(dec), readBalances(jan)]);

  function sumBy(balances: typeof janBalances, pred: (b: typeof janBalances[number]) => boolean): Prisma.Decimal {
    let acc = ZERO_D;
    for (const b of balances) if (pred(b)) acc = acc.plus(b.naturalBalance);
    return acc;
  }

  async function describeAccount(accountNumber: string) {
    const a = await prisma.account.findFirst({
      where: { clubId, accountNumber },
      select: {
        accountNumber: true, name: true, type: true, isControlAccount: true,
        category: { select: { key: true, name: true } },
        fsGroup: { select: { key: true, name: true } },
      },
    });
    const dec1 = sumBy(decBalances, (b) => b.accountNumber === accountNumber);
    const jan1 = sumBy(janBalances, (b) => b.accountNumber === accountNumber);
    return {
      accountNumber,
      name: a?.name ?? null,
      type: a?.type ?? null,
      categoryKey: a?.category?.key ?? null,
      categoryName: a?.category?.name ?? null,
      fsGroupKey: a?.fsGroup?.key ?? null,
      fsGroupName: a?.fsGroup?.name ?? null,
      isControlAccount: a?.isControlAccount ?? null,
      decBalance: dec1.toString(),
      janBalance: jan1.toString(),
      decToJanMovement: jan1.minus(dec1).toString(),
    };
  }

  const [account1200, account1201] = await Promise.all([describeAccount("1200"), describeAccount("1201")]);

  // §2 — does the operational ledger have any JournalEntryLine activity
  // for the 1201 account?
  const account1201Record = await prisma.account.findFirst({
    where: { clubId, accountNumber: "1201" },
    select: { id: true },
  });
  const opLedgerActivity1201 = account1201Record
    ? await prisma.journalEntryLine.count({ where: { accountId: account1201Record.id } })
    : null;

  // §2 — is there a committed AR snapshot that reconciles to 1201?
  const arSnapshotTotal = await prisma.arAgingImportBatch.findFirst({
    where: { clubId, status: "COMMITTED", glControlAccountNumber: "1201" },
    select: { id: true },
  });

  // -------------------------------------------------------------
  // §3 MISC A/R overlap diagnostic
  // -------------------------------------------------------------
  // Current-state view: a Member is MISC A/R if their LATEST
  // MembershipHistoryEntry has sourceStatus = "MISC A/R".
  const latestEntryByMember = await prisma.$queryRaw<Array<{ memberId: string; sourceStatus: string; sourceMembershipDescription: string | null; sourceGolfClassification: string | null }>>`
    SELECT m."memberId" AS "memberId",
           m."sourceStatus",
           m."sourceMembershipDescription",
           m."sourceGolfClassification"
      FROM "MembershipHistoryEntry" m
      INNER JOIN (
        SELECT "memberId", MAX("effectiveFrom") AS maxEff
          FROM "MembershipHistoryEntry"
         WHERE "clubId" = ${clubId}
      GROUP BY "memberId"
      ) latest
        ON latest."memberId" = m."memberId"
       AND latest.maxEff = m."effectiveFrom"
     WHERE m."clubId" = ${clubId}
  `;
  const totalMembers = latestEntryByMember.length;
  const miscArMembers = new Set(
    latestEntryByMember.filter((r) => r.sourceStatus === "MISC A/R").map((r) => r.memberId),
  );
  const miscArCount = miscArMembers.size;

  // January AR rows (committed snapshot).
  const janBatch = await prisma.arAgingImportBatch.findFirst({
    where: {
      clubId, status: "COMMITTED",
      sourceEffectiveDate: { gte: new Date(Date.UTC(2026, 0, 31, 0, 0, 0, 0)), lte: jan },
    },
    orderBy: { committedAt: "desc" },
  });
  const arRows = janBatch
    ? await prisma.arAgingSnapshotRow.findMany({
        where: { importBatchId: janBatch.id },
        select: {
          memberId: true, netAmount: true, current: true,
          oneMonth: true, twoMonths: true, threeMonths: true, overFourMonths: true,
        },
      })
    : [];

  function emptyAggregate() {
    return {
      profileCount: 0,
      arAccountCount: 0,
      totalAR: ZERO_D,
      current: ZERO_D,
      oneMonth: ZERO_D,
      twoMonths: ZERO_D,
      threeMonths: ZERO_D,
      overFourMonths: ZERO_D,
      nonCurrentAccounts: 0,
    };
  }
  function addRow(agg: ReturnType<typeof emptyAggregate>, r: typeof arRows[number]) {
    agg.arAccountCount++;
    agg.totalAR = agg.totalAR.plus(r.netAmount as Prisma.Decimal);
    agg.current = agg.current.plus(r.current as Prisma.Decimal);
    agg.oneMonth = agg.oneMonth.plus(r.oneMonth as Prisma.Decimal);
    agg.twoMonths = agg.twoMonths.plus(r.twoMonths as Prisma.Decimal);
    agg.threeMonths = agg.threeMonths.plus(r.threeMonths as Prisma.Decimal);
    agg.overFourMonths = agg.overFourMonths.plus(r.overFourMonths as Prisma.Decimal);
    const nonCur = (r.oneMonth as Prisma.Decimal)
      .plus(r.twoMonths as Prisma.Decimal)
      .plus(r.threeMonths as Prisma.Decimal)
      .plus(r.overFourMonths as Prisma.Decimal);
    if (nonCur.abs().gt(TOL)) agg.nonCurrentAccounts++;
  }
  function finalize(agg: ReturnType<typeof emptyAggregate>) {
    const total = Number(agg.totalAR.toString());
    const curPct = total > 0 ? (Number(agg.current.toString()) / total) * 100 : null;
    return {
      profileCount: agg.profileCount,
      arAccountCount: agg.arAccountCount,
      totalAR: agg.totalAR.toString(),
      current: agg.current.toString(),
      oneMonth: agg.oneMonth.toString(),
      twoMonths: agg.twoMonths.toString(),
      threeMonths: agg.threeMonths.toString(),
      overFourMonths: agg.overFourMonths.toString(),
      currentPct: curPct,
      nonCurrentAccounts: agg.nonCurrentAccounts,
    };
  }

  // MISC A/R overlap.
  const miscArAgg = emptyAggregate();
  miscArAgg.profileCount = miscArCount;
  const arMemberIds = new Set<string>();
  for (const r of arRows) {
    arMemberIds.add(r.memberId);
    if (miscArMembers.has(r.memberId)) addRow(miscArAgg, r);
  }
  const miscArInAR = miscArAgg.arAccountCount;
  const miscArNotInAR = miscArCount - miscArInAR;

  // -------------------------------------------------------------
  // §4 AR composition by sourceStatus / description / golf class
  // -------------------------------------------------------------
  const latestByMemberId = new Map(latestEntryByMember.map((r) => [r.memberId, r]));
  const byStatus = new Map<string, ReturnType<typeof emptyAggregate>>();
  const byMembershipDesc = new Map<string, ReturnType<typeof emptyAggregate>>();
  const byGolfClass = new Map<string, ReturnType<typeof emptyAggregate>>();
  for (const r of arRows) {
    const latest = latestByMemberId.get(r.memberId);
    const statusKey = latest?.sourceStatus ?? "<no membership entry>";
    const descKey = latest?.sourceMembershipDescription ?? "<no description>";
    const golfKey = latest?.sourceGolfClassification ?? "<no golf classification>";
    for (const [map, key] of [[byStatus, statusKey], [byMembershipDesc, descKey], [byGolfClass, golfKey]] as const) {
      const agg = map.get(key) ?? emptyAggregate();
      addRow(agg, r);
      map.set(key, agg);
    }
  }
  // ProfileCount per status = count of DISTINCT members (not AR rows)
  // in the Member Master, grouped by latest sourceStatus.
  const profileCountByStatus = new Map<string, number>();
  for (const r of latestEntryByMember) {
    profileCountByStatus.set(r.sourceStatus, (profileCountByStatus.get(r.sourceStatus) ?? 0) + 1);
  }
  const compositionByStatus = Array.from(byStatus.entries())
    .map(([k, v]) => {
      const fin = finalize(v);
      return { sourceStatus: k, ...fin, profileCount: profileCountByStatus.get(k) ?? v.arAccountCount };
    })
    .sort((a, b) => Number(b.totalAR) - Number(a.totalAR));
  const compositionByMembershipDesc = Array.from(byMembershipDesc.entries())
    .filter(([, v]) => v.arAccountCount >= 3) // suppress fragments
    .map(([k, v]) => ({ sourceMembershipDescription: k, ...finalize(v) }))
    .sort((a, b) => Number(b.totalAR) - Number(a.totalAR));
  const compositionByGolfClass = Array.from(byGolfClass.entries())
    .filter(([, v]) => v.arAccountCount >= 3)
    .map(([k, v]) => ({ sourceGolfClassification: k, ...finalize(v) }))
    .sort((a, b) => Number(b.totalAR) - Number(a.totalAR));

  // -------------------------------------------------------------
  // §5 Bill-to analysis
  // -------------------------------------------------------------
  const billingRows = arMemberIds.size > 0
    ? await prisma.memberBillingRelationship.findMany({
        where: { clubId, memberId: { in: Array.from(arMemberIds) } },
        select: { memberId: true, billedByMemberId: true, outcome: true, sourceBillToExternalIdentifier: true },
      })
    : [];
  let billSelf = 0, billResolved = 0, billUnresolved = 0, billInvalid = 0, billMissing = 0;
  const billedByMemberIds: string[] = [];
  for (const memberId of arMemberIds) {
    const b = billingRows.find((x) => x.memberId === memberId);
    if (!b) { billMissing++; continue; }
    switch (b.outcome) {
      case "SELF": billSelf++; break;
      case "RESOLVED": billResolved++; break;
      case "UNRESOLVED": billUnresolved++; break;
      case "INVALID": billInvalid++; break;
    }
    if (b.outcome === "RESOLVED" && b.billedByMemberId) billedByMemberIds.push(b.billedByMemberId);
  }
  // How many of those bill-to Members ALSO have their own January AR?
  const billedByAlsoHaveAr = billedByMemberIds.filter((id) => arMemberIds.has(id)).length;

  // Aggregate AR tied to RESOLVED (secondary) relationships.
  const resolvedMemberIds = new Set(
    billingRows.filter((b) => b.outcome === "RESOLVED").map((b) => b.memberId),
  );
  const resolvedAgg = emptyAggregate();
  for (const r of arRows) {
    if (resolvedMemberIds.has(r.memberId)) addRow(resolvedAgg, r);
  }

  // -------------------------------------------------------------
  // Response
  // -------------------------------------------------------------
  return NextResponse.json({
    asOf: {
      dec: dec.toISOString().slice(0, 10),
      jan: jan.toISOString().slice(0, 10),
    },

    // §2 §C
    accounts1200vs1201: {
      "1200": account1200,
      "1201": account1201,
      opLedgerActivity1201,
      arSnapshotFor1201: arSnapshotTotal ? arSnapshotTotal.id : null,
    },

    // §3 §E
    miscArOverlap: {
      totalMiscArProfiles: miscArCount,
      profilesInJanuaryAR: miscArInAR,
      profilesNotInJanuaryAR: miscArNotInAR,
      aggregate: finalize(miscArAgg),
    },

    // §4 §F §G
    compositionByStatus,
    compositionByMembershipDescription: compositionByMembershipDesc,
    compositionByGolfClassification: compositionByGolfClass,

    // §5 §H
    billTo: {
      arMemberCount: arMemberIds.size,
      self: billSelf,
      resolved: billResolved,
      unresolved: billUnresolved,
      invalid: billInvalid,
      missing: billMissing,
      resolvedBilledByAlsoHaveAr: billedByAlsoHaveAr,
      resolvedAggregate: finalize(resolvedAgg),
    },

    totalMembers,
    arSnapshotTotalRows: arRows.length,
  });
}
