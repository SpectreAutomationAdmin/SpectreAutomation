// Sprint 3 Checkpoint 15B (2026-07-24) — Origin resolver + writer.
//
// The polymorphic (kind, referenceId) shape on WorkIntakeOrigin means
// Prisma cannot enforce foreign-key integrity. This module is the
// SOLE server-side resolver — every write and every read routes
// through here so:
//
//   1. Every kind is validated against the closed ORIGIN_KINDS list.
//   2. Every referenceId is verified to exist in its source table
//      AND to belong to the same clubId as the intake.
//   3. Every client-facing API accepts a WorkIntakeItem id ONLY —
//      never a raw (kind, referenceId) pair. The server resolves
//      origins from the intake, not from the client.

import { prisma } from "@/lib/prisma";
import {
  ORIGIN_KINDS,
  type EvidenceReference,
  type OriginKind,
  type OriginRole,
  IntelligenceError,
} from "./types";

/** Validate every reference belongs to the target club. Returns the
 *  list of references that resolved; missing ones raise DATA_MISSING. */
export async function resolveEvidenceReferences(args: {
  clubId: string;
  refs: EvidenceReference[];
}): Promise<EvidenceReference[]> {
  const { clubId, refs } = args;
  const resolved: EvidenceReference[] = [];
  for (const ref of refs) {
    if (!(ORIGIN_KINDS as readonly string[]).includes(ref.kind)) {
      throw new IntelligenceError(
        "UNEXPECTED",
        `Unknown origin kind: ${ref.kind}`,
        ref.referenceId,
      );
    }
    const exists = await referenceExistsForClub(ref.kind, ref.referenceId, clubId);
    if (!exists) {
      throw new IntelligenceError(
        "DATA_MISSING",
        `Reference not found or cross-club: ${ref.kind}:${ref.referenceId}`,
        ref.referenceId,
      );
    }
    resolved.push(ref);
  }
  return resolved;
}

/** Exists-check per kind. All checks include a clubId filter to
 *  prevent cross-tenant leakage. */
async function referenceExistsForClub(
  kind: OriginKind,
  referenceId: string,
  clubId: string,
): Promise<boolean> {
  switch (kind) {
    case "MEMBER_ACCOUNT":
      return (
        (await prisma.memberAccount.count({
          where: { id: referenceId, clubId },
        })) === 1
      );
    case "MEMBER":
      return (
        (await prisma.member.count({ where: { id: referenceId, clubId } })) ===
        1
      );
    case "COLLECTION_NOTICE":
      return (
        (await prisma.collectionNotice.count({
          where: { id: referenceId, clubId },
        })) === 1
      );
    case "MEMBER_TRANSACTION": {
      // MEMBER_TRANSACTION is a virtual kind covering both `Payment`
      // and `Charge`. The reference id may match either; both are
      // club-scoped. Prefer Payment (more selective for our AR use).
      const p = await prisma.payment.count({
        where: { id: referenceId, clubId },
      });
      if (p === 1) return true;
      const c = await prisma.charge.count({
        where: { id: referenceId, clubId },
      });
      return c === 1;
    }
    case "INGESTED_DOCUMENT":
      return (
        (await prisma.ingestedDocument.count({
          where: { id: referenceId, clubId },
        })) === 1
      );
    case "AP_INVOICE":
      return (
        (await prisma.aPInvoice.count({
          where: { id: referenceId, clubId },
        })) === 1
      );
    default:
      return false;
  }
}

/** Idempotently upsert a set of origins on an intake. Existing
 *  matching (kind, referenceId, role) rows are preserved unchanged;
 *  new rows are inserted. Never deletes an existing origin (existing
 *  data survives re-materialisation). */
export async function upsertOrigins(args: {
  clubId: string;
  workIntakeItemId: string;
  origins: Array<EvidenceReference & { role: OriginRole; linkReason?: string }>;
  createdByUserId?: string | null;
}): Promise<{ inserted: number; preserved: number }> {
  const { clubId, workIntakeItemId, origins, createdByUserId } = args;
  let inserted = 0;
  let preserved = 0;
  for (const o of origins) {
    const existing = await prisma.workIntakeOrigin.findUnique({
      where: {
        workIntakeItemId_kind_referenceId_role: {
          workIntakeItemId,
          kind: o.kind,
          referenceId: o.referenceId,
          role: o.role,
        },
      },
      select: { id: true },
    });
    if (existing) {
      preserved += 1;
      continue;
    }
    await prisma.workIntakeOrigin.create({
      data: {
        clubId,
        workIntakeItemId,
        kind: o.kind,
        referenceId: o.referenceId,
        role: o.role,
        linkReason: o.linkReason ?? null,
        createdByUserId: createdByUserId ?? null,
      },
    });
    inserted += 1;
  }
  return { inserted, preserved };
}

/** Enumerate all origins on an intake. Used by the loader + card. */
export async function readOrigins(workIntakeItemId: string): Promise<
  Array<{
    id: string;
    kind: OriginKind;
    referenceId: string;
    role: OriginRole;
    linkReason: string | null;
    createdAt: string;
  }>
> {
  const rows = await prisma.workIntakeOrigin.findMany({
    where: { workIntakeItemId },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      kind: true,
      referenceId: true,
      role: true,
      linkReason: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as OriginKind,
    referenceId: r.referenceId,
    role: r.role as OriginRole,
    linkReason: r.linkReason,
    createdAt: r.createdAt.toISOString(),
  }));
}
