// Phase 6B — Reporting packages (board / finance committee).
//
// A ReportingPackage is a versioned bundle of ReportRuns + narrative commentary
// + KPI grids. Sections are ordered. Once APPROVED, the package becomes
// immutable (no further edits to sections / commentaries), versioned, and
// distributable. Versioning preserves prior packages for audit.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned, tenantWhere } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { runReport } from "./reports";

export const packageSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional().nullable(),
  periodLabel: z.string().trim().min(1).max(60),
  asOfDate: z.string().or(z.date()),
  audience: z.enum(["BOARD", "FINANCE_COMMITTEE", "INTERNAL"]).default("BOARD"),
  executiveSummary: z.string().trim().max(20000).optional().nullable(),
});

export async function createPackage(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "packages:write");
  const parsed = packageSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  // Determine next version for (clubId, name).
  const last = await prisma.reportingPackage.findFirst({
    where: { clubId, name: d.name }, orderBy: { version: "desc" },
  });
  const pkg = await prisma.reportingPackage.create({
    data: {
      clubId, name: d.name, description: d.description ?? null,
      periodLabel: d.periodLabel, asOfDate: new Date(d.asOfDate),
      version: (last?.version ?? 0) + 1,
      audience: d.audience,
      executiveSummary: d.executiveSummary ?? null,
      status: "DRAFT",
      createdByUserId: principal.id,
    },
  });
  await audit(principal, { action: "package.create", entityType: "ReportingPackage", entityId: pkg.id, clubId, after: { name: d.name, version: pkg.version, periodLabel: d.periodLabel } });
  return pkg;
}

export const sectionSchema = z.object({
  title: z.string().trim().min(1).max(160),
  sortOrder: z.number().int().min(0).default(0),
  kind: z.enum(["REPORT", "NARRATIVE", "KPI_GRID", "COMMENTARY"]).default("REPORT"),
  reportDefinitionKey: z.string().optional().nullable(),
  reportParameters: z.record(z.string(), z.unknown()).optional().nullable(),
  body: z.string().trim().max(20000).optional().nullable(),
});

export async function addSection(principal: Principal, packageId: string, raw: unknown) {
  const pkg = await prisma.reportingPackage.findUnique({ where: { id: packageId } });
  assertTenantOwned(pkg, principal);
  requirePermission(principal, pkg.clubId, "packages:write");
  if (pkg.status !== "DRAFT" && pkg.status !== "IN_REVIEW") {
    throw new ConflictError(`Cannot edit sections of ${pkg.status} package — create a new version`);
  }
  const parsed = sectionSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;

  // For REPORT sections, snapshot the report by running it now.
  let reportRunId: string | null = null;
  if (d.kind === "REPORT" && d.reportDefinitionKey) {
    const run = await runReport(principal, pkg.clubId, {
      definitionKey: d.reportDefinitionKey,
      parameters: { asOf: pkg.asOfDate.toISOString(), ...(d.reportParameters ?? {}) },
    });
    reportRunId = run.id;
  }

  const section = await prisma.reportingPackageSection.create({
    data: {
      clubId: pkg.clubId, packageId,
      title: d.title, sortOrder: d.sortOrder, kind: d.kind,
      reportRunId, body: d.body ?? null,
    },
  });
  await audit(principal, { action: "package.section.add", entityType: "ReportingPackageSection", entityId: section.id, clubId: pkg.clubId, after: { title: d.title, kind: d.kind } });
  return section;
}

export const commentarySchema = z.object({
  subject: z.string().trim().min(1).max(160),
  scope: z.enum(["GENERAL", "VARIANCE", "DEPARTMENT", "ACTION_PLAN", "RISK"]).default("GENERAL"),
  body: z.string().trim().min(1).max(20000),
  followUpDate: z.string().or(z.date()).optional().nullable(),
  priorCommentaryId: z.string().optional().nullable(),
});

export async function addCommentary(principal: Principal, packageId: string, raw: unknown) {
  const pkg = await prisma.reportingPackage.findUnique({ where: { id: packageId } });
  assertTenantOwned(pkg, principal);
  requirePermission(principal, pkg.clubId, "packages:write");
  if (pkg.status === "APPROVED" || pkg.status === "DISTRIBUTED" || pkg.status === "ARCHIVED") {
    throw new ConflictError(`Cannot add commentary to ${pkg.status} package`);
  }
  const parsed = commentarySchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const commentary = await prisma.reportingPackageCommentary.create({
    data: {
      clubId: pkg.clubId, packageId,
      subject: d.subject, scope: d.scope, body: d.body,
      followUpDate: d.followUpDate ? new Date(d.followUpDate) : null,
      priorCommentaryId: d.priorCommentaryId ?? null,
      authorUserId: principal.id,
      status: "DRAFT",
    },
  });
  await audit(principal, { action: "package.commentary.add", entityType: "ReportingPackageCommentary", entityId: commentary.id, clubId: pkg.clubId, after: { subject: d.subject, scope: d.scope } });
  return commentary;
}

