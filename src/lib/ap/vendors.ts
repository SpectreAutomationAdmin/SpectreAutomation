// Vendor service.
//
// Lifecycle:
//   createDraft → submitForApproval → (approvals) → activate
//   activate     → ACTIVE   (only after approval request resolves APPROVED)
//   block        → BLOCKED  (irrevocable until unblocked by SUPER_ADMIN)
//   deactivate   → INACTIVE
//
// Banking changes go through a separate approval flow because they're the
// highest-risk vendor mutation. See `addBankingProfile` / `verifyBanking`.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, hasPermission, type Principal } from "../rbac";
import { tenantWhere, assertTenantOwned } from "../services/tenant";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { submitForApproval, isApproved, getRequestForEntity } from "./approvals";
import { resolveAnyAlias } from "../vendor-intelligence/resolve";

const optStr = (max: number) =>
  z.string().trim().max(max).optional().or(z.literal("")).transform((v) => (v && v.length ? v : null));

export const vendorCreateSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  operatingName: optStr(200),
  taxRegistrationNumber: optStr(50),
  taxRegion: optStr(20),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
  paymentMethod: z.enum(["EFT", "CHEQUE", "CC", "OTHER"]).default("CHEQUE"),
  email: z.string().email().max(254).optional().or(z.literal("")).transform((v) => v && v.length ? v.toLowerCase() : null),
  phone: optStr(40),
  website: optStr(200),
  address1: optStr(200),
  address2: optStr(200),
  city: optStr(100),
  provinceState: optStr(100),
  postalCode: optStr(20),
  country: optStr(80),
  notes: optStr(2000),
  defaultExpenseAccountNumber: optStr(40),
  defaultDepartmentCode: optStr(40),
  defaultTaxCodeKey: optStr(40),
});
export type VendorCreateInput = z.infer<typeof vendorCreateSchema>;

async function nextVendorNumber(clubId: string): Promise<string> {
  const count = await prisma.vendor.count({ where: { clubId } });
  return `V-${(count + 1).toString().padStart(5, "0")}`;
}

// Simple duplicate detection — legalName "contains" match OR tax registration
// number match. SQLite's `contains` is case-sensitive; the catalogue is small
// enough that this is fine for now and the unique constraint catches exact dups.
export async function findVendorDuplicates(clubId: string, legalName: string, taxRegistrationNumber?: string | null) {
  return prisma.vendor.findMany({
    where: {
      clubId,
      OR: [
        { legalName: { contains: legalName.trim() } },
        ...(taxRegistrationNumber ? [{ taxRegistrationNumber }] : []),
      ],
    },
    take: 5,
  });
}

