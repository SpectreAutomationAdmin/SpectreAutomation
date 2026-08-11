// Phase 4R architectural refactor · Phase 1 TDD suite (2026-08-11).
//
// FOUNDER §1 ARCHITECTURAL LAW (post-refactor invariant):
//
//     analysis.gl.accountNumber === analysis.gl.candidates[0].accountNumber
//
// The winner must be at candidates[0] because the CANONICAL RANKER
// determined it was the strongest classification — not because a
// downstream override wrote a different account into `gl.accountNumber`
// after ranking without touching `gl.candidates`.
//
// This suite is INTENTIONALLY RED against the current v206 architecture
// where 10+ post-ranking mutation sites in analyse.ts can rewrite
// `gl.accountNumber` without rebuilding `gl.candidates` (see §Root-
// cause architecture map in the prior stop-condition report).
//
// It goes GREEN after Phases 2-5 consolidate the two ranking pipelines
// (`rankAccountsPure` + `rankPurposeDrivenAccounts`) into one canonical
// ranker and remove the post-ranking override capability.
//
// FOUNDER §4 - RED FOR THE RIGHT REASON:
// Each failure is CATEGORIZED by the architectural failure mode it
// exposes, not just "17 tests failed". The suite reports one of:
//   - WINNER_REPLACED_AFTER_RANKING — override site fired; winner
//     rewritten; candidates untouched. This is the primary defect
//     from analyse.ts:1583 (purpose_driven_full_coa_search) and
//     lines 1446, 1472, 2006, 2149, 2221, 2342, 2360, 2419.
//   - WINNER_ABSENT_FROM_CANDIDATES — winner accountNumber does
//     not appear anywhere in candidates[].
//   - CANDIDATES_RECONSTRUCTED_INDEPENDENTLY — candidates array
//     came from a different scoring source than the winner.
//   - INVARIANT_HOLDS — this scenario ALREADY satisfies the
//     invariant under v206. Not every scenario must fail; the
//     suite proves the architecture DOES NOT GUARANTEE the
//     invariant.
//   - ABSTAINED — winner is null; invariant vacuously holds
//     (§9 abstention is legitimate as long as it doesn't secretly
//     select another account).
//
// FOUNDER §5 - test the behaviour, not a quota. The 17 scenario keys
// below cover the required accounting shapes (§3) but the assertion
// posture is structural: "how does Spectre reach and explain this
// decision?" not "which account number should Spectre have picked?".

