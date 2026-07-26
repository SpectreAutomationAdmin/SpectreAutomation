// Phase 14C — Saved import templates (Jonas + generic).
//
// Templates persist the column-name mapping + required-column list that an
// import batch should use. The shipped catalog covers Jonas (the most common
// legacy system for the first pilot) plus generic CSV/XLSX scaffolds, but
// implementation staff can add their own.
//
// Lifecycle:
//   DRAFT      → editable
//   PUBLISHED  → visible in the import wizard; mapping is locked
//   ARCHIVED   → no longer offered; existing references still valid
//
// `version` allows non-destructive iteration — bumping a template publishes
// a new row rather than mutating the existing one.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { isSuperAdmin, requirePermission, type Principal } from "../rbac";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";

// ---------------------------------------------------------------------------
// Catalog — shipped templates seeded on first read.
// ---------------------------------------------------------------------------
type CatalogTemplate = {
  key: string;
  source: "JONAS" | "GENERIC_CSV" | "GENERIC_XLSX";
  domain: string;
  name: string;
  description: string;
  mapping: Record<string, string>;
  requiredColumns: string[];
  transforms?: Record<string, string>;
};

export const SHIPPED_TEMPLATES: CatalogTemplate[] = [
  {
    key: "jonas.members.v1", source: "JONAS", domain: "MEMBERS",
    name: "Jonas — Members export",
    description: "Maps the Jonas Member Master export columns to Spectre member fields.",
    mapping: {
      "Member #": "memberNumber",
      "First Name": "firstName",
      "Last Name": "lastName",
      "Email Address": "email",
      "Phone": "phone",
      "Category Code": "membershipCategory",
      "Join Date": "joinDate",
      "Status": "status",
    },
    requiredColumns: ["Member #", "First Name", "Last Name", "Email Address"],
    transforms: { "Status": "uppercase" },
  },
  {
    key: "jonas.member_balances.v1", source: "JONAS", domain: "AR_HISTORY",
    name: "Jonas — Member account balances",
    description: "Per-member opening AR balance rows from the Jonas Member Balances report.",
    mapping: {
      "Member #": "memberNumber",
      "Transaction Date": "transactionDate",
      "Category": "category",
      "Description": "description",
      "Amount": "amount",
    },
    requiredColumns: ["Member #", "Amount"],
  },
  {
    key: "jonas.ar_aging.v1", source: "JONAS", domain: "AR_HISTORY",
    name: "Jonas — AR aging report",
    description: "Aging buckets pulled from the Jonas AR Aging detail report.",
    mapping: {
      "Member": "memberNumber",
      "Invoice Date": "transactionDate",
      "Category": "category",
      "Description": "description",
      "Outstanding": "amount",
    },
    requiredColumns: ["Member", "Outstanding"],
  },
  {
    key: "jonas.vendors.v1", source: "JONAS", domain: "VENDORS",
    name: "Jonas — Vendors export",
    description: "Vendor master from Jonas AP — name, terms, payment method, default GL.",
    mapping: {
      "Vendor Name": "legalName",
      "Display Name": "displayName",
      "Email": "email",
      "Phone": "phone",
      "Terms (days)": "paymentTermsDays",
      "Pay Method": "paymentMethod",
      "Default GL": "defaultExpenseAccountNumber",
      "Tax Code": "defaultTaxCodeKey",
    },
    requiredColumns: ["Vendor Name"],
  },
  {
    key: "jonas.coa.v1", source: "JONAS", domain: "COA",
    name: "Jonas — Chart of accounts",
    description: "GL accounts exported from Jonas Accounting.",
    mapping: {
      "Account #": "number",
      "Account Name": "name",
      "Type": "type",
      "Category": "categoryKey",
      "FS Group": "fsGroupKey",
      "Department": "departmentCode",
    },
    requiredColumns: ["Account #", "Account Name", "Type"],
    transforms: { "Type": "uppercase" },
  },
  {
    key: "jonas.trial_balance.v1", source: "JONAS", domain: "OPENING_TRIAL_BALANCE",
    name: "Jonas — Trial balance",
    description: "Opening trial balance — one row per account with debit OR credit.",
    mapping: {
      "Account #": "accountNumber",
      "Debit": "debit",
      "Credit": "credit",
      "Description": "description",
    },
    requiredColumns: ["Account #"],
  },
  {
    key: "jonas.ap_vendor_balances.v1", source: "JONAS", domain: "AR_HISTORY",
    name: "Jonas — AP vendor balances",
    description: "Vendor opening balances from the Jonas AP aging report (for opening AP subledger).",
    mapping: {
      "Vendor Name": "memberNumber",
      "Outstanding": "amount",
      "Description": "description",
    },
    requiredColumns: ["Vendor Name", "Outstanding"],
  },
  {
    key: "jonas.inventory.v1", source: "JONAS", domain: "INVENTORY",
    name: "Jonas — Inventory items",
    description: "Pro shop + F&B inventory items from Jonas.",
    mapping: {
      "SKU": "sku",
      "Item Name": "name",
      "Category": "categoryName",
      "UOM": "unit",
      "Avg Cost": "unitCost",
      "Reorder At": "reorderLevel",
    },
    requiredColumns: ["SKU", "Item Name"],
  },
  {
    key: "generic.csv.members.v1", source: "GENERIC_CSV", domain: "MEMBERS",
    name: "Generic CSV — Members",
    description: "Stock CSV layout for migrating members from any source.",
    mapping: {
      "memberNumber": "memberNumber",
      "firstName": "firstName",
      "lastName": "lastName",
      "email": "email",
      "phone": "phone",
      "membershipCategory": "membershipCategory",
      "joinDate": "joinDate",
      "status": "status",
    },
    requiredColumns: ["memberNumber", "firstName", "lastName", "email"],
  },
  {
    key: "generic.xlsx.coa.v1", source: "GENERIC_XLSX", domain: "COA",
    name: "Generic XLSX — Chart of accounts",
    description: "Stock XLSX layout for migrating GL accounts from any source.",
    mapping: { "number": "number", "name": "name", "type": "type" },
    requiredColumns: ["number", "name", "type"],
  },
];