export async function createVendor(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "vendor:create");
  const parsed = vendorCreateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const input = parsed.data;

  // Sprint 3 Checkpoint 15F — resolve against VendorAlias first so
  // historical Jonas / legacy identifiers do NOT create duplicate
  // vendor rows. If we find a canonical, throw a ConflictError with
  // the canonical id so the caller can redirect.
  const aliasHit = await resolveAnyAlias({
    clubId,
    taxNumber: input.taxRegistrationNumber ?? null,
    legalName: input.legalName,
    operatingName: input.operatingName ?? null,
  });
  if (aliasHit) {
    throw new ConflictError(
      `Vendor identity resolves to canonical vendor ${aliasHit.canonicalVendorId} via ${aliasHit.aliasKind} alias. Use the canonical vendor instead of creating a new one.`,
    );
  }

  // Duplicate by exact legalName (DB unique constraint also enforces this).
  const dup = await prisma.vendor.findFirst({ where: { clubId, legalName: input.legalName } });
  if (dup) throw new ConflictError(`Vendor "${input.legalName}" already exists`);

  // Resolve defaults.
  const expenseAccount = input.defaultExpenseAccountNumber
    ? await prisma.account.findFirst({ where: { clubId, accountNumber: input.defaultExpenseAccountNumber } })
    : null;
  if (input.defaultExpenseAccountNumber && !expenseAccount) {
    throw new ConflictError(`Unknown expense account ${input.defaultExpenseAccountNumber}`);
  }
  const dept = input.defaultDepartmentCode
    ? await prisma.department.findFirst({ where: { clubId, code: input.defaultDepartmentCode } })
    : null;
  if (input.defaultDepartmentCode && !dept) {
    throw new ConflictError(`Unknown department ${input.defaultDepartmentCode}`);
  }
  if (input.defaultTaxCodeKey) {
    const tc = await prisma.taxCode.findFirst({ where: { clubId, key: input.defaultTaxCodeKey } });
    if (!tc) throw new ConflictError(`Unknown tax code ${input.defaultTaxCodeKey}`);
  }

  const vendorNumber = await nextVendorNumber(clubId);
  const created = await prisma.vendor.create({
    data: {
      clubId,
      vendorNumber,
      legalName: input.legalName,
      operatingName: input.operatingName,
      taxRegistrationNumber: input.taxRegistrationNumber,
      taxRegion: input.taxRegion,
      defaultExpenseAccountId: expenseAccount?.id ?? null,
      defaultDepartmentId: dept?.id ?? null,
      defaultTaxCodeKey: input.defaultTaxCodeKey,
      paymentTermsDays: input.paymentTermsDays,
      paymentMethod: input.paymentMethod,
      email: input.email,
      phone: input.phone,
      website: input.website,
      address1: input.address1,
      address2: input.address2,
      city: input.city,
      provinceState: input.provinceState,
      postalCode: input.postalCode,
      country: input.country,
      notes: input.notes,
      status: "DRAFT",
      createdByUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "vendor.create",
    entityType: "Vendor",
    entityId: created.id,
    clubId,
    after: created,
  });
  return created;
}

export async function submitVendorForApproval(principal: Principal, vendorId: string) {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  assertTenantOwned(vendor, principal);
  requirePermission(principal, vendor.clubId, "vendor:create");
  if (vendor.status !== "DRAFT") throw new ConflictError(`Vendor is ${vendor.status}`);

  await submitForApproval(principal, vendor.clubId, "VENDOR", vendorId, 0);
  const updated = await prisma.vendor.update({ where: { id: vendorId }, data: { status: "PENDING_APPROVAL" } });
  await audit(principal, {
    action: "vendor.submit_for_approval",
    entityType: "Vendor",
    entityId: vendorId,
    clubId: vendor.clubId,
    before: { status: "DRAFT" },
    after: { status: "PENDING_APPROVAL" },
  });
  return updated;
}

export async function activateVendor(principal: Principal, vendorId: string) {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  assertTenantOwned(vendor, principal);
  requirePermission(principal, vendor.clubId, "vendor:approve");

  const req = await getRequestForEntity(vendor.clubId, "VENDOR", vendorId);
  if (vendor.status !== "PENDING_APPROVAL" && vendor.status !== "DRAFT") {
    throw new ConflictError(`Vendor is ${vendor.status}`);
  }
  // If a request exists, it must be APPROVED. Allow direct activate by an
  // authorized approver when no policy is set OR when the user holds the
  // exception override.
  if (req && !isApproved(req) && !hasPermission(principal, vendor.clubId, "ap:exception:override")) {
    throw new ConflictError("Approval request is not yet APPROVED");
  }

  const updated = await prisma.vendor.update({
    where: { id: vendorId },
    data: { status: "ACTIVE", approvedAt: new Date(), approvedByUserId: principal.id },
  });
  await audit(principal, {
    action: "vendor.activate",
    entityType: "Vendor",
    entityId: vendorId,
    clubId: vendor.clubId,
    before: { status: vendor.status },
    after: { status: "ACTIVE" },
  });
  return updated;
}

