// Tax-code service.
//
// Seeds + reads. The catalog is editable by an admin in a future Phase; for
// now we ship a sensible default per region and the AP invoice service uses
// it to drive the recoverable-vs-non-recoverable posting split.

import { prisma } from "../prisma";
import { tenantWhere } from "../services/tenant";
import { audit } from "../audit";
import { ConflictError } from "../errors";
import type { Principal } from "../rbac";

export type TaxCodeSeed = {
  key: string;
  name: string;
  region: string | null;
  ratePct: number;
  recoverableAccountNumber: string | null;
  payableAccountNumber: string | null;
  isRecoverable: boolean;
};

// Default catalog. AP-relevant taxes have a recoverable account (Input Tax
// Credit) since the club is the *purchaser* on AP. Provinces with PST add
// non-recoverable PST as Phase 5+ work — Phase 4 supports GST/HST flows.
export const DEFAULT_TAX_CODES: TaxCodeSeed[] = [
  { key: "GST_5",      name: "GST 5%",       region: "AB", ratePct: 5,    recoverableAccountNumber: "1310", payableAccountNumber: "2110", isRecoverable: true },
  { key: "HST_13",     name: "HST 13%",      region: "ON", ratePct: 13,   recoverableAccountNumber: "1310", payableAccountNumber: "2110", isRecoverable: true },
  { key: "HST_15",     name: "HST 15%",      region: "NB", ratePct: 15,   recoverableAccountNumber: "1310", payableAccountNumber: "2110", isRecoverable: true },
  { key: "EXEMPT",     name: "Tax exempt",   region: null, ratePct: 0,    recoverableAccountNumber: null,   payableAccountNumber: null,   isRecoverable: false },
  { key: "ZERO_RATED", name: "Zero-rated",   region: null, ratePct: 0,    recoverableAccountNumber: null,   payableAccountNumber: null,   isRecoverable: false },
];

export async function seedDefaultTaxCodes(clubId: string) {
  for (const t of DEFAULT_TAX_CODES) {
    const recoverable = t.recoverableAccountNumber
      ? await prisma.account.findFirst({ where: { clubId, accountNumber: t.recoverableAccountNumber } })
      : null;
    const payable = t.payableAccountNumber
      ? await prisma.account.findFirst({ where: { clubId, accountNumber: t.payableAccountNumber } })
      : null;
    await prisma.taxCode.upsert({
      where: { clubId_key: { clubId, key: t.key } },
      update: {
        name: t.name,
        region: t.region,
        ratePct: t.ratePct,
        recoverableAccountId: recoverable?.id ?? null,
        payableAccountId: payable?.id ?? null,
        isRecoverable: t.isRecoverable,
      },
      create: {
        clubId,
        key: t.key,
        name: t.name,
        region: t.region,
        ratePct: t.ratePct,
        recoverableAccountId: recoverable?.id ?? null,
        payableAccountId: payable?.id ?? null,
        isRecoverable: t.isRecoverable,
      },
    });
  }
}

export async function listTaxCodes(principal: Principal, clubId: string) {
  return prisma.taxCode.findMany({
    where: { ...tenantWhere(principal, clubId), isActive: true },
    include: { recoverableAccount: true, payableAccount: true },
    orderBy: { key: "asc" },
  });
}

export async function getTaxCode(clubId: string, taxCodeId: string) {
  const tc = await prisma.taxCode.findFirst({
    where: { id: taxCodeId, clubId },
    include: { recoverableAccount: true, payableAccount: true },
  });
  if (!tc) throw new ConflictError(`Unknown tax code ${taxCodeId}`);
  return tc;
}

// Region heuristic — used by exception detection. If a club is configured for
// GST-only (Alberta) but the invoice carries a non-GST tax code, flag it.
export function isExpectedTaxForRegion(clubRegion: string | null, taxCodeKey: string): boolean {
  if (!clubRegion) return true;
  if (clubRegion === "AB") return taxCodeKey === "GST_5" || taxCodeKey === "EXEMPT" || taxCodeKey === "ZERO_RATED";
  if (clubRegion === "ON") return taxCodeKey === "HST_13" || taxCodeKey === "EXEMPT" || taxCodeKey === "ZERO_RATED";
  return true; // unknown region — don't flag
}

// Hook used by services. Swallow audit failures (audit() already does that internally).
export async function auditTaxCodeChange(p: Principal | null, clubId: string, before: unknown, after: unknown) {
  await audit(p, { action: "tax.code.upsert", entityType: "TaxCode", clubId, before, after });
}
