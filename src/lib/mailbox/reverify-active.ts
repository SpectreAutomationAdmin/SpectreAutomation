// WI-SYNC-1h (2026-10-18) — Active Work Intake re-verification.
//
// Called from the manual Feed Sync refresh handler.  For every
// currently-active email-backed Work Intake item in the active
// club, calls Microsoft Graph directly to confirm the message's
// current folder.  If the message has moved to Deleted Items
// since Spectre last saw it, applies the same tombstone the
// 15-minute reconciliation sweep would — immediately, in-request.
//
// Why this exists:
//
//   Microsoft Graph's Inbox-scoped delta stream does NOT reliably
//   emit `@removed` markers when a user deletes a message in
//   Outlook.  WI-SYNC-1g acceptance observed six consecutive
//   Spectre-initiated deletes that converged inline but WI-SYNC-1h
//   confirmed that an Outlook-side delete can leave Spectre's
//   mirror stale for the full 15-minute reconciliation window.
//
//   The 60-second delta poll + the webhook-expedited delta both
//   depend on the same `@removed` channel and inherit the same
//   gap.  The 15-min reconciliation sweep closes it with active
//   probing, but 15 minutes is too long for a manual refresh
//   click.  This service runs the same probe path on the subset
//   of messages the user is currently looking at.
//
// Scope + bounds:
//
//   • Only OPEN / IN_PROGRESS / INFORMATIONAL / DEFERRED WIs.
//     RESOLVED / SUPPRESSED are already finalised.
//   • At most 50 WIs per call (same bound as the existing reverify).
//   • One Graph round-trip per message; grouped by mailbox so
//     one access token covers all its messages.
//   • Delete loop prevention is reused via `applyTombstone` →
//     `handleEmailEvidenceDeleted`, which already checks for a
//     SUCCEEDED OutlookDeleteMutation and records
//     EVIDENCE_DELETE_RECONCILED instead of double-tombstoning.
//
// Archive preservation (founder's §3 explicit ask):
//
//   PRESENT_ARCHIVE is classified SKIP_ARCHIVE_DEFERRED by
//   classifyProbe (reconciliation.ts §WI-SYNC-1a).  This service
//   inherits that semantic — archived messages are NEVER
//   tombstoned.
//
// Financial preservation:
//
//   Only EmailMessage.softDeletedAt and WorkIntakeItem.status are
//   mutated.  Approvals / invoices / journal entries / payments
//   are untouched.

import { prisma } from "@/lib/prisma";
import { getMicrosoftDelegatedProvider } from "@/lib/integrations/microsoft-graph-delegated";
import { getFreshDelegatedAccessToken } from "./connect";
import { applyTombstone, classifyProbe } from "./reconciliation";
import { logger } from "@/lib/observability/logger";

export interface ReverifyResult {
  reverifiedCount: number;
  tombstonedCount: number;
  isReadUpdatedCount: number;
  archivePreservedCount: number;
  otherFolderCount: number;
  deletedCount: number;
  errors: number;
  // Per-message outcomes for diagnostic reports.
  details: Array<{
    emailMessageId: string;
    graphMessageId: string;
    disposition: string;
    action: string;
  }>;
}

