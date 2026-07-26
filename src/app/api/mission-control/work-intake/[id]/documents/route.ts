// Sprint 3 Checkpoint 15D (2026-07-24) — Documents panel for the
// Mission Control evidence surface.
//
// GET /api/mission-control/work-intake/[id]/documents
//
// Returns the ordered list of IngestedDocument metadata that has been
// linked to this work-intake item. Read-only; no writes. Auth: session
// + active club + intake belongs to the club.
//
// The UI uses each returned entry's `id` to build previewUrl /
// downloadUrl endpoints (see ../../../../documents/[id]/{preview,download}).
// Storage keys / bucket names are NEVER returned here.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { listDocumentsForWorkIntake } from "@/lib/documents/retrieve";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const workIntakeItemId = params.id;
  if (!workIntakeItemId) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Tenant guard first — never let a well-formed 404 leak that the
  // intake exists in another club.
  const intakeInClub = await prisma.workIntakeItem.count({
    where: { id: workIntakeItemId, clubId },
  });
  if (intakeInClub === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const docs = await listDocumentsForWorkIntake({ clubId, workIntakeItemId });

  // Sprint 3 Checkpoint 15H Unified Remediation (2026-07-25) — For
  // email-derived intakes, ALSO include IngestedDocuments that were
  // ingested from this email's attachments. These docs are the
  // primary accounting evidence for the unified email card; they may
  // not carry an explicit WORK_INTAKE_ITEM evidence link because the
  // link goes doc→child intake (AP/Statement), not doc→email intake.
  const emailOrigin = await prisma.emailWorkIntakeOrigin.findFirst({
    where: { workIntakeItemId, role: "PRIMARY", clubId },
    select: {
      emailMessage: {
        select: { id: true, attachments: { select: { id: true, isInline: true } } },
      },
    },
  });
  const emailAttachmentIds = (emailOrigin?.emailMessage?.attachments ?? [])
    .filter((a) => !a.isInline)
    .map((a) => a.id);
  const attachmentDocs = emailAttachmentIds.length > 0
    ? await prisma.ingestedDocument.findMany({
        where: { clubId, sourceKind: "EMAIL_ATTACHMENT", sourceReferenceId: { in: emailAttachmentIds } },
        select: { id: true, filename: true, mimeType: true, byteLength: true, sha256Hash: true, classification: true, classificationRuleKey: true, receivedAt: true, ingestedAt: true },
      })
    : [];
  // Merge with the WORK_INTAKE_ITEM-linked docs, dedup by id.
  const byId = new Map<string, {
    id: string; filename: string; mimeType: string; byteLength: number; sha256Hash: string;
    classification: string; classificationRuleKey: string | null; receivedAt: string; ingestedAt: string;
  }>();
  for (const d of docs) byId.set(d.id, d);
  for (const d of attachmentDocs) {
    if (!byId.has(d.id)) {
      byId.set(d.id, {
        id: d.id, filename: d.filename, mimeType: d.mimeType, byteLength: d.byteLength,
        sha256Hash: d.sha256Hash, classification: d.classification, classificationRuleKey: d.classificationRuleKey,
        receivedAt: d.receivedAt.toISOString(), ingestedAt: d.ingestedAt.toISOString(),
      });
    }
  }
  const merged = [...byId.values()].sort((a, b) => (b.receivedAt).localeCompare(a.receivedAt));

  return NextResponse.json({
    workIntakeItemId,
    documents: merged.map((d) => ({
      id: d.id,
      filename: d.filename,
      mimeType: d.mimeType,
      byteLength: d.byteLength,
      sha256Hash: d.sha256Hash,
      classification: d.classification,
      classificationRuleKey: d.classificationRuleKey,
      receivedAt: d.receivedAt,
      ingestedAt: d.ingestedAt,
      // These are relative URLs the browser can hit; auth is enforced
      // on the same-origin call. Storage keys are NOT included.
      metadataUrl: `/api/documents/${d.id}/metadata`,
      previewUrl: `/api/documents/${d.id}/preview`,
      downloadUrl: `/api/documents/${d.id}/download`,
    })),
  });
}
