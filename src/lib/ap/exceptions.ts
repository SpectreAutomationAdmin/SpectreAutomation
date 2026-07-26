// AP exception engine.
//
// Detection runs after each AP invoice create/edit and emits APException rows.
// Severity controls UI prominence; override of HIGH-severity flags requires
// the `ap:exception:override` permission.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, hasPermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { isExpectedTaxForRegion } from "./tax-codes";
import { ConflictError } from "../errors";

const ATTACHMENT_THRESHOLD = 500; // invoices > $500 require an attachment

type ExceptionInput = {
  kind: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
  description: string;
};

// Detect exceptions on an AP invoice. Idempotent — clears prior OPEN flags
// for this invoice and re-creates the current set.
export async function detectInvoiceExceptions(principal: Principal, clubId: string, invoiceId: string) {
  const inv = await prisma.aPInvoice.findUnique({
    where: { id: invoiceId },
    include: {
      vendor: { include: { riskFlags: { where: { resolvedAt: null } } } },
      lines: { include: { taxCode: true } },
      attachments: true,
    },
  });
  if (!inv) return [];

  const club = await prisma.club.findUnique({ where: { id: clubId } });
  const expectedRegion = club?.region ?? null;

  // Clear prior OPEN flags so we can re-detect cleanly.
  await prisma.aPException.updateMany({
    where: { clubId, invoiceId, status: "OPEN" },
    data: { status: "OVERRIDDEN", resolutionNote: "Replaced by re-detection" },
  });

  const flags: ExceptionInput[] = [];

  // (1) Duplicate by vendor invoice number — caught at create time, but if
  // we got here without a vendorReference, soft-flag.
  if (!inv.vendorReference) {
    flags.push({ kind: "DUPLICATE_INVOICE_NUMBER", severity: "LOW", description: "No vendor invoice number on file — duplicate detection limited." });
  }

  // (2) Duplicate amount + date + vendor (close approximate match)
  const sameDateAmount = await prisma.aPInvoice.findFirst({
    where: {
      clubId, vendorId: inv.vendorId, id: { not: inv.id },
      total: inv.total,
      invoiceDate: { gte: new Date(inv.invoiceDate.getTime() - 7 * 86400000), lte: new Date(inv.invoiceDate.getTime() + 7 * 86400000) },
    },
  });
  if (sameDateAmount) {
    flags.push({
      kind: "DUPLICATE_AMOUNT_DATE",
      severity: "MEDIUM",
      description: `Similar invoice ${sameDateAmount.invoiceNumber} (same vendor, ±7 days, same total ${inv.total.toString()})`,
    });
  }

  // (3) New vendor: vendor's first AP invoice
  const priorCount = await prisma.aPInvoice.count({ where: { clubId, vendorId: inv.vendorId, id: { not: inv.id } } });
  if (priorCount === 0) {
    flags.push({ kind: "NEW_VENDOR", severity: "MEDIUM", description: "First AP invoice for this vendor." });
  }

  // (4) Banking recently changed
  const recentBanking = await prisma.vendorBankingProfile.findFirst({
    where: {
      vendorId: inv.vendorId,
      OR: [
        { approvedAt: { gte: new Date(Date.now() - 30 * 86400000) } },
        { createdAt: { gte: new Date(Date.now() - 30 * 86400000) }, status: "VERIFIED" },
      ],
    },
  });
  if (recentBanking) {
    flags.push({ kind: "BANKING_RECENTLY_CHANGED", severity: "HIGH", description: "Vendor banking was updated in the last 30 days." });
  }

  // (5) Exceeds normal spend (3x average of prior 6 months)
  const sixMonthsAgo = new Date(Date.now() - 180 * 86400000);
  const prior = await prisma.aPInvoice.findMany({
    where: { clubId, vendorId: inv.vendorId, id: { not: inv.id }, invoiceDate: { gte: sixMonthsAgo }, status: { in: ["POSTED", "PARTIALLY_PAID", "PAID"] } },
    select: { total: true },
  });
  if (prior.length >= 3) {
    const avg = prior.reduce((s, p) => s + Number(p.total.toString()), 0) / prior.length;
    const cur = Number(inv.total.toString());
    if (avg > 0 && cur > avg * 3) {
      flags.push({
        kind: "EXCEEDS_NORMAL_SPEND",
        severity: "MEDIUM",
        description: `Invoice total ${cur.toFixed(2)} exceeds 3× the 6-mo average ${avg.toFixed(2)} for this vendor.`,
      });
    }
  }

  // (6) Unexpected tax (e.g., PST/QST on an Alberta club)
  for (const line of inv.lines) {
    if (line.taxCode && !isExpectedTaxForRegion(expectedRegion, line.taxCode.key)) {
      flags.push({
        kind: "UNEXPECTED_TAX",
        severity: "LOW",
        description: `Tax code ${line.taxCode.key} unusual for ${expectedRegion ?? "club"} region.`,
      });
      break;
    }
  }

  // (7) Missing attachment for invoices > threshold
  if (Number(inv.total.toString()) > ATTACHMENT_THRESHOLD && inv.attachments.length === 0) {
    flags.push({
      kind: "MISSING_ATTACHMENT",
      severity: "MEDIUM",
      description: `Invoices over $${ATTACHMENT_THRESHOLD} should have a supporting attachment.`,
    });
  }

  // (8) Blocked vendor
  if (inv.vendor.status === "BLOCKED") {
    flags.push({ kind: "BLOCKED_VENDOR", severity: "HIGH", description: "Vendor is BLOCKED. Invoice cannot be paid." });
  }

  // (9) Self-approved: creator is going to approve their own request later.
  // Recorded only as a hint; the approval engine will block at decision time.
  if (inv.createdByUserId && principal.id === inv.createdByUserId && Number(inv.total.toString()) > 0) {
    flags.push({
      kind: "SELF_APPROVED",
      severity: "LOW",
      description: "Invoice created by the same user; approval will require a different approver.",
    });
  }

  // Insert.
  for (const f of flags) {
    await prisma.aPException.create({
      data: { clubId, invoiceId, vendorId: inv.vendorId, kind: f.kind, severity: f.severity, description: f.description, status: "OPEN" },
    });
  }
  return flags;
}