export async function finalizeCommentary(principal: Principal, commentaryId: string) {
  const c = await prisma.reportingPackageCommentary.findUnique({ where: { id: commentaryId } });
  assertTenantOwned(c, principal);
  requirePermission(principal, c.clubId, "packages:write");
  if (c.status === "FINALIZED") return c;
  const updated = await prisma.reportingPackageCommentary.update({
    where: { id: commentaryId },
    data: { status: "FINALIZED", finalizedAt: new Date() },
  });
  await audit(principal, { action: "package.commentary.finalize", entityType: "ReportingPackageCommentary", entityId: commentaryId, clubId: c.clubId, after: { status: "FINALIZED" } });
  return updated;
}

export async function submitForApproval(principal: Principal, packageId: string) {
  const pkg = await prisma.reportingPackage.findUnique({ where: { id: packageId } });
  assertTenantOwned(pkg, principal);
  requirePermission(principal, pkg.clubId, "packages:write");
  if (pkg.status !== "DRAFT") throw new ConflictError(`Package status is ${pkg.status}`);
  const updated = await prisma.reportingPackage.update({ where: { id: packageId }, data: { status: "IN_REVIEW" } });
  await audit(principal, { action: "package.submit", entityType: "ReportingPackage", entityId: packageId, clubId: pkg.clubId, before: { status: pkg.status }, after: { status: "IN_REVIEW" } });
  return updated;
}

export async function approvePackage(principal: Principal, packageId: string, notes?: string) {
  const pkg = await prisma.reportingPackage.findUnique({ where: { id: packageId } });
  assertTenantOwned(pkg, principal);
  requirePermission(principal, pkg.clubId, "packages:approve");
  if (pkg.status !== "IN_REVIEW" && pkg.status !== "DRAFT") {
    throw new ConflictError(`Cannot approve package in status ${pkg.status}`);
  }
  // Block self-approval — the creator cannot approve their own package.
  if (pkg.createdByUserId === principal.id) {
    throw new ConflictError("Self-approval is not permitted");
  }
  await prisma.packageApproval.create({
    data: { clubId: pkg.clubId, packageId, approverUserId: principal.id, status: "APPROVED", decidedAt: new Date(), notes: notes ?? null },
  });
  const updated = await prisma.reportingPackage.update({
    where: { id: packageId },
    data: { status: "APPROVED", finalizedAt: new Date(), finalizedByUserId: principal.id },
  });
  await audit(principal, { action: "package.approve", entityType: "ReportingPackage", entityId: packageId, clubId: pkg.clubId, after: { status: "APPROVED" } });
  return updated;
}

export const distributionSchema = z.object({
  recipientName: z.string().trim().min(1),
  recipientEmail: z.string().email(),
  recipientUserId: z.string().optional().nullable(),
  channel: z.enum(["EMAIL", "PORTAL", "DOWNLOAD"]).default("EMAIL"),
});

export async function recordDistribution(principal: Principal, packageId: string, raw: unknown) {
  const pkg = await prisma.reportingPackage.findUnique({ where: { id: packageId } });
  assertTenantOwned(pkg, principal);
  requirePermission(principal, pkg.clubId, "packages:distribute");
  if (pkg.status !== "APPROVED" && pkg.status !== "DISTRIBUTED") {
    throw new ConflictError("Package must be APPROVED before distribution");
  }
  const parsed = distributionSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const dist = await prisma.packageDistribution.create({
    data: {
      clubId: pkg.clubId, packageId,
      recipientName: d.recipientName, recipientEmail: d.recipientEmail,
      recipientUserId: d.recipientUserId ?? null, channel: d.channel,
      status: "SENT", sentAt: new Date(),
    },
  });
  if (pkg.status === "APPROVED") {
    await prisma.reportingPackage.update({ where: { id: packageId }, data: { status: "DISTRIBUTED" } });
  }
  await audit(principal, { action: "package.distribute", entityType: "PackageDistribution", entityId: dist.id, clubId: pkg.clubId, after: { recipient: d.recipientEmail, channel: d.channel } });
  return dist;
}

export async function listPackages(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "packages:read");
  return prisma.reportingPackage.findMany({
    where: tenantWhere(principal, clubId),
    include: { sections: true, commentaries: true, distributions: true, approvals: true },
    orderBy: [{ asOfDate: "desc" }, { version: "desc" }],
  });
}

export async function getPackage(principal: Principal, packageId: string) {
  const pkg = await prisma.reportingPackage.findUnique({
    where: { id: packageId },
    include: {
      sections: { include: { reportRun: { include: { definition: true } } }, orderBy: { sortOrder: "asc" } },
      commentaries: { orderBy: { createdAt: "asc" } },
      distributions: { orderBy: { sentAt: "desc" } },
      approvals: { orderBy: { decidedAt: "desc" } },
    },
  });
  if (!pkg) throw new NotFoundError("ReportingPackage", packageId);
  assertTenantOwned(pkg, principal);
  requirePermission(principal, pkg.clubId, "packages:read");
  return pkg;
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
