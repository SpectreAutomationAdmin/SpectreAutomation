// Sprint 2 B4 (2026-07-19) — Email source materializer.
//
// Implements the SourceMaterializer contract (see
// src/lib/work-intake/materializer.ts) for the EmailMessage origin.
// This is the ONE authoritative writer of the `display_*` and
// `classification_*` columns on WorkIntakeItem when the source is
// email. Ad-hoc writes from the sync handler are forbidden — the
// handler calls upsertFromEmail() and nothing else.
//
// Invariants enforced here (per §7 of the B4 directive):
//   I1 idempotent — rerunning against the same email produces the
//                   same DB state, incl. same intake id via the
//                   PRIMARY link natural key.
//   I2 orchestration preserved — status / ownerUserId / deferredUntil
//                                / resolvedAt / resolvedByUserId /
//                                judgmentRequired NEVER overwritten
//                                on resync.
//   I3 override respected — if classificationOverriddenByUserId is
//                           set, refreshClassification is a no-op.
//   I4 evidence retraction — handleEvidenceDeleted marks the intake
//                             SUPPRESSED and appends activity, but
//                             preserves the row.
//   I5 tenant isolation — every write scoped by clubId.

import { prisma } from "@/lib/prisma";
import type { EmailMessage, WorkIntakeItem } from "@prisma/client";
import { isClassificationLocked } from "@/lib/work-intake/materializer";
import { classifyEmail, type ClassificationResult } from "./classifier";
import { normalizeGraphMessage } from "./normalize";
import type { RawGraphMessage } from "@/lib/integrations/microsoft-graph-delegated";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Presentation input for the display projection — pure data. */
export interface EmailDisplayProjection {
  senderName: string;
  senderAddress: string;
  subject: string;
  preview: string;
  receivedAt: Date;
  hasAttachments: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Idempotently upsert a WorkIntakeItem for this EmailMessage per the
 * B4 policy (§8):
 *   - CLASSIFIER → intakeAction  →  behaviour
 *     CREATE_ACTIONABLE           →  status = OPEN (or unchanged), judgmentRequired = true
 *     CREATE_INFORMATIONAL        →  status = INFORMATIONAL (only if first materialisation)
 *     SUPPRESS                    →  status = SUPPRESSED   (only if first materialisation)
 *
 * Rerun with the same email refreshes only display + classification
 * (subject to override guard). Never resets user orchestration state.
 * Returns the WorkIntakeItem (created or reused). Returns null when
 * the intakeAction was SUPPRESS AND no prior intake row existed
 * (nothing to render, nothing to write).
 */
export async function upsertEmailIntake(args: {
  clubId: string;
  email: EmailMessage;
  classification: ClassificationResult;
}): Promise<WorkIntakeItem | null> {
  const existingLink = await prisma.emailWorkIntakeOrigin.findFirst({
    where: { emailMessageId: args.email.id, role: "PRIMARY" },
    include: { workIntakeItem: true },
  });
  const projection = displayProjectionFromEmail(args.email);
  const displaySourceLabel = "Outlook";

  // Path 1 — link already exists: refresh display + classification,
  // never orchestration. This is the common resync branch.
  if (existingLink) {
    const intake = existingLink.workIntakeItem;
    if (intake.clubId !== args.clubId) {
      // Tenant guard — this MUST NEVER happen; the link's
      // workIntakeItem carries the club of the mailbox connection.
      throw new Error(
        `Email materializer: WorkIntakeItem ${intake.id} belongs to club ${intake.clubId} but email ${args.email.id} is being materialised for club ${args.clubId}`,
      );
    }
    const shouldRefreshClassification = !isClassificationLocked(intake);
    await prisma.workIntakeItem.update({
      where: { id: intake.id },
      data: {
        // Display always refreshes.
        displaySourceLabel,
        displaySender: projection.senderName || projection.senderAddress,
        displaySubject: projection.subject,
        displayPreview: projection.preview,
        displayReceivedAt: projection.receivedAt,
        displayHasAttachments: projection.hasAttachments,
        ...(shouldRefreshClassification
          ? {
              classification: args.classification.label,
              classificationReason: args.classification.reason,
              classificationMethod: args.classification.method,
              classificationConfidence: args.classification.confidence,
              classificationRuleKey: args.classification.ruleKey,
              classificationRuleVersion: args.classification.ruleVersion,
            }
          : {}),
      },
    });
    // Note: we do NOT overwrite status / owner / defer / resolved /
    // judgmentRequired here. §7 invariant I2.
    return await prisma.workIntakeItem.findUnique({ where: { id: intake.id } });
  }

  // Path 2 — no link yet: create per the intakeAction rule.
  if (args.classification.intakeAction === "SUPPRESS") {
    // No intake row created. The email evidence still exists in the
    // DB; it just does not appear in Mission Control.
    return null;
  }

  const initialStatus =
    args.classification.intakeAction === "CREATE_INFORMATIONAL" ? "INFORMATIONAL" : "OPEN";
  const judgmentRequired = args.classification.intakeAction === "CREATE_ACTIONABLE";

  const created = await prisma.workIntakeItem.create({
    data: {
      clubId: args.clubId,
      status: initialStatus,
      judgmentRequired,
      classification: args.classification.label,
      classificationReason: args.classification.reason,
      classificationMethod: args.classification.method,
      classificationConfidence: args.classification.confidence,
      classificationRuleKey: args.classification.ruleKey,
      classificationRuleVersion: args.classification.ruleVersion,
      displaySourceLabel,
      displaySender: projection.senderName || projection.senderAddress,
      displaySubject: projection.subject,
      displayPreview: projection.preview,
      displayReceivedAt: projection.receivedAt,
      displayHasAttachments: projection.hasAttachments,
    },
  });
  await prisma.emailWorkIntakeOrigin.create({
    data: {
      clubId: args.clubId,
      workIntakeItemId: created.id,
      emailMessageId: args.email.id,
      role: "PRIMARY",
    },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: created.id,
      action: "MATERIALISED",
      note: `Intake materialised from email ${args.email.graphMessageId}`,
    },
  });
  return created;
}

