// Sprint 3 · Checkpoint 16H rejection (2026-08-06) — unit tests
// for the conversation-persistence + reconciliation architecture.
// Covers §18 acceptance criteria at unit-test scope. Full Prisma
// round-trip runs in the staging Playwright acceptance.
//
// What this exercises:
//   1. Graph 202 with an empty response still produces a canonical
//      outbound row (persistCanonicalOutboundReply is idempotent).
//   2. Successful reply creates exactly one outbound message; a
//      repeated call collapses onto the same row (§4 uniqueness).
//   3. Retry does not duplicate (idempotency by replyMutationId).
//   4. Local outbound is visible BEFORE Sent-Items reconciliation.
//   5. §10 matching hierarchy: internetMessageId wins; else tight
//      window + owner sender + conversationId; conversationId alone
//      NEVER merges.

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — inline the mock factory so it doesn't depend
// on a top-level `prismaMock` variable that hasn't been initialised
// at hoist time.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversationMessage: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    outlookReplyMutation: { update: vi.fn() },
    backgroundJob: { create: vi.fn() },
    mailboxConnection: { findUnique: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) =>
      Promise.all(ops.map((o) => (o as Promise<unknown>)))),
  },
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { persistCanonicalOutboundReply, pickBestSentMatch } from "@/lib/mailbox/conversation-messages";
const prismaMock = prisma as unknown as {
  conversationMessage: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  outlookReplyMutation: { update: ReturnType<typeof vi.fn> };
  backgroundJob: { create: ReturnType<typeof vi.fn> };
  mailboxConnection: { findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  prismaMock.conversationMessage.findUnique.mockReset();
  prismaMock.conversationMessage.create.mockReset();
  prismaMock.conversationMessage.update.mockReset();
  prismaMock.outlookReplyMutation.update.mockReset();
  prismaMock.backgroundJob.create.mockReset().mockResolvedValue({ id: "job1" });
  prismaMock.mailboxConnection.findUnique.mockReset();
});

const BASE_ARGS = {
  clubId: "cr",
  workIntakeItemId: "wi1",
  mailboxConnectionId: "mbx1",
  conversationId: "conv-abc",
  replyMutationId: "mut1",
  senderName: "cturcato@spectreautomation.com",
  senderAddress: "cturcato@spectreautomation.com",
  recipientsJson: JSON.stringify({ to: [{ emailAddress: { address: "inquirer@example.com" } }], cc: [] }),
  subject: "Re: Membership Inquiry",
  bodyText: "Thanks for reaching out — happy to send our packet.",
  bodyCiphertext: null as string | null,
  bodySecretRef: null as string | null,
  sentAt: new Date("2026-08-04T23:44:58.912Z"),
};

describe("16H · persistCanonicalOutboundReply", () => {
  it("creates a new ConversationMessage when none exists (Graph 202-empty case)", async () => {
    prismaMock.conversationMessage.findUnique.mockResolvedValue(null);
    prismaMock.conversationMessage.create.mockResolvedValue({ id: "cm1" });
    const res = await persistCanonicalOutboundReply({ ...BASE_ARGS });
    expect(res.conversationMessageId).toBe("cm1");
    expect(res.reconciliationEnqueued).toBe(true);
    // §5 linkage: outbound row carries the same clubId, mailbox,
    // conversationId, WI, and replyMutationId as the source thread.
    const call = prismaMock.conversationMessage.create.mock.calls[0][0];
    expect(call.data.direction).toBe("OUTBOUND");
    expect(call.data.source).toBe("SPECTRE_REPLY");
    expect(call.data.reconciliationStatus).toBe("PENDING");
    expect(call.data.conversationId).toBe("conv-abc");
    expect(call.data.replyMutationId).toBe("mut1");
    expect(call.data.providerMessageId).toBeNull();
    // Reconciliation is scheduled — a background job is enqueued.
    expect(prismaMock.backgroundJob.create).toHaveBeenCalledTimes(1);
    const jobCall = prismaMock.backgroundJob.create.mock.calls[0][0];
    expect(jobCall.data.kind).toBe("CONVERSATION_MESSAGE_RECONCILE");
  });

  it("is idempotent per replyMutationId (§4) — repeat calls do not duplicate", async () => {
    // First call: no existing row.
    prismaMock.conversationMessage.findUnique.mockResolvedValueOnce(null);
    prismaMock.conversationMessage.create.mockResolvedValueOnce({ id: "cm-once" });
    const r1 = await persistCanonicalOutboundReply({ ...BASE_ARGS });
    // Second call for the same mutation: findUnique now returns the row.
    prismaMock.conversationMessage.findUnique.mockResolvedValueOnce({ id: "cm-once" });
    const r2 = await persistCanonicalOutboundReply({ ...BASE_ARGS });
    expect(r1.conversationMessageId).toBe("cm-once");
    expect(r2.conversationMessageId).toBe("cm-once");
    // create was called EXACTLY once across both attempts.
    expect(prismaMock.conversationMessage.create).toHaveBeenCalledTimes(1);
  });

  it("skips reconciliation when the source had no conversationId (nothing for Graph to look up)", async () => {
    prismaMock.conversationMessage.findUnique.mockResolvedValue(null);
    prismaMock.conversationMessage.create.mockResolvedValue({ id: "cm2" });
    const res = await persistCanonicalOutboundReply({ ...BASE_ARGS, conversationId: null });
    expect(res.reconciliationEnqueued).toBe(false);
    const call = prismaMock.conversationMessage.create.mock.calls[0][0];
    expect(call.data.reconciliationStatus).toBe("NOT_APPLICABLE");
    expect(prismaMock.backgroundJob.create).not.toHaveBeenCalled();
  });

  it("local outbound is visible BEFORE Sent Items reconciliation (providerMessageId is null on create)", async () => {
    prismaMock.conversationMessage.findUnique.mockResolvedValue(null);
    prismaMock.conversationMessage.create.mockResolvedValue({ id: "cm3" });
    await persistCanonicalOutboundReply({ ...BASE_ARGS });
    const call = prismaMock.conversationMessage.create.mock.calls[0][0];
    // Founder §2: local canonical row is persisted immediately with
    // no provider identity — the Conversation tab renders it as soon
    // as the request returns.
    expect(call.data.providerMessageId).toBeNull();
    expect(call.data.reconciliationStatus).toBe("PENDING");
    expect(call.data.sentAt).toEqual(BASE_ARGS.sentAt);
  });
});

