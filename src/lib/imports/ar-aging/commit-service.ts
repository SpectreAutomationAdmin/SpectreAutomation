// AR-HIST-1 §9-14 (2026-10-03) — Jonas AR Aging commit service.
//
// Transactional non-additive snapshot commit:
//   1. Resolve 100% of AR Member Codes via MemberExternalIdentity
//      (clubId, "JONAS", externalIdentifier). Any unmatched →
//      PREVIEW with reconciliationStatus=OUT_OF_BALANCE; no commit.
//   2. Compute aggregate totals + per-row aging reconciliation
//      (within $0.01).
//   3. Discover the GL AR control account from the Jan 31 TB
//      snapshot and compare subledger total vs GL natural balance.
//      Tolerance $0.01 (TB-HIST-12A pattern).
//   4. If ALL gates pass + action="commit", write ArAgingImportBatch
//      + N ArAgingSnapshotRow + create a MemberAccount for each
//      resolved Member that does not yet have one.
//   5. Idempotent on (clubId, sourceSystem, sourceFileHash,
//      sourceEffectiveDate).
//
// ZERO JournalEntry / Charge / Payment / Statement / TB mutations.

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { toMoney, ZERO } from "@/lib/accounting/decimal";
import { parseArAgingRowValues, type ArAgingParseResult, type ArAgingRow } from "./parser";
import { reportingAccountBalances } from "@/lib/accounting/reporting-balances";
import { consolidateAccountBalances } from "@/lib/accounting/balance";

const JONAS = "JONAS";
const TOLERANCE = toMoney("0.01");
/** AR fsGroupKeys considered part of the Member AR control for
 *  reconciliation. Discovered via the ar-gl-control-diagnostic
 *  endpoint — the Jan 31 TB has Jonas accounts "Accts Receivable -
 *  Members & Assoc" and "Accts Receivable - Monthly Dues" mapped to
 *  BS_MEMBER_AR; "Member Receivables" also lands in BS_MEMBER_AR. */
const AR_CONTROL_FS_GROUPS = ["BS_MEMBER_AR"];

export type ReconciliationStatus = "RECONCILED" | "OUT_OF_BALANCE";
export type MemberResolution = {
  memberId: string | null;
  externalIdentifier: string;
  outcome: "MATCHED" | "UNMATCHED" | "AMBIGUOUS" | "INVALID";
  reason: string | null;
};

export type ArPreviewResult = {
  sourceFileHash: string;
  sourceEffectiveDate: Date;
  parse: ArAgingParseResult;
  resolutions: MemberResolution[];
  resolutionSummary: {
    matched: number;
    unmatched: number;
    ambiguous: number;
    invalid: number;
  };
  nameConsistency: {
    checked: number;
    nameMatches: number;
    nameMismatches: number;
    blankNames: number;
  };
  gl: {
    accountNumber: string | null;
    accountName: string | null;
    naturalBalance: Prisma.Decimal | null;
    fsGroupsUsed: string[];
    accountsIncluded: Array<{ accountNumber: string; name: string; fsGroupKey: string | null; naturalBalance: string }>;
    subledgerTotal: Prisma.Decimal;
    difference: Prisma.Decimal | null;
    status: ReconciliationStatus | null;
    reason: string | null;
  };
  commitEligible: boolean;
};

export type ArCommitResult = {
  batchId: string;
  rowsCommitted: number;
  newMemberAccounts: number;
  existingMemberAccounts: number;
  reconciliationStatus: ReconciliationStatus;
  committedAt: Date;
};

