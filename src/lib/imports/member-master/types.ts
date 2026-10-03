// MEM-HIST-1 (2026-10-03) — member-master import types.
//
// Pure types + enums. Shared across parser / match resolver /
// synthetic fixtures / tests. No I/O.

export type MembershipClassificationCode =
  | "SHAREHOLDER_FULL"
  | "SHAREHOLDER_SOCIAL"
  | "SHAREHOLDER_SENIOR"
  | "INTERMEDIATE"
  | "SOCIAL"
  | "JUNIOR"
  | "NON_RESIDENT"
  | "CORPORATE"
  | "HONORARY"
  | "APPLICANT";

export type MembershipStatus =
  | "ACTIVE"
  | "INACTIVE"
  | "RESIGNED"
  | "TERMINATED"
  | "APPLICANT"
  | "WAITLIST";

/** The sanitized row shape the parser emits per source row. All
 *  identifiers are already synthetic — this type represents the
 *  SANITIZED upload, never the raw Jonas export. */
export type MemberMasterRow = {
  /** Sanitized external identifier (e.g. "CR-7a3e9b"). Mandatory;
   *  rows missing this become INVALID outcomes. */
  externalIdentifier: string;
  /** Synthetic display name (e.g. "Member 7a3e"). Never the real
   *  name. */
  displayName: string;
  /** Classification code. Must match MembershipClassificationCode. */
  classificationCode: MembershipClassificationCode;
  /** Lifecycle status. */
  status: MembershipStatus;
  /** Shareholder flag — may be redundant with classification code
   *  (SHAREHOLDER_* codes imply true), but allowed as independent
   *  signal from the source. */
  isShareholder: boolean;
  /** Date this classification became effective. */
  effectiveFrom: Date;
  /** Original join-club date — identity-level, informational. */
  joinDate: Date | null;
  /** When status is RESIGNED / TERMINATED, the resignation date. */
  resignationDate: Date | null;
  /** When a classification change happened this reporting period —
   *  previous code for conversions-this-period reporting. */
  previousClassificationCode: MembershipClassificationCode | null;
  previousClassificationChangedAt: Date | null;
  /** Household-primary flag — when present, this member heads a
   *  household and secondary persons link to this member's external
   *  identifier via the HouseholdSecondary row set (future). */
  householdPrimary: boolean | null;
};

/** Per-row match outcome (hard enum; directive §5 / §F). */
export type MemberMatchOutcome =
  | "MATCHED"
  | "UNMATCHED"
  | "AMBIGUOUS"
  | "INVALID"
  | "NEW";

/** The outcome of resolving one row against a (hypothetical, future)
 *  MemberExternalIdentity table. In MEM-HIST-1 the resolver runs in
 *  pure mode with an in-memory existingIdentityIndex supplied by the
 *  caller — no DB read. */
export type MemberMatchResult = {
  rowIndex: number;
  externalIdentifier: string;
  outcome: MemberMatchOutcome;
  /** When MATCHED, the resolved Spectre memberId. Null otherwise. */
  resolvedMemberId: string | null;
  /** For INVALID / AMBIGUOUS / UNMATCHED, a one-line reason. */
  reason: string | null;
};

/** Parser output shape. */
export type MemberMasterParseResult = {
  rows: MemberMasterRow[];
  /** Rows that failed validation BEFORE match resolution (missing
   *  required field, unknown classification, malformed date). */
  invalidRows: Array<{
    rowIndex: number;
    externalIdentifier: string | null;
    reason: string;
  }>;
  /** Hard warnings — unexpected columns, blank header row, zero
   *  valid rows, etc. */
  warnings: string[];
  /** Source-file hash — computed over the normalized workbook bytes
   *  by the caller (NOT the parser; the parser is pure over row
   *  arrays). The parser emits this field as null; API callers set
   *  it. Used for idempotency key per §J. */
  sourceFileHash: string | null;
  /** The snapshot as-of date for this file — supplied by the
   *  operator at upload time; the parser passes it through. */
  sourceEffectiveDate: Date | null;
};

/** Match-resolver output shape. */
export type MemberMatchResolverResult = {
  results: MemberMatchResult[];
  summary: {
    matched: number;
    unmatched: number;
    ambiguous: number;
    invalid: number;
    newMembers: number;
  };
};

/** The existing-identity index the resolver walks. Supplied by the
 *  caller — in MEM-HIST-2 this will be built from Prisma. In
 *  MEM-HIST-1 tests supply it in-memory. */
export type ExistingIdentityIndex = Map<string, string[]>;
//            externalIdentifier → [resolved memberId, ...]
//                                 2+ entries ⇒ AMBIGUOUS.

/** All valid classification codes (used by parser validation). */
export const CLASSIFICATION_CODES: ReadonlyArray<MembershipClassificationCode> = [
  "SHAREHOLDER_FULL",
  "SHAREHOLDER_SOCIAL",
  "SHAREHOLDER_SENIOR",
  "INTERMEDIATE",
  "SOCIAL",
  "JUNIOR",
  "NON_RESIDENT",
  "CORPORATE",
  "HONORARY",
  "APPLICANT",
];

/** All valid status codes. */
export const STATUS_CODES: ReadonlyArray<MembershipStatus> = [
  "ACTIVE",
  "INACTIVE",
  "RESIGNED",
  "TERMINATED",
  "APPLICANT",
  "WAITLIST",
];

/** Classifications that imply shareholder regardless of the
 *  isShareholder column. */
export const SHAREHOLDER_CLASSIFICATION_CODES: ReadonlySet<MembershipClassificationCode> = new Set([
  "SHAREHOLDER_FULL",
  "SHAREHOLDER_SOCIAL",
  "SHAREHOLDER_SENIOR",
  "CORPORATE",
]);