// ---------------------------------------------------------------------------
// Seeding — idempotent. First read seeds the catalog as GLOBAL PUBLISHED.
// ---------------------------------------------------------------------------
async function ensureSeeded() {
  // Detect seed status via the DB (tests reset the DB between runs).
  const existingCount = await prisma.importTemplate.count({ where: { scope: "GLOBAL" } });
  if (existingCount >= SHIPPED_TEMPLATES.length) return;
  for (const t of SHIPPED_TEMPLATES) {
    await prisma.importTemplate.upsert({
      where: { scope_key_version: { scope: "GLOBAL", key: t.key, version: 1 } },
      update: {},
      create: {
        scope: "GLOBAL", source: t.source, domain: t.domain,
        key: t.key, version: 1, name: t.name, description: t.description,
        mappingJson: JSON.stringify(t.mapping),
        requiredColumns: JSON.stringify(t.requiredColumns),
        transformsJson: JSON.stringify(t.transforms ?? {}),
        status: "PUBLISHED", isDefault: true,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Read APIs
// ---------------------------------------------------------------------------
export async function listTemplates(args: { clubId?: string | null; domain?: string } = {}) {
  await ensureSeeded();
  return prisma.importTemplate.findMany({
    where: {
      AND: [
        { OR: [{ scope: "GLOBAL" }, ...(args.clubId ? [{ clubId: args.clubId }] : [])] },
        ...(args.domain ? [{ domain: args.domain }] : []),
        { status: { not: "ARCHIVED" } },
      ],
    },
    orderBy: [{ scope: "asc" }, { domain: "asc" }, { name: "asc" }],
  });
}

export async function getTemplate(templateId: string) {
  const t = await prisma.importTemplate.findUnique({ where: { id: templateId } });
  if (!t) throw new NotFoundError("ImportTemplate", templateId);
  return {
    ...t,
    mapping: JSON.parse(t.mappingJson) as Record<string, string>,
    requiredColumns: JSON.parse(t.requiredColumns) as string[],
    transforms: JSON.parse(t.transformsJson) as Record<string, string>,
  };
}

// ---------------------------------------------------------------------------
// Apply a template to a batch — copies mapping into ImportBatch.mappingJson.
// ---------------------------------------------------------------------------
export async function applyTemplateToBatch(principal: Principal, args: { templateId: string; batchId: string }) {
  const template = await getTemplate(args.templateId);
  const batch = await prisma.importBatch.findUnique({ where: { id: args.batchId } });
  if (!batch) throw new NotFoundError("ImportBatch", args.batchId);
  // Tenant guard.
  if (template.scope === "CLUB" && template.clubId !== batch.clubId) {
    throw new ForbiddenError("Template belongs to a different club");
  }
  if (template.domain !== batch.domain) {
    throw new ConflictError(`Template domain ${template.domain} does not match batch domain ${batch.domain}`);
  }
  // Required-column validation against any row we already have.
  const firstRow = await prisma.importRow.findFirst({ where: { batchId: batch.id }, orderBy: { rowNumber: "asc" } });
  if (firstRow) {
    const headers = Object.keys(JSON.parse(firstRow.rawJson));
    const missing = template.requiredColumns.filter((col) => !headers.includes(col));
    if (missing.length > 0) {
      throw new ValidationError(missing.map((m) => ({ path: m, message: `Required column "${m}" missing from upload` })));
    }
  }
  const updated = await prisma.importBatch.update({
    where: { id: batch.id },
    data: { mappingJson: template.mappingJson },
  });
  await audit(principal, {
    action: "import.template.apply",
    entityType: "ImportBatch",
    entityId: batch.id,
    clubId: batch.clubId,
    after: { templateKey: template.key, templateVersion: template.version },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Write APIs (custom club templates)
// ---------------------------------------------------------------------------
export const upsertSchema = z.object({
  clubId: z.string().optional(), // omit for GLOBAL (SUPER_ADMIN only)
  source: z.enum(["JONAS", "GENERIC_CSV", "GENERIC_XLSX", "CUSTOM"]).default("CUSTOM"),
  domain: z.string().min(1).max(60),
  key: z.string().min(3).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/, "key must be lowercase slug"),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  mapping: z.record(z.string(), z.string()).default({}),
  requiredColumns: z.array(z.string().min(1).max(120)).default([]),
  transforms: z.record(z.string(), z.string()).default({}),
});

export async function upsertTemplate(principal: Principal, raw: unknown) {
  const parsed = upsertSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const isGlobal = !parsed.data.clubId;
  if (isGlobal && !isSuperAdmin(principal)) throw new ForbiddenError("Only SUPER_ADMIN may publish global templates");
  if (!isGlobal) requirePermission(principal, parsed.data.clubId!, "settings:write");

  // Bump version on every save so referenced batches don't suddenly mutate.
  const existing = await prisma.importTemplate.findFirst({
    where: { scope: isGlobal ? "GLOBAL" : "CLUB", key: parsed.data.key, clubId: isGlobal ? null : parsed.data.clubId },
    orderBy: { version: "desc" },
  });
  const version = (existing?.version ?? 0) + 1;
  const template = await prisma.importTemplate.create({
    data: {
      scope: isGlobal ? "GLOBAL" : "CLUB",
      clubId: isGlobal ? null : parsed.data.clubId,
      source: parsed.data.source,
      domain: parsed.data.domain,
      key: parsed.data.key,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      version,
      mappingJson: JSON.stringify(parsed.data.mapping),
      requiredColumns: JSON.stringify(parsed.data.requiredColumns),
      transformsJson: JSON.stringify(parsed.data.transforms),
      status: "DRAFT",
      createdByUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "import.template.upsert",
    entityType: "ImportTemplate",
    entityId: template.id,
    clubId: template.clubId ?? null,
    after: { key: template.key, version },
  });
  return template;
}

export async function publishTemplate(principal: Principal, templateId: string) {
  const t = await prisma.importTemplate.findUnique({ where: { id: templateId } });
  if (!t) throw new NotFoundError("ImportTemplate", templateId);
  if (t.scope === "GLOBAL" && !isSuperAdmin(principal)) throw new ForbiddenError("Only SUPER_ADMIN may publish global templates");
  if (t.scope === "CLUB") requirePermission(principal, t.clubId!, "settings:write");
  return prisma.importTemplate.update({ where: { id: t.id }, data: { status: "PUBLISHED" } });
}

export async function archiveTemplate(principal: Principal, templateId: string) {
  const t = await prisma.importTemplate.findUnique({ where: { id: templateId } });
  if (!t) throw new NotFoundError("ImportTemplate", templateId);
  if (t.scope === "GLOBAL" && !isSuperAdmin(principal)) throw new ForbiddenError("Only SUPER_ADMIN may archive global templates");
  if (t.scope === "CLUB") requirePermission(principal, t.clubId!, "settings:write");
  return prisma.importTemplate.update({ where: { id: t.id }, data: { status: "ARCHIVED" } });
}
