// Sprint 2 Checkpoint 13G (2026-07-23) — Delta source-contract tests.
//
// Locks the observable behaviour of:
//   - effectiveDeltaSyncMessageCap (controlled-sync helper)
//   - runDeltaSyncForConnection (delta-sync module)
//   - MAILBOX_DELTA_SYNC handler + manifest flip (queue handlers)
//
// Follows the existing pattern from
// tests/mailbox-controlled-sync-controls.test.ts and
// tests/mailbox-refresh-diagnostic.test.ts: read the compiled TS
// files and assert the source shape. This locks the API and
// prevents accidental regressions without needing a real Prisma
// or Microsoft in the loop.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SYNC_SCOPE } from "@/lib/mailbox/sync-scope";

const CONTROLLED_TS = readFileSync(path.resolve(__dirname, "../src/lib/mailbox/controlled-sync.ts"), "utf8");
const DELTA_TS = readFileSync(path.resolve(__dirname, "../src/lib/mailbox/delta-sync.ts"), "utf8");
const HANDLERS_TS = readFileSync(path.resolve(__dirname, "../src/lib/queue/handlers.ts"), "utf8");

// ---------------------------------------------------------------------------
// 1. effectiveDeltaSyncMessageCap
// ---------------------------------------------------------------------------

describe("effectiveDeltaSyncMessageCap — Checkpoint 13G", () => {
  it("is exported from controlled-sync.ts", () => {
    expect(CONTROLLED_TS).toMatch(/export function effectiveDeltaSyncMessageCap\(\)/);
  });

  it("returns SYNC_SCOPE.messageCap when controlled mode is off", () => {
    const helper = CONTROLLED_TS.slice(CONTROLLED_TS.indexOf("effectiveDeltaSyncMessageCap"));
    expect(helper).toMatch(/return SYNC_SCOPE\.messageCap;/);
  });

  it("returns Math.min(override, SYNC_SCOPE.messageCap) when controlled mode is on with override", () => {
    const helper = CONTROLLED_TS.slice(CONTROLLED_TS.indexOf("effectiveDeltaSyncMessageCap"));
    expect(helper).toMatch(/return Math\.min\(override,\s*SYNC_SCOPE\.messageCap\);/);
  });

  it("gates the override lookup on controlled-mode-active + numeric + positive", () => {
    const helper = CONTROLLED_TS.slice(CONTROLLED_TS.indexOf("effectiveDeltaSyncMessageCap"));
    expect(helper).toMatch(
      /isControlledSyncModeActive\(\)\s*&&\s*typeof override === "number"\s*&&\s*override > 0/,
    );
  });

  it("reuses MAILBOX_SYNC_MAX_MESSAGES_OVERRIDE (no delta-specific env)", () => {
    const helper = CONTROLLED_TS.slice(CONTROLLED_TS.indexOf("effectiveDeltaSyncMessageCap"));
    expect(helper).toMatch(/env\.MAILBOX_SYNC_MAX_MESSAGES_OVERRIDE/);
    // And no ONE_PAGE_ONLY env was introduced anywhere in this file
    expect(CONTROLLED_TS).not.toMatch(/DELTA_ONE_PAGE_ONLY/);
  });

  it("cap arithmetic — cap=10 override clamps under 500 SYNC_SCOPE production cap", () => {
    expect(Math.min(10, SYNC_SCOPE.messageCap)).toBe(10);
    expect(Math.min(999, SYNC_SCOPE.messageCap)).toBe(SYNC_SCOPE.messageCap);
  });
});

// ---------------------------------------------------------------------------
// 2. Handler registration + manifest
// ---------------------------------------------------------------------------