describe("16H · pickBestSentMatch — §10 matching hierarchy", () => {
  const anchor = new Date("2026-08-04T23:44:58.912Z");
  const owner = "cturcato@spectreautomation.com";
  const conv = "conv-abc";

  it("high-confidence match: internetMessageId wins over conversationId+time", async () => {
    const target = {
      id: "graph-target", internetMessageId: "<AAA@spectre>", conversationId: conv,
      subject: "Re: Membership Inquiry",
      from: { emailAddress: { address: owner } },
      toRecipients: [], ccRecipients: [],
      sentDateTime: "2026-08-04T23:45:30.000Z",
      bodyPreview: "thanks", body: null,
    };
    const distractor = {
      id: "graph-distractor", internetMessageId: "<BBB@spectre>", conversationId: conv,
      subject: "Re: Membership Inquiry",
      from: { emailAddress: { address: owner } },
      toRecipients: [], ccRecipients: [],
      sentDateTime: "2026-08-04T23:44:59.000Z",
      bodyPreview: "hi", body: null,
    };
    const chosen = pickBestSentMatch([distractor, target], {
      ownerAddressLower: owner,
      anchorSentAt: anchor,
      conversationId: conv,
      knownInternetMessageId: "<AAA@spectre>",
    });
    expect(chosen).toBe(target);
  });

  it("medium-confidence: conversationId + owner + tight window → closest to anchor", async () => {
    const near = {
      id: "graph-near", internetMessageId: null, conversationId: conv,
      subject: "Re: X",
      from: { emailAddress: { address: owner } },
      toRecipients: [], ccRecipients: [],
      sentDateTime: "2026-08-04T23:45:10.000Z", // 12s after anchor
      bodyPreview: "n", body: null,
    };
    const far = {
      id: "graph-far", internetMessageId: null, conversationId: conv,
      subject: "Re: X",
      from: { emailAddress: { address: owner } },
      toRecipients: [], ccRecipients: [],
      sentDateTime: "2026-08-04T23:52:00.000Z", // ~7min after
      bodyPreview: "f", body: null,
    };
    const chosen = pickBestSentMatch([far, near], {
      ownerAddressLower: owner,
      anchorSentAt: anchor,
      conversationId: conv,
      knownInternetMessageId: null,
    });
    expect(chosen).toBe(near);
  });

  it("conversationId alone does NOT merge (§10) — wrong sender is rejected", async () => {
    const wrongSender = {
      id: "graph-wrong", internetMessageId: null, conversationId: conv,
      subject: "Re: X",
      from: { emailAddress: { address: "someone-else@somewhere.com" } },
      toRecipients: [], ccRecipients: [],
      sentDateTime: "2026-08-04T23:45:00.000Z",
      bodyPreview: "?", body: null,
    };
    const chosen = pickBestSentMatch([wrongSender], {
      ownerAddressLower: owner,
      anchorSentAt: anchor,
      conversationId: conv,
      knownInternetMessageId: null,
    });
    expect(chosen).toBeNull();
  });

  it("rejects candidates outside the tight ±10 min window", async () => {
    const stale = {
      id: "graph-stale", internetMessageId: null, conversationId: conv,
      subject: "Re: X",
      from: { emailAddress: { address: owner } },
      toRecipients: [], ccRecipients: [],
      sentDateTime: "2026-08-05T00:30:00.000Z", // ~45 min after anchor
      bodyPreview: "?", body: null,
    };
    const chosen = pickBestSentMatch([stale], {
      ownerAddressLower: owner,
      anchorSentAt: anchor,
      conversationId: conv,
      knownInternetMessageId: null,
    });
    expect(chosen).toBeNull();
  });
});