export async function previewArAgingBatch(opts: {
  clubId: string;
  rows: unknown[][];
  sourceFileName: string | null;
  sourceFileHash: string;
  sourceEffectiveDate: Date;
}): Promise<ArPreviewResult> {
  const parse = parseArAgingRowValues(opts.rows);

  // Resolve Member Codes against MemberExternalIdentity.
  const codes = parse.rows.map((r) => r.memberCode);
  const identities = codes.length > 0
    ? await prisma.memberExternalIdentity.findMany({
        where: {
          clubId: opts.clubId,
          sourceSystem: JONAS,
          externalIdentifier: { in: codes },
        },
        select: {
          externalIdentifier: true,
          memberId: true,
          member: { select: { firstName: true, lastName: true } },
        },
      })
    : [];
  const identityByCode = new Map<string, { memberId: string; firstName: string; lastName: string }[]>();
  for (const i of identities) {
    const bucket = identityByCode.get(i.externalIdentifier) ?? [];
    bucket.push({ memberId: i.memberId, firstName: i.member.firstName, lastName: i.member.lastName });
    identityByCode.set(i.externalIdentifier, bucket);
  }

  const resolutions: MemberResolution[] = [];
  let matched = 0, unmatched = 0, ambiguous = 0, invalid = 0;
  let nameChecked = 0, nameMatches = 0, nameMismatches = 0, blankNames = 0;
  for (const row of parse.rows) {
    const code = row.memberCode;
    if (!code || code.trim() === "") {
      resolutions.push({ memberId: null, externalIdentifier: code, outcome: "INVALID", reason: "Missing Member Code" });
      invalid++;
      continue;
    }
    const hits = identityByCode.get(code) ?? [];
    if (hits.length === 0) {
      resolutions.push({ memberId: null, externalIdentifier: code, outcome: "UNMATCHED", reason: "No MemberExternalIdentity found" });
      unmatched++;
    } else if (hits.length > 1) {
      resolutions.push({ memberId: null, externalIdentifier: code, outcome: "AMBIGUOUS", reason: `${hits.length} matches` });
      ambiguous++;
    } else {
      resolutions.push({ memberId: hits[0].memberId, externalIdentifier: code, outcome: "MATCHED", reason: null });
      matched++;
      // §7 name consistency check (secondary control; does NOT change
      // the identity match).
      const arName = (row.memberName ?? "").trim();
      if (!arName) {
        blankNames++;
      } else {
        const canonical = `${hits[0].firstName} ${hits[0].lastName}`.trim();
        nameChecked++;
        if (normalize(arName) === normalize(canonical)) nameMatches++;
        else nameMismatches++;
      }
    }
  }

  // GL control resolution — discover from the Jan 31 BS.
  const asOf = opts.sourceEffectiveDate;
  const bs = await reportingAccountBalances(opts.clubId, { asOf }, { allowCarryForward: true });
  const consolidated = consolidateAccountBalances(bs.balances);
  const accountIds = new Set<string>();
  for (const b of consolidated) {
    if (b.accountId && b.fsGroupKey && AR_CONTROL_FS_GROUPS.includes(b.fsGroupKey)) {
      accountIds.add(b.accountId);
    }
  }
  const accounts = accountIds.size > 0
    ? await prisma.account.findMany({
        where: { id: { in: Array.from(accountIds) } },
        select: {
          accountNumber: true, name: true, isControlAccount: true,
          fsGroup: { select: { key: true } },
        },
      })
    : [];
  let glControlTotal = ZERO;
  const accountsIncluded: ArPreviewResult["gl"]["accountsIncluded"] = [];
  for (const b of consolidated) {
    if (!b.accountId) continue;
    if (b.fsGroupKey && AR_CONTROL_FS_GROUPS.includes(b.fsGroupKey)) {
      glControlTotal = glControlTotal.plus(b.naturalBalance);
      accountsIncluded.push({
        accountNumber: b.accountNumber ?? "",
        name: b.accountName ?? "",
        fsGroupKey: b.fsGroupKey ?? null,
        naturalBalance: b.naturalBalance.toString(),
      });
    }
  }
  const subledgerTotal = parse.totals.totalAR;
  const difference = glControlTotal.minus(subledgerTotal);
  const status: ReconciliationStatus | null = accountIds.size > 0
    ? (difference.abs().lte(TOLERANCE) ? "RECONCILED" : "OUT_OF_BALANCE")
    : null;

  // Pick representative GL account label for the batch header
  // (first BS_MEMBER_AR account by accountNumber).
  const headerAccount = accounts.sort((a, b) => (a.accountNumber ?? "").localeCompare(b.accountNumber ?? ""))[0];

  const commitEligible =
    parse.rows.length > 0 &&
    parse.warnings.length === 0 &&
    parse.aggregateReconcilesPerRow &&
    matched === parse.rows.length &&
    status === "RECONCILED";

  return {
    sourceFileHash: opts.sourceFileHash,
    sourceEffectiveDate: opts.sourceEffectiveDate,
    parse,
    resolutions,
    resolutionSummary: { matched, unmatched, ambiguous, invalid },
    nameConsistency: { checked: nameChecked, nameMatches, nameMismatches, blankNames },
    gl: {
      accountNumber: headerAccount?.accountNumber ?? null,
      accountName: headerAccount?.name ?? null,
      naturalBalance: accountIds.size > 0 ? glControlTotal : null,
      fsGroupsUsed: AR_CONTROL_FS_GROUPS,
      accountsIncluded,
      subledgerTotal,
      difference: accountIds.size > 0 ? difference : null,
      status,
      reason: accountIds.size > 0 ? null : "No accounts mapped to BS_MEMBER_AR for this tenant",
    },
    commitEligible,
  };
}