/**
 * Sprint 2 Checkpoint 14C (2026-07-23) — Conversation-grouped
 * materialisation.
 *
 * The founder's revised direction is: one Microsoft conversationId
 * within one mailbox = one operational situation = one
 * WorkIntakeItem. Multiple messages in the same conversation get
 * linked to the same intake row (each via a PRIMARY origin).
 *
 * Behaviour:
 *   1. If email.conversationId is null → falls back to the legacy
 *      per-email upsertEmailIntake() path (unchanged).
 *   2. Else, looks for an existing WorkIntakeItem whose PRIMARY
 *      origin points at an EmailMessage with the same
 *      (mailboxConnectionId, conversationId).
 *   3a. Existing found → ensures this email has its own PRIMARY link
 *      to the SAME intake row (creates the link if absent). Refreshes
 *      display from the NEWEST message in the conversation. Refreshes
 *      classification only if not locked. NEVER touches orchestration.
 *   3b. No existing intake → falls back to upsertEmailIntake() which
 *      applies the intakeAction rule (CREATE_ACTIONABLE /
 *      CREATE_INFORMATIONAL / SUPPRESS).
 *
 * Idempotency: rerunning against the same email in the same
 * conversation makes no additional link and creates no additional
 * activity row.
 *
 * Tenant guard: the existing-intake lookup filters by clubId.
 * Cross-mailbox conversations do NOT merge — the natural key is
 * (mailboxConnectionId, conversationId), not conversationId alone.
 */
