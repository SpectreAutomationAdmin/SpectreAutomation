// Phase 6I — Global search.
//
// Permission-aware, tenant-safe global search across members, vendors,
// invoices, journal entries, reports, events, assets, inventory, employees,
// documents, and reporting packages. Backed by a denormalized
// SearchIndexEntry table that the service layer refreshes on writes.

import { prisma } from "../prisma";
import { requirePermission, hasPermission, type Principal } from "../rbac";
import type { PermissionKey } from "../permissions";

export type SearchHit = {
  entityType: string;
  entityId: string;
  title: string;
  subtitle: string | null;
  url: string;
  meta: unknown;
};

// ---------------------------------------------------------------------------
// Index writes — call these from service layers when an entity is created /
// renamed. Cheap upserts (no full reindex needed at write time).
// ---------------------------------------------------------------------------
export async function indexEntity(args: {
  clubId: string;
  entityType: string; entityId: string;
  title: string; subtitle?: string | null; body?: string | null;
  url: string; permissionKey?: PermissionKey; meta?: unknown;
}) {
  return prisma.searchIndexEntry.upsert({
    where: { clubId_entityType_entityId: { clubId: args.clubId, entityType: args.entityType, entityId: args.entityId } },
    update: {
      title: args.title, subtitle: args.subtitle ?? null, body: args.body ?? null,
      url: args.url, permissionKey: args.permissionKey ?? null,
      metaJson: args.meta ? JSON.stringify(args.meta) : null,
    },
    create: {
      clubId: args.clubId,
      entityType: args.entityType, entityId: args.entityId,
      title: args.title, subtitle: args.subtitle ?? null, body: args.body ?? null,
      url: args.url, permissionKey: args.permissionKey ?? null,
      metaJson: args.meta ? JSON.stringify(args.meta) : null,
    },
  });
}

export async function removeFromIndex(clubId: string, entityType: string, entityId: string) {
  await prisma.searchIndexEntry.deleteMany({ where: { clubId, entityType, entityId } });
}

// ---------------------------------------------------------------------------
// Read — permission-aware filter on results.
// ---------------------------------------------------------------------------
export async function globalSearch(principal: Principal, clubId: string, query: string, opts?: { entityTypes?: string[]; limit?: number }): Promise<SearchHit[]> {
  requirePermission(principal, clubId, "search:read");
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const entries = await prisma.searchIndexEntry.findMany({
    where: {
      clubId,
      ...(opts?.entityTypes ? { entityType: { in: opts.entityTypes } } : {}),
      OR: [
        { title: { contains: q } },
        { subtitle: { contains: q } },
        { body: { contains: q } },
      ],
    },
    take: opts?.limit ?? 50,
    orderBy: { updatedAt: "desc" },
  });
  // Permission-aware filter.
  return entries
    .filter((e) => !e.permissionKey || hasPermission(principal, clubId, e.permissionKey as PermissionKey))
    .map((e) => ({
      entityType: e.entityType, entityId: e.entityId,
      title: e.title, subtitle: e.subtitle, url: e.url,
      meta: e.metaJson ? safeParse(e.metaJson) : null,
    }));
}

function safeParse(j: string): unknown {
  try { return JSON.parse(j); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Bootstrap reindex — best-effort batch indexer. Idempotent.
// ---------------------------------------------------------------------------
export async function reindexClub(clubId: string) {
  const [members, vendors, invoices, journalEntries, packages, assets, employees, documents] = await Promise.all([
    prisma.member.findMany({ where: { clubId }, take: 500 }),
    prisma.vendor.findMany({ where: { clubId }, take: 500 }),
    prisma.aPInvoice.findMany({ where: { clubId }, include: { vendor: true }, take: 500 }),
    prisma.journalEntry.findMany({ where: { clubId }, take: 500 }),
    prisma.reportingPackage.findMany({ where: { clubId }, take: 500 }),
    prisma.capitalAsset.findMany({ where: { clubId }, take: 500 }),
    prisma.employee.findMany({ where: { clubId }, take: 500 }),
    prisma.document.findMany({ where: { clubId, status: "ACTIVE" }, take: 500 }),
  ]);
  for (const m of members) {
    await indexEntity({
      clubId, entityType: "MEMBER", entityId: m.id,
      title: `${m.firstName} ${m.lastName}`, subtitle: `${m.memberNumber} · ${m.membershipCategory ?? "—"}`,
      url: `/app/admin/members/${m.id}`, permissionKey: "members:read",
    });
  }
  for (const v of vendors) {
    await indexEntity({
      clubId, entityType: "VENDOR", entityId: v.id,
      title: v.legalName, subtitle: v.operatingName ?? null,
      url: `/app/admin/ap/vendors/${v.id}`, permissionKey: "vendor:view",
    });
  }
  for (const i of invoices) {
    await indexEntity({
      clubId, entityType: "INVOICE", entityId: i.id,
      title: `${i.invoiceNumber} — ${i.vendor.legalName}`, subtitle: `${i.status} · $${i.total.toString()}`,
      url: `/app/admin/ap/invoices/${i.id}`, permissionKey: "ap:invoice:view",
    });
  }
  for (const j of journalEntries) {
    await indexEntity({
      clubId, entityType: "JOURNAL_ENTRY", entityId: j.id,
      title: `JE ${j.entryNumber}`, subtitle: j.description ?? null,
      url: `/app/admin/gl/${j.id}`, permissionKey: "gl:read",
    });
  }
  for (const p of packages) {
    await indexEntity({
      clubId, entityType: "PACKAGE", entityId: p.id,
      title: `${p.name} · v${p.version}`, subtitle: `${p.periodLabel} · ${p.status}`,
      url: `/app/admin/governance/packages/${p.id}`, permissionKey: "packages:read",
    });
  }
  for (const a of assets) {
    await indexEntity({
      clubId, entityType: "ASSET", entityId: a.id,
      title: `${a.assetNumber} · ${a.name}`, subtitle: `${a.status}`,
      url: `/app/admin/ops/assets`, permissionKey: "assets:read",
    });
  }
  for (const e of employees) {
    await indexEntity({
      clubId, entityType: "EMPLOYEE", entityId: e.id,
      title: `${e.firstName} ${e.lastName}`, subtitle: e.employeeNumber,
      url: `/app/admin/ops/payroll`, permissionKey: "payroll:read",
    });
  }
  for (const d of documents) {
    await indexEntity({
      clubId, entityType: "DOCUMENT", entityId: d.id,
      title: d.name, subtitle: d.description ?? null, body: d.searchText ?? null,
      url: `/app/admin/documents/${d.id}`, permissionKey: "documents:read",
    });
  }
}