export async function commitArAgingBatch(opts: {
  clubId: string;
  rows: unknown[][];
  sourceFileName: string | null;
  sourceFileHash: string;
  sourceEffectiveDate: Date;
  uploadedByUserId: string | null;
}): Promise<ArCommitResult> {
  const preview = await previewArAgingBatch({
    clubId: opts.clubId,
    rows: opts.rows,
    sourceFileName: opts.sourceFileName,
    sourceFileHash: opts.sourceFileHash,
    sourceEffectiveDate: opts.sourceEffectiveDate,
  });
  if (!preview.commitEligible) {
    throw new Error(
      `AR-HIST-1 commit gate failed: parsed=${preview.parse.rows.length} warnings=${preview.parse.warnings.length} aggregateReconciles=${preview.parse.aggregateReconcilesPerRow} matched=${preview.resolutionSummary.matched} status=${preview.gl.status}`,
    );
  }

  // Idempotency check.
  const existing = await prisma.arAgingImportBatch.findUnique({
    where: {
      clubId_sourceSystem_sourceFileHash_sourceEffectiveDate: {
        clubId: opts.clubId,
        sourceSystem: JONAS,
        sourceFileHash: opts.sourceFileHash,
        sourceEffectiveDate: opts.sourceEffectiveDate,
      },
    },
  });
  if (existing && existing.status === "COMMITTED") {
    throw new Error(
      `Refusing to commit — identical AR workbook (hash ${opts.sourceFileHash.slice(0, 10)}…) already committed as batch ${existing.id} on ${existing.committedAt?.toISOString() ?? "unknown"}.`,
    );
  }

  const now = new Date();
  const batch = existing && existing.status === "PREVIEW"
    ? existing
    : await prisma.arAgingImportBatch.create({
        data: {
          clubId: opts.clubId,
          status: "PREVIEW",
          sourceSystem: JONAS,
          sourceFileName: opts.sourceFileName,
          sourceFileHash: opts.sourceFileHash,
          sourceEffectiveDate: opts.sourceEffectiveDate,
          rowCount: preview.parse.rows.length,
          invalidCount: 0,
          warningCount: preview.parse.warnings.length,
          totalNet: preview.parse.totals.totalAR,
          totalCurrent: preview.parse.totals.current,
          totalOneMonth: preview.parse.totals.oneMonth,
          totalTwoMonths: preview.parse.totals.twoMonths,
          totalThreeMonths: preview.parse.totals.threeMonths,
          totalOverFourMonths: preview.parse.totals.overFourMonths,
          matchedMembers: preview.resolutionSummary.matched,
          unmatchedMembers: preview.resolutionSummary.unmatched,
          ambiguousMembers: preview.resolutionSummary.ambiguous,
          invalidMembers: preview.resolutionSummary.invalid,
          glControlAccountNumber: preview.gl.accountNumber,
          glControlAccountName: preview.gl.accountName,
          glControlBalance: preview.gl.naturalBalance,
          reconciliationDifference: preview.gl.difference,
          reconciliationStatus: preview.gl.status,
          uploadedByUserId: opts.uploadedByUserId ?? undefined,
          uploadedAt: now,
        },
      });

  const memberIds = preview.resolutions.filter((r) => r.outcome === "MATCHED").map((r) => r.memberId!);
  const existingAccounts = memberIds.length > 0
    ? await prisma.memberAccount.findMany({ where: { memberId: { in: memberIds } }, select: { id: true, memberId: true } })
    : [];
  const accountByMember = new Map(existingAccounts.map((a) => [a.memberId, a.id]));
  let newMemberAccounts = 0;
  for (const memberId of memberIds) {
    if (!accountByMember.has(memberId)) {
      const created = await prisma.memberAccount.create({
        data: { clubId: opts.clubId, memberId },
      });
      accountByMember.set(memberId, created.id);
      newMemberAccounts++;
    }
  }

  // Row inserts.
  const existingRows = await prisma.arAgingSnapshotRow.findMany({
    where: { importBatchId: batch.id },
    select: { memberId: true },
  });
  const existingRowMemberIds = new Set(existingRows.map((r) => r.memberId));
  let rowsCommitted = existingRows.length;
  for (let i = 0; i < preview.parse.rows.length; i++) {
    const parsed = preview.parse.rows[i];
    const resolution = preview.resolutions[i];
    if (resolution.outcome !== "MATCHED" || !resolution.memberId) continue;
    if (existingRowMemberIds.has(resolution.memberId)) continue;
    await prisma.arAgingSnapshotRow.create({
      data: {
        clubId: opts.clubId,
        importBatchId: batch.id,
        memberId: resolution.memberId,
        memberAccountId: accountByMember.get(resolution.memberId) ?? null,
        sourceMemberCode: parsed.memberCode,
        sourceMemberName: parsed.memberName,
        netAmount: parsed.netAmount,
        current: parsed.current,
        oneMonth: parsed.oneMonth,
        twoMonths: parsed.twoMonths,
        threeMonths: parsed.threeMonths,
        overFourMonths: parsed.overFourMonths,
        sourceSystem: JONAS,
        sourceEffectiveDate: opts.sourceEffectiveDate,
      },
    });
    rowsCommitted++;
  }

  const committedAt = new Date();
  await prisma.arAgingImportBatch.update({
    where: { id: batch.id },
    data: { status: "COMMITTED", committedAt },
  });

  return {
    batchId: batch.id,
    rowsCommitted,
    newMemberAccounts,
    existingMemberAccounts: existingAccounts.length,
    reconciliationStatus: preview.gl.status!,
    committedAt,
  };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
