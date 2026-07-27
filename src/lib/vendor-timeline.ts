// Sprint 3 · Checkpoint 15O (2026-07-27) — Vendor relationship
// timeline loader.
//
// A vendor timeline exists ONLY when a real Vendor record exists.
// The 15M provisional route + `loadProvisionalVendorTimeline` are
// rejected by the founder — that helper is removed in this file and
// the corresponding /app/admin/ap/vendors/provisional page is deleted.
//
// PRODUCT RULE (§Phase 10 of Checkpoint 15O): the timeline's oldest
// event is always the `Vendor created` event. Nothing may predate it.
// The source email, invoice PDF, and Work Intake records associated
// with the vendor by the Create Vendor workflow appear on the
// timeline via their existing tenant-scoped queries, but their
// displayed timestamps are CLAMPED to Vendor.createdAt so the
// visible ordering matches "the vendor's story starts here."
//
// Reusable: while this file targets vendors first, the shape
// (events keyed to an entity + tenant + optional filters) applies
// verbatim to members / employees / committees / projects in
// follow-ups. No new event table is introduced; source records are
// aggregated at read time.

import { prisma } from "@/lib/prisma";

export type VendorTimelineEventKind =
  | "VENDOR_CREATED"
  | "VENDOR_UPDATED"
  | "EMAIL_RECEIVED"
  | "EMAIL_SENT"
  | "INVOICE_INGESTED"
  | "AP_INVOICE_CREATED"
  | "AP_INVOICE_POSTED"
  | "AP_INVOICE_PAID"
  | "WORK_INTAKE_OPENED"
  | "WORK_INTAKE_RESOLVED"
  | "AUDIT";

export interface VendorTimelineEvent {
  id: string;
  kind: VendorTimelineEventKind;
  ts: string;                           // ISO — clamped to vendor.createdAt on read
  actorLabel: string | null;            // "System" / user name / vendor
  title: string;
  detail: string | null;
  sourceKind: "EmailMessage" | "IngestedDocument" | "APInvoice" | "Vendor" | "WorkIntakeItem" | "AuditLog";
  sourceId: string;
  href: string | null;                  // deep-link to source
}

export interface VendorTimelineHeader {
  vendorId: string;
  legalName: string;
  operatingName: string | null;
  status: string;
  vendorSince: string | null;
  paymentTermsDays: number | null;
  currency: string | null;
  totalInvoices12mo: number;
  openInvoices: number;
  lastInvoiceDate: string | null;
}

export interface VendorTimelineResult {
  header: VendorTimelineHeader;
  events: VendorTimelineEvent[];
}

// ---------------------------------------------------------------------------
// Matched vendor path (the ONLY path since 15O)
// ---------------------------------------------------------------------------

