// Sprint 2 Checkpoint 14C (2026-07-23) — Conversation-based Work
// Intake intelligence + in-feed email execution.
//
// Locks the observable behavior of:
//   - src/lib/mission-control/invoice-analysis.ts (deterministic pipeline)
//   - src/lib/mailbox/email-materializer.ts (conversation grouping + remediation)
//   - src/lib/mission-control/email-intake.ts  (loader emits synopsis + evidence)
//   - src/lib/mission-control/index.ts         (WorkItem type extensions)
//   - src/app/app/admin/page.tsx               (structured card wiring)
//   - src/components/mission-control/EmailIntakeCard.tsx  (no Open detail; icons)
//   - src/components/mission-control/InlineConversationPanel.tsx (newest-first; no Outlook)
//   - src/components/mission-control/ReplyComposer.tsx  (consent + confirmation gate)
//   - src/app/api/mission-control/work-intake/[id]/thread/route.ts
//   - src/app/api/mission-control/work-intake/[id]/reply/route.ts
//   - src/lib/integrations/microsoft-graph-delegated.ts (Mail.Send + replyToMessage)

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractIdentifiersFromEmail, normalizeVendorName } from "@/lib/mission-control/invoice-analysis";
import type { EmailMessage } from "@prisma/client";

const ANALYSIS_TS  = readFileSync(path.resolve(__dirname, "../src/lib/mission-control/invoice-analysis.ts"), "utf8");
const MATERIALIZER_TS = readFileSync(path.resolve(__dirname, "../src/lib/mailbox/email-materializer.ts"), "utf8");
const INTAKE_TS = readFileSync(path.resolve(__dirname, "../src/lib/mission-control/email-intake.ts"), "utf8");
const MC_INDEX_TS = readFileSync(path.resolve(__dirname, "../src/lib/mission-control/index.ts"), "utf8");
const MC_PAGE_TSX = readFileSync(path.resolve(__dirname, "../src/app/app/admin/page.tsx"), "utf8");
const CARD_TSX = readFileSync(path.resolve(__dirname, "../src/components/mission-control/EmailIntakeCard.tsx"), "utf8");
const PANEL_TSX = readFileSync(path.resolve(__dirname, "../src/components/mission-control/InlineConversationPanel.tsx"), "utf8");
const COMPOSER_TSX = readFileSync(path.resolve(__dirname, "../src/components/mission-control/ReplyComposer.tsx"), "utf8");
const THREAD_ROUTE = readFileSync(path.resolve(__dirname, "../src/app/api/mission-control/work-intake/[id]/thread/route.ts"), "utf8");
const REPLY_ROUTE = readFileSync(path.resolve(__dirname, "../src/app/api/mission-control/work-intake/[id]/reply/route.ts"), "utf8");
const DELEGATED_TS = readFileSync(path.resolve(__dirname, "../src/lib/integrations/microsoft-graph-delegated.ts"), "utf8");
const MOCK_TS = readFileSync(path.resolve(__dirname, "../src/lib/integrations/microsoft-graph-delegated-mock.ts"), "utf8");
const ICONS_TSX = readFileSync(path.resolve(__dirname, "../src/components/spectre/icons/index.tsx"), "utf8");

function mkEmail(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "em_test", clubId: "cl", mailboxConnectionId: "mc",
    graphMessageId: "g1", immutableId: null, internetMessageId: null,
    conversationId: null,
    senderName: "Test Sender", senderAddress: "sender@example.test",
    recipientsJson: "{}", subject: "Subject",
    receivedAt: new Date(), sentAt: null,
    preview: "", bodyHtmlSanitized: null, bodyTextExtract: null,
    importance: "normal", isRead: true, hasAttachments: false,
    webLink: null, lastSyncedAt: new Date(), softDeletedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
    ingestFailedAt: null, ingestFailReason: null, retryAttempts: 0,
    ...overrides,
  } as EmailMessage;
}

// ---------------------------------------------------------------------------
// 1. Deterministic identifier extraction (unit tests — no DB)
// ---------------------------------------------------------------------------