import { beforeAll, describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { analyseIngestedInvoice } from "@/lib/ap-intelligence/analyse";
import { ingestAttachment } from "@/lib/documents/ingest";
import { memoryDocumentStorageAdapter, _resetMemoryDocumentStorage_TEST_ONLY } from "@/lib/documents/storage";

// -----------------------------------------------------------------------------
// Hermetic fixture — one Club + a broad neutral COA + document ingest
// helper (memory storage), reusable across scenarios. Modelled on
// tests/ap-intelligence-integration.test.ts.
//
// Neutral COA is deliberate: it contains semantically-adjacent
// alternatives (Membership vs Subscriptions; IT vs Telecom; Equipment
// vs CIP; R&M subcategories) so genuine ambiguity CAN emerge from
// correct evidence AND semantic accidents CAN'T sneak through.
// -----------------------------------------------------------------------------

const suiteToken = "phase4r-single-auth-" + Math.random().toString(36).slice(2, 8);
let CLUB: string;

const NEUTRAL_COA: Array<{
  number: string; name: string;
  type: "EXPENSE" | "ASSET";
  categoryKey?: string; fsGroupKey?: string;
}> = [
  { number: "1500", name: "Equipment & Fixtures", type: "ASSET", categoryKey: "CAPITAL_ASSETS", fsGroupKey: "IS_FIXED_ASSETS" },
  { number: "1502", name: "Construction in Progress", type: "ASSET", categoryKey: "CAPITAL_ASSETS", fsGroupKey: "IS_CIP" },
  { number: "1540", name: "Equipment & Vehicles", type: "ASSET", categoryKey: "CAPITAL_ASSETS", fsGroupKey: "IS_FIXED_ASSETS" },
  { number: "5000", name: "Cost of Goods Sold - Merchandise", type: "EXPENSE", categoryKey: "COST_OF_SALES", fsGroupKey: "IS_COGS_MERCHANDISE" },
  { number: "6010", name: "Wages - Staff", type: "EXPENSE", fsGroupKey: "IS_PAYROLL" },
  { number: "6020", name: "Grounds Maintenance", type: "EXPENSE", categoryKey: "REPAIRS_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE" },
  { number: "6025", name: "Fuel", type: "EXPENSE", fsGroupKey: "IS_UTILITIES" },
  { number: "6033", name: "R & M Preventative Maintenance", type: "EXPENSE", categoryKey: "REPAIRS_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE" },
  { number: "6035", name: "R & M - Ground Equipment", type: "EXPENSE", categoryKey: "REPAIRS_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE" },
  { number: "6050", name: "Utilities - Electricity", type: "EXPENSE", fsGroupKey: "IS_UTILITIES" },
  { number: "6051", name: "Bank Charges & Credit Card Fees", type: "EXPENSE", fsGroupKey: "IS_BANK_CHARGES" },
  { number: "6053", name: "Interest Expense", type: "EXPENSE", fsGroupKey: "IS_INTEREST_EXPENSE" },
  { number: "6054", name: "Computer & IT Services", type: "EXPENSE", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_IT_SOFTWARE" },
  { number: "6062", name: "Licenses & Permits", type: "EXPENSE", fsGroupKey: "IS_LICENCES_PERMITS" },
  { number: "6064", name: "Membership & Dues", type: "EXPENSE", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_MEMBERSHIPS_SUBS" },
  { number: "6071", name: "Subscriptions", type: "EXPENSE", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_MEMBERSHIPS_SUBS" },
  { number: "6072", name: "Telephone & Internet", type: "EXPENSE", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_TELEPHONE_INTERNET" },
  { number: "6080", name: "Professional Fees - Accounting", type: "EXPENSE", fsGroupKey: "IS_PROFESSIONAL_FEES" },
  { number: "6081", name: "Insurance", type: "EXPENSE", fsGroupKey: "IS_INSURANCE" },
];

function makeFixturePdf(): Buffer {
  return Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    Buffer.from("% phase4r single-authority fixture — synthetic bytes only.\n"),
    randomBytes(128),
  ]);
}

async function ingestFixtureDoc(sourceRef: string): Promise<string> {
  const storage = memoryDocumentStorageAdapter("BUCKET_" + suiteToken);
  const pdf = makeFixturePdf();
  const result = await ingestAttachment({
    clubId: CLUB,
    sourceKind: "EMAIL_ATTACHMENT",
    sourceReferenceId: sourceRef,
    claimedContentType: "application/pdf",
    claimedSizeBytes: pdf.length,
    originalFilename: "Invoice.pdf",
    receivedAt: new Date("2026-01-05T10:00:00Z"),
    isInline: false,
    bytes: { async fetchBytes() { return pdf; } },
    classifySignals: { emailSubject: "Invoice" },
    autoAttachTo: null,
    storageOverride: storage,
  });
  if (result.outcome !== "STORED_NEW" || !result.documentId) {
    throw new Error(`ingestFixtureDoc failed: ${JSON.stringify(result)}`);
  }
  await prisma.ingestedDocument.update({
    where: { id: result.documentId }, data: { classification: "INVOICE" },
  });
  return result.documentId;
}

beforeAll(async () => {
  _resetMemoryDocumentStorage_TEST_ONLY();
  const club = await prisma.club.create({
    data: { slug: `${suiteToken}-club`, name: `Phase 4R Single-Auth Test Club` },
    select: { id: true },
  });
  CLUB = club.id;
  for (const a of NEUTRAL_COA) {
    await prisma.account.create({
      data: {
        clubId: CLUB,
        accountNumber: a.number,
        name: a.name,
        type: a.type,
        normalBalance: "DEBIT",
        isActive: true,
        allowManualPosting: true,
        sortOrder: Number.parseInt(a.number, 10),
      },
    });
  }
  // Note: categoryKey / fsGroupKey wiring lives on Category / FsGroup
  // model relations, not directly on Account. The v206 recommendation
  // pipeline does not require these to be seeded for structural
  // ranking behaviour — it will fall back to name-similarity + concept
  // matching without them, which is exactly the shape needed to
  // expose the winner/candidates divergence on the same-authority
  // invariant.
});

// -----------------------------------------------------------------------------
// FAILURE-MODE CLASSIFIER — the heart of the "red for the right
// reason" requirement (founder §4).
// -----------------------------------------------------------------------------

type InvariantOutcome =
  | { kind: "INVARIANT_HOLDS"; winner: string; top: string }
  | { kind: "ABSTAINED"; candidateCount: number }
  | { kind: "WINNER_REPLACED_AFTER_RANKING"; winner: string; top: string; reason: string; overrideMarker: string }
  | { kind: "WINNER_ABSENT_FROM_CANDIDATES"; winner: string; candidateNumbers: string[]; reason: string }
  | { kind: "NO_CANDIDATES"; winner: string; reason: string };

function classifyInvariant(scenarioKey: string, analysis: any): InvariantOutcome {
  const winner: string | null = analysis?.gl?.accountNumber ?? null;
  const candidates: Array<{ accountNumber: string }> = analysis?.gl?.candidates ?? [];
  const reason: string = analysis?.gl?.reason ?? "";
  if (winner == null) {
    return { kind: "ABSTAINED", candidateCount: candidates.length };
  }
  if (candidates.length === 0) {
    return { kind: "NO_CANDIDATES", winner, reason };
  }
  const top = candidates[0].accountNumber;
  if (top === winner) {
    return { kind: "INVARIANT_HOLDS", winner, top };
  }
  const candidateNumbers = candidates.map((c) => c.accountNumber);
  if (!candidateNumbers.includes(winner)) {
    return { kind: "WINNER_ABSENT_FROM_CANDIDATES", winner, candidateNumbers, reason };
  }
  // Winner is in candidates but not at position 0 → a downstream
  // override rewrote gl.accountNumber. The reason string names which
  // override site fired (per the §Investigation map).
  const overrideMarkers = [
    "purpose_ontology_promotion",
    "purpose_driven_full_coa_search",
    "purpose_ontology_abstain",
    "capital_aware_ranking",
    "split_",
  ];
  const marker = overrideMarkers.find((m) => reason.includes(m)) ?? "unknown_override";
  return { kind: "WINNER_REPLACED_AFTER_RANKING", winner, top, reason, overrideMarker: marker };
}

// -----------------------------------------------------------------------------
// SCENARIOS — 17 shapes per founder §3. The suite exercises the
// architecture, not a quota; some may already satisfy the invariant.
// -----------------------------------------------------------------------------

interface Scenario {
  key: string;
  description: string;
  invoiceText: string;
}

function makeInvoiceText(vendorName: string, lines: Array<{ desc: string; amt: number }>, total: number, invoiceNo: string): string {
  const rows = lines.map((l) => `${l.desc.padEnd(55)}${l.amt.toFixed(2).padStart(10)}`).join("\n");
  const subtotal = lines.reduce((a, l) => a + l.amt, 0);
  const tax = Math.max(0, total - subtotal);
  return [
    vendorName,
    "",
    `INVOICE`,
    `Invoice Number: ${invoiceNo}`,
    `Invoice Date: 2026-01-05`,
    `Due Date: 2026-02-04`,
    ``,
    `Item                                                   Amount`,
    rows,
    ``,
    `                                        Subtotal: ${subtotal.toFixed(2)}`,
    `                                        Tax (5%):  ${tax.toFixed(2)}`,
    `                                        Total:    ${total.toFixed(2)}`,
  ].join("\n");
}

const SCENARIOS: Scenario[] = [
  { key: "operating_expense", description: "office supplies operating expense",
    invoiceText: makeInvoiceText("Northland Office Supply Ltd", [
      { desc: "Copy paper 10 reams", amt: 85.00 },
      { desc: "Toner cartridges 3 units", amt: 315.00 },
    ], 420.00, "P4R-01") },
  { key: "capital_equipment", description: "capital fairway mower complete unit",
    invoiceText: makeInvoiceText("TurfPro Equipment Co", [
      { desc: "Commercial fairway mower FM-9000 serial TP-556621 complete unit delivered assembled", amt: 48500.00 },
    ], 50925.00, "P4R-02") },
  { key: "repair_service", description: "grounds equipment repair labor",
    invoiceText: makeInvoiceText("TurfPro Equipment Co", [
      { desc: "Fairway mower reel bearing repair service call", amt: 385.00 },
      { desc: "Preventative maintenance labor", amt: 240.00 },
    ], 656.25, "P4R-03") },
  { key: "professional_service", description: "accounting tax preparation",
    invoiceText: makeInvoiceText("Cascade & Associates Chartered Accountants", [
      { desc: "Tax return preparation and review services", amt: 3200.00 },
    ], 3360.00, "P4R-04") },
  { key: "subscription", description: "annual SaaS subscription",
    invoiceText: makeInvoiceText("CloudMetrics Inc", [
      { desc: "Annual cloud analytics subscription 10 seats", amt: 4800.00 },
    ], 5040.00, "P4R-05") },
  { key: "utility", description: "electricity utility bill",
    invoiceText: makeInvoiceText("Regional Hydro Cooperative", [
      { desc: "Electricity service November 2025 12500 kWh", amt: 1450.00 },
    ], 1522.50, "P4R-06") },
  { key: "fuel", description: "diesel fuel delivery",
    invoiceText: makeInvoiceText("PetroDeliver Ltd", [
      { desc: "Diesel fuel 2400 litres", amt: 3120.00 },
    ], 3276.00, "P4R-07") },
  { key: "merchandise_inventory", description: "resale merchandise",
    invoiceText: makeInvoiceText("Fairway Apparel Distributors", [
      { desc: "Mens golf polos 48 units for resale", amt: 2160.00 },
    ], 2268.00, "P4R-08") },
  { key: "professional_dues", description: "staff professional dues (association)",
    invoiceText: makeInvoiceText("Professional Body Association Alberta", [
      { desc: "Member dues annual professional accountant", amt: 810.00 },
    ], 850.50, "P4R-09") },
  { key: "novel_vendor", description: "unseen vendor with novel invoice wording",
    invoiceText: makeInvoiceText("Zephyr Grounds Solutions Corp", [
      { desc: "Aerator equipment quarterly service", amt: 780.00 },
    ], 819.00, "P4R-10") },
  { key: "department_sensitive", description: "kitchen equipment purchase",
    invoiceText: makeInvoiceText("Restaurant Supply Direct", [
      { desc: "Commercial combi oven for kitchen prep line model KO-6600 complete unit", amt: 12500.00 },
    ], 13125.00, "P4R-11") },
  { key: "genuine_two_account_ambiguity", description: "software license AND subscription (legitimately ambiguous)",
    invoiceText: makeInvoiceText("Amberlight Software Ltd", [
      { desc: "Annual software licence and subscription portal application", amt: 6400.00 },
    ], 6720.00, "P4R-12") },
  { key: "weak_semantic_accident", description: "landscape maintenance service (cart-paths lexical accident target)",
    invoiceText: makeInvoiceText("Cartway Landscaping Inc", [
      { desc: "Landscape maintenance service quarterly", amt: 1250.00 },
    ], 1312.50, "P4R-13") },
  { key: "capital_operating_ambiguity", description: "replacement engine on durable asset",
    invoiceText: makeInvoiceText("TurfPro Equipment Co", [
      { desc: "Replacement engine assembly for grounds unit", amt: 8900.00 },
    ], 9345.00, "P4R-14") },
  { key: "multi_allocation", description: "dues + late-payment penalty on one invoice",
    invoiceText: makeInvoiceText("Professional Body Association", [
      { desc: "Member dues annual", amt: 810.00 },
      { desc: "Late-payment penalty", amt: 150.00 },
    ], 1008.00, "P4R-15") },
  { key: "insurance", description: "insurance premium",
    invoiceText: makeInvoiceText("Northern Assurance Group", [
      { desc: "Annual commercial general liability insurance premium", amt: 8400.00 },
    ], 8400.00, "P4R-16") },
  { key: "telephone_internet", description: "telecom service",
    invoiceText: makeInvoiceText("Provincial Telecom Cooperative", [
      { desc: "Business fibre internet 200Mbps monthly service", amt: 240.00 },
    ], 252.00, "P4R-17") },
];

// -----------------------------------------------------------------------------
// The SUITE — categorised by architectural outcome per scenario.
// -----------------------------------------------------------------------------

describe("Phase 4R · single-GL-authority invariant · winner === candidates[0]", () => {
  const outcomes = new Map<string, InvariantOutcome>();

  for (const scenario of SCENARIOS) {
    it(`${scenario.key} — invariant check`, async () => {
      const docId = await ingestFixtureDoc(`${suiteToken}-${scenario.key}-${Math.random()}`);
      const analysis = await analyseIngestedInvoice({
        clubId: CLUB,
        ingestedDocumentId: docId,
        extractedTextOverride: scenario.invoiceText,
      });
      const outcome = classifyInvariant(scenario.key, analysis);
      outcomes.set(scenario.key, outcome);
      // Log the mode so the RED reason is legible.
      console.log(`[${scenario.key}] outcome=${outcome.kind}`
        + (outcome.kind === "WINNER_REPLACED_AFTER_RANKING"
            ? ` winner=${outcome.winner} top=${outcome.top} override=${outcome.overrideMarker}`
            : outcome.kind === "INVARIANT_HOLDS"
              ? ` winner=${outcome.winner}`
              : outcome.kind === "ABSTAINED"
                ? ` (no winner)`
                : outcome.kind === "WINNER_ABSENT_FROM_CANDIDATES"
                  ? ` winner=${outcome.winner} (not in [${outcome.candidateNumbers.join(",")}])`
                  : ` (${outcome.kind})`),
      );
      // The architectural invariant. Failure is EXPECTED against
      // v206; it's the point of this Phase 1 suite. Failures must
      // classify to WINNER_REPLACED_AFTER_RANKING or WINNER_ABSENT_
      // FROM_CANDIDATES — those are the two mutation modes documented
      // in the root-cause architecture map. If we see NO_CANDIDATES
      // instead, that's a NEW failure mode that needs separate
      // architectural attention.
      const isCleanState = outcome.kind === "INVARIANT_HOLDS" || outcome.kind === "ABSTAINED";
      expect(
        isCleanState,
        `[${scenario.key}] invariant violated with mode="${outcome.kind}". `
        + `winner=${(outcome as any).winner ?? "(none)"} `
        + `top=${(outcome as any).top ?? "(none)"} `
        + `reason="${(outcome as any).reason ?? ""}". `
        + `Founder §1: winner MUST equal candidates[0] because ONE canonical ranker chose it.`,
      ).toBe(true);
    });
  }
});

// -----------------------------------------------------------------------------
// EXPLICIT ARCHITECTURAL REGRESSION CASES (founder §2)
// -----------------------------------------------------------------------------
//
// These two cases are the empirical counterexamples that established
// the two distinct structural failure modes. They are PRESERVED as
// named regression tests so Phase 2/3 must eventually make BOTH pass
// for the correct reason (winner === candidates[0] because the
// canonical ranker chose it, NOT because someone fabricated
// [winner] after recommendation).

describe("Phase 4R · architectural regression cases (post-Phase-3 must pass)", () => {
  it("REGRESSION · utility invoice must not exhibit WINNER_REPLACED_AFTER_RANKING", async () => {
    const util = SCENARIOS.find((s) => s.key === "utility")!;
    const docId = await ingestFixtureDoc(`${suiteToken}-regr-utility-${Math.random()}`);
    const analysis = await analyseIngestedInvoice({
      clubId: CLUB, ingestedDocumentId: docId,
      extractedTextOverride: util.invoiceText,
    });
    const outcome = classifyInvariant("utility", analysis);
    // Explicitly proves the post-ranking-selector defect on v206.
    // Phase 3 must eliminate the override that produces this mode.
    expect(
      outcome.kind === "INVARIANT_HOLDS" || outcome.kind === "ABSTAINED",
      `utility invoice: winner (${(outcome as any).winner ?? "(none)"}) ≠ candidates[0] `
      + `(${(outcome as any).top ?? "(none)"}). Mode=${outcome.kind}. `
      + `This is the two-ranker override defect (analyse.ts:1583 purpose_driven_full_coa_search) `
      + `and must be closed by Phase 3. Do NOT fix by manually reordering candidates[] after ranking.`,
    ).toBe(true);
  });

  it("REGRESSION · novel-vendor invoice must not produce NO_CANDIDATES", async () => {
    const novel = SCENARIOS.find((s) => s.key === "novel_vendor")!;
    const docId = await ingestFixtureDoc(`${suiteToken}-regr-novel-${Math.random()}`);
    const analysis = await analyseIngestedInvoice({
      clubId: CLUB, ingestedDocumentId: docId,
      extractedTextOverride: novel.invoiceText,
    });
    const outcome = classifyInvariant("novel_vendor", analysis);
    // Explicitly proves that v206 can produce a winner with an empty
    // candidate competition — Pipeline A's `emptyRecommendation()`
    // returns candidates=[] and Pipeline B (rankPurposeDrivenAccounts)
    // subsequently writes a winner via the analyse.ts:1583 override.
    //
    // The canonical unified ranker in Phase 2 must produce a proper
    // candidate competition INCLUDING the winner. Do NOT solve this
    // by post-hoc synthesising `candidates=[winner]` after Pipeline B
    // — that is exactly the mechanical shortcut founder §2 forbids.
    expect(
      outcome.kind !== "NO_CANDIDATES" && outcome.kind !== "WINNER_ABSENT_FROM_CANDIDATES",
      `novel-vendor invoice: mode=${outcome.kind}, winner=${(outcome as any).winner ?? "(none)"}, `
      + `candidate count=${(outcome as any).candidateCount ?? (outcome as any).candidateNumbers?.length ?? "?"}. `
      + `A recommendation without a canonical candidate competition is a two-ranker fingerprint. `
      + `Phase 2's unified ranker MUST produce the candidate competition; Phase 3 must remove the `
      + `Pipeline-B override that currently backfills the winner into an empty candidates array.`,
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// STATIC ARCHITECTURAL GUARD (founder §3 · Approach B)
// -----------------------------------------------------------------------------
//
// This is a SOURCE-CODE guard, not a behavioural check. It scans
// analyse.ts for the runtime patterns that represent obsolete GL
// selection authorities (post-ranking mutation of gl.accountNumber).
//
// FOUNDER §3 DECISION: this guard is created NOW as an EXPECTED-RED
// architectural-debt marker during Phases 1-2. It will go GREEN
// automatically as Phase 3 removes the mutation sites.
//
// Rationale for expecting RED during Phases 1-2:
//   The v206 architecture DEMONSTRABLY still contains the obsolete
//   override authorities (analyse.ts lines 1446, 1472, 1583, and 7+
//   others). A guard that passes today while those sites exist would
//   be lying. Better to fail loudly during the refactor so the guard
//   cannot silently rot.
//
// After Phase 3 the guard passes because the mutation sites are gone.
// After that, any future edit that reintroduces a post-ranking
// `gl = { ...gl, accountNumber: X }` pattern will re-fail the guard,
// providing the permanent backsliding protection founder §3.B
// requires.

describe("Phase 4R · static architectural guard against post-ranking GL override authorities", () => {
  it("analyse.ts contains no post-ranking `gl = { ...gl, accountNumber: ... }` mutation (EXPECTED RED until Phase 3)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve("src/lib/ap-intelligence/analyse.ts"),
      "utf8",
    ) as string;
    // Detects the mutation pattern that constitutes a post-ranking
    // override authority: `gl = { ...gl, accountNumber: ... }` or
    // any equivalent rewrite of `gl.accountNumber` after the initial
    // recommendGlAccount call.
    //
    // Multiline / whitespace-tolerant. We match the specific shape
    // that appears at analyse.ts lines 1446, 1472, 1590, 1824, 2006,
    // 2149, 2221, 2342, 2360, 2419 — the 10 sites identified in the
    // §Root-cause architecture map.
    const overridePattern = /gl\s*=\s*\{\s*\.\.\.gl\s*,\s*accountNumber\s*:/;
    const overrideMatches = [...src.matchAll(new RegExp(overridePattern.source, "gm"))];
    // The guard's expected end-state is GREEN (zero matches). During
    // Phases 1-2 the guard is EXPECTED RED — matched sites still exist.
    // We assert the current count for visibility; when Phase 3 lands,
    // this expectation flips to zero and the test naturally goes GREEN.
    //
    // Progression ceiling: 10 → 7 (Group A) → 4 (Group B) → 2 (Group C) → 1 (Group D) → 0 (Group E).
    // Phase 3.2 (Group A migration, 2026-08-11) reduced count from
    // 10 to 7 by eliminating purpose_ontology_promotion +
    // purpose_ontology_abstain + purpose_driven_full_coa_search
    // override sites.
    // Phase 3.3 (Group B migration, 2026-08-11) reduced count from
    // 7 to 4 by eliminating nature_promoted (Stage A promotion),
    // nature_scoped_full_coa_search (Stage B full-COA fallback),
    // and Phase 2 eligibility recheck. Nature signals now feed
    // canonical ranking as a pre-ranking input (CAPITAL_NATURE
    // family) instead of a post-ranking selector.
    // Phase 3.4 (Group C migration, 2026-08-11) reduced count from
    // 4 to 2 by eliminating the capital-aware full-COA ranker's
    // winner-promotion + abstain-override sites. The compatibility
    // gate now runs in the facade upstream of canonical ranking;
    // PREFERRED / INCOMPATIBLE verdicts become CAPITAL_NATURE
    // observations (NATURE_GATE_PREFERRED / NATURE_GATE_CONTRADICTED).
    // Phase 3.5 (Group D migration, 2026-08-11) reduced count from
    // 2 to 1 by eliminating the Slice 5.3 object-authority guard
    // (durable-asset context vs interest/fee account name-regex).
    // Replaced with taxonomy-based (fsGroupKey) scoring evidence in
    // the CAPITAL_NATURE family (OBJECT_ROLE_CONTRADICTION), defeasible
    // via hasFinancingEvidence.
    // Phase 3.6 (Group E migration, 2026-08-11) reduced count from
    // 1 to 0 by eliminating the field-quality gate's post-canonical
    // gl.accountNumber = null override. The recommendation-quality
    // policy (recommendation-policy.ts + facade projection) now
    // separates classification from automation. RECOMMEND / ABSTAIN_*
    // status is projected into gl.recommendationStatus with winner
    // provenance preserved on gl.canonicalWinnerAccountNumber.
    // Ceiling is now 0. ANY post-ranking override site is
    // architectural regression against the single-authority invariant.
    const EXPECTED_MAX_SITES_DURING_REFACTOR = 0;
    expect(
      overrideMatches.length,
      `analyse.ts contains ${overrideMatches.length} \`gl = { ...gl, accountNumber: ... }\` `
      + `override sites (expected max ${EXPECTED_MAX_SITES_DURING_REFACTOR} after Phase 3.6). `
      + `The single-authority invariant \`analysis.gl.accountNumber === analysis.gl.candidates[0].accountNumber\` `
      + `is ESTABLISHED. ANY new override site regresses the architecture.`,
    ).toBeLessThanOrEqual(EXPECTED_MAX_SITES_DURING_REFACTOR);
  });

  // Phase 4R · Phase 5 (2026-08-11) — allocation-level authority guard.
  it("gl-allocations.ts contains no post-ranking allocation account override or rankAccountsPure call", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve("src/lib/ap-intelligence/gl-allocations.ts"),
      "utf8",
    ) as string;
    // Detects the shapes that would constitute a post-canonical
    // allocation account override:
    //   allocation.accountNumber = <new value>
    //   recommendedAccount = { accountNumber: <new value> ... }
    // Also detects any re-introduction of the legacy rankAccountsPure
    // ranker inside the allocations runtime (the compat import
    // itself is removed; a runtime call would fail typecheck, but the
    // guard catches string references too as a belt-and-braces
    // architectural protection).
    const allocationOverride = /allocation(?:\.recommendedAccount|s?\[[^\]]+\])(?:\.accountNumber)?\s*=\s*[^=]/g;
    const legacyRankerCall = /rankAccountsPure\s*\(/g;
    const allocMatches = [...src.matchAll(allocationOverride)];
    const legacyMatches = [...src.matchAll(legacyRankerCall)];
    expect(
      allocMatches.length,
      `gl-allocations.ts contains ${allocMatches.length} post-ranking allocation account overrides. `
      + `Every allocation winner must come from the canonical ranker; no substitution after ranking.`,
    ).toBe(0);
    expect(
      legacyMatches.length,
      `gl-allocations.ts still calls the legacy rankAccountsPure ranker. `
      + `Phase 5 replaced it with the canonical per-cluster ranker.`,
    ).toBe(0);
    console.log(`[static-guard] gl-allocations.ts: ${allocMatches.length} overrides, ${legacyMatches.length} legacy calls (target: 0/0)`);
  });
});

describe("Phase 4R · anti-overfitting lint", () => {
  it("no vendor / invoice / account literal string comparisons in canonical GL runtime code", () => {
    const fs = require("fs");
    const path = require("path");
    const filesToScan = [
      "src/lib/ap-intelligence/gl-recommend.ts",
      "src/lib/ap-intelligence/purpose-driven-ranker.ts",
      "src/lib/ap-intelligence/analyse.ts",
      "src/lib/ap-intelligence/gl-allocations.ts",
    ];
    // These literal comparisons are FORBIDDEN in runtime code.
    // A regression here means someone smuggled in a hardcoded rule
    // (e.g. `if (accountNumber === "6054") ...`).
    const forbidden = [
      /===\s*["'](6054|6030|6033|6035|6051|6053|6064|6071|6072|1500|1502|1506|1540)["']/,
      /===\s*["']Club\s*Support/i,
      /===\s*["']OXIO/i,
      /===\s*["']Oakcreek/i,
      /===\s*["']CPA\s*Alberta/i,
      /===\s*["']DMM\s*Energy/i,
      /===\s*["']221178["']/,
      /===\s*["']1091559["']/,
      /===\s*["']1087769["']/,
      /===\s*["']1007565767["']/,
    ];
    for (const file of filesToScan) {
      const src = fs.readFileSync(path.resolve(file), "utf8") as string;
      for (const re of forbidden) {
        const match = src.match(re);
        expect(
          match,
          `[${file}] runtime literal comparison detected: /${re.source}/ matched "${match?.[0] ?? ""}". `
          + `Founder §12: no invoice/vendor/GL-account literals in runtime intelligence.`,
        ).toBeNull();
      }
    }
  });
});
