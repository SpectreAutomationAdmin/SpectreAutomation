// Sprint 3 Checkpoint 15G (2026-07-24) — Statement vendor resolution.
//
// Reuses the 15F vendor-intelligence resolver (alias-aware) and adds
// statement-specific signal collection from the extracted header.
// Always returns the CANONICAL vendor (aliases resolve to the canonical
// row) so downstream matching runs against the full ledger.

import { prisma } from "@/lib/prisma";
import type { ExtractedStatement, StatementVendorResolutionState } from "./types";
import { resolveAnyAlias, normaliseAliasValue } from "@/lib/vendor-intelligence/resolve";
import { normaliseVendorName } from "@/lib/vendor-intelligence/normalize";

export interface StatementVendorCandidate {
  id: string;
  legalName: string;
  operatingName: string | null;
  matchSignals: string[];
}

export interface StatementVendorResolution {
  state: StatementVendorResolutionState;
  canonicalVendorId: string | null;
  candidates: StatementVendorCandidate[];
  ruleVersion: number;
}

const RULE_VERSION = 1;

export async function resolveStatementVendor(args: {
  clubId: string;
  extraction: ExtractedStatement;
  senderAddress?: string | null;
}): Promise<StatementVendorResolution> {
  const header = args.extraction.header;
  const name = header.vendorNameGuess ?? "";
  const accountNumber = header.vendorAccountNumber ?? "";

  const candidatesById = new Map<string, StatementVendorCandidate>();

  // Signal 1: alias hit (Jonas code, tax number, legal name, operating name).
  const aliasHit = await resolveAnyAlias({
    clubId: args.clubId,
    legalName: name,
    jonasVendorCode: accountNumber,
  });
  if (aliasHit) {
    const v = await prisma.vendor.findFirst({
      where: { id: aliasHit.canonicalVendorId, clubId: args.clubId, status: { not: "MERGED" } },
      select: { id: true, legalName: true, operatingName: true },
    });
    if (v) {
      upsert(candidatesById, v, `alias.${aliasHit.aliasKind.toLowerCase()}`);
    }
  }

  // Signal 2: exact legalName / operatingName after normalization.
  if (name.length >= 3) {
    const nameNorm = normaliseVendorName(name);
    if (nameNorm.length >= 3) {
      const rows = await prisma.vendor.findMany({
        where: { clubId: args.clubId, status: { not: "MERGED" } },
        select: { id: true, legalName: true, operatingName: true },
        take: 500,
      });
      for (const v of rows) {
        const ln = normaliseVendorName(v.legalName);
        const on = v.operatingName ? normaliseVendorName(v.operatingName) : "";
        if (ln === nameNorm || on === nameNorm) upsert(candidatesById, v, "name_normalised");
      }
    }
  }

  // Signal 3: sender-address domain (email domain match against Vendor.email).
  if (args.senderAddress) {
    const emailAt = args.senderAddress.indexOf("@");
    if (emailAt > 0) {
      const domain = args.senderAddress.slice(emailAt + 1).toLowerCase();
      const rows = await prisma.vendor.findMany({
        where: { clubId: args.clubId, status: { not: "MERGED" }, NOT: { email: null } },
        select: { id: true, legalName: true, operatingName: true, email: true },
        take: 500,
      });
      for (const v of rows) {
        const vd = (v.email ?? "").toLowerCase();
        if (vd.endsWith(`@${domain}`)) upsert(candidatesById, v, "email_domain");
      }
    }
  }

  const candidates = [...candidatesById.values()];
  const alwaysCanonical = !!aliasHit && candidates.length === 1;
  if (candidates.length === 0) {
    return { state: "NOT_FOUND", canonicalVendorId: null, candidates: [], ruleVersion: RULE_VERSION };
  }
  if (candidates.length === 1) {
    return { state: "MATCHED", canonicalVendorId: candidates[0].id, candidates, ruleVersion: RULE_VERSION };
  }
  // Multiple candidates — treat as ambiguous. An alias hit that also
  // returned a name match against a DIFFERENT vendor is a genuine
  // conflict; flag as CONFLICT_REQUIRES_REVIEW.
  if (aliasHit) {
    return { state: "CONFLICT_REQUIRES_REVIEW", canonicalVendorId: aliasHit.canonicalVendorId, candidates, ruleVersion: RULE_VERSION };
  }
  return { state: "AMBIGUOUS", canonicalVendorId: null, candidates, ruleVersion: RULE_VERSION };
}

function upsert(map: Map<string, StatementVendorCandidate>, v: { id: string; legalName: string; operatingName: string | null }, signal: string): void {
  const existing = map.get(v.id);
  if (existing) {
    if (!existing.matchSignals.includes(signal)) existing.matchSignals.push(signal);
    return;
  }
  map.set(v.id, { id: v.id, legalName: v.legalName, operatingName: v.operatingName, matchSignals: [signal] });
}
