// Fund Applicability — one-shot backfill (founder rule 2026-07-02 v15.0).
//
// After the schema field is introduced, every existing P&L
// account needs `fundApplicability` populated exactly ONCE from
// its FS Group's canonical default. This function is idempotent:
//
//   • Skips accounts that already have a value (whether "OPERATING"
//     or "CAPITAL" or a multi-fund CSV) so operator overrides
//     survive.
//   • Skips non-P&L accounts (ASSET / LIABILITY / EQUITY) because
//     fund applicability is a P&L concept only.
//   • Reads FS Group's `key` (not the account name / number) —
//     that's the founder's design principle enforced in code.
//
// Ships alongside the schema change. Test suites use the
// per-club variant so setup can guarantee a clean starting state.

import { prisma } from "../prisma";
import type { AccountType } from "./types";
import {
  defaultFundApplicabilityStringForAccount,
} from "./fund-applicability";

export type BackfillResult = {
  scanned: number;
  updated: number;
  skippedAlreadySet: number;
  skippedNonPL: number;
};

/**
 * Backfill Fund Applicability for every P&L account on ONE club.
 * Used from the seed, from tests, and from the migration helper.
 */
export async function backfillFundApplicabilityForClub(
  clubId: string,
): Promise<BackfillResult> {
  const accounts = await prisma.account.findMany({
    where: { clubId },
    select: {
      id: true,
      type: true,
      fundApplicability: true,
      fsGroup: { select: { key: true } },
    },
  });
  const result: BackfillResult = {
    scanned: accounts.length,
    updated: 0,
    skippedAlreadySet: 0,
    skippedNonPL: 0,
  };
  for (const a of accounts) {
    if (a.type !== "REVENUE" && a.type !== "EXPENSE") {
      result.skippedNonPL++;
      continue;
    }
    if (a.fundApplicability != null && a.fundApplicability.length > 0) {
      result.skippedAlreadySet++;
      continue;
    }
    const value = defaultFundApplicabilityStringForAccount(
      a.type as AccountType,
      a.fsGroup?.key ?? null,
    );
    await prisma.account.update({
      where: { id: a.id },
      data: { fundApplicability: value },
    });
    result.updated++;
  }
  return result;
}

/**
 * Backfill Fund Applicability across EVERY club in the tenant.
 * Called once from the deploy migration + the seed.
 */
export async function backfillFundApplicabilityForAllClubs(): Promise<BackfillResult> {
  const clubs = await prisma.club.findMany({ select: { id: true } });
  const totals: BackfillResult = {
    scanned: 0,
    updated: 0,
    skippedAlreadySet: 0,
    skippedNonPL: 0,
  };
  for (const c of clubs) {
    const r = await backfillFundApplicabilityForClub(c.id);
    totals.scanned += r.scanned;
    totals.updated += r.updated;
    totals.skippedAlreadySet += r.skippedAlreadySet;
    totals.skippedNonPL += r.skippedNonPL;
  }
  return totals;
}