describe("MAILBOX_DELTA_SYNC handler wiring — Checkpoint 13G", () => {
  it("registers a MAILBOX_DELTA_SYNC handler that dispatches to runDeltaSyncForConnection", () => {
    expect(HANDLERS_TS).toMatch(
      /registerHandler<\{\s*mailboxConnectionId:\s*string\s*\}>\("MAILBOX_DELTA_SYNC"/,
    );
    expect(HANDLERS_TS).toMatch(/runDeltaSyncForConnection\(/);
    expect(HANDLERS_TS).toMatch(/await import\("\.\.\/mailbox\/delta-sync"\)/);
  });

  it("handler validates the payload has a non-empty mailboxConnectionId string", () => {
    const handler = HANDLERS_TS.slice(HANDLERS_TS.indexOf('"MAILBOX_DELTA_SYNC"'));
    expect(handler).toMatch(/if \(typeof rawId !== "string" \|\| rawId\.length === 0\)/);
    expect(handler).toMatch(/throw new Error\("MAILBOX_DELTA_SYNC payload missing mailboxConnectionId"\)/);
  });

  it("removes both implemented mailbox handlers from the NOT_IMPLEMENTED loop", () => {
    // 2026-07-25 — updated to reflect that MAILBOX_ATTACHMENT_FETCH
    // was implemented in Sprint 3 Checkpoint 15D (real R2 attachment
    // ingest). Both MAILBOX_DELTA_SYNC and MAILBOX_ATTACHMENT_FETCH
    // now have registered handlers and must NOT appear in the
    // NOT_IMPLEMENTED placeholder loop. RENEW_SUBSCRIPTION and
    // RECONCILIATION_HEARTBEAT remain reserved for Phase C.
    const anchor = HANDLERS_TS.indexOf("MAILBOX_RENEW_SUBSCRIPTION");
    expect(anchor).toBeGreaterThan(-1);
    const loopStart = HANDLERS_TS.lastIndexOf("for (const kind of [", anchor);
    expect(loopStart).toBeGreaterThan(-1);
    const loop = HANDLERS_TS.slice(loopStart);
    const arrayMatch = loop.match(/for \(const kind of \[([\s\S]*?)\] as const\) \{/);
    expect(arrayMatch).toBeTruthy();
    const array = arrayMatch![1]!;
    expect(array).not.toMatch(/MAILBOX_DELTA_SYNC/);
    expect(array).not.toMatch(/MAILBOX_ATTACHMENT_FETCH/);
    // The remaining Phase-C reserved handlers must still be there.
    expect(array).toMatch(/MAILBOX_RENEW_SUBSCRIPTION/);
    expect(array).toMatch(/MAILBOX_RECONCILIATION_HEARTBEAT/);
  });

  it("manifest marks both implemented handlers IMPLEMENTED; others remain RESERVED", () => {
    // 2026-07-25 — MAILBOX_ATTACHMENT_FETCH is IMPLEMENTED as of
    // Sprint 3 Checkpoint 15D. The manifest is the source of truth
    // for handler state; this test locks the current shape so future
    // reserved→implemented promotions are visible in review.
    const manifest = HANDLERS_TS.slice(HANDLERS_TS.indexOf("MAILBOX_JOB_IMPLEMENTATION"));
    expect(manifest).toMatch(/MAILBOX_INITIAL_SYNC:\s*"IMPLEMENTED"/);
    expect(manifest).toMatch(/MAILBOX_DELTA_SYNC:\s*"IMPLEMENTED"/);
    expect(manifest).toMatch(/MAILBOX_ATTACHMENT_FETCH:\s*"IMPLEMENTED"/);
    expect(manifest).toMatch(/MAILBOX_RENEW_SUBSCRIPTION:\s*"RESERVED_PHASE_C"/);
    expect(manifest).toMatch(/MAILBOX_RECONCILIATION_HEARTBEAT:\s*"RESERVED_PHASE_C"/);
  });
});

// ---------------------------------------------------------------------------
// 3. Delta runner — bounding + pagination + cap enforcement
// ---------------------------------------------------------------------------

describe("runDeltaSyncForConnection — bounding + pagination (Checkpoint 13G)", () => {
  it("uses effectiveDeltaSyncMessageCap (not effectiveInitialSyncMessageCap) to set the cap", () => {
    expect(DELTA_TS).toMatch(/const effectiveCap = effectiveDeltaSyncMessageCap\(\)/);
    // Explicitly not the initial-sync cap
    expect(DELTA_TS).not.toMatch(/effectiveInitialSyncMessageCap/);
  });

  it("outer while-loop terminates when messagesExamined reaches the effective cap", () => {
    expect(DELTA_TS).toMatch(/while \(result\.messagesExamined < effectiveCap\)/);
  });

  it("bounds requested pageSize by remaining capacity (prevents overshoot)", () => {
    expect(DELTA_TS).toMatch(/const remainingCapacity = Math\.max\(1,\s*effectiveCap - result\.messagesExamined\)/);
    expect(DELTA_TS).toMatch(/const requestedPageSize = Math\.min\(SYNC_SCOPE\.pageSize,\s*remainingCapacity\)/);
    expect(DELTA_TS).toMatch(/pageSize:\s*requestedPageSize/);
  });

  it("inner-loop cap is on (imported + updated), not just imported", () => {
    expect(DELTA_TS).toMatch(/importedThisRun \+ updatedThisRun >= effectiveCap/);
  });

  it("passes continuationUrl through to the provider (not reconstructed)", () => {
    expect(DELTA_TS).toMatch(/continuationUrl/);
    expect(DELTA_TS).toMatch(/provider\.listInboxMessagesDelta\(/);
  });

  it("uses the shared ingestOneMessage from ./sync — no second email mapper", () => {
    expect(DELTA_TS).toMatch(/import \{ ingestOneMessage, finaliseSyncRun \} from "\.\/sync"/);
    // The delta runner uses only these two symbols from sync.ts
    const allSyncImports = DELTA_TS.match(/from "\.\/sync"/g) || [];
    expect(allSyncImports.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Delta runner — cursor lifecycle + partial enumeration
// ---------------------------------------------------------------------------

describe("runDeltaSyncForConnection — cursor lifecycle (Checkpoint 13G)", () => {
  it("starts with continuationUrl = prior stored cursor (null on first run)", () => {
    expect(DELTA_TS).toMatch(/const priorCursor = conn\.deltaLink;/);
    expect(DELTA_TS).toMatch(/let continuationUrl: string \| null = priorCursor;/);
  });

  it("stores a new terminal deltaLink only when page.deltaLink is present", () => {
    expect(DELTA_TS).toMatch(/if \(page\.deltaLink\)/);
    expect(DELTA_TS).toMatch(/newTerminalDeltaLink = page\.deltaLink/);
    expect(DELTA_TS).toMatch(/result\.terminalCursorReceived = true/);
  });

  it("never stores an intermediate nextLink as the deltaLink", () => {
    // Stabilization (2026-08-19): the cursor-advance predicate is
    // `shouldAdvanceCursor` in the WIP-authoritative rev-13
    // implementation (was `isTerminalSuccess` in the pre-WIP branch).
    // The invariant tested is unchanged: the persistence write for
    // the cursor-advance path uses `newTerminalDeltaLink`, which is
    // only ever set from `page.deltaLink` (never from nextPageToken).
    const successBlock = DELTA_TS.slice(DELTA_TS.indexOf("if (shouldAdvanceCursor)"));
    expect(successBlock).toMatch(/deltaLink:\s*newTerminalDeltaLink/);
  });

  it("BOUNDED_PARTIAL outcome fires when cap is reached without terminal deltaLink", () => {
    expect(DELTA_TS).toMatch(
      /const hitCapWithoutTerminal = !result\.terminalCursorReceived && result\.messagesExamined >= effectiveCap;/,
    );
    expect(DELTA_TS).toMatch(/result\.outcome = "BOUNDED_PARTIAL";/);
  });

  it("BOUNDED_PARTIAL persistence path does NOT touch deltaLink (preserves prior cursor)", () => {
    // Stabilization (2026-08-19): the "hit cap mid-page" branch is
    // the else of `if (shouldAdvanceCursor)`. This assertion no
    // longer requires a specific comment string; the invariant is
    // that the else branch's mailboxConnection.update payload does
    // NOT include a `deltaLink:` write.
    const successIdx = DELTA_TS.indexOf("if (shouldAdvanceCursor)");
    const elseIdx = DELTA_TS.indexOf("} else {", successIdx);
    const outerCatchIdx = DELTA_TS.indexOf("} catch (err)", elseIdx);
    const partialBlock = DELTA_TS.slice(elseIdx, outerCatchIdx);
    const updateStart = partialBlock.indexOf("data: {");
    // The payload ends at the closing `}` at that indentation depth;
    // for the current shape a simple sequential-brace scan is enough.
    const updateEnd = partialBlock.indexOf("},", updateStart);
    const updateBody = partialBlock.slice(updateStart, updateEnd);
    const withoutComments = updateBody.replace(/\/\/[^\n]*/g, "");
    expect(withoutComments).not.toMatch(/deltaLink\s*:/);
  });

  it("lastSuccessfulSyncAt is only set on the cursor-advance branch (not on BOUNDED_PARTIAL)", () => {
    // Stabilization (2026-08-19): renamed predicate from
    // `isTerminalSuccess` → `shouldAdvanceCursor`. Same invariant.
    const successIdx = DELTA_TS.indexOf("if (shouldAdvanceCursor)");
    const elseIdx = DELTA_TS.indexOf("} else {", successIdx);
    const successBlock = DELTA_TS.slice(successIdx, elseIdx);
    expect(successBlock).toMatch(/lastSuccessfulSyncAt:\s*new Date\(\)/);
  });

  it("does not transition to CONNECTED on BOUNDED_PARTIAL (status stays as-is)", () => {
    const successIdx = DELTA_TS.indexOf("if (shouldAdvanceCursor)");
    const elseIdx = DELTA_TS.indexOf("} else {", successIdx);
    const outerCatchIdx = DELTA_TS.indexOf("} catch (err)", elseIdx);
    const successBlock = DELTA_TS.slice(successIdx, elseIdx);
    expect(successBlock).toMatch(/status:/);
    const partialBlock = DELTA_TS.slice(elseIdx, outerCatchIdx);
    expect(partialBlock).not.toMatch(/MAILBOX_STATUS\.CONNECTED/);
  });
});

// ---------------------------------------------------------------------------
// 5. Delta runner — feature gate + connection preconditions
// ---------------------------------------------------------------------------

describe("runDeltaSyncForConnection — feature gate + preconditions (Checkpoint 13G)", () => {
  it("refuses execution when mailbox integration is disabled", () => {
    expect(DELTA_TS).toMatch(/if \(!isMailboxIntegrationEnabled\(\)\)/);
    expect(DELTA_TS).toMatch(/result\.errorCode = MAILBOX_ERROR_CODE\.FEATURE_DISABLED/);
  });

  it("returns SKIPPED for missing connection", () => {
    expect(DELTA_TS).toMatch(/MAILBOX_ERROR_CODE\.CONNECTION_NOT_FOUND/);
  });

  it("returns SKIPPED for terminal statuses (REAUTH_REQUIRED, DISCONNECTED)", () => {
    expect(DELTA_TS).toMatch(/if \(isTerminalStatus\(conn\.status\)\)/);
  });

  it("requires the connection status be operationally connected (CONNECTED / DELAYED / PENDING_SYNC)", () => {
    expect(DELTA_TS).toMatch(/conn\.status !== MAILBOX_STATUS\.CONNECTED &&/);
    expect(DELTA_TS).toMatch(/conn\.status !== MAILBOX_STATUS\.DELAYED &&/);
    expect(DELTA_TS).toMatch(/conn\.status !== MAILBOX_STATUS\.CONNECTED_PENDING_SYNC/);
  });
});

// ---------------------------------------------------------------------------
// 6. Delta runner — isolation controls
// ---------------------------------------------------------------------------

describe("runDeltaSyncForConnection — isolation controls (Checkpoint 13G)", () => {
  it("reads shouldSkipMaterialization + shouldSkipAttachmentMetadata from controlled-sync helpers", () => {
    expect(DELTA_TS).toMatch(/const skipMaterialization = shouldSkipMaterialization\(\)/);
    expect(DELTA_TS).toMatch(/const skipAttachmentMetadata = shouldSkipAttachmentMetadata\(\)/);
  });

  it("passes both skip flags into ingestOneMessage", () => {
    expect(DELTA_TS).toMatch(/skipAttachmentMetadata,/);
    expect(DELTA_TS).toMatch(/skipMaterialization,/);
    expect(DELTA_TS).toMatch(/ingestOneMessage\(\{/);
  });

  it("never calls enqueue() — no self-scheduling, no follow-on job", () => {
    // Founder §"No recurring behavior": add a source-level test proving
    // the delta implementation contains no call to the queue enqueue() function.
    expect(DELTA_TS).not.toMatch(/\benqueue\(/);
    // Also no import of enqueue from anywhere
    expect(DELTA_TS).not.toMatch(/import \{[^}]*enqueue[^}]*\}/);
    expect(DELTA_TS).not.toMatch(/from "@\/lib\/queue"/);
  });

  it("never creates a Graph subscription", () => {
    expect(DELTA_TS).not.toMatch(/graphSubscription/);
    expect(DELTA_TS).not.toMatch(/\/subscriptions/);
  });

  it("never uses setInterval, setTimeout for recurring polls, or cron patterns", () => {
    expect(DELTA_TS).not.toMatch(/setInterval\(/);
    expect(DELTA_TS).not.toMatch(/setTimeout\(/);
    expect(DELTA_TS).not.toMatch(/cron/i);
  });

  it("does not call the /attachments endpoint directly (attachment fetches only happen inside ingestOneMessage when unskipped)", () => {
    // The delta runner itself must not hit /attachments; that flow lives
    // in ingestOneMessage, gated by skipAttachmentMetadata.
    expect(DELTA_TS).not.toMatch(/listAttachmentMetadata/);
    expect(DELTA_TS).not.toMatch(/attachments/i);
  });

  it("does not invoke classifyEmail or upsertEmailIntake directly (materialization only happens inside ingestOneMessage when unskipped)", () => {
    expect(DELTA_TS).not.toMatch(/classifyEmail/);
    expect(DELTA_TS).not.toMatch(/upsertEmailIntake/);
  });
});

// ---------------------------------------------------------------------------
// 7. Delta runner — tombstone handling
// ---------------------------------------------------------------------------

describe("runDeltaSyncForConnection — tombstones (Checkpoint 13G)", () => {
  it("delegates tombstone handling to the shared ingestOneMessage soft-delete path", () => {
    // The delta runner detects raw.removed to count softDeletedThisRun,
    // but the actual softDeletedAt write lives in ingestOneMessage in
    // sync.ts (which the runner imports and calls).
    expect(DELTA_TS).toMatch(/const wasTombstone = !!raw\.removed/);
    expect(DELTA_TS).toMatch(/if \(wasTombstone\) softDeletedThisRun \+= 1/);
    // No direct softDeletedAt write in delta-sync.ts — proves reuse
    expect(DELTA_TS).not.toMatch(/softDeletedAt/);
  });

  it("counts messagesSoftDeleted regardless of whether the row existed", () => {
    // The wasTombstone counter increments BEFORE inspecting ingestOneMessage's
    // return value, so a tombstone-of-unknown-message still counts as
    // one tombstone seen from Graph (even though no row was updated).
    const inner = DELTA_TS.slice(DELTA_TS.indexOf("for (const raw of page.messages)"));
    const wasTombstoneIdx = inner.indexOf("const wasTombstone = !!raw.removed");
    const ingestIdx = inner.indexOf("await ingestOneMessage(");
    const counterIdx = inner.indexOf("if (wasTombstone) softDeletedThisRun += 1");
    expect(wasTombstoneIdx).toBeGreaterThan(-1);
    expect(ingestIdx).toBeGreaterThan(-1);
    expect(counterIdx).toBeGreaterThan(-1);
    expect(wasTombstoneIdx).toBeLessThan(ingestIdx);
    // counter is set only when ingestOneMessage returned successfully —
    // this is intentional: a tombstone that throws counts as failed,
    // not as soft-deleted.
    expect(counterIdx).toBeGreaterThan(ingestIdx);
  });
});

// ---------------------------------------------------------------------------
// 8. Delta runner — error handling + status transitions
// ---------------------------------------------------------------------------

describe("runDeltaSyncForConnection — error handling (Checkpoint 13G)", () => {
  it("catches thrown errors and classifies them via classifyMsalError", () => {
    expect(DELTA_TS).toMatch(/const classification = classifyMsalError\(err\);/);
  });

  it("terminal errors transition status to REAUTH_REQUIRED", () => {
    expect(DELTA_TS).toMatch(/classification === "terminal"\s*\?\s*MAILBOX_STATUS\.REAUTH_REQUIRED/);
  });

  it("retryable errors transition CONNECTED → DELAYED (preserving DISCONNECTED/PENDING)", () => {
    expect(DELTA_TS).toMatch(
      /conn\.status === MAILBOX_STATUS\.CONNECTED\s*\?\s*MAILBOX_STATUS\.DELAYED/,
    );
  });

  it("terminal auth error emits a REAUTH_REQUIRED audit event", () => {
    expect(DELTA_TS).toMatch(/auditMailboxEvent\(MAILBOX_AUDIT_ACTION\.REAUTH_REQUIRED,/);
    expect(DELTA_TS).toMatch(/errorCode:\s*MAILBOX_ERROR_CODE\.REFRESH_TERMINAL/);
  });

  it("retryable error preserves the existing cursor (no deltaLink write in error path)", () => {
    // Stabilization (2026-08-19): the OUTER catch(err) block is the
    // one that owns the error-path update. The first `} catch (err)`
    // in the file is the INNER per-message-error catch (which
    // legitimately does NOT touch the connection at all). Scope the
    // slice to the outer catch by anchoring on the last `} catch (err)`
    // before end-of-function.
    const lastCatchIdx = DELTA_TS.lastIndexOf("} catch (err)");
    // The outer catch's terminal `return result;` is the LAST one in
    // the file (final `return result;` inside the error branch).
    const returnIdx = DELTA_TS.indexOf("return result;", lastCatchIdx);
    const catchBlock = DELTA_TS.slice(lastCatchIdx, returnIdx);
    // Isolate ONLY the mailboxConnection.update payload — not the
    // surrounding logger / audit / finaliseSyncRun calls.
    const updateIdx = catchBlock.indexOf("mailboxConnection.update");
    expect(updateIdx).toBeGreaterThan(-1);
    const updateBodyStart = catchBlock.indexOf("data: {", updateIdx);
    const updateBodyEnd = catchBlock.indexOf("},", updateBodyStart);
    const updateBody = catchBlock.slice(updateBodyStart, updateBodyEnd);
    expect(updateBody).not.toMatch(/deltaLink/);
  });

  it("error path finalises the sync run with a non-COMPLETED status + failureCategory", () => {
    const catchBlock = DELTA_TS.slice(
      DELTA_TS.indexOf("} catch (err)"),
      DELTA_TS.indexOf("return result;", DELTA_TS.indexOf("} catch (err)")),
    );
    expect(catchBlock).toMatch(/finaliseSyncRun\(/);
    expect(catchBlock).toMatch(/status:\s*classification === "terminal" \? "TERMINAL" : "DELAYED"/);
    expect(catchBlock).toMatch(/failureCategory:/);
  });
});

// ---------------------------------------------------------------------------
// 9. Delta runner — safe logging (no secrets, no cursor URLs, no bodies)
// ---------------------------------------------------------------------------

describe("runDeltaSyncForConnection — safe logging (Checkpoint 13G)", () => {
  it("emits mailbox.delta.start and mailbox.delta.complete structured events", () => {
    expect(DELTA_TS).toMatch(/logger\.info\("mailbox\.delta\.start"/);
    expect(DELTA_TS).toMatch(/logger\.info\("mailbox\.delta\.complete"/);
    expect(DELTA_TS).toMatch(/logger\.warn\("mailbox\.delta\.error"/);
  });

  it("does not log the access token, refresh token, or Authorization header", () => {
    // No log payload references the raw token variable
    expect(DELTA_TS).not.toMatch(/accessToken:\s*accessToken\b/);
    expect(DELTA_TS).not.toMatch(/refreshToken:\s*refreshToken\b/);
    expect(DELTA_TS).not.toMatch(/Authorization:/i);
  });

  it("does not log the continuationUrl / deltaLink values (only boolean presence flags)", () => {
    // A log event that carried the cursor URL directly would count as
    // leaking the cursor into logs. The start event only carries
    // `hadPriorCursor: !!priorCursor`.
    expect(DELTA_TS).toMatch(/hadPriorCursor:\s*!!priorCursor/);
    // No `deltaLink: newTerminalDeltaLink` in any logger call
    expect(DELTA_TS).not.toMatch(/logger\.[a-z]+\([^)]*deltaLink:/);
    expect(DELTA_TS).not.toMatch(/logger\.[a-z]+\([^)]*continuationUrl:/);
  });

  it("does not log message body content (bodyHtml / bodyText / preview / subject)", () => {
    expect(DELTA_TS).not.toMatch(/logger\.[a-z]+\([^)]*bodyHtml/);
    expect(DELTA_TS).not.toMatch(/logger\.[a-z]+\([^)]*bodyText/);
    expect(DELTA_TS).not.toMatch(/logger\.[a-z]+\([^)]*preview:/);
    expect(DELTA_TS).not.toMatch(/logger\.[a-z]+\([^)]*subject:/);
  });
});

// ---------------------------------------------------------------------------
// 10. Delta runner — MailboxSyncRun record + triggerKind distinguishability
// ---------------------------------------------------------------------------

describe("runDeltaSyncForConnection — MailboxSyncRun record (Checkpoint 13G)", () => {
  it("creates a MailboxSyncRun with triggerKind DELTA (distinguishable from initial-sync SYNC_NOW)", () => {
    expect(DELTA_TS).toMatch(/triggerKind:\s*args\.triggerKind \?\? "DELTA"/);
  });

  it("finalises the run via the shared finaliseSyncRun helper", () => {
    expect(DELTA_TS).toMatch(/await finaliseSyncRun\(syncRun\.id,/);
  });

  it("surfaces per-run counters that have no dedicated column (pagesRequested, terminalCursorReceived) in the handler result — NOT via schema migration", () => {
    // The DeltaSyncResult interface exposes these fields
    expect(DELTA_TS).toMatch(/pagesRequested:\s*number/);
    expect(DELTA_TS).toMatch(/terminalCursorReceived:\s*boolean/);
    // These are logged and returned, not written to a new column
    const completeLog = DELTA_TS.slice(DELTA_TS.indexOf("mailbox.delta.complete"));
    expect(completeLog).toMatch(/pagesRequested/);
    expect(completeLog).toMatch(/terminalCursorReceived/);
  });

  it("BOUNDED_PARTIAL outcome maps to PARTIAL sync-run status", () => {
    expect(DELTA_TS).toMatch(/result\.outcome === "BOUNDED_PARTIAL"\s*\?\s*"PARTIAL"/);
  });

  it("controlled-mode intake counters are zero (skipMaterialization forces intake=0)", () => {
    // The success finaliseSyncRun call surfaces intakeCreatedInformational as 0
    // because delta processing does not distinguish informational vs actionable
    // at this checkpoint (materialization is skipped in controlled mode).
    expect(DELTA_TS).toMatch(/intakeCreatedInformational:\s*0,/);
  });
});
