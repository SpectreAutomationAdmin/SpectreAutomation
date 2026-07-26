// Sprint 2 B3 (2026-07-19) — Mission Control connect-prompt visibility
// loader. Kept as a plain .ts (no JSX) so tests can import it under
// vitest's Node environment without pulling in a client component.
//
// The .tsx client component in
// src/components/mailbox/MissionControlConnectPrompt.tsx re-exports
// this loader so existing call-sites keep working.

import { prisma } from "@/lib/prisma";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import { hasPermission, type Principal } from "@/lib/rbac";

export interface MissionControlConnectPromptSpec {
  visible: boolean;
  headline: string;
  copy: string;
  connectHref: string;
}

export async function loadMissionControlConnectPromptSpec(args: {
  principal: Principal;
  clubId: string;
}): Promise<MissionControlConnectPromptSpec | null> {
  if (!isMailboxIntegrationEnabled()) return null;
  if (!hasPermission(args.principal, args.clubId, "settings:write")) return null;
  const existing = await prisma.mailboxConnection.findFirst({
    where: {
      userId: args.principal.id,
      clubId: args.clubId,
      mailboxType: "PERSONAL",
      status: { notIn: ["DISCONNECTED"] },
    },
    select: { id: true, status: true },
  });
  if (existing) return null; // hide the prompt when a mailbox is connected
  return {
    visible: true,
    headline: "Bring Outlook into Work Intake",
    copy:
      "Connect your Microsoft 365 mailbox so Spectre can surface relevant email alongside operational work. During this phase Spectre only reads your Inbox — nothing is sent, deleted, or marked read.",
    connectHref: "/app/user/settings/connected-accounts",
  };
}
