// Sprint 3 Checkpoint 15E (2026-07-24) — Vendor resolution for the
// AP-invoice analyser.
//
// Wraps the existing `matchVendorForClub` from mission-control and
// adds one more signal: exact match on Vendor.taxRegistrationNumber.
// All lookups are club-scoped. No cross-tenant leak.

import { prisma } from "@/lib/prisma";
import { normalizeVendorName, matchVendorForClub } from "@/lib/mission-control/invoice-analysis";
import type { ExtractedInvoice, VendorMatchState } from "./types";

export interface VendorMatchCandidate {
  id: string;
  operatingName: string | null;
  legalName: string;
  matchSignals: string[];
}

export interface VendorResolveResult {
  state: VendorMatchState;
  candidates: VendorMatchCandidate[];
  ruleVersion: number;
}

const RULE_VERSION = 1;

export async function resolveVendorForExtraction(args: {
  clubId: string;
  extraction: ExtractedInvoice;
}): Promise<VendorResolveResult> {
  const { clubId, extraction } = args;
  const email = extraction.vendor.guessedEmail?.toLowerCase() ?? "";
  const domain = extraction.vendor.guessedDomain?.toLowerCase() ?? "";
  const name = extraction.vendor.guessedName ?? "";
  const taxNumber = extraction.vendor.guessedTaxNumber ?? "";

  // Bail early on insufficient signal — never brute-force the vendor table.
  if (!email && !domain && !name && !taxNumber) {
    return { state: "INSUFFICIENT_SIGNAL", candidates: [], ruleVersion: RULE_VERSION };
  }

  // Signal 1: exact tax registration number match (strongest signal — a
  // company's HST/GST number is unique to them).
  const candidatesById = new Map<string, VendorMatchCandidate>();
  if (taxNumber) {
    const norm = taxNumber.replace(/\s+/g, "").toUpperCase();
    const byTax = await prisma.vendor.findMany({
      where: { clubId, taxRegistrationNumber: { not: null } },
      select: { id: true, operatingName: true, legalName: true, taxRegistrationNumber: true },
      take: 200,
    });
    for (const v of byTax) {
      if ((v.taxRegistrationNumber ?? "").replace(/\s+/g, "").toUpperCase() === norm) {
        upsertCandidate(candidatesById, v.id, v.operatingName, v.legalName, "tax_number_exact");
      }
    }
  }

  // Signals 2-5: reuse the mission-control matcher (email / contact
  // email / domain / normalized name).
  if (email || domain || name) {
    const totalCents = extraction.total ? Math.round(Number(extraction.total) * 100) : null;
    const invoiceNumberNormalized = extraction.invoiceNumber
      ? extraction.invoiceNumber.replace(/[^A-Za-z0-9]/g, "").replace(/^0+/, "").toLowerCase() || null
      : null;
    const mc = await matchVendorForClub({
      clubId,
      ident: {
        senderEmail: email,
        senderDomain: domain,
        senderName: name,
        invoiceNumberRaw: extraction.invoiceNumber,
        invoiceNumberNormalized,
        statedAmountCents: totalCents,
        purchaseOrderNumber: extraction.purchaseOrder,
      },
    });
    for (const c of mc.candidates) {
      upsertCandidate(candidatesById, c.id, c.operatingName, c.legalName, c.matchSignal);
    }
  }

  // Signal 6: fallback fuzzy on operatingName when we still have zero
  // candidates and a plausible vendor name from the PDF.
  if (candidatesById.size === 0 && name && name.split(/\s+/).length >= 2) {
    const norm = normalizeVendorName(name);
    if (norm.length >= 4) {
      const rows = await prisma.vendor.findMany({
        where: { clubId },
        select: { id: true, operatingName: true, legalName: true },
        take: 500,
      });
      for (const v of rows) {
        const opNorm = v.operatingName ? normalizeVendorName(v.operatingName) : "";
        const legalNorm = normalizeVendorName(v.legalName);
        if (opNorm === norm || legalNorm === norm) {
          upsertCandidate(candidatesById, v.id, v.operatingName, v.legalName, "pdf_name_normalized");
        }
      }
    }
  }

  const candidates = [...candidatesById.values()];
  if (candidates.length === 0) return { state: "NOT_FOUND", candidates: [], ruleVersion: RULE_VERSION };
  if (candidates.length === 1) return { state: "MATCHED", candidates, ruleVersion: RULE_VERSION };
  return { state: "AMBIGUOUS", candidates, ruleVersion: RULE_VERSION };
}

function upsertCandidate(
  map: Map<string, VendorMatchCandidate>,
  id: string,
  operatingName: string | null,
  legalName: string,
  signal: string,
): void {
  const existing = map.get(id);
  if (existing) {
    if (!existing.matchSignals.includes(signal)) existing.matchSignals.push(signal);
    return;
  }
  map.set(id, { id, operatingName, legalName, matchSignals: [signal] });
}
