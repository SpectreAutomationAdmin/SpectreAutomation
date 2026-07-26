// Test helpers for Phase 4 AP suites — bootstrap a club with COA, periods,
// tax codes, approval policies, and a verified-banking vendor.

import { db } from "./db";
import { bootstrapAccountingClub } from "./gl";
import { seedDefaultTaxCodes } from "@/lib/ap/tax-codes";
import { ensureDefaultPolicies } from "@/lib/ap/approvals";
import { createVendor, addBankingProfile, submitBankingForApproval, verifyBanking } from "@/lib/ap/vendors";
import type { Principal } from "@/lib/rbac";

export async function bootstrapAPClub(name = "AP Test Club") {
  const club = await bootstrapAccountingClub(name);
  await seedDefaultTaxCodes(club.id);
  await ensureDefaultPolicies(club.id);
  return club;
}

export async function makeActiveVendor(
  principal: Principal,
  clubId: string,
  opts: { legalName: string; expense?: string; dept?: string; taxKey?: string; withVerifiedBanking?: boolean }
) {
  const v = await createVendor(principal, clubId, {
    legalName: opts.legalName,
    paymentTermsDays: 30,
    paymentMethod: "EFT",
    defaultExpenseAccountNumber: opts.expense ?? "6010",
    defaultDepartmentCode: opts.dept ?? "COURSE",
    defaultTaxCodeKey: opts.taxKey ?? "GST_5",
  });
  // Force ACTIVE for test convenience (the ACTIVE flow itself is covered by other tests).
  await db().vendor.update({ where: { id: v.id }, data: { status: "ACTIVE", approvedAt: new Date(), approvedByUserId: principal.id } });
  if (opts.withVerifiedBanking) {
    const bp = await addBankingProfile(principal, v.id, {
      type: "EFT", bankName: "Test Bank",
      institutionNumber: "001", transitNumber: "01234",
      accountLastFour: "9999", processorToken: "vault_test",
    });
    await submitBankingForApproval(principal, bp.id);
    await verifyBanking(principal, bp.id, { skipPennyTest: true });
  }
  return v;
}
