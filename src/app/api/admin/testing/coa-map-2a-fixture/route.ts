// COA-MAP-2A (2026-10-06) — disposable test fixture for the
// Mapping Studio browser acceptance.  Creates an isolated Account
// + two FinancialStatementGroups so the authenticated staging
// Playwright can prove a full DRAG → PREVIEW → APPLY → RELOAD →
// PERSISTED round-trip without touching any founder-committed
// Coulee mapping.
//
// STAGING-ONLY.  All records are tenant-scoped (`clubId`) and
// explicitly prefixed `COA_MAP_2A_FIXTURE_*` so cleanup is safe
// and discoverable.
//
// POST creates the fixture (idempotent by `fixtureKey`).
// DELETE removes everything with the fixture prefix for the club.

import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

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

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const body = await req.json().catch(() => ({}));
  const clubId = String(body.clubId ?? "").trim();
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Idempotent-ish stamp — a stable per-run key the caller supplies.
  const fixtureKey = String(body.fixtureKey ?? "").trim() || `COA_MAP_2A_FIXTURE_${Date.now()}`;

  // Two Balance Sheet groups so the test can prove a same-statement
  // asset-group move.
  const groupA = await prisma.financialStatementGroup.create({
    data: {
      clubId,
      key: `TENANT_${fixtureKey}_A`,
      name: `${fixtureKey} — Group A`,
      statement: "BALANCE_SHEET",
      reportingRole: "CASH",
      sortOrder: 9000,
      isTenantCreated: true,
    },
    select: { id: true, name: true, key: true },
  });
  const groupB = await prisma.financialStatementGroup.create({
    data: {
      clubId,
      key: `TENANT_${fixtureKey}_B`,
      name: `${fixtureKey} — Group B`,
      statement: "BALANCE_SHEET",
      reportingRole: "ACCOUNTS_RECEIVABLE",
      sortOrder: 9001,
      isTenantCreated: true,
    },
    select: { id: true, name: true, key: true },
  });

  // Disposable Account assigned to Group A.
  const account = await prisma.account.create({
    data: {
      clubId,
      accountNumber: `9${Date.now().toString().slice(-5)}`,
      name: `${fixtureKey} test account`,
      type: "ASSET",
      normalBalance: "DEBIT",
      fsGroupId: groupA.id,
      isActive: true,
    },
    select: { id: true, accountNumber: true, name: true },
  });

  // COA-MAP-2B — a second disposable Account seeded onto Group B so
  // the Account List renders a Group B sub-header.  (Account List
  // only renders sub-headers for groups that have at least one
  // account.)  This anchor account is NOT the drag source — the
  // test drags `account` from Group A → Group B.  Both get cleaned
  // up on DELETE.
  const anchorB = await prisma.account.create({
    data: {
      clubId,
      accountNumber: `9${Date.now().toString().slice(-5)}8`,
      name: `${fixtureKey} anchor B`,
      type: "ASSET",
      normalBalance: "DEBIT",
      fsGroupId: groupB.id,
      isActive: true,
    },
    select: { id: true, accountNumber: true, name: true },
  });

  // Seed the effective-dated assignment table so the resolver can
  // find both accounts AS OF today.  We date the seed rows 7 days
  // ago so a reassign that fires today lands on a DIFFERENT
  // effectiveFrom and never collides with the
  // AccountFinancialStatementAssignment unique index on
  // (accountId, effectiveFrom).
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - 7);
  await prisma.accountFinancialStatementAssignment.createMany({
    data: [
      { clubId, accountId: account.id,  fsGroupId: groupA.id, effectiveFrom: start },
      { clubId, accountId: anchorB.id,  fsGroupId: groupB.id, effectiveFrom: start },
    ],
  });

  return NextResponse.json({
    fixtureKey,
    account,
    anchorB,
    groupA,
    groupB,
  });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const url = new URL(req.url);
  const clubId = (url.searchParams.get("clubId") ?? "").trim();
  const fixtureKey = (url.searchParams.get("fixtureKey") ?? "").trim();
  if (!clubId || !fixtureKey) {
    return NextResponse.json({ error: "clubId and fixtureKey required" }, { status: 400 });
  }
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Cleanup must be strict: only touch rows carrying the fixture
  // prefix in the key / name.  Never remove anything else.
  const groups = await prisma.financialStatementGroup.findMany({
    where: {
      clubId,
      OR: [
        { key: { startsWith: `TENANT_${fixtureKey}_` } },
        { name: { startsWith: `${fixtureKey} —` } },
      ],
    },
    select: { id: true },
  });
  const groupIds = groups.map((g) => g.id);

  const accounts = await prisma.account.findMany({
    where: {
      clubId,
      name: { startsWith: `${fixtureKey} ` },
    },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);

  const summary = await prisma.$transaction(async (tx) => {
    const assignmentDel = await tx.accountFinancialStatementAssignment.deleteMany({
      where: {
        clubId,
        OR: [
          { accountId: { in: accountIds.length > 0 ? accountIds : [""] } },
          { fsGroupId: { in: groupIds.length > 0 ? groupIds : [""] } },
        ],
      },
    });
    const auditDel = await tx.mappingChangeAudit.deleteMany({
      where: {
        clubId,
        OR: [
          { entityId: { in: accountIds.length > 0 ? accountIds : [""] } },
          { entityId: { in: groupIds.length > 0 ? groupIds : [""] } },
        ],
      },
    });
    const accDel = await tx.account.deleteMany({
      where: { id: { in: accountIds } },
    });
    const grpDel = await tx.financialStatementGroup.deleteMany({
      where: { id: { in: groupIds } },
    });
    return {
      assignmentsDeleted: assignmentDel.count,
      auditsDeleted: auditDel.count,
      accountsDeleted: accDel.count,
      groupsDeleted: grpDel.count,
    };
  });

  return NextResponse.json({ ok: true, fixtureKey, ...summary });
}
