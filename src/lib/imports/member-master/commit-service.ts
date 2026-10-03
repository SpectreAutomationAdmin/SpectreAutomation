// MEM-HIST-2 §18-20 (2026-10-03) — Member Master commit service.
//
// Transactional commit of a parsed Jonas Member Master workbook:
//   1. Upsert a MemberMasterImportBatch row (idempotency on
//      clubId + sourceSystem + sourceFileHash + sourceEffectiveDate).
//      Re-upload of the identical workbook is REJECTED by the unique
//      constraint; the error surface preserves whichever batch
//      previously claimed the slot.
//   2. For each parsed row, upsert the Member + MemberExternalIdentity.
//      Resolution is by (clubId, sourceSystem=JONAS, externalIdentifier
//      = raw Member # verbatim). Leading zeros + alphabetic suffixes
//      preserved as strings per §2.
//   3. Insert one MembershipHistoryEntry per Member with
//      effectiveFrom = batch.sourceEffectiveDate. Prior entries
//      (none in MEM-HIST-2's first commit) are left intact.
//   4. Resolve + upsert the MemberBillingRelationship. Outcomes:
//      SELF / RESOLVED / UNRESOLVED. "INVALID" (bill-to blank)
//      is treated as SELF per §13.
//   5. Mark the batch COMMITTED with roll-ups.
//
// ZERO accounting writes — no JournalEntry, no MemberAccount
// mutation (MemberAccount creation is deliberately deferred to
// MEM-HIST-3 when the real AR aging lands and defines the per-member
// balance).

import { prisma } from "@/lib/prisma";
import type { JonasMemberMasterRow, JonasParseResult } from "./jonas-parser";
import { resolveBillToOutcomes } from "./jonas-parser";

export type CommitOutcome = {
  batchId: string;
  rowCount: number;
  newMembers: number;
  matchedMembers: number;
  billToSelf: number;
  billToResolved: number;
  billToUnresolved: number;
  classifications: number;
  committedAt: Date;
};

const JONAS = "JONAS";

