// Sprint 3 · Post-16H Phase 4 Slice 2 (2026-08-06) — canonical
// replay endpoint. Used by the authenticated Playwright
// feature-acceptance suite to exercise the deployed extraction
// pipeline in-browser without requiring a real invoice ingest
// (per founder §11: "without asking the founder to submit
// another invoice").
//
// Semantics:
//   * Accepts { text, emailSenderAddress? } as JSON.
//   * Runs the PRODUCTION parseInvoiceText — no fixture-specific
//     branches, no test-only paths — so a passing assertion here
//     proves the deployed image runs the current Slice 2 code.
//   * Returns the full ParseResult, INCLUDING the canonical
//     evidence + selection surfaces, so acceptance specs can
//     assert provenance + rejected alternates.
//
// Security posture:
//   * Requires an authenticated principal (any session).
//   * Requires ap:invoice:view permission — same permission gate
//     that guards the founder's AP surfaces.
//   * Payload is capped at 32 KB — this is a diagnostic surface
//     for benchmark-shaped documents, NOT a bulk ingest.
//   * No side effects: no DB writes, no queue enqueue, no OCR
//     provider calls. Runs entirely in the caller's request
//     lifecycle.
//
// The endpoint intentionally does NOT run vendor resolution or
// GL ranking — those depend on tenant state (vendors, chart of
// accounts) that the caller would need to seed. Slice 3 may add
// a `resolveAgainstTenant: true` mode that exercises those.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { parseInvoiceText } from "@/lib/ap-intelligence/parse-invoice";

const bodySchema = z.object({
  text: z.string().min(1).max(32_000),
  emailSenderAddress: z.string().email().optional().nullable(),
  emailSubject: z.string().max(1024).optional().nullable(),
});

export async function POST(req: Request) {
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ ok: false, error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) {
    return NextResponse.json({ ok: false, error: "NO_CLUB" }, { status: 400 });
  }
  if (!hasPermission(principal, clubId, "ap:invoice:view")) {
    return NextResponse.json({ ok: false, error: "PERMISSION" }, { status: 403 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "VALIDATION", detail: parsed.error.issues }, { status: 400 });
  }
  try {
    const result = parseInvoiceText({
      extractedText: parsed.data.text,
      emailSenderAddress: parsed.data.emailSenderAddress ?? null,
      emailSubject: parsed.data.emailSubject ?? null,
    });
    // Return a compact, JSON-safe projection. Canonical evidence +
    // selection surfaces are included so feature-acceptance tests
    // can assert provenance.
    return NextResponse.json({
      ok: true,
      invoice: result.invoice,
      supplier: {
        value: result.supplier.value,
        confidence: result.supplier.confidence,
        source: result.supplier.source,
        reasoningCode: result.supplier.reasoningCode,
      },
      selection: result.selection
        ? {
            supplier: pick(result.selection.supplier),
            payableReference: {
              ...pick(result.selection.payableReference),
              type: result.selection.payableReference.type,
            },
            invoiceDate: pick(result.selection.invoiceDate),
            dueDate: pick(result.selection.dueDate),
            currency: pick(result.selection.currency),
            subtotal: pick(result.selection.subtotal),
            tax: pick(result.selection.tax),
            total: pick(result.selection.total),
            amountReconciliation: result.selection.amountReconciliation,
          }
        : null,
      evidenceConflicts: result.canonicalEvidence?.evidenceConflicts ?? [],
      hintsCount: result.hints.length,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "PARSE_FAILED", detail: err instanceof Error ? err.message : "unknown" },
      { status: 500 },
    );
  }
}

function pick<T>(sel: { value: T | null; confidence: number | null; strategy: string | null; ruleKey: string | null }) {
  return {
    value: sel.value,
    confidence: sel.confidence,
    strategy: sel.strategy,
    ruleKey: sel.ruleKey,
  };
}