export async function blockVendor(principal: Principal, vendorId: string, reason: string) {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  assertTenantOwned(vendor, principal);
  requirePermission(principal, vendor.clubId, "vendor:approve");
  const updated = await prisma.vendor.update({
    where: { id: vendorId },
    data: { status: "BLOCKED", blockedReason: reason },
  });
  await audit(principal, {
    action: "vendor.block",
    entityType: "Vendor",
    entityId: vendorId,
    clubId: vendor.clubId,
    before: { status: vendor.status },
    after: { status: "BLOCKED" },
    meta: { reason },
  });
  return updated;
}

export async function deactivateVendor(principal: Principal, vendorId: string) {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  assertTenantOwned(vendor, principal);
  requirePermission(principal, vendor.clubId, "vendor:edit");
  const updated = await prisma.vendor.update({ where: { id: vendorId }, data: { status: "INACTIVE" } });
  await audit(principal, {
    action: "vendor.deactivate",
    entityType: "Vendor", entityId: vendorId, clubId: vendor.clubId,
    before: { status: vendor.status }, after: { status: "INACTIVE" },
  });
  return updated;
}

// Sprint 3 · Checkpoint 15P-4 (2026-07-28) — vendor deletion with a
// hard safe-delete gate.
//
// Founder rule (§Safe deletion behaviour): "Do not blindly hard-
// delete a vendor with financial history." We enumerate every
// foreign-key reference before deciding:
//
//   • no financial / operational history  → hard delete (cascades
//     VendorContact rows via the existing schema onDelete:Cascade;
//     everything else is guaranteed empty by the pre-check)
//   • ANY posted invoice, payment, banking profile, penny test,
//     inventory receiving, purchase-order-like record, or non-DRAFT
//     status flip                          → refuse, tell the
//     caller to deactivate instead
//
// The dependency probe runs BEFORE the delete so we never begin a
// destructive transaction that has to be rolled back.
export type VendorDependencyDetail = {
  invoices: number;
  payments: number;
  bankingProfiles: number;
  pennyTests: number;
  inventoryReceivings: number;
  inventoryItems: number;
  aliases: number;
  statementReconciliations: number;
  documents: number;
  riskFlags: number;
};
export interface VendorDeleteBlocked {
  ok: false;
  reason: "HAS_FINANCIAL_HISTORY";
  details: VendorDependencyDetail;
  message: string;
}
export interface VendorDeleteSuccess {
  ok: true;
  vendorId: string;
  vendorLegalName: string;
}

export async function probeVendorDependencies(clubId: string, vendorId: string): Promise<VendorDependencyDetail> {
  // Tenant-scoped counts — never leak cross-tenant references. Kept
  // to a single Promise.all round-trip.
  const [
    invoices, payments, bankingProfiles, pennyTests,
    inventoryReceivings, inventoryItems, aliases, statementReconciliations,
    documents, riskFlags,
  ] = await Promise.all([
    prisma.aPInvoice.count({                     where: { clubId, vendorId } }),
    prisma.vendorPayment.count({                 where: { clubId, vendorId } }),
    prisma.vendorBankingProfile.count({          where: { clubId, vendorId } }),
    prisma.pennyTest.count({                     where: { clubId, vendorId } }),
    prisma.inventoryReceiving.count({            where: { clubId, vendorId } }),
    prisma.inventoryItem.count({                 where: { clubId, preferredVendorId: vendorId } }),
    prisma.vendorAlias.count({                   where: { canonicalVendorId: vendorId } }),
    prisma.vendorStatementReconciliation.count({ where: { clubId, canonicalVendorId: vendorId } }),
    prisma.vendorDocument.count({                where: { clubId, vendorId } }),
    prisma.vendorRiskFlag.count({                where: { clubId, vendorId } }),
  ]);
  return {
    invoices, payments, bankingProfiles, pennyTests,
    inventoryReceivings, inventoryItems, aliases,
    statementReconciliations, documents, riskFlags,
  };
}

/**
 * Delete a vendor. Refuses when the vendor has any financial or
 * operational history. Success cascades VendorContact rows via the
 * schema (onDelete: Cascade). Audited either way.
 *
 * RBAC gate: `vendor:delete` (granted to CLUB_ADMIN + CONTROLLER by
 * default; NOT granted to AP reviewer / auditor roles).
 */