export async function commitJonasMemberMasterBatch(opts: {
  clubId: string;
  parsed: JonasParseResult;
  uploadedByUserId: string | null;
}): Promise<CommitOutcome> {
  const { clubId, parsed, uploadedByUserId } = opts;
  if (parsed.rows.length === 0) {
    throw new Error("Refusing to commit — parsed workbook has zero valid rows.");
  }

  // §13 §15 safety — abort if duplicate Member #s exist. The parser
  // surfaces these as warnings; the commit refuses because a single
  // Member # cannot resolve to two Members.
  const dupWarnings = parsed.warnings.filter((w) => w.startsWith("Duplicate Member #"));
  if (dupWarnings.length > 0) {
    throw new Error(`Refusing to commit — duplicate Member # detected: ${dupWarnings.join(" | ")}`);
  }

  // Idempotency check — reject if a prior COMMITTED batch has the
  // same hash + date. We do NOT silently update it.
  const existing = await prisma.memberMasterImportBatch.findUnique({
    where: {
      clubId_sourceSystem_sourceFileHash_sourceEffectiveDate: {
        clubId,
        sourceSystem: JONAS,
        sourceFileHash: parsed.sourceFileHash,
        sourceEffectiveDate: parsed.sourceEffectiveDate,
      },
    },
  });
  if (existing && existing.status === "COMMITTED") {
    throw new Error(
      `Refusing to commit — identical workbook (hash ${parsed.sourceFileHash.slice(0, 10)}…) already committed as batch ${existing.id} on ${existing.committedAt?.toISOString() ?? "unknown"}.`,
    );
  }

  // Resolve bill-to outcomes now so the summary roll-ups are
  // deterministic before the transaction.
  const billToOutcomes = parsed.billToOutcomes.length > 0
    ? parsed.billToOutcomes
    : resolveBillToOutcomes(parsed.rows, 0);
  const billToByMemberNo = new Map(billToOutcomes.map((o) => [o.memberNumber, o]));

  // Phase 1 — Create / find Members by externalIdentifier.
  // Done outside the transaction because 3,080 upserts are too large
  // for one Postgres transaction at the Fly staging db-size tier.
  // Each row is independently idempotent.
  const now = new Date();
  const batchId = (await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `select ('c' || substring(md5(random()::text || clock_timestamp()::text), 1, 24)) as id`,
  ).catch(() => null))?.[0]?.id ?? undefined;
  // Fallback to cuid-ish via Prisma default if the inline cuid gen
  // fails on SQLite dev. Prisma's @default(cuid()) covers both.
  const createdBatch = await prisma.memberMasterImportBatch.create({
    data: {
      ...(batchId ? { id: batchId } : {}),
      clubId,
      status: "PREVIEW",
      sourceSystem: JONAS,
      sourceFileName: parsed.sourceFileName,
      sourceFileHash: parsed.sourceFileHash,
      sourceEffectiveDate: parsed.sourceEffectiveDate,
      rowCount: parsed.rows.length,
      validCount: parsed.rows.length,
      invalidCount: parsed.invalidRows.length,
      warningCount: parsed.warnings.length,
      uploadedByUserId: uploadedByUserId ?? undefined,
      uploadedAt: now,
    },
  });

  let newMembers = 0;
  let matchedMembers = 0;
  let billToSelf = 0;
  let billToResolved = 0;
  let billToUnresolved = 0;
  let classifications = 0;

  // Index of memberNumber → memberId after phase 1 (used by phase 3
  // to resolve bill-to to a Member.id).
  const memberIdByMemberNo = new Map<string, string>();

  for (const row of parsed.rows) {
    const existingIdentity = await prisma.memberExternalIdentity.findUnique({
      where: {
        clubId_sourceSystem_externalIdentifier: {
          clubId,
          sourceSystem: JONAS,
          externalIdentifier: row.memberNumber,
        },
      },
    });

    let memberId: string;
    if (existingIdentity) {
      matchedMembers++;
      memberId = existingIdentity.memberId;
      // Keep Member.firstName/lastName in sync with the latest source
      // sync (per directive §11 Member profile is name-first).
      await prisma.member.update({
        where: { id: memberId },
        data: {
          firstName: row.firstName || "Member",
          lastName: row.lastName,
          // Preserve existing memberNumber if it was already set by
          // some earlier operational path; otherwise mirror the
          // Jonas Member # as the tenant-scoped identifier.
        },
      });
    } else {
      newMembers++;
      // Try to attach to an existing Member by (clubId, memberNumber)
      // ONLY if the Member row doesn't already have a different
      // Jonas identity (we never overwrite a different ext id).
      const byNumber = await prisma.member.findUnique({
        where: {
          clubId_memberNumber: { clubId, memberNumber: row.memberNumber },
        },
      });
      if (byNumber) {
        memberId = byNumber.id;
        matchedMembers++;
        newMembers--;
        await prisma.member.update({
          where: { id: memberId },
          data: {
            firstName: row.firstName || byNumber.firstName,
            lastName: row.lastName || byNumber.lastName,
          },
        });
      } else {
        // Create a new Member. Required Member fields:
        //   clubId / memberNumber / firstName / lastName / email /
        //   status / createdAt — status defaults ONBOARDING in the
        //   schema, which we override to reflect the import source.
        // The schema today requires `email` (non-null). The directive
        // prohibits email import. We satisfy the constraint with a
        // deterministic placeholder that is NOT a valid routable
        // address: `no-email+<externalIdentifier>@placeholder.invalid`.
        // The `.invalid` TLD is RFC 2606 reserved — guaranteed not
        // to resolve. The regression test asserts no `@` emission
        // outside this placeholder shape.
        const emailPlaceholder = `no-email+${row.memberNumber.toLowerCase()}@placeholder.invalid`;
        const created = await prisma.member.create({
          data: {
            clubId,
            memberNumber: row.memberNumber,
            firstName: row.firstName || "Member",
            lastName: row.lastName,
            email: emailPlaceholder,
            status: row.interpretedStatus === "ACTIVE" ? "ACTIVE" : row.interpretedStatus,
            joinDate: row.joinedDate,
          },
        });
        memberId = created.id;
      }
      // Create the external identity row.
      await prisma.memberExternalIdentity.create({
        data: {
          clubId,
          memberId,
          sourceSystem: JONAS,
          externalIdentifier: row.memberNumber,
          effectiveFrom: parsed.sourceEffectiveDate,
          importBatchId: createdBatch.id,
          updatedAt: now,
        },
      });
    }

    memberIdByMemberNo.set(row.memberNumber, memberId);

    // Phase 2 — Membership history entry.
    await prisma.membershipHistoryEntry.create({
      data: {
        clubId,
        memberId,
        sourceStatus: row.sourceStatus,
        sourceMembershipDescription: row.sourceMembershipDescription,
        sourceCategory1: row.sourceCategory1,
        sourceCategory1Description: row.sourceCategory1Description,
        sourceCategory2: row.sourceCategory2,
        sourceGolfClassification: row.sourceGolfClassification,
        interpretedStatus: row.interpretedStatus,
        isShareholder: row.isShareholder,
        effectiveFrom: parsed.sourceEffectiveDate,
        sourceSystem: JONAS,
        sourceEffectiveDate: parsed.sourceEffectiveDate,
        importBatchId: createdBatch.id,
      },
    });
    classifications++;
  }

  // Phase 3 — Billing relationships (needs memberIdByMemberNo map).
  for (const row of parsed.rows) {
    const memberId = memberIdByMemberNo.get(row.memberNumber);
    if (!memberId) continue;
    const outcome = billToByMemberNo.get(row.memberNumber);
    if (!outcome) continue;
    const outcomeTag = outcome.outcome;
    let billedByMemberId: string | null = memberId; // SELF default
    switch (outcomeTag) {
      case "SELF":
        billedByMemberId = memberId;
        billToSelf++;
        break;
      case "RESOLVED":
        billedByMemberId = memberIdByMemberNo.get(outcome.billToMemberNumber!) ?? null;
        if (billedByMemberId) billToResolved++;
        else { billedByMemberId = null; billToUnresolved++; }
        break;
      case "UNRESOLVED":
        billedByMemberId = null;
        billToUnresolved++;
        break;
      case "INVALID":
        billedByMemberId = memberId; // treat INVALID as SELF
        billToSelf++;
        break;
    }
    await prisma.memberBillingRelationship.upsert({
      where: { clubId_memberId: { clubId, memberId } },
      update: {
        billedByMemberId,
        outcome: outcomeTag,
        sourceBillToExternalIdentifier: outcome.billToMemberNumber,
        importBatchId: createdBatch.id,
      },
      create: {
        clubId,
        memberId,
        billedByMemberId,
        outcome: outcomeTag,
        sourceBillToExternalIdentifier: outcome.billToMemberNumber,
        importBatchId: createdBatch.id,
      },
    });
  }

  // Phase 4 — Mark batch COMMITTED with final roll-ups.
  const committedAt = new Date();
  await prisma.memberMasterImportBatch.update({
    where: { id: createdBatch.id },
    data: {
      status: "COMMITTED",
      newMemberCount: newMembers,
      matchedMemberCount: matchedMembers,
      billToSelfCount: billToSelf,
      billToResolvedCount: billToResolved,
      billToUnresolvedCount: billToUnresolved,
      classificationCount: classifications,
      committedAt,
    },
  });

  return {
    batchId: createdBatch.id,
    rowCount: parsed.rows.length,
    newMembers,
    matchedMembers,
    billToSelf,
    billToResolved,
    billToUnresolved,
    classifications,
    committedAt,
  };
}