export async function materialiseEmailIntoConversation(args: {
  clubId: string;
  email: EmailMessage;
  mailboxConnectionId: string;
  classification: ClassificationResult;
}): Promise<WorkIntakeItem | null> {
  const { clubId, email, mailboxConnectionId, classification } = args;

  // Null conversationId → fall back to legacy per-email path.
  if (!email.conversationId) {
    return await upsertEmailIntake({ clubId, email, classification });
  }

  // Look for an existing WorkIntakeItem whose PRIMARY link points at
  // ANOTHER EmailMessage in the same (mailboxConnectionId,
  // conversationId). The `not: email.id` guard prevents matching this
  // very email on a rerun — we want the OTHER-message case.
  const existingIntakeViaAnotherEmail = await prisma.workIntakeItem.findFirst({
    where: {
      clubId,
      emailOrigins: {
        some: {
          role: "PRIMARY",
          emailMessage: {
            id: { not: email.id },
            mailboxConnectionId,
            conversationId: email.conversationId,
          },
        },
      },
    },
    include: {
      emailOrigins: {
        where: { emailMessageId: email.id },
        select: { id: true, role: true, workIntakeItemId: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // Also check whether THIS email already has its own PRIMARY link
  // pointing somewhere — used for both idempotency and to detect a
  // stale link that predates conversation grouping.
  const thisEmailPrimaryLink = await prisma.emailWorkIntakeOrigin.findFirst({
    where: { emailMessageId: email.id, role: "PRIMARY" },
    select: { id: true, workIntakeItemId: true },
  });

  if (existingIntakeViaAnotherEmail) {
    const canonical = existingIntakeViaAnotherEmail;
    if (canonical.clubId !== clubId) {
      // Tenant guard — cross-club materialisation is a bug.
      throw new Error(
        `Conversation materialisation: WorkIntakeItem ${canonical.id} belongs to club ${canonical.clubId} but email ${email.id} is being materialised for club ${clubId}`,
      );
    }

    // Ensure this specific email is linked to the canonical intake.
    if (!thisEmailPrimaryLink) {
      // No existing link — create one to the canonical intake.
      await prisma.emailWorkIntakeOrigin.create({
        data: {
          clubId,
          workIntakeItemId: canonical.id,
          emailMessageId: email.id,
          role: "PRIMARY",
        },
      });
      await prisma.workIntakeActivity.create({
        data: {
          workIntakeItemId: canonical.id,
          action: "MATERIALISED",
          note: `Additional email in conversation added: ${email.graphMessageId}`,
        },
      });
    } else if (thisEmailPrimaryLink.workIntakeItemId !== canonical.id) {
      // Pre-C14C data — this email's PRIMARY link points at a stale
      // duplicate intake. Repoint it to the canonical intake. The
      // stale intake will be neutralised by
      // remediateDuplicateConversationItems() (called once, offline).
      await prisma.emailWorkIntakeOrigin.update({
        where: { id: thisEmailPrimaryLink.id },
        data: { workIntakeItemId: canonical.id },
      });
      await prisma.workIntakeActivity.create({
        data: {
          workIntakeItemId: canonical.id,
          action: "MATERIALISED",
          note: `Origin repointed to canonical conversation intake: ${email.graphMessageId}`,
        },
      });
    }

    // Refresh display from the NEWEST message in the conversation.
    // Reads at most a handful of rows — bounded by mailbox +
    // conversation.
    await refreshDisplayFromNewestInConversation({
      workIntakeItemId: canonical.id,
      mailboxConnectionId,
      conversationId: email.conversationId,
      newestClassification: classification,
    });

    return await prisma.workIntakeItem.findUnique({ where: { id: canonical.id } });
  }

  // No existing conversation intake → single-email path. This creates
  // the FIRST intake for this conversation; subsequent emails will
  // attach to it via the branch above.
  return await upsertEmailIntake({ clubId, email, classification });
}

/**
 * Refresh a WorkIntakeItem's display projection from the NEWEST
 * message in its conversation (by receivedAt). Respects the
 * classification-lock invariant. Never touches orchestration.
 */
async function refreshDisplayFromNewestInConversation(args: {
  workIntakeItemId: string;
  mailboxConnectionId: string;
  conversationId: string;
  newestClassification: ClassificationResult;
}): Promise<void> {
  const newest = await prisma.emailMessage.findFirst({
    where: {
      mailboxConnectionId: args.mailboxConnectionId,
      conversationId: args.conversationId,
      softDeletedAt: null,
    },
    orderBy: { receivedAt: "desc" },
  });
  if (!newest) return;

  const intake = await prisma.workIntakeItem.findUnique({
    where: { id: args.workIntakeItemId },
    select: { classificationOverriddenByUserId: true },
  });
  if (!intake) return;
  const shouldRefreshClassification = !isClassificationLocked(intake);

  const projection = displayProjectionFromEmail(newest);
  await prisma.workIntakeItem.update({
    where: { id: args.workIntakeItemId },
    data: {
      displaySourceLabel: "Outlook",
      displaySender: projection.senderName || projection.senderAddress,
      displaySubject: projection.subject,
      displayPreview: projection.preview,
      displayReceivedAt: projection.receivedAt,
      displayHasAttachments: projection.hasAttachments,
      ...(shouldRefreshClassification
        ? {
            classification: args.newestClassification.label,
            classificationReason: args.newestClassification.reason,
            classificationMethod: args.newestClassification.method,
            classificationConfidence: args.newestClassification.confidence,
            classificationRuleKey: args.newestClassification.ruleKey,
            classificationRuleVersion: args.newestClassification.ruleVersion,
          }
        : {}),
    },
  });
}

/**
 * Sprint 2 Checkpoint 14C — one-off remediation of pre-C14C
 * duplicate WorkIntakeItems that share (mailboxConnectionId,
 * conversationId).
 *
 * Policy:
 *   - Canonical survivor = the OLDEST WorkIntakeItem in the group
 *     (preserves orchestration continuity — the first-materialised
 *     intake is the one users were operating against).
 *   - Every duplicate:
 *       - Its EmailWorkIntakeOrigin PRIMARY links are repointed to
 *         the canonical intake.
 *       - Its WorkIntakeActivity rows are moved to the canonical
 *         intake with a "MERGED_FROM_<id>" annotation.
 *       - Its status is set to SUPPRESSED (never physically
 *         deleted — the founder's audit policy preserves data).
 *       - A "SUPPRESSED" activity row is appended noting the merge.
 *   - Canonical gets one "MERGED_IN" activity per absorbed duplicate.
 *
 * Idempotent: rerunning against an already-remediated group produces
 * no additional changes because the "duplicate" WorkIntakeItems no
 * longer have PRIMARY origins after the first run.
 *
 * Returns per-group counters for the closeout report.
 */
export async function remediateDuplicateConversationItems(args: {
  clubId: string;
}): Promise<{
  groupsInspected: number;
  groupsWithDuplicates: number;
  duplicatesNeutralized: number;
  emailLinksMoved: number;
  activityRowsMoved: number;
  survivors: Array<{ canonicalId: string; absorbedIds: string[]; mailboxConnectionId: string; conversationId: string }>;
}> {
  const { clubId } = args;
  const summary = {
    groupsInspected: 0,
    groupsWithDuplicates: 0,
    duplicatesNeutralized: 0,
    emailLinksMoved: 0,
    activityRowsMoved: 0,
    survivors: [] as Array<{ canonicalId: string; absorbedIds: string[]; mailboxConnectionId: string; conversationId: string }>,
  };

  // Enumerate every (mailboxConnectionId, conversationId) group with
  // more than one distinct WorkIntakeItem. Bounded by the club's
  // email volume; runs once during checkpoint.
  const emailsWithLinks = await prisma.emailMessage.findMany({
    where: {
      clubId,
      conversationId: { not: null },
      workIntakeOrigins: { some: { role: "PRIMARY" } },
    },
    select: {
      id: true,
      mailboxConnectionId: true,
      conversationId: true,
      receivedAt: true,
      workIntakeOrigins: { where: { role: "PRIMARY" }, select: { workIntakeItemId: true } },
    },
  });

  // Group by (mailboxConnectionId, conversationId)
  const groups = new Map<string, Array<(typeof emailsWithLinks)[number]>>();
  for (const e of emailsWithLinks) {
    const key = `${e.mailboxConnectionId}:::${e.conversationId}`;
    let bucket = groups.get(key);
    if (!bucket) { bucket = []; groups.set(key, bucket); }
    bucket.push(e);
  }

  for (const [key, emails] of groups.entries()) {
    summary.groupsInspected += 1;
    const distinctIntakeIds = new Set<string>();
    for (const e of emails) {
      for (const o of e.workIntakeOrigins) distinctIntakeIds.add(o.workIntakeItemId);
    }
    if (distinctIntakeIds.size <= 1) continue;
    summary.groupsWithDuplicates += 1;

    const [mailboxConnectionId, conversationId] = key.split(":::");
    const allIntakes = await prisma.workIntakeItem.findMany({
      where: { id: { in: [...distinctIntakeIds] } },
      orderBy: { createdAt: "asc" },
    });
    const canonical = allIntakes[0]!;
    const duplicates = allIntakes.slice(1);

    for (const dup of duplicates) {
      // Repoint every PRIMARY EmailWorkIntakeOrigin from dup → canonical
      const links = await prisma.emailWorkIntakeOrigin.updateMany({
        where: { workIntakeItemId: dup.id, role: "PRIMARY" },
        data: { workIntakeItemId: canonical.id },
      });
      summary.emailLinksMoved += links.count;

      // Move activity rows from dup → canonical (with note reference).
      const dupActivity = await prisma.workIntakeActivity.findMany({
        where: { workIntakeItemId: dup.id },
        select: { id: true },
      });
      if (dupActivity.length > 0) {
        await prisma.workIntakeActivity.updateMany({
          where: { workIntakeItemId: dup.id },
          data: { workIntakeItemId: canonical.id },
        });
        summary.activityRowsMoved += dupActivity.length;
      }

      // Add a MERGED_IN activity on canonical + a suppressive activity
      // on the duplicate.
      await prisma.workIntakeActivity.create({
        data: {
          workIntakeItemId: canonical.id,
          action: "MERGED_IN",
          fromValue: dup.id,
          note: `Merged conversation duplicate ${dup.id}`,
        },
      });
      await prisma.workIntakeActivity.create({
        data: {
          workIntakeItemId: dup.id,
          action: "SUPPRESSED",
          toValue: "SUPPRESSED",
          note: `Merged into canonical conversation intake ${canonical.id}`,
        },
      });
      await prisma.workIntakeItem.update({
        where: { id: dup.id },
        data: { status: "SUPPRESSED" },
      });
      summary.duplicatesNeutralized += 1;
    }

    summary.survivors.push({
      canonicalId: canonical.id,
      absorbedIds: duplicates.map((d) => d.id),
      mailboxConnectionId: mailboxConnectionId!,
      conversationId: conversationId!,
    });
  }

  return summary;
}

/**
 * Called when the email is soft-deleted (Graph reports it gone).
 * The intake survives; we transition to SUPPRESSED unless it's
 * already been resolved by the user (in which case we leave it
 * alone — a resolved intake is a historical artefact).
 */
export async function handleEmailEvidenceDeleted(args: {
  clubId: string;
  emailMessageId: string;
}): Promise<void> {
  const link = await prisma.emailWorkIntakeOrigin.findFirst({
    where: { emailMessageId: args.emailMessageId, role: "PRIMARY" },
    include: { workIntakeItem: true },
  });
  if (!link) return;
  if (link.workIntakeItem.clubId !== args.clubId) return; // tenant guard
  if (link.workIntakeItem.status === "RESOLVED" || link.workIntakeItem.status === "SUPPRESSED") {
    return;
  }
  await prisma.$transaction([
    prisma.workIntakeItem.update({
      where: { id: link.workIntakeItemId },
      data: { status: "SUPPRESSED" },
    }),
    prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: link.workIntakeItemId,
        action: "EVIDENCE_DELETED",
        note: "Source email was removed from the mailbox",
      },
    }),
  ]);
}

/** Pure projection — used by the materialiser AND callable by any
 *  future read layer that wants to preview an email without touching
 *  the DB. */
export function displayProjectionFromEmail(email: EmailMessage): EmailDisplayProjection {
  const senderName = email.senderName || email.senderAddress || "Unknown sender";
  const senderAddress = email.senderAddress || "";
  return {
    senderName,
    senderAddress,
    subject: email.subject || "(no subject)",
    preview: email.preview || "",
    receivedAt: email.receivedAt,
    hasAttachments: email.hasAttachments,
  };
}

// Convenience wrapper used by the sync handler — normalises a raw
// Graph message, runs the classifier, then upserts intake. Keeps the
// handler code short and testable.
export async function materialiseEmailFromRaw(args: {
  clubId: string;
  email: EmailMessage;
  raw: RawGraphMessage;
}): Promise<WorkIntakeItem | null> {
  const normalized = normalizeGraphMessage(args.raw);
  const classification = classifyEmail(normalized);
  return await upsertEmailIntake({
    clubId: args.clubId,
    email: args.email,
    classification,
  });
}