describe("extractIdentifiersFromEmail — deterministic invoice-identifier extraction", () => {
  it("extracts invoice numbers from 'Invoice #00336' subject shape", () => {
    const e = mkEmail({ subject: "Payment reminder for Invoice #00336" });
    const ident = extractIdentifiersFromEmail(e);
    expect(ident.invoiceNumberRaw).toBe("00336");
    expect(ident.invoiceNumberNormalized).toBe("336");
  });

  it("extracts 'Invoice for INV-2025-1029'", () => {
    const e = mkEmail({ subject: "", bodyTextExtract: "Attached: Invoice for INV-2025-1029 · balance $412.00" });
    const ident = extractIdentifiersFromEmail(e);
    expect(ident.invoiceNumberRaw).toBe("INV-2025-1029");
    expect(ident.invoiceNumberNormalized).toBe("inv20251029");
  });

  it("returns null when no invoice number is present", () => {
    const e = mkEmail({ subject: "Thanks for the meeting", bodyTextExtract: "Just following up" });
    const ident = extractIdentifiersFromEmail(e);
    expect(ident.invoiceNumberRaw).toBeNull();
  });

  it("extracts dollar amount from 'balance $1,812.43'", () => {
    const e = mkEmail({ subject: "Invoice #00336", bodyTextExtract: "Amount due: $1,812.43 by Friday." });
    const ident = extractIdentifiersFromEmail(e);
    expect(ident.statedAmountCents).toBe(181243);
  });

  it("returns null amount when no dollar figure is present", () => {
    const e = mkEmail({ subject: "Invoice #00336" });
    const ident = extractIdentifiersFromEmail(e);
    expect(ident.statedAmountCents).toBeNull();
  });

  it("extracts sender domain from senderAddress", () => {
    const e = mkEmail({ senderAddress: "billing@flint-pace.com" });
    const ident = extractIdentifiersFromEmail(e);
    expect(ident.senderDomain).toBe("flint-pace.com");
  });

  it("extracts PO number 'PO#7788' or 'purchase order 7788'", () => {
    const e = mkEmail({ subject: "Invoice #00336 · PO#7788" });
    const ident = extractIdentifiersFromEmail(e);
    expect(ident.purchaseOrderNumber).toBe("7788");
  });
});

describe("normalizeVendorName — corporate suffix / punctuation normalization", () => {
  it("strips 'Inc.', 'LLC', punctuation, and normalizes '&' to 'and'", () => {
    expect(normalizeVendorName("Flint & Pace, Inc.")).toBe("flint and pace");
    expect(normalizeVendorName("ACME Corporation")).toBe("acme");
    expect(normalizeVendorName("Smith Ltd")).toBe("smith");
    expect(normalizeVendorName("SMITH  HOLDINGS  GROUP")).toBe("smith");
  });

  it("preserves single-word vendor names", () => {
    expect(normalizeVendorName("Xerox")).toBe("xerox");
  });
});

// ---------------------------------------------------------------------------
// 2. Analysis composer — grounded output rules
// ---------------------------------------------------------------------------