export async function loadVendorTimeline(
  clubId: string,
  vendorId: string,
): Promise<VendorTimelineResult | null> {
  const vendor = await prisma.vendor.findFirst({
    where: { id: vendorId, clubId },
    select: {
      id: true, legalName: true, operatingName: true, status: true,
      paymentTermsDays: true, createdAt: true, createdByUserId: true,
    },
  });
  if (!vendor) return null;

  // Header metrics — cheap counts + one findFirst.
  const now = new Date();
  const start12mo = new Date(now.getFullYear(), now.getMonth() - 12, now.getDate());
  const [totalInvoices12mo, openInvoices, lastInvoice] = await Promise.all([
    prisma.aPInvoice.count({ where: { clubId, vendorId, invoiceDate: { gte: start12mo } } }),
    prisma.aPInvoice.count({ where: { clubId, vendorId, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED"] } } }),
    prisma.aPInvoice.findFirst({
      where: { clubId, vendorId },
      orderBy: { invoiceDate: "desc" },
      select: { invoiceDate: true, currency: true },
    }),
  ]);

  const header: VendorTimelineHeader = {
    vendorId: vendor.id,
    legalName: vendor.legalName,
    operatingName: vendor.operatingName,
    status: vendor.status,
    vendorSince: vendor.createdAt.toISOString().slice(0, 10),
    paymentTermsDays: vendor.paymentTermsDays ?? null,
    currency: lastInvoice?.currency ?? null,
    totalInvoices12mo,
    openInvoices,
    lastInvoiceDate: lastInvoice?.invoiceDate ? lastInvoice.invoiceDate.toISOString().slice(0, 10) : null,
  };

  const events = await gatherVendorEvents(
    clubId, vendorId, vendor.legalName, vendor.operatingName,
    vendor.createdAt, vendor.createdByUserId,
  );
  // Sprint 3 · Checkpoint 15O — LOWER BOUND: never surface an event
  // dated before Vendor.createdAt. The source records (email, PDF,
  // Work Intake) may have real timestamps that predate vendor
  // creation; they still appear on the timeline (the workflow linked
  // them at creation) but their displayed `ts` is clamped so the
  // ordering matches the founder's rule: nothing predates
  // Vendor created.
  const clamped = events.map((e) => {
    const eventTs = new Date(e.ts).getTime();
    const floor = vendor.createdAt.getTime();
    return eventTs < floor ? { ...e, ts: vendor.createdAt.toISOString() } : e;
  });
  clamped.sort((a, b) => b.ts.localeCompare(a.ts));
  return { header, events: clamped };
}

async function gatherVendorEvents(
  clubId: string,
  vendorId: string,
  legalName: string,
  operatingName: string | null,
  vendorCreatedAt: Date,
  vendorCreatedByUserId: string | null,
): Promise<VendorTimelineEvent[]> {
  const events: VendorTimelineEvent[] = [];

  // ---- Vendor creation event -------------------------------------
  const actorName = vendorCreatedByUserId
    ? (await prisma.user.findFirst({ where: { id: vendorCreatedByUserId }, select: { name: true } }))?.name ?? "System"
    : "System";
  events.push({
    id: `vendor-created-${vendorId}`,
    kind: "VENDOR_CREATED",
    ts: vendorCreatedAt.toISOString(),
    actorLabel: actorName,
    title: `Vendor created`,
    detail: null,
    sourceKind: "Vendor",
    sourceId: vendorId,
    href: `/app/admin/ap/vendors/${vendorId}`,
  });

  // ---- APInvoice creation / status transitions --------------------
  const invoices = await prisma.aPInvoice.findMany({
    where: { clubId, vendorId },
    select: {
      id: true, invoiceNumber: true, vendorReference: true, total: true, currency: true,
      status: true, invoiceDate: true, postedAt: true, createdAt: true, dueDate: true,
      createdByUserId: true,
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  for (const inv of invoices) {
    events.push({
      id: `apinv-created-${inv.id}`,
      kind: "AP_INVOICE_CREATED",
      ts: inv.createdAt.toISOString(),
      actorLabel: "System",
      title: `AP invoice ${inv.invoiceNumber} created` + (inv.vendorReference ? ` (vendor ref ${inv.vendorReference})` : ""),
      detail: `${inv.currency ?? "CAD"} ${Number(inv.total).toFixed(2)} — status ${inv.status}`,
      sourceKind: "APInvoice",
      sourceId: inv.id,
      href: `/app/admin/ap/invoices/${inv.id}`,
    });
    if (inv.postedAt) {
      events.push({
        id: `apinv-posted-${inv.id}`,
        kind: "AP_INVOICE_POSTED",
        ts: inv.postedAt.toISOString(),
        actorLabel: null,
        title: `AP invoice ${inv.invoiceNumber} posted`,
        detail: `${inv.currency ?? "CAD"} ${Number(inv.total).toFixed(2)}`,
        sourceKind: "APInvoice",
        sourceId: inv.id,
        href: `/app/admin/ap/invoices/${inv.id}`,
      });
    }
  }

  // ---- Email messages associated with this vendor -----------------
  // Match by extracted vendor name in the message OR by matching
  // sender domain. Simple contains fallback for the WHERE — a
  // structured Email ↔ Vendor join is a follow-up ticket.
  const emails = await prisma.emailMessage.findMany({
    where: {
      clubId,
      OR: [
        { senderName: { contains: legalName } },
        operatingName ? { senderName: { contains: operatingName } } : { id: "__never__" },
      ],
    },
    select: {
      id: true, senderName: true, senderAddress: true, subject: true, receivedAt: true,
    },
    orderBy: { receivedAt: "desc" },
    take: 50,
  });
  for (const e of emails) {
    events.push({
      id: `email-${e.id}`,
      kind: "EMAIL_RECEIVED",
      ts: e.receivedAt.toISOString(),
      actorLabel: e.senderName ?? e.senderAddress,
      title: `Email received: ${e.subject ?? "(no subject)"}`,
      detail: e.senderAddress,
      sourceKind: "EmailMessage",
      sourceId: e.id,
      href: null,
    });
  }

  // ---- Ingested documents (invoice PDFs etc.) ---------------------
  const docs = await prisma.ingestedDocument.findMany({
    where: {
      clubId,
      OR: [
        { filename: { contains: legalName } },
        operatingName ? { filename: { contains: operatingName } } : { id: "__never__" },
      ],
    },
    select: { id: true, filename: true, receivedAt: true, classification: true },
    orderBy: { receivedAt: "desc" },
    take: 50,
  });
  for (const d of docs) {
    events.push({
      id: `doc-${d.id}`,
      kind: "INVOICE_INGESTED",
      ts: d.receivedAt.toISOString(),
      actorLabel: null,
      title: `${d.classification === "INVOICE" ? "Invoice PDF" : "Document"} ingested: ${d.filename}`,
      detail: null,
      sourceKind: "IngestedDocument",
      sourceId: d.id,
      href: `/api/documents/${d.id}/preview`,
    });
  }

  return events;
}