export async function deleteVendor(
  principal: Principal,
  vendorId: string,
): Promise<VendorDeleteSuccess | VendorDeleteBlocked> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, clubId: true, legalName: true, status: true },
  });
  assertTenantOwned(vendor, principal);
  requirePermission(principal, vendor.clubId, "vendor:delete");

  const deps = await probeVendorDependencies(vendor.clubId, vendor.id);
  const totalRefs =
    deps.invoices + deps.payments + deps.bankingProfiles + deps.pennyTests +
    deps.inventoryReceivings + deps.inventoryItems + deps.aliases +
    deps.statementReconciliations + deps.documents + deps.riskFlags;

  if (totalRefs > 0) {
    // Emit an audit trail for the REFUSED attempt so blocked
    // deletions are still visible in the tenant's audit history.
    await audit(principal, {
      action: "vendor.delete.blocked",
      entityType: "Vendor", entityId: vendor.id, clubId: vendor.clubId,
      after: { reason: "HAS_FINANCIAL_HISTORY", dependencies: deps },
    });
    return {
      ok: false,
      reason: "HAS_FINANCIAL_HISTORY",
      details: deps,
      message: `${vendor.legalName} has posted financial or operational history and cannot be deleted. Deactivate the vendor instead.`,
    };
  }

  await prisma.$transaction(async (tx) => {
    // VendorContact rows cascade via schema. Explicit contact
    // wipe kept as belt-and-braces so tenants that migrated from a
    // schema without onDelete:Cascade still delete cleanly.
    await tx.vendorContact.deleteMany({ where: { vendorId: vendor.id } });
    await tx.vendor.delete({ where: { id: vendor.id } });
  }, { timeout: 30_000, maxWait: 10_000 });

  await audit(principal, {
    action: "vendor.delete",
    entityType: "Vendor", entityId: vendor.id, clubId: vendor.clubId,
    before: {
      legalName: vendor.legalName, status: vendor.status,
    },
    after: null,
  });

  return { ok: true, vendorId: vendor.id, vendorLegalName: vendor.legalName };
}

// ---------- Banking ----------
export const bankingCreateSchema = z.object({
  type: z.enum(["EFT", "WIRE", "CHEQUE"]).default("EFT"),
  bankName: z.string().trim().min(1).max(120),
  institutionNumber: z.string().trim().regex(/^\d{0,4}$/, "Up to 4 digits").max(4).optional(),
  transitNumber: z.string().trim().regex(/^\d{0,6}$/, "Up to 6 digits").max(6).optional(),
  accountLastFour: z.string().trim().regex(/^\d{0,4}$/, "Up to 4 digits").max(4).optional(),
  processorToken: z.string().trim().max(500).optional(), // opaque token from banking adapter
});