export async function reverifyWorkIntakeEmails(args: {
  clubId: string;
  callerUserId: string;
  limit?: number;
}): Promise<ReverifyResult> {
  const limit = Math.min(100, Math.max(1, args.limit ?? 50));
  const result: ReverifyResult = {
    reverifiedCount: 0,
    tombstonedCount: 0,
    isReadUpdatedCount: 0,
    archivePreservedCount: 0,
    otherFolderCount: 0,
    deletedCount: 0,
    errors: 0,
    details: [],
  };

  const openIntakes = await prisma.workIntakeItem.findMany({
    where: {
      clubId: args.clubId,
      status: { in: ["OPEN", "IN_PROGRESS", "DEFERRED", "INFORMATIONAL"] },
      emailOrigins: { some: { role: "PRIMARY" } },
    },
    select: {
      id: true,
      emailOrigins: {
        where: { role: "PRIMARY" },
        take: 1,
        select: {
          emailMessage: {
            select: {
              id: true,
              graphMessageId: true,
              mailboxConnectionId: true,
              isRead: true,
              softDeletedAt: true,
            },
          },
        },
      },
    },
    take: limit,
    orderBy: { createdAt: "desc" },
  });

  type Row = {
    emailId: string;
    graphMessageId: string;
    currentIsRead: boolean;
    currentSoftDeletedAt: Date | null;
  };
  const byMailbox = new Map<string, Row[]>();
  for (const it of openIntakes) {
    const em = it.emailOrigins[0]?.emailMessage;
    if (!em) continue;
    if (!em.graphMessageId) continue;
    if (em.softDeletedAt) continue; // already tombstoned — nothing to reverify
    if (!byMailbox.has(em.mailboxConnectionId)) byMailbox.set(em.mailboxConnectionId, []);
    byMailbox.get(em.mailboxConnectionId)!.push({
      emailId: em.id,
      graphMessageId: em.graphMessageId,
      currentIsRead: em.isRead,
      currentSoftDeletedAt: em.softDeletedAt,
    });
  }

  const provider = getMicrosoftDelegatedProvider();

  for (const [mailboxId, rows] of byMailbox.entries()) {
    try {
      const tok = await getFreshDelegatedAccessToken({
        mailboxConnectionId: mailboxId,
        callerClubId: args.clubId,
        callerUserId: args.callerUserId,
      });

      // Resolve the three well-known folder ids once per mailbox —
      // same shape the main sweep uses.
      const [inboxFolder, deletedFolder, archiveFolder] = await Promise.all([
        provider.getWellKnownFolder({ accessToken: tok.accessToken, wellKnownName: "inbox" }),
        provider.getWellKnownFolder({ accessToken: tok.accessToken, wellKnownName: "deleteditems" }),
        provider.getWellKnownFolder({ accessToken: tok.accessToken, wellKnownName: "archive" }),
      ]);
      const folderNames: Record<string, string> = {};
      if (inboxFolder) folderNames[inboxFolder.id] = `Inbox (${inboxFolder.displayName})`;
      if (deletedFolder) folderNames[deletedFolder.id] = `Deleted Items (${deletedFolder.displayName})`;
      if (archiveFolder) folderNames[archiveFolder.id] = `Archive (${archiveFolder.displayName})`;

      for (const r of rows) {
        try {
          const probe = await provider.probeMessage({
            accessToken: tok.accessToken,
            graphMessageId: r.graphMessageId,
          });
          const row = classifyProbe({
            base: {
              emailMessageId: r.emailId,
              graphMessageId: r.graphMessageId,
              subject: "",
              senderAddress: "",
              receivedAt: new Date(0),
              linkedWorkIntakeItemId: null,
              linkedWorkIntakeStatus: null,
              hasApIntakeSource: false,
              probeOutcome: probe.outcome,
              httpStatus: probe.httpStatus,
              errorCode: probe.errorCode,
              retryAfterSeconds: probe.retryAfterSeconds,
            },
            probe,
            inboxFolderId: inboxFolder?.id ?? null,
            deletedItemsFolderId: deletedFolder?.id ?? null,
            archiveFolderId: archiveFolder?.id ?? null,
            folderNames,
          });
          result.reverifiedCount += 1;
          result.details.push({
            emailMessageId: r.emailId,
            graphMessageId: r.graphMessageId,
            disposition: row.disposition,
            action: row.action,
          });

          switch (row.disposition) {
            case "PRESENT_INBOX": {
              // Still in Inbox — update isRead if Graph has changed it.
              if (
                typeof probe.isRead === "boolean" &&
                probe.isRead !== r.currentIsRead
              ) {
                await prisma.emailMessage.update({
                  where: { id: r.emailId },
                  data: { isRead: probe.isRead, lastSyncedAt: new Date() },
                });
                result.isReadUpdatedCount += 1;
              }
              break;
            }
            case "PRESENT_DELETED_ITEMS": {
              // Smallest reliable correction (founder's §3): tombstone
              // + call handleEmailEvidenceDeleted (idempotent).
              await applyTombstone({
                emailMessageId: r.emailId,
                clubId: args.clubId,
              });
              result.tombstonedCount += 1;
              break;
            }
            case "PRESENT_ARCHIVE": {
              // Archive is NOT equivalent to deletion (founder's §3).
              // Leave softDeletedAt alone.
              result.archivePreservedCount += 1;
              break;
            }
            case "PRESENT_OTHER_FOLDER": {
              result.otherFolderCount += 1;
              break;
            }
            case "DELETED": {
              // 404 — the message is gone entirely.  Treat as a
              // tombstone (same as a Deleted Items move, from
              // Spectre's perspective: the user cannot see it).
              await applyTombstone({
                emailMessageId: r.emailId,
                clubId: args.clubId,
              });
              result.deletedCount += 1;
              break;
            }
            // INACCESSIBLE_RETRYABLE / INACCESSIBLE_PERMANENT are
            // left to the next sweep tick — don't tombstone on a
            // transient Graph error.
            default:
              break;
          }
        } catch (err) {
          result.errors += 1;
          logger.warn("mailbox.reverify.probe_failed", {
            emailMessageIdTail: r.emailId.slice(-6),
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      // Mailbox-level token / token-refresh failure — count every
      // message as an error but keep going on the next mailbox.
      result.errors += rows.length;
      logger.warn("mailbox.reverify.mailbox_failed", {
        mailboxIdTail: mailboxId.slice(-6),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
