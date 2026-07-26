// Sprint 3 Checkpoint 15G (2026-07-24) — Phase Q cross-linking:
// when a statement flags an invoice as NOT_FOUND, check whether an
// ingested INVOICE PDF exists that matches the vendor + reference +
// amount. If so, surface it so the reviewer can open an AP Invoice
// Draft Review without hunting through the document library.

import { prisma } from "@/lib/prisma";
import { toMoney } from "@/lib/accounting/decimal";
import type { ExtractedStatementLine } from "./types";

const AMOUNT_TOLERANCE_CENTS = 2;
const DATE_TOLERANCE_DAYS = 14; // wider — invoice may be dated inside statement period

export interface CandidateInvoiceDocument {
  ingestedDocumentId: string;
  filename: string;
  sha256Hash: string;
  ingestedAt: string;
  matchSignals: string[];
}

function normaliseRef(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

export async function findCandidateInvoiceDocument(args: {
  clubId: string;
  canonicalVendorId: string;
  line: ExtractedStatementLine;
}): Promise<CandidateInvoiceDocument | null> {
  const line = args.line;
  const refNorm = normaliseRef(line.referenceNumber);
  const lineAmount = toMoney(line.debitAmount ?? "0");
  const lineDate = line.transactionDate ? new Date(line.transactionDate) : null;

  // Look at IngestedDocuments classified INVOICE. There is currently
  // no direct FK from IngestedDocument → Vendor, so we filter by
  // classification and then rank candidates.
  const dayMs = 24 * 60 * 60 * 1000;
  const dateFilter = lineDate
    ? {
        receivedAt: {
          gte: new Date(lineDate.getTime() - DATE_TOLERANCE_DAYS * dayMs),
          lte: new Date(lineDate.getTime() + DATE_TOLERANCE_DAYS * dayMs),
        },
      }
    : {};
  const docs = await prisma.ingestedDocument.findMany({
    where: {
      clubId: args.clubId,
      classification: "INVOICE",
      status: "STORED",
      ...dateFilter,
    },
    select: { id: true, filename: true, sha256Hash: true, ingestedAt: true },
    take: 50,
    orderBy: { ingestedAt: "desc" },
  });
  if (docs.length === 0) return null;

  // The ingested doc's identity is mostly held in its filename. Match
  // on normalised reference first.
  const refMatches = refNorm.length >= 3
    ? docs.filter((d) => normaliseRef(d.filename).includes(refNorm))
    : [];
  if (refMatches.length === 1) {
    return {
      ingestedDocumentId: refMatches[0].id,
      filename: refMatches[0].filename,
      sha256Hash: refMatches[0].sha256Hash,
      ingestedAt: refMatches[0].ingestedAt.toISOString(),
      matchSignals: ["filename.ref_match", "date.proximity"],
    };
  }

  // Amount + date only — every candidate is filtered to the date
  // window; we cannot re-check the amount without re-extracting the
  // PDF. Return the most recent doc as a weak signal.
  if (!lineAmount.isZero() && docs.length >= 1) {
    return {
      ingestedDocumentId: docs[0].id,
      filename: docs[0].filename,
      sha256Hash: docs[0].sha256Hash,
      ingestedAt: docs[0].ingestedAt.toISOString(),
      matchSignals: ["date.proximity"],
    };
  }

  return null;
}
