// Sprint 3 · Checkpoint 15L (2026-07-27) — vendor-lookup endpoint
// backing the "Possible existing matches" panel of the Create Vendor
// & Post modal.
//
// Tenant-scoped by the current session's activeClubId. Returns at
// most 10 candidate vendors matching the query on normalised legal
// name, operating name, email domain, or tax registration number.
// Never returns vendors from another tenant. Never returns bank /
// EFT / remittance detail.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";

export async function GET(req: Request) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ matches: [] }, { status: 401 });
  const clubId = principal.activeClubId;
  if (!clubId) return NextResponse.json({ matches: [] }, { status: 400 });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ matches: [] });

  // Extract the email domain if the query looks like an email.
  const emailMatch = q.match(/([\w.-]+)@([\w.-]+\.[a-z]{2,})/i);
  const emailDomain = emailMatch ? emailMatch[2].toLowerCase() : null;

  const rows = await prisma.vendor.findMany({
    where: {
      clubId,
      OR: [
        { legalName: { contains: q } },
        { operatingName: { contains: q } },
        emailDomain ? { email: { contains: `@${emailDomain}` } } : { taxRegistrationNumber: q },
      ],
    },
    select: {
      id: true, legalName: true, operatingName: true, email: true,
      taxRegistrationNumber: true, status: true,
      // Include the most recent APInvoice date via a subquery.
      // Small blast radius: `_count` and `orderBy` inside include
      // require nested queries which Prisma doesn't natively
      // support on findMany — instead we do a second query below.
    },
    take: 10,
  });

  // Second pass: fetch the last invoice date per vendor. Cheap for
  // ≤10 candidates.
  const invoiceMaxByVendor = new Map<string, Date | null>();
  await Promise.all(rows.map(async (v) => {
    const inv = await prisma.aPInvoice.findFirst({
      where: { clubId, vendorId: v.id },
      orderBy: { invoiceDate: "desc" },
      select: { invoiceDate: true },
    });
    invoiceMaxByVendor.set(v.id, inv?.invoiceDate ?? null);
  }));

  const matches = rows.map((v) => {
    const evidence: string[] = [];
    const qLower = q.toLowerCase();
    if (v.legalName.toLowerCase().includes(qLower)) evidence.push("name");
    if (v.operatingName && v.operatingName.toLowerCase().includes(qLower)) evidence.push("operating name");
    if (emailDomain && v.email?.toLowerCase().includes(`@${emailDomain}`)) evidence.push("email domain");
    if (v.taxRegistrationNumber && v.taxRegistrationNumber === q) evidence.push("tax id");
    if (v.status && v.status !== "ACTIVE") evidence.push(v.status.toLowerCase());
    const confidence =
      evidence.includes("tax id") ? 98
      : evidence.includes("email domain") ? 85
      : evidence.includes("name") && evidence.includes("operating name") ? 80
      : evidence.includes("name") ? 65
      : 40;
    const lastInv = invoiceMaxByVendor.get(v.id);
    return {
      id: v.id,
      legalName: v.legalName,
      operatingName: v.operatingName,
      matchEvidence: `matched on ${evidence.length > 0 ? evidence.join(", ") : "fuzzy name similarity"}`,
      confidence,
      lastInvoiceDate: lastInv ? lastInv.toISOString().slice(0, 10) : null,
    };
  });

  return NextResponse.json({ matches });
}
