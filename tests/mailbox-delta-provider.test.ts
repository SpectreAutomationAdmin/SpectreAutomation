// Sprint 2 Checkpoint 13G (2026-07-23) — Delta provider tests.
//
// Locks in the delta-endpoint contract for the delegated Microsoft
// Graph provider:
//   1. URL validator (assertMicrosoftGraphDeltaUrl) rejection surface
//   2. Base request shape when no continuationUrl supplied
//   3. Continuation URL used verbatim when supplied
//   4. Response shape parsing (@odata.nextLink, @odata.deltaLink,
//      tombstones)
//   5. Read-only guarantee (no POST/PATCH/DELETE via this method)
//
// Deliberately does NOT talk to Microsoft. The provider interface
// tests read the compiled source; runtime behaviour is exercised
// against the mock provider from
// src/lib/integrations/microsoft-graph-delegated-mock.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import {
  assertMicrosoftGraphDeltaUrl,
  setMicrosoftDelegatedProvider,
  getMicrosoftDelegatedProvider,
  type RawGraphMessagePage,
  type RawGraphMessage,
} from "@/lib/integrations/microsoft-graph-delegated";
import { MockMicrosoftDelegatedProvider } from "@/lib/integrations/microsoft-graph-delegated-mock";

const PROVIDER_TS = readFileSync(
  path.resolve(__dirname, "../src/lib/integrations/microsoft-graph-delegated.ts"),
  "utf8",
);
const MOCK_TS = readFileSync(
  path.resolve(__dirname, "../src/lib/integrations/microsoft-graph-delegated-mock.ts"),
  "utf8",
);

// ---------------------------------------------------------------------------
// 1. Continuation URL validator
// ---------------------------------------------------------------------------

describe("assertMicrosoftGraphDeltaUrl", () => {
  it("accepts the canonical /me/mailFolders/inbox/messages/delta base URL", () => {
    expect(() =>
      assertMicrosoftGraphDeltaUrl(
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta",
      ),
    ).not.toThrow();
  });

  it("accepts a delta URL with mailFolders('inbox') syntax", () => {
    expect(() =>
      assertMicrosoftGraphDeltaUrl(
        "https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta",
      ),
    ).not.toThrow();
  });

  it("accepts a delta URL with an opaque folder id (Microsoft's real nextLink shape)", () => {
    expect(() =>
      assertMicrosoftGraphDeltaUrl(
        "https://graph.microsoft.com/v1.0/me/mailFolders('AAMkAGRlZmF1bHQAAAAAAAAA')/messages/delta",
      ),
    ).not.toThrow();
  });

  it("accepts a delta URL with query parameters", () => {
    expect(() =>
      assertMicrosoftGraphDeltaUrl(
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=abc123",
      ),
    ).not.toThrow();
    expect(() =>
      assertMicrosoftGraphDeltaUrl(
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=xyz789",
      ),
    ).not.toThrow();
  });

  it("rejects non-HTTPS schemes (http://)", () => {
    expect(() =>
      assertMicrosoftGraphDeltaUrl(
        "http://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta",
      ),
    ).toThrow(/non-HTTPS scheme/);
  });

  it("rejects non-Microsoft hostnames (attacker-controlled host)", () => {
    expect(() =>
      assertMicrosoftGraphDeltaUrl(
        "https://evil.example.com/v1.0/me/mailFolders/inbox/messages/delta",
      ),
    ).toThrow(/unexpected hostname/);
  });

  it("rejects a Graph URL that is not under /me/mailFolders", () => {
    expect(() =>
      assertMicrosoftGraphDeltaUrl(
        "https://graph.microsoft.com/v1.0/users/other-user/mailFolders/inbox/messages/delta",
      ),
    ).toThrow(/path must begin with \/v1\.0\/me\/mailFolders/);
  });

  it("rejects a path that does not end with /messages/delta (attempted attachments endpoint)", () => {
    expect(() =>
      assertMicrosoftGraphDeltaUrl(
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/AAMkAG.../attachments",
      ),
    ).toThrow(/path must end with \/messages\/delta/);
  });

  it("rejects unparseable strings", () => {
    expect(() => assertMicrosoftGraphDeltaUrl("not a url at all")).toThrow(/not a parseable URL/);
  });
});

// ---------------------------------------------------------------------------
// 2. Provider interface + real MSAL implementation — source contract
// ---------------------------------------------------------------------------