describe("invoice-analysis composer — grounded output invariants", () => {
  it("declares NO_AP_DATA_ON_CLUB state and surfaces it truthfully", () => {
    expect(ANALYSIS_TS).toMatch(/"NO_AP_DATA_ON_CLUB"/);
    expect(ANALYSIS_TS).toMatch(/No AP data/);
  });

  it("never fabricates a vendor when vendorMatch state is NOT_FOUND", () => {
    // The vendor evidence cell picks its state from vendorMatch.state
    expect(ANALYSIS_TS).toMatch(/state:\s*[\s\S]*?vendorMatch\.state === "MATCHED" \? "found"[\s\S]*?"AMBIGUOUS" \? "ambiguous" : "not_found"/);
  });

  it("never fabricates an invoice number — evidence.state falls to 'not_extracted' when null", () => {
    expect(ANALYSIS_TS).toMatch(/ident\.invoiceNumberRaw \? "extracted" : "not_extracted"/);
  });

  it("skips consumer mailbox domains for domain-match signal", () => {
    expect(ANALYSIS_TS).toMatch(/CONSUMER_MAILBOX_DOMAINS/);
    // Common consumer domains present
    expect(ANALYSIS_TS).toMatch(/"gmail\.com"/);
    expect(ANALYSIS_TS).toMatch(/"outlook\.com"/);
    expect(ANALYSIS_TS).toMatch(/"hotmail\.com"/);
    expect(ANALYSIS_TS).toMatch(/"yahoo\.com"/);
  });

  it("recommendation branches by AP lookup state — dedicated branch per state", () => {
    // Confirm distinct recommendation text for each state
    expect(ANALYSIS_TS).toMatch(/apResult\.state === "NO_AP_DATA_ON_CLUB"/);
    expect(ANALYSIS_TS).toMatch(/apResult\.state === "VENDOR_NOT_FOUND"/);
    expect(ANALYSIS_TS).toMatch(/apResult\.state === "VENDOR_AMBIGUOUS"/);
    expect(ANALYSIS_TS).toMatch(/apResult\.state === "INSUFFICIENT_INFORMATION"/);
    expect(ANALYSIS_TS).toMatch(/apResult\.state === "INVOICE_FOUND"/);
    expect(ANALYSIS_TS).toMatch(/apResult\.state === "POSSIBLE_DUPLICATE"/);
  });

  it("does not offer an active AP-draft action when the AP subledger is empty", () => {
    // The NO_AP_DATA_ON_CLUB branch's ap-draft action has a disabledReason
    const block = ANALYSIS_TS.slice(ANALYSIS_TS.indexOf('debugRule = "invoice_no_ap_data_on_club"'));
    const nextBranch = block.indexOf('} else if');
    const branchOnly = block.slice(0, nextBranch);
    expect(branchOnly).toMatch(/key: "ap-draft"[\s\S]*?disabledReason:/);
  });

  it("does not fabricate GST / GL account / due date in any code path", () => {
    // No hardcoded GST/HST/GL numbers; no fabricated tax / expense
    // account references anywhere in the composer.
    expect(ANALYSIS_TS).not.toMatch(/gst.*=.*[0-9]/i);
    expect(ANALYSIS_TS).not.toMatch(/hst.*=.*[0-9]/i);
    expect(ANALYSIS_TS).not.toMatch(/expenseAccountId.*=.*"/);
    expect(ANALYSIS_TS).not.toMatch(/glAccount/);
  });
});

// ---------------------------------------------------------------------------
// 3. Materializer — conversation grouping + remediation
// ---------------------------------------------------------------------------

describe("materialiseEmailIntoConversation — conversation grouping", () => {
  it("is exported", () => {
    expect(MATERIALIZER_TS).toMatch(/export async function materialiseEmailIntoConversation/);
  });

  it("falls back to upsertEmailIntake when conversationId is null", () => {
    const fn = MATERIALIZER_TS.slice(MATERIALIZER_TS.indexOf("export async function materialiseEmailIntoConversation"));
    expect(fn).toMatch(/if \(!email\.conversationId\)/);
    expect(fn).toMatch(/return await upsertEmailIntake\(/);
  });

  it("groups by (mailboxConnectionId, conversationId) — never by conversationId alone", () => {
    expect(MATERIALIZER_TS).toMatch(
      /mailboxConnection: mailboxVisibilityFilter|mailboxConnectionId,\s*conversationId: email\.conversationId/,
    );
  });

  it("looks up existing intake via ANOTHER email in the same conversation, not this email", () => {
    // The query filters emailMessage.id: { not: email.id } so a rerun
    // against the same email doesn't self-match.
    expect(MATERIALIZER_TS).toMatch(/id:\s*\{\s*not:\s*email\.id\s*\}/);
  });

  it("refreshes display from the newest message in the conversation", () => {
    expect(MATERIALIZER_TS).toMatch(/refreshDisplayFromNewestInConversation/);
    const helper = MATERIALIZER_TS.slice(MATERIALIZER_TS.indexOf("async function refreshDisplayFromNewestInConversation"));
    expect(helper).toMatch(/orderBy:\s*\{\s*receivedAt:\s*"desc"\s*\}/);
    expect(helper).toMatch(/isClassificationLocked/);
  });

  it("throws on cross-club materialisation", () => {
    expect(MATERIALIZER_TS).toMatch(/canonical\.clubId !== clubId/);
  });
});

describe("remediateDuplicateConversationItems — merge canonical policy", () => {
  it("is exported", () => {
    expect(MATERIALIZER_TS).toMatch(/export async function remediateDuplicateConversationItems/);
  });

  it("orders intakes ASC to pick the OLDEST as canonical", () => {
    const fn = MATERIALIZER_TS.slice(MATERIALIZER_TS.indexOf("export async function remediateDuplicateConversationItems"));
    expect(fn).toMatch(/orderBy:\s*\{\s*createdAt:\s*"asc"\s*\}/);
    expect(fn).toMatch(/const canonical = allIntakes\[0\]/);
  });

  it("repoints PRIMARY origins from duplicate to canonical", () => {
    const fn = MATERIALIZER_TS.slice(MATERIALIZER_TS.indexOf("export async function remediateDuplicateConversationItems"));
    expect(fn).toMatch(/prisma\.emailWorkIntakeOrigin\.updateMany\(\{\s*where:\s*\{\s*workIntakeItemId:\s*dup\.id,\s*role:\s*"PRIMARY"\s*\}/);
    expect(fn).toMatch(/data:\s*\{\s*workIntakeItemId:\s*canonical\.id\s*\}/);
  });

  it("marks the duplicate SUPPRESSED, never physically deletes", () => {
    const fn = MATERIALIZER_TS.slice(MATERIALIZER_TS.indexOf("export async function remediateDuplicateConversationItems"));
    expect(fn).toMatch(/status:\s*"SUPPRESSED"/);
    // No delete of the intake
    expect(fn).not.toMatch(/prisma\.workIntakeItem\.delete/);
    // Emits a MERGED_IN activity on canonical
    expect(fn).toMatch(/action:\s*"MERGED_IN"/);
    // Emits a SUPPRESSED activity on the duplicate referencing canonical
    expect(fn).toMatch(/note:\s*`Merged into canonical conversation intake/);
  });
});

// ---------------------------------------------------------------------------
// 4. Loader — synopsis + evidence emitted; NO raw preview
// ---------------------------------------------------------------------------

describe("email-intake loader — Checkpoint 14C", () => {
  it("loads ALL PRIMARY origins, not just one", () => {
    expect(INTAKE_TS).toMatch(/emailOrigins:\s*\{\s*where:\s*\{\s*role:\s*"PRIMARY"\s*\},\s*include:/);
    // The C14B `take: 1` limit is gone
    const includeBlock = INTAKE_TS.slice(INTAKE_TS.indexOf("emailOrigins"));
    expect(includeBlock).not.toMatch(/take:\s*1/);
  });

  it("emits synopsisText + evidence via analyseInvoiceConversation", () => {
    expect(INTAKE_TS).toMatch(/analyseInvoiceConversation/);
    expect(INTAKE_TS).toMatch(/synopsisText:\s*analysis\.synopsis/);
    expect(INTAKE_TS).toMatch(/evidence:\s*analysis\.evidence\.map/);
  });

  it("preserves the merged feed contract (mergeWorkItems unchanged)", () => {
    expect(INTAKE_TS).toMatch(/export function mergeWorkItems\(sources:\s*\{\s*ap:\s*WorkItem\[\];\s*ar:\s*WorkItem\[\];\s*email:\s*WorkItem\[\];\s*\}\)/);
  });

  it("does not emit `work` as raw preview anymore", () => {
    // The mapper no longer sets `work` on the returned WorkItem
    const mapper = INTAKE_TS.slice(INTAKE_TS.indexOf("async function toWorkItem"));
    // No `work: it.displayPreview`
    expect(mapper).not.toMatch(/work:\s*it\.displayPreview/);
  });
});

// ---------------------------------------------------------------------------
// 5. WorkItem type + Mission Control page wiring
// ---------------------------------------------------------------------------

describe("WorkItem type + page wiring — Checkpoint 14C", () => {
  it("declares workIntakeItemId + synopsisText + evidence + conversationMessageCount", () => {
    expect(MC_INDEX_TS).toMatch(/workIntakeItemId\?:\s*string;/);
    expect(MC_INDEX_TS).toMatch(/synopsisText\?:\s*string;/);
    expect(MC_INDEX_TS).toMatch(/evidence\?:\s*WorkItemEvidenceCell\[\];/);
    expect(MC_INDEX_TS).toMatch(/conversationMessageCount\?:\s*number;/);
  });

  it("WorkItemAction carries iconKey + disabledReason + onClickAction", () => {
    expect(MC_INDEX_TS).toMatch(/iconKey\?:\s*"mail"\s*\|\s*"reply"\s*\|\s*"edit"\s*\|/);
    expect(MC_INDEX_TS).toMatch(/disabledReason\?:\s*string;/);
    expect(MC_INDEX_TS).toMatch(/onClickAction\?:\s*"expand-view"\s*\|\s*"expand-reply"/);
  });

  it("Mission Control page no longer passes 'detailHref' to EmailIntakeCard", () => {
    expect(MC_PAGE_TSX).not.toMatch(/detailHref:/);
  });

  it("emailFeedData no longer references item.work / preview", () => {
    // Slice ONLY the emailFeedData function body (not the whole
    // remainder of the file — the legacy FeedItem legitimately
    // renders item.work for AP/AR items).
    const start = MC_PAGE_TSX.indexOf("function emailFeedData");
    const end = MC_PAGE_TSX.indexOf("\n}\n", start);
    const helper = MC_PAGE_TSX.slice(start, end + 3);
    expect(helper).not.toMatch(/preview:/);
    expect(helper).not.toMatch(/item\.work\b/);
  });
});

// ---------------------------------------------------------------------------
// 6. EmailIntakeCard — structured render, no Open detail, icons
// ---------------------------------------------------------------------------

describe("EmailIntakeCard — Checkpoint 14C", () => {
  it("no 'Open detail' action rendered anywhere", () => {
    // Strip comments so a docstring reference to the removed action
    // doesn't false-fail.
    const code = CARD_TSX.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/Open detail/);
    expect(code).not.toMatch(/detailHref/);
    expect(code).not.toMatch(/email-action-detail/);
  });

  it("no navigation exit to /app/user/work-intake/ anywhere in the card code", () => {
    const code = CARD_TSX.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/\/app\/user\/work-intake\//);
  });

  it("renders structured synopsis, not a raw email preview", () => {
    expect(CARD_TSX).toMatch(/data-testid="email-synopsis"/);
    expect(CARD_TSX).toMatch(/\{data\.synopsisText\}/);
    // Preview <p> from C14B is gone
    expect(CARD_TSX).not.toMatch(/data-testid="email-preview"/);
  });

  it("renders the four-cell instrument-panel readout when evidence is present (Variant D §3.6)", () => {
    // Sprint 3 Checkpoint 15I (2026-07-26) — the pre-Variant-D
    // `.spectre-mc-evidence` grid was replaced with the Variant D
    // `.spectre-mc-readout` 4-cell instrument-panel strip.
    expect(CARD_TSX).toMatch(/data-testid="email-readout"/);
    expect(CARD_TSX).toMatch(/data\.evidence\.slice\(0, 4\)\.map/);
    expect(CARD_TSX).not.toMatch(/data-testid="email-evidence"/);
  });

  it("no emoji glyphs anywhere in the card", () => {
    // 15I dropped the crisp-icon-per-action pattern because the
    // collapsed row no longer carries Reply/Edit/Send/Mail buttons
    // (§3.4 removed them; actions live inside the tabs). The
    // emoji-negative assertion stays as a defence-in-depth guard.
    expect(CARD_TSX).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it("card fetches the CONVERSATION thread endpoint (not the C14B single-email endpoint)", () => {
    const fetchBlock = CARD_TSX.slice(CARD_TSX.indexOf("fetch("), CARD_TSX.indexOf(");", CARD_TSX.indexOf("fetch(")) + 2);
    expect(fetchBlock).toMatch(/\/api\/mission-control\/work-intake\//);
    expect(fetchBlock).toMatch(/\/thread/);
    // Never targets the old single-email endpoint
    expect(CARD_TSX).not.toMatch(/\/api\/mission-control\/mail\//);
  });

  it("still renders the unread accent + high-importance badge", () => {
    expect(CARD_TSX).toMatch(/spectre-mc-item--unread/);
    expect(CARD_TSX).toMatch(/data-testid="email-importance-high"/);
  });

  it("shows a 'X messages' badge when conversationMessageCount > 1", () => {
    expect(CARD_TSX).toMatch(/data-testid="email-convo-count"/);
    expect(CARD_TSX).toMatch(/data\.conversationMessageCount > 1/);
  });

  it("card-level Resolve is present (Variant D §4.2 — replaces the old ActionButton row)", () => {
    // 15I dropped the ActionButton sub-component + `disabledReason`
    // tooltip pattern because those actions moved into the tabs.
    // The queue-level Resolve control is what the collapsed card
    // now exposes; the same disabled-during-network pattern applies.
    expect(CARD_TSX).toMatch(/data-testid="card-resolve"/);
    expect(CARD_TSX).toMatch(/disabled=\{resolving\}/);
  });
});

// ---------------------------------------------------------------------------
// 7. InlineConversationPanel — newest-first thread, no Outlook link
// ---------------------------------------------------------------------------

describe("InlineConversationPanel — Checkpoint 14C", () => {
  it("no 'Open in Outlook on the web' link anywhere in the panel code", () => {
    const code = PANEL_TSX.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/Open in Outlook/i);
    expect(code).not.toMatch(/outlook\.office\.com/);
    expect(code).not.toMatch(/inline-email-weblink/);
  });

  it("renders the thread in the order the API returned (newest first — API sorts desc)", () => {
    // The panel iterates messages in index order 0..N-1 and marks
    // index 0 as "Most recent". The API guarantees receivedAt desc.
    expect(PANEL_TSX).toMatch(/openByDefault=\{idx === 0\}/);
    expect(PANEL_TSX).toMatch(/idx === 0[\s\S]*?"Most recent"/);
  });

  it("individual messages are collapsible with an expand/collapse toggle", () => {
    expect(PANEL_TSX).toMatch(/data-testid="inline-thread-toggle"/);
    expect(PANEL_TSX).toMatch(/const \[open, setOpen\] = useState\(openByDefault\)/);
  });

  it("renders sanitized HTML via dangerouslySetInnerHTML, ONLY from msg.bodyHtmlSanitized", () => {
    const matches = PANEL_TSX.match(/dangerouslySetInnerHTML=\{\{[^}]*\}\}/g) || [];
    expect(matches.length).toBe(1);
    expect(matches[0]).toMatch(/__html:\s*msg\.bodyHtmlSanitized/);
  });

  it("falls back to plain-text extract when sanitized HTML is null", () => {
    expect(PANEL_TSX).toMatch(/<pre[\s\S]*?msg\.bodyTextExtract/);
  });

  it("renders soft-delete notice when msg.softDeleted", () => {
    expect(PANEL_TSX).toMatch(/msg\.softDeleted \?/);
    expect(PANEL_TSX).toMatch(/data-testid="inline-thread-softdeleted"/);
  });

  it("no navigation-away action anywhere in the panel", () => {
    // No <a> tags with external hrefs
    expect(PANEL_TSX).not.toMatch(/<a\s+href=/);
  });
});

// ---------------------------------------------------------------------------
// 8. Reply composer — consent state + confirmation gate
// ---------------------------------------------------------------------------

describe("ReplyComposer — Checkpoint 14C consent + confirmation gate", () => {
  it("accepts a consentState prop with three states: granted / missing / unavailable", () => {
    expect(COMPOSER_TSX).toMatch(/state:\s*"granted"\s*\|\s*"missing"\s*\|\s*"unavailable"/);
  });

  it("send button is DISABLED unless consentState.state === 'granted'", () => {
    expect(COMPOSER_TSX).toMatch(/canSend = consentState\.state === "granted"/);
  });

  it("first click on Send opens the confirmation step, NOT the network call", () => {
    // goToConfirm handler flips step to "confirm"; confirmSend performs the fetch
    expect(COMPOSER_TSX).toMatch(/const goToConfirm = useCallback\([\s\S]*?setStep\("confirm"\)/);
    expect(COMPOSER_TSX).toMatch(/const confirmSend = useCallback\([\s\S]*?fetch\(/);
  });

  it("confirmation panel names the sending mailbox + subject boundary", () => {
    const confirmBlock = COMPOSER_TSX.slice(COMPOSER_TSX.indexOf("composer-confirm-panel"));
    expect(confirmBlock).toMatch(/sent from/);
    expect(confirmBlock).toMatch(/subject/);
    expect(confirmBlock).toMatch(/cannot change/);
  });

  it("POSTs to /api/mission-control/work-intake/[id]/reply — never to a Graph endpoint directly", () => {
    expect(COMPOSER_TSX).toMatch(/\/api\/mission-control\/work-intake\/[^`]*\/reply/);
    expect(COMPOSER_TSX).not.toMatch(/graph\.microsoft\.com/);
  });

  it("includes an idempotency-key header on the send", () => {
    expect(COMPOSER_TSX).toMatch(/x-idempotency-key/);
  });

  it("displays a truthful post-send confirmation — 'Reply sent', not fabricated thread update", () => {
    expect(COMPOSER_TSX).toMatch(/Reply sent from/);
    expect(COMPOSER_TSX).toMatch(/thread will update after the next mailbox synchronisation/);
    expect(COMPOSER_TSX).not.toMatch(/successfully sent/i);
    expect(COMPOSER_TSX).not.toMatch(/delivered/i);
  });

  it("does not silently auto-resolve the Work Intake item", () => {
    // No POST to a workflow status endpoint
    expect(COMPOSER_TSX).not.toMatch(/status.*"RESOLVED"/);
  });

  it("no send occurs before consentState === 'granted'", () => {
    // Guard rail — the send button is disabled and the goToConfirm
    // handler returns early when !canSend.
    expect(COMPOSER_TSX).toMatch(/if \(!canSend\) return;/);
  });

  it("body length is bounded client-side (defence in depth over the server cap)", () => {
    expect(COMPOSER_TSX).toMatch(/maxLength=\{20000\}/);
  });
});

// ---------------------------------------------------------------------------
// 9. Thread API safety
// ---------------------------------------------------------------------------

describe("GET /api/mission-control/work-intake/[id]/thread — Checkpoint 14C", () => {
  it("requires a session (401 otherwise)", () => {
    expect(THREAD_ROUTE).toMatch(/if \(!principal\)/);
    expect(THREAD_ROUTE).toMatch(/status: 401/);
  });

  it("tenant scope: WorkIntakeItem must match active club", () => {
    expect(THREAD_ROUTE).toMatch(/prisma\.workIntakeItem\.findFirst\(\{\s*where:\s*\{\s*id:\s*workIntakeItemId,\s*clubId\s*\}/);
  });

  it("mailbox visibility filter enforces PERSONAL-owner-only + SHARED-with-access", () => {
    expect(THREAD_ROUTE).toMatch(/mailboxVisibilityFilter\(\{[\s\S]*?userId: principal\.id/);
    expect(THREAD_ROUTE).toMatch(/mailboxType === "PERSONAL" && conn\.userId !== principal\.id/);
    expect(THREAD_ROUTE).toMatch(/mailboxType === "SHARED"/);
  });

  it("thread orders newest-first (receivedAt desc)", () => {
    expect(THREAD_ROUTE).toMatch(/orderBy:\s*\{\s*receivedAt:\s*"desc"\s*\}/);
  });

  it("soft-deleted messages return metadata but not body content", () => {
    expect(THREAD_ROUTE).toMatch(/isSoftDeleted \? null : m\.bodyHtmlSanitized/);
    expect(THREAD_ROUTE).toMatch(/isSoftDeleted \? null : m\.bodyTextExtract/);
  });

  it("route is read-only: only GET, no POST/PATCH/DELETE", () => {
    expect(THREAD_ROUTE).toMatch(/^export async function GET\(/m);
    expect(THREAD_ROUTE).not.toMatch(/^export async function (POST|PATCH|DELETE|PUT)\(/m);
    expect(THREAD_ROUTE).not.toMatch(/prisma\.emailMessage\.update/);
    expect(THREAD_ROUTE).not.toMatch(/\benqueue\(/);
  });

  it("derives reply-consent state from grantedScopes + APPROVED_DELEGATED_SCOPES", () => {
    expect(THREAD_ROUTE).toMatch(/function deriveReplyConsent/);
    expect(THREAD_ROUTE).toMatch(/APPROVED_DELEGATED_SCOPES/);
    expect(THREAD_ROUTE).toMatch(/state:\s*"granted"|"missing"|"unavailable"/);
  });
});

// ---------------------------------------------------------------------------
// 10. Reply API safety
// ---------------------------------------------------------------------------

describe("POST /api/mission-control/work-intake/[id]/reply — Checkpoint 14C-B", () => {
  it("requires a session (401 otherwise)", () => {
    expect(REPLY_ROUTE).toMatch(/if \(!principal\)/);
    expect(REPLY_ROUTE).toMatch(/status: 401/);
  });

  it("resolves the target message SERVER-SIDE (never from the client body)", () => {
    // The route accepts { body } only. No `graphMessageId` or
    // `recipients` or `mailboxConnectionId` in the parsed payload.
    const parse = REPLY_ROUTE.slice(REPLY_ROUTE.indexOf("await req.json()"), REPLY_ROUTE.indexOf("if (bodyText.length === 0)"));
    expect(parse).toMatch(/typeof payload\?\.body === "string" \? payload\.body : ""/);
    expect(REPLY_ROUTE).not.toMatch(/payload\?\.graphMessageId/);
    expect(REPLY_ROUTE).not.toMatch(/payload\?\.recipients/);
    expect(REPLY_ROUTE).not.toMatch(/payload\?\.mailboxConnectionId/);
    expect(REPLY_ROUTE).not.toMatch(/payload\?\.to\b/);
    expect(REPLY_ROUTE).not.toMatch(/payload\?\.subject/);
  });

  it("target = NEWEST authorised message in the conversation, sorted server-side", () => {
    expect(REPLY_ROUTE).toMatch(/const newestOrigin = \[\.\.\.authorisedOrigins\]\.sort/);
    expect(REPLY_ROUTE).toMatch(/const targetEmail = newestOrigin\.emailMessage/);
  });

  it("fails 403 when the source mailbox has NOT granted Mail.Send", () => {
    expect(REPLY_ROUTE).toMatch(/!grantedScopes\.includes\("Mail\.Send"\)/);
    expect(REPLY_ROUTE).toMatch(/error: "consent_missing"/);
  });

  it("fails 400 for empty or oversized body", () => {
    expect(REPLY_ROUTE).toMatch(/error: "empty_body"/);
    expect(REPLY_ROUTE).toMatch(/error: "body_too_long"/);
    expect(REPLY_ROUTE).toMatch(/MAX_BODY_CHARS/);
  });

  it("fails 404 for soft-deleted source (never leaks existence)", () => {
    expect(REPLY_ROUTE).toMatch(/if \(targetEmail\.softDeletedAt\)/);
    expect(REPLY_ROUTE).toMatch(/status: 404/);
  });

  it("supports x-idempotency-key with 409-on-duplicate", () => {
    expect(REPLY_ROUTE).toMatch(/x-idempotency-key/);
    expect(REPLY_ROUTE).toMatch(/status: 409/);
  });

  it("records a REPLY_SENT audit activity without the body content", () => {
    expect(REPLY_ROUTE).toMatch(/action:\s*"REPLY_SENT"/);
    // Note field does NOT include the body
    const activityBlock = REPLY_ROUTE.slice(REPLY_ROUTE.indexOf('action: "REPLY_SENT"'));
    expect(activityBlock).not.toMatch(/note:.*bodyText/);
  });

  it("does not auto-resolve the Work Intake item", () => {
    expect(REPLY_ROUTE).not.toMatch(/status:\s*"RESOLVED"/);
  });

  it("never fabricates a sent-message EmailMessage row", () => {
    expect(REPLY_ROUTE).not.toMatch(/prisma\.emailMessage\.create/);
  });

  it("terminal insufficient_scope from Graph returns 403 + consent_missing", () => {
    expect(REPLY_ROUTE).toMatch(/insufficient_scope/);
    expect(REPLY_ROUTE).toMatch(/error: "consent_missing"/);
  });

  it("does not log the body text", () => {
    expect(REPLY_ROUTE).not.toMatch(/logger\.[a-z]+\([^)]*body:.*bodyText/);
    // Only bodyLength (an integer) may be logged
    expect(REPLY_ROUTE).toMatch(/bodyLength:\s*bodyText\.length/);
  });
});

// ---------------------------------------------------------------------------
// 11. Delegated provider — Mail.Send scope + replyToMessage
// ---------------------------------------------------------------------------

describe("Delegated provider — Mail.Send + replyToMessage — Checkpoint 14C-B", () => {
  it("APPROVED_DELEGATED_SCOPES includes Mail.Send", () => {
    // Look at only the array literal, not the surrounding docblock —
    // the docblock legitimately mentions Mail.ReadWrite in policy notes.
    const startTag = "export const APPROVED_DELEGATED_SCOPES = [";
    const start = DELEGATED_TS.indexOf(startTag) + startTag.length;
    const end = DELEGATED_TS.indexOf("] as const;", start);
    const arrayLiteral = DELEGATED_TS
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\n)\s*\/\/[^\n]*/g, "");
    expect(arrayLiteral).toContain('"Mail.Read"');
    expect(arrayLiteral).toContain('"Mail.Send"');
    // Mail.ReadWrite must not appear as an approved scope.
    expect(arrayLiteral).not.toMatch(/Mail\.ReadWrite/);
    expect(arrayLiteral).not.toMatch(/Mail\.Send\.Shared/);
  });

  it("replyToMessage uses POST /me/messages/{id}/reply with { comment } — no client overrides", () => {
    // Slice ONLY the replyToMessage function body, stopping at the
    // next method (listInboxMessagesDelta) so we don't spill into
    // listInboxMessagesDelta's $select array (which legitimately
    // includes "toRecipients").
    const start = DELEGATED_TS.indexOf("async replyToMessage(args)");
    const end = DELEGATED_TS.indexOf("async listInboxMessagesDelta", start);
    const method = DELEGATED_TS
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\n)\s*\/\/[^\n]*/g, "");
    expect(method).toMatch(/https:\/\/graph\.microsoft\.com\/v1\.0\/me\/messages\/\$\{encodeURIComponent\(args\.graphMessageId\)\}\/reply/);
    expect(method).toMatch(/method:\s*"POST"/);
    expect(method).toMatch(/JSON\.stringify\(\{ comment: args\.body \}\)/);
    // No client-supplied to/cc/subject in the actual request body.
    expect(method).not.toMatch(/toRecipients/);
    expect(method).not.toMatch(/ccRecipients/);
    expect(method).not.toMatch(/subject:/);
  });

  it("provider rejects empty body + missing graphMessageId", () => {
    const method = DELEGATED_TS.slice(DELEGATED_TS.indexOf("async replyToMessage(args)"));
    expect(method).toMatch(/if \(!args\.graphMessageId\)/);
    expect(method).toMatch(/if \(!args\.body \|\| args\.body\.trim\(\)\.length === 0\)/);
  });

  it("mock provider implements replyToMessage with three failure outcomes for tests", () => {
    expect(MOCK_TS).toMatch(/async replyToMessage\(args:\s*ReplyToMessageArgs\)/);
    expect(MOCK_TS).toMatch(/"TERMINAL_INSUFFICIENT_SCOPE"/);
    expect(MOCK_TS).toMatch(/"TERMINAL_INVALID_GRANT"/);
    expect(MOCK_TS).toMatch(/"RETRYABLE_THROTTLE"/);
  });
});

// ---------------------------------------------------------------------------
// 12. Icon system — additions
// ---------------------------------------------------------------------------

describe("Spectre icon system — Checkpoint 14C additions", () => {
  it("adds IconMail, IconReply, IconEdit, IconClock, IconUserPlus, IconSend", () => {
    for (const name of ["IconMail", "IconReply", "IconEdit", "IconClock", "IconUserPlus", "IconSend"]) {
      expect(ICONS_TSX).toMatch(new RegExp(`export const ${name}\\s*=`));
    }
  });

  it("no emoji glyphs in the icon module", () => {
    expect(ICONS_TSX).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it("icons inherit currentColor via the shared <Icon> stroke", () => {
    expect(ICONS_TSX).toMatch(/stroke="currentColor"/);
  });
});
