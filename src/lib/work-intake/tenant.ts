// Sprint 2 (2026-07-19) — Tenant-isolation utilities for the Work
// Intake layer.
//
// The Prisma models `WorkIntakeItem`, `MailboxConnection`,
// `EmailMessage`, and `EmailAttachment` all carry `clubId` (directly
// or through their parent connection). Every read from Mission
// Control / Connected Accounts / the intake detail page MUST pass
// through one of the helpers below.
//
// Two levels of isolation:
//
//   1. Club scoping — clubId matches the active club. Prevents
//      cross-tenant reads.
//
//   2. Personal-mailbox visibility — a mailbox with mailboxType
//      "PERSONAL" is visible ONLY to the connecting user, even to a
//      Club Admin who has settings:write on the club. This is the
//      founder's Phase B rule: "personal mailbox items are visible
//      only to the connecting user" and "Club Admin status alone
//      does not expose personal mailbox contents".
//
// The where clauses below are composable — combine them with any
// domain-specific predicates in the caller. Do not bypass them.

import type { Prisma } from "@prisma/client";

export interface WorkIntakeReaderPrincipal {
  userId: string;
  clubId: string;
  /** Existing role-based permission check, imported by the caller
   *  from src/lib/rbac. Passed in as a boolean so this utility stays
   *  decoupled from the RBAC schema. */
  isClubAdmin: boolean;
  /** SUPER_ADMIN bypass. When true, tenant scoping is preserved
   *  (SUPER_ADMIN cannot cross-tenant read); mailbox-visibility
   *  bypass is NOT granted — SUPER_ADMIN cannot read another user's
   *  personal mailbox contents. This matches the founder's rule that
   *  even Club Admin status alone does not expose personal mailboxes. */
  isSuperAdmin: boolean;
}

/**
 * Where clause for reading `WorkIntakeItem` rows that this principal
 * is authorised to see in Mission Control.
 *
 * Visibility rules:
 *   - Items from PERSONAL mailboxes → only the connecting user.
 *   - Items from SHARED mailboxes → any user with a live
 *     MailboxAccess row (Phase C+; no SHARED mailboxes in B1).
 *   - Items from non-mailbox sources (AP invoices etc.) → not
 *     scoped by this helper; those sources have their own loaders.
 *
 * The `OR` includes both mailbox-derived and non-mailbox-derived
 * intake items. Non-mailbox items have zero `emailOrigins` rows and
 * so pass the second branch trivially.
 */
export function workIntakeReadableByPrincipal(
  principal: WorkIntakeReaderPrincipal,
): Prisma.WorkIntakeItemWhereInput {
  return {
    clubId: principal.clubId,
    OR: [
      // Items with no email origin (AP invoices, weather alerts, etc.
      // once they migrate to materialised intake) — always visible.
      { emailOrigins: { none: {} } },
      // Items with an email origin — must satisfy the mailbox
      // visibility rules on at least one link.
      {
        emailOrigins: {
          some: {
            emailMessage: {
              mailboxConnection: mailboxVisibilityFilter(principal),
            },
          },
        },
      },
    ],
  };
}

/**
 * Filter for MailboxConnection rows this principal can see.
 *
 * A PERSONAL mailbox is visible ONLY to `userId === principal.userId`.
 * A SHARED mailbox is visible to any user with a live
 * `MailboxAccess` row (`revokedAt IS NULL`). Being a Club Admin is
 * not enough on its own — the founder's rule (§12 of Phase B) is
 * explicit.
 */
export function mailboxVisibilityFilter(
  principal: WorkIntakeReaderPrincipal,
): Prisma.MailboxConnectionWhereInput {
  return {
    clubId: principal.clubId,
    OR: [
      // PERSONAL — the connecting user, and only the connecting user.
      { mailboxType: "PERSONAL", userId: principal.userId },
      // SHARED — anyone with an unrevoked MailboxAccess row. No
      // SHARED mailboxes exist in Phase B; this branch is safe.
      {
        mailboxType: "SHARED",
        accesses: {
          some: {
            userId: principal.userId,
            revokedAt: null,
          },
        },
      },
    ],
  };
}

/**
 * Assert that a specific mailbox connection is readable by this
 * principal. Throws if not. Callers reading a single mailbox by id
 * (e.g. the "Sync now" action) MUST call this first.
 */
export function assertMailboxReadable(
  principal: WorkIntakeReaderPrincipal,
  connection: {
    clubId: string;
    userId: string;
    mailboxType: string;
    accesses?: Array<{ userId: string; revokedAt: Date | null }>;
  },
): void {
  if (connection.clubId !== principal.clubId) {
    throw new MailboxAccessDenied("cross-club-read");
  }
  if (connection.mailboxType === "PERSONAL") {
    if (connection.userId !== principal.userId) {
      throw new MailboxAccessDenied("personal-mailbox-not-owner");
    }
    return;
  }
  if (connection.mailboxType === "SHARED") {
    const hasAccess = (connection.accesses ?? []).some(
      (a) => a.userId === principal.userId && a.revokedAt == null,
    );
    if (!hasAccess) throw new MailboxAccessDenied("shared-mailbox-no-access");
    return;
  }
  throw new MailboxAccessDenied(`unknown-mailbox-type:${connection.mailboxType}`);
}

export class MailboxAccessDenied extends Error {
  constructor(reason: string) {
    super(`Mailbox access denied: ${reason}`);
    this.name = "MailboxAccessDenied";
  }
}