describe("MicrosoftDelegatedProvider — delta endpoint contract", () => {
  it("interface declares listInboxMessagesDelta", () => {
    expect(PROVIDER_TS).toMatch(
      /listInboxMessagesDelta\(args:\s*ListInboxMessagesDeltaArgs\):\s*Promise<RawGraphMessagePage>/,
    );
  });

  it("declares ListInboxMessagesDeltaArgs with pageSize + optional continuationUrl", () => {
    expect(PROVIDER_TS).toMatch(/export interface ListInboxMessagesDeltaArgs/);
    const iface = PROVIDER_TS.slice(PROVIDER_TS.indexOf("export interface ListInboxMessagesDeltaArgs"));
    expect(iface).toMatch(/pageSize:\s*number/);
    expect(iface).toMatch(/continuationUrl\?:\s*string\s*\|\s*null/);
    expect(iface).toMatch(/accessToken:\s*string/);
  });

  it("MSAL implementation uses /me/mailFolders/inbox/messages/delta as the base URL", () => {
    expect(PROVIDER_TS).toMatch(
      /const base = "https:\/\/graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages\/delta"/,
    );
  });

  it("MSAL implementation bounds $top by args.pageSize", () => {
    const method = PROVIDER_TS.slice(PROVIDER_TS.indexOf("async listInboxMessagesDelta"));
    expect(method).toMatch(/\$top=\$\{args\.pageSize\}/);
  });

  it("MSAL implementation requests the exact same $select fields as the list endpoint", () => {
    const method = PROVIDER_TS.slice(PROVIDER_TS.indexOf("async listInboxMessagesDelta"));
    for (const field of [
      "id",
      "internetMessageId",
      "conversationId",
      "from",
      "sender",
      "toRecipients",
      "subject",
      "receivedDateTime",
      "body",
      "importance",
      "isRead",
      "hasAttachments",
      "webLink",
    ]) {
      expect(method).toContain(`"${field}"`);
    }
  });

  it("MSAL implementation validates any supplied continuationUrl before fetching", () => {
    const method = PROVIDER_TS.slice(PROVIDER_TS.indexOf("async listInboxMessagesDelta"));
    // The validator is called on the continuation URL BEFORE the URL becomes the fetch target
    expect(method).toMatch(/assertMicrosoftGraphDeltaUrl\(args\.continuationUrl\)/);
    // And the validated URL is used verbatim, not reconstructed
    expect(method).toMatch(/url = args\.continuationUrl/);
  });

  it("MSAL implementation parses @odata.nextLink AND @odata.deltaLink from the response", () => {
    const method = PROVIDER_TS.slice(PROVIDER_TS.indexOf("async listInboxMessagesDelta"));
    expect(method).toMatch(/"@odata\.nextLink"\?:\s*string/);
    expect(method).toMatch(/"@odata\.deltaLink"\?:\s*string/);
    expect(method).toMatch(/nextPageToken:\s*body\["@odata\.nextLink"\]/);
    expect(method).toMatch(/deltaLink:\s*body\["@odata\.deltaLink"\]/);
  });

  it("MSAL implementation is read-only: only fetch() with a GET (no method override for POST/PATCH/DELETE)", () => {
    const method = PROVIDER_TS.slice(
      PROVIDER_TS.indexOf("async listInboxMessagesDelta"),
      PROVIDER_TS.indexOf("async listInboxMessagesDelta") + 2500,
    );
    // No RequestInit with a method: field — default GET
    expect(method).not.toMatch(/method:\s*"(POST|PATCH|DELETE|PUT)"/);
    // fetch() call present with only headers
    expect(method).toMatch(/fetch\(url,\s*\{/);
    expect(method).toMatch(/Authorization:\s*`Bearer/);
  });

  it("RawGraphMessage.removed is declared and typed as an optional Graph tombstone marker", () => {
    expect(PROVIDER_TS).toMatch(/removed\?:\s*\{\s*reason\?:\s*string\s*\}\s*\|\s*null/);
  });
});

// ---------------------------------------------------------------------------
// 3. Mock provider runtime behaviour
// ---------------------------------------------------------------------------

describe("MockMicrosoftDelegatedProvider — delta runtime", () => {
  let mock: MockMicrosoftDelegatedProvider;
  beforeEach(() => {
    mock = new MockMicrosoftDelegatedProvider({
      tenantId: "t1",
      externalUserId: "u1",
      connectedEmail: "test@example.test",
      displayName: "Test",
    });
    setMicrosoftDelegatedProvider(mock);
  });

  it("returns a supplied fixture page verbatim", async () => {
    const page: RawGraphMessagePage = {
      messages: [makeMessage("m1")],
      nextPageToken: null,
      deltaLink: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=cursor-v1",
    };
    mock.setFixtureDeltaPages([page]);
    const out = await getMicrosoftDelegatedProvider().listInboxMessagesDelta({
      accessToken: "at-1",
      pageSize: 10,
    });
    expect(out).toEqual(page);
    expect(mock.capturedListInboxDeltaCalls).toHaveLength(1);
    expect(mock.capturedListInboxDeltaCalls[0]?.pageSize).toBe(10);
    expect(mock.capturedListInboxDeltaCalls[0]?.continuationUrl).toBeFalsy();
  });

  it("supports multi-page enumeration via successive fixture pages", async () => {
    const page1: RawGraphMessagePage = {
      messages: [makeMessage("m1"), makeMessage("m2")],
      nextPageToken:
        "https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta?$skiptoken=SKIP1",
      deltaLink: null,
    };
    const page2: RawGraphMessagePage = {
      messages: [makeMessage("m3")],
      nextPageToken: null,
      deltaLink:
        "https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta?$deltatoken=CURSOR",
    };
    mock.setFixtureDeltaPages([page1, page2]);
    const p = getMicrosoftDelegatedProvider();
    const r1 = await p.listInboxMessagesDelta({ accessToken: "at", pageSize: 10 });
    expect(r1.messages).toHaveLength(2);
    expect(r1.nextPageToken).toBe(page1.nextPageToken);
    expect(r1.deltaLink).toBeNull();
    const r2 = await p.listInboxMessagesDelta({
      accessToken: "at",
      pageSize: 10,
      continuationUrl: r1.nextPageToken,
    });
    expect(r2.messages).toHaveLength(1);
    expect(r2.deltaLink).toBe(page2.deltaLink);
  });

  it("throws when a continuation URL fails validation (mock enforces same guard as real provider)", async () => {
    mock.setFixtureDeltaPages([{ messages: [], nextPageToken: null, deltaLink: null }]);
    await expect(
      getMicrosoftDelegatedProvider().listInboxMessagesDelta({
        accessToken: "at",
        pageSize: 10,
        continuationUrl: "https://evil.example.com/v1.0/me/mailFolders/inbox/messages/delta",
      }),
    ).rejects.toThrow(/unexpected hostname/);
  });

  it("parses tombstones on delta pages", async () => {
    const tomb: RawGraphMessage = { ...makeMessage("m-tomb"), removed: { reason: "deleted" } };
    mock.setFixtureDeltaPages([
      { messages: [tomb], nextPageToken: null, deltaLink: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=C" },
    ]);
    const out = await getMicrosoftDelegatedProvider().listInboxMessagesDelta({ accessToken: "at", pageSize: 10 });
    expect(out.messages[0]?.removed).toEqual({ reason: "deleted" });
  });

  it("throws a distinctive error if the caller loops past the fixture (no silent success)", async () => {
    mock.setFixtureDeltaPages([]);
    await expect(
      getMicrosoftDelegatedProvider().listInboxMessagesDelta({ accessToken: "at", pageSize: 10 }),
    ).rejects.toThrow(/no more fixture pages configured/);
  });
});

// ---------------------------------------------------------------------------
// 4. Mock provider source contract — same $top / continuationUrl semantics
// ---------------------------------------------------------------------------

describe("Mock provider — source contract", () => {
  it("mock declares listInboxMessagesDelta returning Promise<RawGraphMessagePage>", () => {
    expect(MOCK_TS).toMatch(
      /async listInboxMessagesDelta\(args:\s*ListInboxMessagesDeltaArgs\):\s*Promise<RawGraphMessagePage>/,
    );
  });

  it("mock calls the same continuation-URL validator as the real provider", () => {
    expect(MOCK_TS).toMatch(/assertMicrosoftGraphDeltaUrl\(args\.continuationUrl\)/);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeMessage(id: string): RawGraphMessage {
  return {
    id,
    internetMessageId: `<${id}@example.test>`,
    conversationId: `conv-${id}`,
    from: { emailAddress: { address: "sender@example.test", name: "Sender" } },
    sender: null,
    toRecipients: [{ emailAddress: { address: "test@example.test", name: "Test" } }],
    ccRecipients: [],
    bccRecipients: [],
    subject: `Subject ${id}`,
    receivedDateTime: "2026-07-22T12:00:00Z",
    sentDateTime: "2026-07-22T11:59:00Z",
    bodyPreview: "preview",
    body: { contentType: "text", content: "hello" },
    importance: "normal",
    isRead: false,
    hasAttachments: false,
    webLink: "https://outlook.office.com/mail/id/" + id,
  };
}
