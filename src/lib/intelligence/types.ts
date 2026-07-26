// Sprint 3 Checkpoint 15B (2026-07-24) — Operational Intelligence
// contracts.
//
// This module defines the SHARED SHAPES for every analyser +
// materialiser. It has zero domain-specific logic. Domain modules
// live under src/lib/intelligence/analysers/ and
// src/lib/intelligence/materialisers/.
//
// Design rules:
//   - No LLM. Every value produced by the kernel is deterministic.
//   - No Prisma-row leaking to the UI. The UI consumes the
//     serialized DTOs at the bottom of this file.
//   - Closed enumerations for state / severity / origin kinds so
//     the compiler catches drift.

// ---------------------------------------------------------------------------
// Origin kinds — closed enumeration.
//   * 15B added the four AR kinds.
//   * 15E adds INGESTED_DOCUMENT (source-of-truth PDF for an AP-review
//     intake) and AP_INVOICE (link to a matched or drafted APInvoice).
//   Widening this list requires an explicit checkpoint change.
// ---------------------------------------------------------------------------
export const ORIGIN_KINDS = [
  "MEMBER_ACCOUNT",
  "MEMBER",
  "COLLECTION_NOTICE",
  "MEMBER_TRANSACTION",
  "INGESTED_DOCUMENT",
  "AP_INVOICE",
] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

export const ORIGIN_ROLES = ["PRIMARY", "EVIDENCE"] as const;
export type OriginRole = (typeof ORIGIN_ROLES)[number];

export interface EvidenceReference {
  kind: OriginKind;
  referenceId: string;
}

// ---------------------------------------------------------------------------
// Finding state + severity — closed enumerations.
// ---------------------------------------------------------------------------
export const FINDING_STATES = [
  "CONFIRMED",
  "OBSERVED",
  "SUPERSEDED",
  "USER_REJECTED",
  "ERROR",
] as const;
export type FindingState = (typeof FINDING_STATES)[number];

export const FINDING_SEVERITIES = [
  "INFO",
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

// ---------------------------------------------------------------------------
// FindingInput — what an analyser rule emits.
// ---------------------------------------------------------------------------
export interface FindingInput {
  key: string;                      // e.g. "ar.policy.60_day_breach"
  statement: string;                // one-sentence human-readable
  state: FindingState;
  severity: FindingSeverity;
  materialityCents?: bigint | null;
  ruleKey: string;                  // e.g. "ar_aging_policy_v1"
  ruleVersion: number;
  evidenceRefs: EvidenceReference[]; // must resolve on the same intake
}

// ---------------------------------------------------------------------------
// PersistedFinding — the DB row's UI-safe projection.
// Never expose Prisma row shape directly.
// ---------------------------------------------------------------------------
export interface PersistedFinding {
  id: string;
  key: string;
  statement: string;
  state: FindingState;
  severity: FindingSeverity;
  materialityCents: bigint | null;
  ruleKey: string;
  ruleVersion: number;
  evidenceRefs: EvidenceReference[];
  analysisRunId: string | null;
  overriddenByUserId: string | null;
  overriddenAt: string | null;   // ISO
  overrideReason: string | null;
  createdAt: string;             // ISO
}

// ---------------------------------------------------------------------------
// Recommendation — derived (not persisted).
// ---------------------------------------------------------------------------
export const RECOMMENDATION_URGENCIES = ["LOW", "NORMAL", "HIGH", "IMMEDIATE"] as const;
export type RecommendationUrgency = (typeof RECOMMENDATION_URGENCIES)[number];

export interface Recommendation {
  key: string;                          // e.g. "ar.review.90_day_breach"
  statement: string;
  urgency: RecommendationUrgency;
  derivedFromFindingKeys: string[];
  primaryActionKey: string | null;      // e.g. "ar.review_collection_notice"
  secondaryNote?: string;
}

// ---------------------------------------------------------------------------
// AnalysisRun — the aggregate return from one analyser invocation.
// ---------------------------------------------------------------------------
export interface AnalysisRun {
  analysisRunId: string;
  ruleModule: string;                   // "ar-aging"
  ruleModuleVersion: number;
  findings: FindingInput[];
  recommendation: Recommendation | null;
}

// ---------------------------------------------------------------------------
// MaterialisationResult — the aggregate return from one materialiser
// pass over a bounded input set (e.g. all qualifying MemberAccounts).
// ---------------------------------------------------------------------------
export interface MaterialisationResult {
  clubId: string;
  ruleModule: string;
  runAt: string;                        // ISO
  accountsExamined: number;
  situationsMatched: number;
  intakesCreated: number;
  intakesReused: number;
  findingsCreated: number;
  findingsPreserved: number;
  findingsSuperseded: number;
  findingsRejectedPreserved: number;    // USER_REJECTED preserved
  errors: Array<{
    category: PersistenceErrorCategory;
    referenceId: string | null;
    message: string;
  }>;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Analyser input contract — one situation, one call.
// ---------------------------------------------------------------------------
export interface AnalyserInput<TSubject> {
  clubId: string;
  workIntakeItemId: string;             // required — target of persistence
  subject: TSubject;                    // domain-specific — analyser knows the shape
  now: Date;                            // injected for determinism in tests
}

// ---------------------------------------------------------------------------
// Failure categorisation — matches the founder's §N spec.
// ---------------------------------------------------------------------------
export const PERSISTENCE_ERROR_CATEGORIES = [
  "DATA_MISSING",
  "TENANT_MISMATCH",
  "POLICY_UNDEFINED",
  "PERSISTENCE_CONFLICT",
  "UNAUTHORIZED",
  "UNEXPECTED",
] as const;
export type PersistenceErrorCategory = (typeof PERSISTENCE_ERROR_CATEGORIES)[number];

export class IntelligenceError extends Error {
  constructor(
    public readonly category: PersistenceErrorCategory,
    message: string,
    public readonly referenceId?: string,
  ) {
    super(message);
    this.name = "IntelligenceError";
  }
}

// ---------------------------------------------------------------------------
// Semantic-key identity — used by persistence to decide "same finding
// as before" without relying on timestamps or generated ids. Two
// findings are semantically identical iff every field in this shape
// matches.
// ---------------------------------------------------------------------------
export function findingIdentityKey(f: FindingInput): string {
  const refs = [...f.evidenceRefs]
    .sort((a, b) => (a.kind + a.referenceId).localeCompare(b.kind + b.referenceId))
    .map((r) => `${r.kind}:${r.referenceId}`)
    .join("|");
  return [
    f.key,
    f.state,
    f.severity,
    f.materialityCents?.toString() ?? "-",
    f.ruleKey,
    f.ruleVersion,
    f.statement,
    refs,
  ].join("§");
}
