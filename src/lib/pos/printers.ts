// Admin-managed POS printer registry.
//
// Spectre is a web app, so it can't drive an OS printer directly —
// the actual print action always goes through the browser's print
// dialog. What this registry does:
//
//   • lets the admin list named physical printers per club ("Kitchen
//     HP LaserJet 4", "Bar Star TSP100", etc.) so a server tapping
//     "Print" can pick the right one from a familiar dropdown
//
//   • carries a `role` so kitchen / bar / signature chits can hint at
//     the right default
//
//   • marks one printer as the role default, so the print picker
//     pre-selects sensibly
//
//   • leaves "Print to PDF" as the always-available fallback — the
//     UI surfaces it whenever no printer matches the requested role
//
// The driver layer that would actually send IPP / USB jobs is not in
// scope yet; `getChitTransport()` (src/lib/pos/chit.ts) still returns
// `{ kind: "pdf" }`. This file is the data plane; that file is the
// dispatch plane.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import {
  PRINTER_ROLES,
  PRINTER_KINDS,
  PDF_PRINTER_ID,
  type PrinterRole,
  type PrinterKind,
  type PrinterOption,
} from "./printers-shared";

// Re-export so existing callers can keep importing from this module.
// Client components MUST import from `./printers-shared` directly
// (this file pulls in `audit` → `next/headers`, which is server-only).
export {
  PRINTER_ROLES,
  PRINTER_KINDS,
  PDF_PRINTER_ID,
  type PrinterRole,
  type PrinterKind,
  type PrinterOption,
};
export function pdfPrinterOption(): PrinterOption {
  return {
    id: PDF_PRINTER_ID,
    name: "Print to PDF (browser)",
    role: "ANY",
    kind: "PDF",
    location: null,
    isDefault: true,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// All registered printers for a club, plus the synthetic PDF entry
// prepended. Inactive printers are excluded. If no printers are
// registered, the caller still gets the PDF entry — that's the
// "always available fallback" guarantee.
export async function listPrintersForClub(
  principal: Principal,
  clubId: string,
  opts: { role?: PrinterRole; includeInactive?: boolean } = {}
): Promise<PrinterOption[]> {
  requirePermission(principal, clubId, "inventory:read");
  const rows = await prisma.pOSPrinter.findMany({
    where: {
      clubId,
      isActive: opts.includeInactive ? undefined : true,
      // ANY printers always match; otherwise scope to role.
      ...(opts.role && opts.role !== "ANY"
        ? { OR: [{ role: "ANY" }, { role: opts.role }] }
        : {}),
    },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });
  const pdf = pdfPrinterOption();
  // The PDF option is only "default" when no real printer is
  // configured for the role. If the role has a configured default,
  // PDF still appears but at the end of the list.
  const hasRealDefault = rows.some((r) => r.isDefault);
  pdf.isDefault = !hasRealDefault;
  return [
    pdf,
    ...rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role as PrinterRole,
      kind: r.kind as PrinterKind,
      location: r.location,
      isDefault: r.isDefault,
    })),
  ];
}

// Full list for the admin settings page — includes inactive rows so
// the admin can re-activate them.
export async function listPrintersForAdmin(
  principal: Principal,
  clubId: string
) {
  requirePermission(principal, clubId, "settings:read");
  return prisma.pOSPrinter.findMany({
    where: { clubId },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const printerInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.enum(PRINTER_ROLES).default("ANY"),
  kind: z.enum(PRINTER_KINDS).default("NETWORK"),
  location: z.string().trim().max(120).optional().nullable(),
  driverHint: z.string().trim().max(200).optional().nullable(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export async function createPrinter(
  principal: Principal,
  clubId: string,
  raw: unknown
) {
  requirePermission(principal, clubId, "settings:write");
  const parsed = printerInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const d = parsed.data;
  // Uniqueness on (clubId, name) — surface a clean error instead of
  // a Prisma constraint error.
  const existing = await prisma.pOSPrinter.findFirst({
    where: { clubId, name: d.name },
  });
  if (existing) {
    throw new ConflictError(`A printer named "${d.name}" already exists at this club`);
  }
  await ensureSingleDefault(clubId, d.role, d.isDefault === true, null);
  const created = await prisma.pOSPrinter.create({
    data: {
      clubId,
      name: d.name,
      role: d.role,
      kind: d.kind,
      location: d.location ?? null,
      driverHint: d.driverHint ?? null,
      isDefault: d.isDefault ?? false,
      isActive: d.isActive ?? true,
    },
  });
  await audit(principal, {
    action: "pos.printer.create",
    entityType: "POSPrinter",
    entityId: created.id,
    clubId,
    after: { name: created.name, role: created.role, kind: created.kind, isDefault: created.isDefault },
  });
  return created;
}

export async function updatePrinter(
  principal: Principal,
  printerId: string,
  raw: unknown
) {
  const existing = await prisma.pOSPrinter.findUnique({ where: { id: printerId } });
  if (!existing) throw new NotFoundError("POSPrinter", printerId);
  assertTenantOwned(existing, principal);
  requirePermission(principal, existing.clubId, "settings:write");
  const parsed = printerInputSchema.partial().safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const d = parsed.data;
  if (d.name !== undefined && d.name !== existing.name) {
    const dupe = await prisma.pOSPrinter.findFirst({
      where: { clubId: existing.clubId, name: d.name, NOT: { id: existing.id } },
    });
    if (dupe) {
      throw new ConflictError(`A printer named "${d.name}" already exists at this club`);
    }
  }
  await ensureSingleDefault(
    existing.clubId,
    (d.role ?? existing.role) as PrinterRole,
    d.isDefault === true,
    existing.id
  );
  const updated = await prisma.pOSPrinter.update({
    where: { id: existing.id },
    data: {
      name: d.name ?? existing.name,
      role: d.role ?? existing.role,
      kind: d.kind ?? existing.kind,
      location: d.location ?? existing.location,
      driverHint: d.driverHint ?? existing.driverHint,
      isDefault: d.isDefault ?? existing.isDefault,
      isActive: d.isActive ?? existing.isActive,
    },
  });
  await audit(principal, {
    action: "pos.printer.update",
    entityType: "POSPrinter",
    entityId: updated.id,
    clubId: existing.clubId,
    before: { name: existing.name, role: existing.role, isDefault: existing.isDefault, isActive: existing.isActive },
    after: { name: updated.name, role: updated.role, isDefault: updated.isDefault, isActive: updated.isActive },
  });
  return updated;
}

export async function deletePrinter(principal: Principal, printerId: string) {
  const existing = await prisma.pOSPrinter.findUnique({ where: { id: printerId } });
  if (!existing) throw new NotFoundError("POSPrinter", printerId);
  assertTenantOwned(existing, principal);
  requirePermission(principal, existing.clubId, "settings:write");
  await prisma.pOSPrinter.delete({ where: { id: existing.id } });
  await audit(principal, {
    action: "pos.printer.delete",
    entityType: "POSPrinter",
    entityId: existing.id,
    clubId: existing.clubId,
    before: { name: existing.name, role: existing.role },
  });
}

// Clears any prior default at (clubId, role) when this row is being
// flagged as default. Keeps the "one default per role" invariant.
async function ensureSingleDefault(
  clubId: string,
  role: PrinterRole,
  becomingDefault: boolean,
  excludeId: string | null
) {
  if (!becomingDefault) return;
  await prisma.pOSPrinter.updateMany({
    where: {
      clubId,
      role,
      isDefault: true,
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    data: { isDefault: false },
  });
}
