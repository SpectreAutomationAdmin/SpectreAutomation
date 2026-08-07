// Sprint 3 · Post-16H Phase 4 Slice 3-forensic (2026-08-06) —
// systemic Outlook attachment-ingestion audit for the founder's
// §10 request. Read-only. Same security posture as inspect-wi.
//
// Scans every EmailMessage in the caller's active club where
// hasAttachments = true, joins to EmailAttachment / ApIntakeSource /
// IngestedDocument, and reports counts of every breakage shape.
//
// Response is aggregate + sanitized: no filenames, no subjects,
// no addresses, only tail-hashes for the offending message IDs so
// the founder-facing report can name specific records without
// leaking their content.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission, isSuperAdmin } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

function isStagingEnv(): boolean {
  const env = (process.env.SPECTRE_ENV ?? process.env.NODE_ENV ?? "").toLowerCase();
  return env !== "production" && env !== "prod";
}
function idTail(v: string | null | undefined, n: number = 8): string {
  if (!v) return "(null)";
  return v.slice(-n);
}
function hashTail(v: string | null | undefined): string {
  if (!v) return "(null)";
  return "h_" + crypto.createHash("sha1").update(v).digest("hex").slice(-10);
}

export async function GET() {
  if (!isStagingEnv()) return new NextResponse("Not Found", { status: 404 });
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ ok: false, error: "UNAUTHENTICATED" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return NextResponse.json({ ok: false, error: "NO_CLUB" }, { status: 400 });
  if (!isSuperAdmin(principal) && !hasPermission(principal, clubId, "system:audit:read")) {
    return NextResponse.json({ ok: false, error: "PERMISSION" }, { status: 403 });
  }

  // Every EmailMessage in the club where hasAttachments is true.
  const messages = await prisma.emailMessage.findMany({
    where: { clubId, hasAttachments: true, softDeletedAt: null },
    select: {
      id: true, graphMessageId: true, internetMessageId: true,
      receivedAt: true, hasAttachments: true, retryAttempts: true,
      ingestFailedAt: true, ingestFailReason: true,
      attachments: {
        select: {
          id: true, contentType: true, sizeBytes: true, isInline: true,
          storageState: true, storageKey: true,
        },
      },
      workIntakeOrigins: {
        select: { workIntakeItemId: true, role: true },
      },
      apIntakeSources: {
        select: { id: true, ingestedDocumentId: true, emailAttachmentId: true },
      },
    },
    orderBy: { receivedAt: "desc" },
    take: 500,   // bound the scan
  });

  // For each message, classify the state.
  const buckets: Record<string, Array<{ msgIdTail: string; internetIdHash: string; receivedAt: Date; attachmentContentTypes: string[]; retryAttempts: number }>> = {
    "OK — has non-inline PDF + linked IngestedDocument via ApIntakeSource": [],
    "hasAttachments=true but EmailAttachment table has ZERO rows": [],
    "EmailAttachment present but ALL inline (no PDF-like)": [],
    "Non-inline PDF-shaped attachment present but ApIntakeSource missing": [],
    "ApIntakeSource present but IngestedDocument missing": [],
    "Message has ingestFailedAt (quarantined)": [],
    "Non-PDF attachment(s) only (image / office / other)": [],
  };

  for (const m of messages) {
    const nonInline = m.attachments.filter((a) => !a.isInline);
    const nonInlinePdf = nonInline.filter((a) =>
      /pdf/i.test(a.contentType) || /image\//i.test(a.contentType),
    );
    const info = {
      msgIdTail: idTail(m.id, 10),
      internetIdHash: hashTail(m.internetMessageId),
      receivedAt: m.receivedAt,
      attachmentContentTypes: m.attachments.map((a) => `${a.isInline ? "inline:" : ""}${a.contentType}`),
      retryAttempts: m.retryAttempts,
    };
    if (m.ingestFailedAt) {
      buckets["Message has ingestFailedAt (quarantined)"].push(info);
      continue;
    }
    if (m.attachments.length === 0) {
      buckets["hasAttachments=true but EmailAttachment table has ZERO rows"].push(info);
      continue;
    }
    if (nonInline.length === 0) {
      buckets["EmailAttachment present but ALL inline (no PDF-like)"].push(info);
      continue;
    }
    if (nonInlinePdf.length === 0) {
      buckets["Non-PDF attachment(s) only (image / office / other)"].push(info);
      continue;
    }
    // We have a non-inline PDF/image attachment. Check downstream links.
    if (m.apIntakeSources.length === 0) {
      buckets["Non-inline PDF-shaped attachment present but ApIntakeSource missing"].push(info);
      continue;
    }
    const missingDoc = m.apIntakeSources.some((s) => !s.ingestedDocumentId);
    if (missingDoc) {
      buckets["ApIntakeSource present but IngestedDocument missing"].push(info);
      continue;
    }
    buckets["OK — has non-inline PDF + linked IngestedDocument via ApIntakeSource"].push(info);
  }

  const counts: Record<string, number> = {};
  for (const k of Object.keys(buckets)) counts[k] = buckets[k].length;

  return NextResponse.json({
    ok: true,
    clubId: hashTail(clubId),
    scanScope: {
      totalMessagesWithAttachmentsTrue: messages.length,
      cap: 500,
    },
    counts,
    // Only surface up to 20 offending records per bucket to keep
    // the response small.
    samples: Object.fromEntries(Object.entries(buckets).map(([k, arr]) => [k, arr.slice(0, 20)])),
  });
}
