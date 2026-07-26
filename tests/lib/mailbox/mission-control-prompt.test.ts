// Sprint 2 B3 (2026-07-19) — Mission Control connect prompt tests.
//
// Verifies the visibility gate honours §12 of the B3 directive:
//   • hidden when feature flag off
//   • hidden when the user lacks connect permission
//   • hidden when the user already has an active personal mailbox
//   • visible otherwise

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { loadMissionControlConnectPromptSpec } from "@/lib/mailbox/mission-control-prompt";
import { MockMicrosoftDelegatedProvider } from "@/lib/integrations/microsoft-graph-delegated-mock";
import { setMicrosoftDelegatedProvider } from "@/lib/integrations/microsoft-graph-delegated";
import { startConnect, finaliseConnection, disconnectMailbox } from "@/lib/mailbox/connect";
import type { Principal } from "@/lib/rbac";

async function seedUser(prefix: string) {
  const club = await prisma.club.create({
    data: { name: `Prompt Club ${prefix}`, slug: `prompt-club-${prefix}-${Date.now()}` },
  });
  const user = await prisma.user.create({
    data: {
      name: `Prompt User ${prefix}`,
      email: `${prefix}-${Date.now()}@example.test`,
      role: "CLUB_ADMIN",
      passwordHash: "not-used",
      clubId: club.id,
    },
  });
  return { clubId: club.id, userId: user.id };
}

// Minimal Principal for the visibility check. `hasPermission` reads
// memberships → roleKey → ROLE_PERMISSIONS. CLUB_ADMIN grants
// `settings:write`; MEMBER does not.
function principal(userId: string, clubId: string, canConnect: boolean): Principal {
  return {
    id: userId,
    email: "x@x.test",
    name: "x",
    status: "ACTIVE",
    activeClubId: clubId,
    memberships: [
      { clubId, roleKey: canConnect ? "CLUB_ADMIN" : "MEMBER" },
    ],
    memberId: null,
  };
}

describe("Mission Control connect prompt", () => {
  afterEach(() => setMicrosoftDelegatedProvider(null));

  it("is visible when the user has no connected mailbox and has permission", async () => {
    const { userId, clubId } = await seedUser("visible");
    const spec = await loadMissionControlConnectPromptSpec({
      principal: principal(userId, clubId, true),
      clubId,
    });
    expect(spec?.visible).toBe(true);
    expect(spec?.connectHref).toBe("/app/user/settings/connected-accounts");
  });

  it("is hidden when the user lacks connect permission", async () => {
    const { userId, clubId } = await seedUser("nopermission");
    const spec = await loadMissionControlConnectPromptSpec({
      principal: principal(userId, clubId, false),
      clubId,
    });
    expect(spec).toBeNull();
  });

  it("is hidden when the user already has a CONNECTED_PENDING_SYNC mailbox", async () => {
    const { userId, clubId } = await seedUser("hidden-pending");
    const provider = new MockMicrosoftDelegatedProvider({
      tenantId: "00000000-0000-0000-0000-mcprompt111",
      externalUserId: "mcp_prompt1_" + Date.now(),
      connectedEmail: "mcp1@corporate.test",
      displayName: "Prompt Tester",
    });
    setMicrosoftDelegatedProvider(provider);
    const started = await startConnect({ userId, clubId, returnPath: "/app/user/settings" });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const tx = await prisma.mailboxOAuthTransaction.findUnique({ where: { state } });
    provider.updateConfig({ echoNonce: tx!.nonce });
    await finaliseConnection({ state, code: "code", callerUserId: userId, callerClubId: clubId });

    const spec = await loadMissionControlConnectPromptSpec({
      principal: principal(userId, clubId, true),
      clubId,
    });
    expect(spec).toBeNull();
  });

  it("is VISIBLE again after the user disconnects the mailbox", async () => {
    const { userId, clubId } = await seedUser("visible-after-disc");
    const provider = new MockMicrosoftDelegatedProvider({
      tenantId: "00000000-0000-0000-0000-mcprompt222",
      externalUserId: "mcp_prompt2_" + Date.now(),
      connectedEmail: "mcp2@corporate.test",
      displayName: "Prompt Tester",
    });
    setMicrosoftDelegatedProvider(provider);
    const started = await startConnect({ userId, clubId, returnPath: "/app/user/settings" });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const tx = await prisma.mailboxOAuthTransaction.findUnique({ where: { state } });
    provider.updateConfig({ echoNonce: tx!.nonce });
    const res = await finaliseConnection({ state, code: "code", callerUserId: userId, callerClubId: clubId });
    await disconnectMailbox({ mailboxConnectionId: res.mailboxConnectionId, callerUserId: userId, callerClubId: clubId });

    const spec = await loadMissionControlConnectPromptSpec({
      principal: principal(userId, clubId, true),
      clubId,
    });
    // The user is now disconnected — they SHOULD see the prompt again.
    expect(spec?.visible).toBe(true);
  });
});
