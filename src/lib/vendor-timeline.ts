// Sprint 3 · Checkpoint 15M (2026-07-27) — Vendor relationship
// timeline loader.
//
// Aggregates events from existing tenant-scoped tables into a single
// newest-first stream keyed to a vendor. No new event table introduced
// — the source-of-truth records (EmailMessage, APInvoice, IngestedDocument,
// AuditLog, WorkIntakeItem) already exist. The timeline is a view, not
// a duplicate store.
//
// Every event carries a `sourceKind` + `sourceId` so links back to the
// original record work uniformly. Tenant scope enforced on every query.
//
// Reusable: while this file targets vendors first, the shape (events
// keyed to an entity + tenant + optional filters) applies verbatim to
// members / employees / committees / projects in a follow-up.

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
  ts: string;                           // ISO
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
  header: VendorTimelineHeader | null;   // Null for provisional (unmatched) vendors.
  provisional?: {
    // Sprint 3 · Checkpoint 15M — the "no vendor record yet" view.
    // Timeline still renders whatever pre-creation history exists,
    // keyed to the extracted vendor identity, so nothing is lost
    // when the vendor is finally created.
    extractedName: string;
    workIntakeItemId: string | null;
  };
  events: VendorTimelineEvent[];
}

// ---------------------------------------------------------------------------
// Matched vendor path
// ---------------------------------------------------------------------------

export async function loadVendorTimeline(clubId: string, vendorId: string): Promise<VendorTimelineResult | null> {
  const vendor = await prisma.vendor.findFirst({
    where: { id: vendorId, clubId },
    select: {
      id: true, legalName: true, operatingName: true, status: true,
      paymentTermsDays: true, createdAt: true,
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

  const events = await gatherVendorEvents(clubId, vendorId, vendor.legalName, vendor.operatingName);
  events.sort((a, b) => b.ts.localeCompare(a.ts));
  return { header, events };
}

async function gatherVendorEvents(
  clubId: string,
  vendorId: string,
  legalName: string,
  operatingName: string | null,
): Promise<VendorTimelineEvent[]> {
  const events: VendorTimelineEvent[] = [];

  // ---- Vendor creation event -------------------------------------
  const vendorRow = await prisma.vendor.findFirst({
    where: { id: vendorId, clubId },
    select: { createdAt: true, createdByUserId: true },
  });
  if (vendorRow) {
    const actorName = vendorRow.createdByUserId
      ? (await prisma.user.findFirst({ where: { id: vendorRow.createdByUserId }, select: { name: true } }))?.name ?? "System"
      : "System";
    events.push({
      id: `vendor-created-${vendorId}`,
      kind: "VENDOR_CREATED",
      ts: vendorRow.createdAt.toISOString(),
      actorLabel: actorName,
      title: `Vendor record created`,
      detail: null,
      sourceKind: "Vendor",
      sourceId: vendorId,
      href: `/app/admin/ap/vendors/${vendorId}`,
    });
  }

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

  // ---- Email messages (sender or recipient side) ------------------
  // Match by extracted vendor name in the message OR by matching
  // sender domain. Simple contains fallback for the WHERE — this
  // vendor timeline is best-effort for pre-vendor-creation history.
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
      // Best-effort tie via filename contains.
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

// ---------------------------------------------------------------------------
// Provisional (unmatched) vendor path
// ---------------------------------------------------------------------------
// When the founder clicks a vendor name that has no Vendor row yet
// (Microsoft on Coulee Ridge), we still want to show the pre-creation
// history — the email, the PDF, the Work Intake item — so nothing is
// lost the moment the vendor IS created.

export async function loadProvisionalVendorTimeline(
  clubId: string,
  args: { extractedName: string; workIntakeItemId?: string | null },
): Promise<VendorTimelineResult> {
  const events: VendorTimelineEvent[] = [];

  // Work intake item + linked email + doc.
  if (args.workIntakeItemId) {
    const wi = await prisma.workIntakeItem.findFirst({
      where: { id: args.workIntakeItemId, clubId },
      select: {
        id: true, status: true, classification: true, createdAt: true, resolvedAt: true,
        displaySubject: true, displaySender: true,
        origins: {
          where: { kind: "INGESTED_DOCUMENT", role: "PRIMARY" },
          select: { referenceId: true },
          take: 1,
        },
      },
    });
    if (wi) {
      events.push({
        id: `wi-opened-${wi.id}`,
        kind: "WORK_INTAKE_OPENED",
        ts: wi.createdAt.toISOString(),
        actorLabel: wi.displaySender ?? "Mailbox",
        title: `Work Intake opened: ${wi.displaySubject ?? "(no subject)"}`,
        detail: `Classification ${wi.classification ?? "unclassified"}`,
        sourceKind: "WorkIntakeItem",
        sourceId: wi.id,
        href: `/app/admin`,
      });
      if (wi.resolvedAt) {
        events.push({
          id: `wi-resolved-${wi.id}`,
          kind: "WORK_INTAKE_RESOLVED",
          ts: wi.resolvedAt.toISOString(),
          actorLabel: null,
          title: `Work Intake resolved`,
          detail: null,
          sourceKind: "WorkIntakeItem",
          sourceId: wi.id,
          href: `/app/admin`,
        });
      }
      const docId = wi.origins[0]?.referenceId ?? null;
      if (docId) {
        const doc = await prisma.ingestedDocument.findFirst({
          where: { id: docId, clubId },
          select: { id: true, filename: true, receivedAt: true, classification: true, sourceReferenceId: true },
        });
        if (doc) {
          events.push({
            id: `doc-${doc.id}`,
            kind: "INVOICE_INGESTED",
            ts: doc.receivedAt.toISOString(),
            actorLabel: null,
            title: `${doc.classification === "INVOICE" ? "Invoice PDF" : "Document"} ingested: ${doc.filename}`,
            detail: null,
            sourceKind: "IngestedDocument",
            sourceId: doc.id,
            href: `/api/documents/${doc.id}/preview`,
          });
          // Source email attached to this document?
          if (doc.sourceReferenceId) {
            const attachment = await prisma.emailAttachment.findFirst({
              where: { id: doc.sourceReferenceId, emailMessage: { clubId } },
              select: {
                emailMessage: {
                  select: { id: true, senderName: true, senderAddress: true, subject: true, receivedAt: true, clubId: true },
                },
              },
            });
            const email = attachment?.emailMessage;
            if (email && email.clubId === clubId) {
              events.push({
                id: `email-${email.id}`,
                kind: "EMAIL_RECEIVED",
                ts: email.receivedAt.toISOString(),
                actorLabel: email.senderName ?? email.senderAddress,
                title: `Email received: ${email.subject ?? "(no subject)"}`,
                detail: email.senderAddress,
                sourceKind: "EmailMessage",
                sourceId: email.id,
                href: null,
              });
            }
          }
        }
      }
    }
  }

  events.sort((a, b) => b.ts.localeCompare(a.ts));
  return {
    header: null,
    provisional: {
      extractedName: args.extractedName,
      workIntakeItemId: args.workIntakeItemId ?? null,
    },
    events,
  };
}
