// Founder rule 2026-07-02 v15.2 — pure bulk Fund Applicability
// helper. Split out of the CoA server-action file so it CAN be
// exercised directly by an end-to-end regression test — the
// server-action file is `"use server"`-marked, which restricts
// what shapes its exports can take (they must be RPC-safe async
// functions) and would surface every test call as a Next.js
// build warning about non-serialisable arguments (Principal is
// not RPC-safe).
//
// Contract:
//   • Tenant + permission gate at entry.
//   • `select` on the source `Account` rows EXPLICITLY lists
//     `fundApplicability` — this is the byte the founder's dev
//     server crashed on ("Invalid prisma.account.findMany()
//     invocation … fundApplicability: true"), so the regression
//     suite that calls this helper is the invariant that keeps
//     the generated Prisma client and the schema aligned.
//   • BS accounts in the selection are silently skipped (Fund
//     Applicability is a P&L concept).
//   • Emits one aggregate audit row.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";

export type BulkFundApplicabilityResult = {
  updated: number;
  skippedBs: number;
  requested: number;
  fundApplicability: string | null;
};

export async function applyBulkFundApplicability(
  principal: Principal,
  clubId: string,
  accountIds: ReadonlyArray<string>,
  explicitFund: string | null,
): Promise<BulkFundApplicabilityResult> {
  requirePermission(principal, clubId, "coa:write");
  // The `fundApplicability` field in this select IS the runtime
  // fault line — the founder's dev server crashed here because
  // the generated Prisma client was stale. Do not weaken the
  // select; the whole point of this helper is that the query
  // has to succeed for the schema + generated client to line up.
  const candidates = await prisma.account.findMany({
    where: { id: { in: [...accountIds] }, clubId },
    select: { id: true, type: true, accountNumber: true, fundApplicability: true },
  });
  let updated = 0;
  let skippedBs = 0;
  for (const c of candidates) {
    if (c.type !== "REVENUE" && c.type !== "EXPENSE") {
      skippedBs++;
      continue;
    }
    await prisma.account.update({
      where: { id: c.id },
      data: { fundApplicability: explicitFund },
    });
    updated++;
  }
  await audit(principal, {
    action: "coa.account.bulk-fund-applicability",
    entityType: "Account",
    entityId: `bulk:${updated}`,
    clubId,
    after: {
      fundApplicability: explicitFund,
      updated,
      skippedBs,
      requested: accountIds.length,
    },
  });
  return {
    updated,
    skippedBs,
    requested: accountIds.length,
    fundApplicability: explicitFund,
  };
}