export async function overrideException(principal: Principal, exceptionId: string, note: string) {
  const ex = await prisma.aPException.findUnique({ where: { id: exceptionId } });
  assertTenantOwned(ex, principal);
  requirePermission(principal, ex.clubId, "ap:exception:override");
  if (ex.status !== "OPEN") throw new ConflictError(`Exception is ${ex.status}`);
  const updated = await prisma.aPException.update({
    where: { id: exceptionId },
    data: { status: "OVERRIDDEN", overrideByUserId: principal.id, resolvedAt: new Date(), resolutionNote: note },
  });
  await audit(principal, {
    action: "ap.exception.override",
    entityType: "APException", entityId: exceptionId, clubId: ex.clubId,
    before: { status: "OPEN" }, after: { status: "OVERRIDDEN" },
    meta: { kind: ex.kind, severity: ex.severity, note },
  });
  return updated;
}

export async function resolveException(principal: Principal, exceptionId: string, note: string) {
  const ex = await prisma.aPException.findUnique({ where: { id: exceptionId } });
  assertTenantOwned(ex, principal);
  // Less restricted — anyone with AP read can resolve a low-severity exception
  // by adding a note. HIGH-severity flags need override.
  if (ex.severity === "HIGH" && !hasPermission(principal, ex.clubId, "ap:exception:override")) {
    throw new ConflictError("HIGH severity exceptions require override permission");
  }
  const updated = await prisma.aPException.update({
    where: { id: exceptionId },
    data: { status: "RESOLVED", resolvedAt: new Date(), resolutionNote: note },
  });
  await audit(principal, {
    action: "ap.exception.resolve",
    entityType: "APException", entityId: exceptionId, clubId: ex.clubId,
    before: { status: "OPEN" }, after: { status: "RESOLVED" },
    meta: { kind: ex.kind, note },
  });
  return updated;
}
