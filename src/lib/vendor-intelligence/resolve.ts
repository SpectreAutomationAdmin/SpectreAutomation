// Sprint 3 Checkpoint 15F (2026-07-24) — Alias resolver for future
// imports (Phase K).
//
// Given a candidate identifier (Jonas vendor code, legacy invoice
// number, or legal name), return the canonical Vendor if a
// VendorAlias exists — otherwise null. Import paths MUST call this
// BEFORE deciding to create a new Vendor.

import { prisma } from "@/lib/prisma";
import type { PrismaClient } from "@prisma/client";
import type { VendorAliasKind } from "./types";
import { normaliseTaxNumber, normaliseVendorName } from "./normalize";

export interface ResolveAliasArgs {
  clubId: string;
  aliasKind: VendorAliasKind;
  aliasValue: string;
}

export interface ResolvedAlias {
  canonicalVendorId: string;
  aliasKind: VendorAliasKind;
  aliasValueNormalized: string;
}

// The single normalization function per alias kind so writes and
// reads always use the same key.
export function normaliseAliasValue(aliasKind: VendorAliasKind, raw: string): string {
  switch (aliasKind) {
    case "JONAS_VENDOR_CODE":
    case "LEGACY_INVOICE_NUMBER":
    case "OTHER":
      return raw.trim().toUpperCase();
    case "TAX_NUMBER":
      return normaliseTaxNumber(raw);
    case "LEGAL_NAME":
    case "OPERATING_NAME":
      return normaliseVendorName(raw);
  }
}

// Resolve — read-only. Returns null when no alias exists.
export async function resolveVendorAlias(args: ResolveAliasArgs): Promise<ResolvedAlias | null> {
  const normalized = normaliseAliasValue(args.aliasKind, args.aliasValue);
  if (!normalized) return null;
  const alias = await prisma.vendorAlias.findFirst({
    where: {
      clubId: args.clubId,
      aliasKind: args.aliasKind,
      aliasValueNormalized: normalized,
    },
    select: { canonicalVendorId: true },
  });
  if (!alias) return null;
  return {
    canonicalVendorId: alias.canonicalVendorId,
    aliasKind: args.aliasKind,
    aliasValueNormalized: normalized,
  };
}

// Convenience: try several alias kinds in a single call. Order matters
// — tax number wins over legal name. Returns the first hit.
export async function resolveAnyAlias(args: {
  clubId: string;
  taxNumber?: string | null;
  legalName?: string | null;
  operatingName?: string | null;
  jonasVendorCode?: string | null;
}): Promise<ResolvedAlias | null> {
  const tries: Array<{ kind: VendorAliasKind; value: string | null | undefined }> = [
    { kind: "TAX_NUMBER",         value: args.taxNumber },
    { kind: "JONAS_VENDOR_CODE",  value: args.jonasVendorCode },
    { kind: "LEGAL_NAME",         value: args.legalName },
    { kind: "OPERATING_NAME",     value: args.operatingName },
  ];
  for (const t of tries) {
    if (!t.value) continue;
    const hit = await resolveVendorAlias({ clubId: args.clubId, aliasKind: t.kind, aliasValue: t.value });
    if (hit) return hit;
  }
  return null;
}

// Transactional alias writer for the merge executor (Phase E).
export interface CreateAliasArgs {
  tx?: PrismaClient | { vendorAlias: PrismaClient["vendorAlias"] };
  clubId: string;
  canonicalVendorId: string;
  aliasKind: VendorAliasKind;
  aliasValue: string;
  originVendorId?: string | null;
  createdViaMergeId?: string | null;
  createdByUserId?: string | null;
}

export async function createAlias(args: CreateAliasArgs): Promise<{ created: boolean; aliasId: string }> {
  const normalized = normaliseAliasValue(args.aliasKind, args.aliasValue);
  if (!normalized) return { created: false, aliasId: "" };
  const client = args.tx ?? prisma;
  // Upsert-shape via the unique key.
  const existing = await client.vendorAlias.findFirst({
    where: {
      clubId: args.clubId,
      aliasKind: args.aliasKind,
      aliasValueNormalized: normalized,
    },
    select: { id: true, canonicalVendorId: true },
  });
  if (existing) {
    // If existing points at same canonical, nothing to do. If it points
    // at a different canonical, the caller has a data conflict — we
    // refuse to silently overwrite.
    if (existing.canonicalVendorId !== args.canonicalVendorId) {
      throw new Error(
        `VendorAlias conflict: (${args.aliasKind}, ${normalized}) already maps to canonical ${existing.canonicalVendorId.slice(-6)}, not ${args.canonicalVendorId.slice(-6)}`,
      );
    }
    return { created: false, aliasId: existing.id };
  }
  const row = await client.vendorAlias.create({
    data: {
      clubId: args.clubId,
      canonicalVendorId: args.canonicalVendorId,
      aliasKind: args.aliasKind,
      aliasValue: args.aliasValue,
      aliasValueNormalized: normalized,
      originVendorId: args.originVendorId ?? null,
      createdViaMergeId: args.createdViaMergeId ?? null,
      createdByUserId: args.createdByUserId ?? null,
    },
    select: { id: true },
  });
  return { created: true, aliasId: row.id };
}
