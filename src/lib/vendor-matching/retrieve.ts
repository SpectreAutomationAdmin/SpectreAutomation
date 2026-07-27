// Sprint 3 · Checkpoint 15P-3 (2026-07-27) — candidate retrieval.
//
// Separated from scoring per the founder rule:
//   "Candidate retrieval and candidate evaluation are separate
//    stages."
//
// This module takes the extracted profile and returns a broad set
// of tenant-scoped vendor rows that might be the same organisation.
// It does NOT rank; the caller runs `evaluateVendorMatch` against
// each returned row.
//
// Rules:
//   • Tenant-scoped by clubId, always.
//   • Uses identifying signals — normalized name, normalized
//     operating name, tax registration number, email domain,
//     phone digit prefix, website host, postal code.
//   • Does NOT return banking / EFT / remittance-instruction data.
//   • Does NOT require every signal to be present.
//   • Deduplicates by vendor id.
//   • Returns at most `limit` candidates (default 20).

import { prisma } from "@/lib/prisma";
import {
  normalizeName, normalizePhoneDigits, normalizeTaxRegistrationNumber,
  normalizeWebsiteHost, normalizePostalCode, emailDomain,
} from "./normalize";
import type { MatchInputProfile } from "./compare";

export interface VendorCandidate {
  id: string;
  legalName: string;
  operatingName: string | null;
  status: string;
  // Full profile-shaped row so `evaluateVendorMatch` can score
  // without a second Prisma round-trip.
  profile: MatchInputProfile;
  lastInvoiceDate: string | null;
}

export interface CandidateRetrievalArgs {
  clubId: string;
  extracted: MatchInputProfile;
  limit?: number;
}

export async function retrieveCandidates(args: CandidateRetrievalArgs): Promise<VendorCandidate[]> {
  const limit = args.limit ?? 20;
  const nameNorm = normalizeName(args.extracted.legalName);
  const opNameNorm = normalizeName(args.extracted.operatingName);
  const taxNorm = normalizeTaxRegistrationNumber(args.extracted.taxRegistrationNumber);
  const phoneNorm = normalizePhoneDigits(args.extracted.phone);
  const domain = emailDomain(args.extracted.email)
                ?? emailDomain(args.extracted.arEmail)
                ?? emailDomain(args.extracted.apRemittanceEmail);
  const webHost = normalizeWebsiteHost(args.extracted.website);
  const postal = normalizePostalCode(args.extracted.postalCode);

  // Build a set of OR clauses. Prisma's `contains` is case-sensitive
  // on SQLite (dev) — production runs Postgres. We use the un-
  // normalized first token of the legal name for a broad initial
  // substring sweep, and let the in-memory evaluator do the exact
  // symmetric normalization.
  //
  // The founder's brief specifically calls out "Do not require every
  // signal to be present." Each `contains` clause below is a
  // possible signal; ANY of them qualifies a candidate for retrieval.
  const or: import("@prisma/client").Prisma.VendorWhereInput[] = [];
  if (nameNorm) {
    // First non-punctuation token, minimum 3 chars. That's specific
    // enough to keep the query cheap and broad enough not to miss
    // "Microsoft Corporation" ↔ "microsoft".
    const firstToken = nameNorm.split(" ").find((t) => t.length >= 3);
    if (firstToken) or.push({ legalName: { contains: firstToken } });
    if (firstToken) or.push({ operatingName: { contains: firstToken } });
  }
  if (opNameNorm) {
    const firstToken = opNameNorm.split(" ").find((t) => t.length >= 3);
    if (firstToken) or.push({ legalName: { contains: firstToken } });
    if (firstToken) or.push({ operatingName: { contains: firstToken } });
  }
  if (taxNorm) {
    // The tenant stores tax numbers with varying punctuation; match
    // on the normalized 9-digit BN prefix so "135625069RT0001" and
    // "135625069 RT 0001" both land.
    or.push({ taxRegistrationNumber: { contains: taxNorm.slice(0, 9) } });
  }
  if (domain) or.push({ email: { contains: `@${domain}` } });
  if (phoneNorm) or.push({ phone: { contains: phoneNorm.slice(-7) } });
  if (webHost) or.push({ website: { contains: webHost } });
  if (postal) or.push({ postalCode: { contains: postal } });

  if (or.length === 0) return [];

  const rows = await prisma.vendor.findMany({
    where: { clubId: args.clubId, OR: or },
    select: {
      id: true, legalName: true, operatingName: true, status: true,
      email: true, phone: true, website: true,
      address1: true, address2: true, city: true, provinceState: true,
      postalCode: true, country: true,
      taxRegistrationNumber: true, paymentTermsDays: true,
      // Contacts, for AR / remittance / main-contact evaluation.
      contacts: {
        select: { role: true, name: true, email: true, isPrimary: true },
      },
      // NEVER select banking / EFT / remittance-instruction data:
      // bankingProfiles, pennyTests, or any processor tokens.
    },
    take: limit * 2,   // over-fetch so dedup doesn't underserve the caller
  });

  // Last-invoice date per vendor.
  const invMap = new Map<string, string | null>();
  await Promise.all(rows.map(async (v) => {
    const inv = await prisma.aPInvoice.findFirst({
      where: { clubId: args.clubId, vendorId: v.id },
      orderBy: { invoiceDate: "desc" },
      select: { invoiceDate: true },
    });
    invMap.set(v.id, inv?.invoiceDate ? inv.invoiceDate.toISOString().slice(0, 10) : null);
  }));

  // Flatten contacts into the profile shape the evaluator expects.
  return rows.slice(0, limit).map<VendorCandidate>((v) => {
    const arContact = v.contacts.find((c) => c.role === "AR");
    const remit    = v.contacts.find((c) => c.role === "REMITTANCE");
    const main     = v.contacts.find((c) => c.isPrimary) ?? v.contacts.find((c) => c.role === "MAIN") ?? v.contacts[0];
    return {
      id: v.id,
      legalName: v.legalName,
      operatingName: v.operatingName,
      status: v.status,
      lastInvoiceDate: invMap.get(v.id) ?? null,
      profile: {
        legalName: v.legalName,
        operatingName: v.operatingName,
        addressLine1: v.address1,
        addressLine2: v.address2,
        city: v.city,
        provinceState: v.provinceState,
        postalCode: v.postalCode,
        country: v.country,
        phone: v.phone,
        website: v.website,
        email: v.email,
        arEmail: arContact?.email ?? null,
        apRemittanceEmail: remit?.email ?? null,
        taxRegistrationNumber: v.taxRegistrationNumber,
        paymentTermsDays: v.paymentTermsDays,
        mainContactName: main?.name ?? null,
        mainContactEmail: main?.email ?? null,
      },
    };
  });
}