export async function addBankingProfile(principal: Principal, vendorId: string, raw: unknown) {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  assertTenantOwned(vendor, principal);
  requirePermission(principal, vendor.clubId, "vendor:banking:edit");
  const parsed = bankingCreateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const created = await prisma.vendorBankingProfile.create({
    data: {
      clubId: vendor.clubId,
      vendorId,
      type: parsed.data.type,
      bankName: parsed.data.bankName,
      institutionNumber: parsed.data.institutionNumber ?? null,
      transitNumber: parsed.data.transitNumber ?? null,
      accountLastFour: parsed.data.accountLastFour ?? null,
      processorToken: parsed.data.processorToken ?? null,
      status: "DRAFT",
      createdByUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "vendor.banking.add",
    entityType: "VendorBankingProfile", entityId: created.id, clubId: vendor.clubId,
    after: { type: created.type, accountLastFour: created.accountLastFour, status: created.status },
  });
  return created;
}

export async function submitBankingForApproval(principal: Principal, profileId: string) {
  const profile = await prisma.vendorBankingProfile.findUnique({ where: { id: profileId } });
  assertTenantOwned(profile, principal);
  requirePermission(principal, profile.clubId, "vendor:banking:edit");
  if (profile.status !== "DRAFT") throw new ConflictError(`Banking profile is ${profile.status}`);
  const req = await submitForApproval(principal, profile.clubId, "VENDOR_BANKING", profileId, 0);
  await prisma.vendorBankingProfile.update({
    where: { id: profileId },
    data: { status: "PENDING_APPROVAL", approvalRequestId: req.id },
  });
  await audit(principal, {
    action: "vendor.banking.submit",
    entityType: "VendorBankingProfile", entityId: profileId, clubId: profile.clubId,
    after: { status: "PENDING_APPROVAL" },
  });
}

// Verify (approve + activate) the banking profile. Caller must hold the
// approval-side perm, and there must be either a fully-approved request or an
// override. Also runs penny-test sanity check: at least one CONFIRMED
// PennyTest required unless the override permission applies.
export async function verifyBanking(principal: Principal, profileId: string, opts?: { skipPennyTest?: boolean }) {
  const profile = await prisma.vendorBankingProfile.findUnique({ where: { id: profileId } });
  assertTenantOwned(profile, principal);
  requirePermission(principal, profile.clubId, "vendor:banking:approve");
  if (profile.status === "VERIFIED") return profile;
  if (profile.status === "DRAFT") {
    throw new ConflictError("Banking profile must be submitted for approval before it can be verified");
  }
  if (profile.status === "REJECTED" || profile.status === "INACTIVE") {
    throw new ConflictError(`Banking profile is ${profile.status}`);
  }
  const req = profile.approvalRequestId
    ? await prisma.approvalRequest.findUnique({ where: { id: profile.approvalRequestId } })
    : null;
  if (req && !isApproved(req) && !hasPermission(principal, profile.clubId, "ap:exception:override")) {
    throw new ConflictError("Banking approval request is not yet APPROVED");
  }
  if (!opts?.skipPennyTest && !hasPermission(principal, profile.clubId, "ap:exception:override")) {
    const test = await prisma.pennyTest.findFirst({
      where: { bankingProfileId: profileId, status: "CONFIRMED" },
    });
    if (!test) throw new ConflictError("A confirmed penny test is required before verifying banking");
  }

  // Deactivate any prior active profile for this vendor.
  await prisma.vendorBankingProfile.updateMany({
    where: { vendorId: profile.vendorId, isActive: true, id: { not: profileId } },
    data: { isActive: false, status: "INACTIVE" },
  });
  const updated = await prisma.vendorBankingProfile.update({
    where: { id: profileId },
    data: {
      status: "VERIFIED",
      isActive: true,
      approvedAt: new Date(),
      approvedByUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "vendor.banking.verify",
    entityType: "VendorBankingProfile", entityId: profileId, clubId: profile.clubId,
    before: { status: profile.status, isActive: profile.isActive },
    after: { status: "VERIFIED", isActive: true },
  });
  return updated;
}

export async function rejectBanking(principal: Principal, profileId: string, reason: string) {
  const profile = await prisma.vendorBankingProfile.findUnique({ where: { id: profileId } });
  assertTenantOwned(profile, principal);
  requirePermission(principal, profile.clubId, "vendor:banking:approve");
  const updated = await prisma.vendorBankingProfile.update({
    where: { id: profileId },
    data: { status: "REJECTED", isActive: false, rejectedReason: reason },
  });
  await audit(principal, {
    action: "vendor.banking.reject",
    entityType: "VendorBankingProfile", entityId: profileId, clubId: profile.clubId,
    before: { status: profile.status }, after: { status: "REJECTED" },
    meta: { reason },
  });
  return updated;
}

// ---------- Penny tests ----------
export const pennyTestSchema = z.object({
  amount: z.number().positive().max(1), // typical penny-test ceiling
  notes: z.string().trim().max(2000).optional(),
});

export async function initiatePennyTest(principal: Principal, profileId: string, raw: unknown) {
  const profile = await prisma.vendorBankingProfile.findUnique({ where: { id: profileId } });
  assertTenantOwned(profile, principal);
  requirePermission(principal, profile.clubId, "vendor:banking:edit");
  const parsed = pennyTestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const t = await prisma.pennyTest.create({
    data: {
      clubId: profile.clubId,
      vendorId: profile.vendorId,
      bankingProfileId: profileId,
      amount: parsed.data.amount,
      notes: parsed.data.notes ?? null,
      initiatedByUserId: principal.id,
      status: "SENT",
    },
  });
  await audit(principal, {
    action: "vendor.penny_test.initiate",
    entityType: "PennyTest", entityId: t.id, clubId: profile.clubId,
    after: { amount: t.amount.toString(), status: "SENT" },
  });
  return t;
}

export async function confirmPennyTest(principal: Principal, pennyTestId: string, confirmedAmount: number) {
  const t = await prisma.pennyTest.findUnique({ where: { id: pennyTestId } });
  assertTenantOwned(t, principal);
  requirePermission(principal, t.clubId, "vendor:banking:approve");
  if (t.status !== "SENT") throw new ConflictError(`Penny test is ${t.status}`);
  const match = Math.abs(Number(t.amount.toString()) - confirmedAmount) < 0.01;
  const updated = await prisma.pennyTest.update({
    where: { id: pennyTestId },
    data: {
      status: match ? "CONFIRMED" : "FAILED",
      confirmedAt: new Date(),
      confirmedAmount: confirmedAmount,
    },
  });
  await audit(principal, {
    action: match ? "vendor.penny_test.confirm" : "vendor.penny_test.fail",
    entityType: "PennyTest", entityId: pennyTestId, clubId: t.clubId,
    before: { status: "SENT" },
    after: { status: updated.status, confirmedAmount },
  });
  return updated;
}

// ---------- Reads ----------
export async function listVendors(principal: Principal, clubId: string, opts?: { status?: string }) {
  return prisma.vendor.findMany({
    where: { ...tenantWhere(principal, clubId), ...(opts?.status ? { status: opts.status } : {}) },
    orderBy: [{ status: "asc" }, { legalName: "asc" }],
    include: { defaultExpenseAccount: true, defaultDepartment: true },
  });
}

export async function getVendor(principal: Principal, vendorId: string) {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    include: {
      contacts: { orderBy: { isPrimary: "desc" } },
      bankingProfiles: { orderBy: { createdAt: "desc" }, include: { pennyTests: { orderBy: { sentAt: "desc" } } } },
      documents: { orderBy: { uploadedAt: "desc" } },
      riskFlags: { where: { resolvedAt: null }, orderBy: { createdAt: "desc" } },
      defaultExpenseAccount: true,
      defaultDepartment: true,
      invoices: { take: 10, orderBy: { invoiceDate: "desc" } },
      payments: { take: 10, orderBy: { paymentDate: "desc" } },
    },
  });
  if (!vendor) throw new NotFoundError("Vendor", vendorId);
  assertTenantOwned(vendor, principal);
  if (!hasPermission(principal, vendor.clubId, "vendor:view")) throw new ForbiddenError("Not permitted to view vendors");
  return vendor;
}

// Computed vendor balance — open AP invoices minus posted payments. Source-of-
// truth check; the AP→GL reconciliation report uses this and compares to 2010.
export async function getVendorBalance(clubId: string, vendorId: string): Promise<number> {
  const invoices = await prisma.aPInvoice.findMany({
    where: {
      clubId, vendorId,
      status: { in: ["POSTED", "PARTIALLY_PAID"] },
    },
    select: { total: true, amountPaid: true },
  });
  let owed = 0;
  for (const i of invoices) {
    owed += Number(i.total.toString()) - Number(i.amountPaid.toString());
  }
  return Math.round(owed * 100) / 100;
}
