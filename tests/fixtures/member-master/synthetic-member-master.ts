// MEM-HIST-1 §18 — synthetic member-master fixtures.
//
// ALL IDENTITIES ARE SYNTHETIC. No real Silver Springs names,
// member numbers, emails, phones, addresses, or DOBs anywhere.
// The repo's .gitignore blocks the real export from ever landing
// here; this file is the canonical source of synthetic staging
// members for every member-master test.

export const MEMBER_MASTER_HEADERS = [
  "External Identifier",
  "Display Name",
  "Classification Code",
  "Status",
  "Is Shareholder",
  "Effective From",
  "Join Date",
  "Resignation Date",
  "Previous Classification",
  "Previous Classification Changed At",
  "Household Primary",
];

/** Baseline fixture exercising every §18 scenario the directive
 *  called out. */
export const MEMBER_MASTER_FIXTURE_ROWS: unknown[][] = [
  MEMBER_MASTER_HEADERS,

  // 1. active shareholder
  ["CR-0001a1", "Member 0001", "SHAREHOLDER_FULL", "ACTIVE", "Y", "2020-01-01", "2015-07-01", "", "", "", "Y"],

  // 2. active non-shareholder (intermediate)
  ["CR-0002b2", "Member 0002", "INTERMEDIATE", "ACTIVE", "N", "2024-03-15", "2024-03-15", "", "", "", "Y"],

  // 3. active social member
  ["CR-0003c3", "Member 0003", "SOCIAL", "ACTIVE", "N", "2022-06-01", "2022-06-01", "", "", "", "Y"],

  // 4. membership category conversion between two effective dates
  //    (same external identifier appears twice — the parser emits
  //    both rows; the resolver + MembershipHistoryEntry inserts
  //    close the earlier row on commit).
  ["CR-0004d4", "Member 0004", "INTERMEDIATE", "ACTIVE", "N", "2024-01-01", "2020-05-10", "", "", "", "Y"],
  ["CR-0004d4", "Member 0004", "SHAREHOLDER_FULL", "ACTIVE", "Y", "2026-01-01", "2020-05-10", "", "INTERMEDIATE", "2026-01-01", "Y"],

  // 5. resigned member
  ["CR-0005e5", "Member 0005", "SHAREHOLDER_FULL", "RESIGNED", "Y", "2010-04-02", "2010-04-02", "2025-11-30", "", "", "Y"],

  // 6. new member (not in existing index at resolve time)
  ["CR-0006f6", "Member 0006", "SOCIAL", "ACTIVE", "N", "2026-01-05", "2026-01-05", "", "", "", "Y"],

  // 7. duplicate external identifier (second occurrence — the parser
  //    emits both; the match resolver detects AMBIGUOUS when existing
  //    index returns 2+ hits). Note: on a fresh file this surfaces as
  //    a parser-level "Duplicate externalIdentifier" warning.
  ["CR-0007g7", "Member 0007", "SOCIAL", "ACTIVE", "N", "2024-03-01", "2024-03-01", "", "", "", "Y"],
  ["CR-0007g7", "Member 0007-dup", "SOCIAL", "ACTIVE", "N", "2024-03-01", "2024-03-01", "", "", "", "Y"],

  // 8. corporate membership
  ["CR-0008h8", "Member 0008", "CORPORATE", "ACTIVE", "Y", "2018-10-01", "2018-10-01", "", "", "", "Y"],

  // 9. junior member (will convert to adult category eventually)
  ["CR-0009i9", "Member 0009", "JUNIOR", "ACTIVE", "N", "2024-08-15", "2024-08-15", "", "", "", "Y"],

  // 10. non-resident
  ["CR-0010j0", "Member 0010", "NON_RESIDENT", "ACTIVE", "N", "2019-05-01", "2019-05-01", "", "", "", "Y"],

  // 11. honorary
  ["CR-0011k1", "Member 0011", "HONORARY", "ACTIVE", "N", "2005-01-01", "2005-01-01", "", "", "", "Y"],

  // 12. INVALID — missing effective-from date
  ["CR-0012l2", "Member 0012", "INTERMEDIATE", "ACTIVE", "N", "", "2024-03-15", "", "", "", "Y"],

  // 13. INVALID — unknown classification code
  ["CR-0013m3", "Member 0013", "FOUNDING_MEMBER", "ACTIVE", "N", "2023-01-01", "2023-01-01", "", "", "", "Y"],
];

/** Fixture: a later snapshot where Member 0005 is ABSENT. Confirms
 *  §13 directive: absence must NOT silently create a RESIGNED record. */
export const MEMBER_MASTER_LATER_SNAPSHOT_ROWS: unknown[][] = [
  MEMBER_MASTER_HEADERS,
  // CR-0001a1 (unchanged)
  ["CR-0001a1", "Member 0001", "SHAREHOLDER_FULL", "ACTIVE", "Y", "2020-01-01", "2015-07-01", "", "", "", "Y"],
  // CR-0002b2 (converted from INTERMEDIATE to SHAREHOLDER)
  ["CR-0002b2", "Member 0002", "SHAREHOLDER_FULL", "ACTIVE", "Y", "2026-10-01", "2024-03-15", "", "INTERMEDIATE", "2026-10-01", "Y"],
  // CR-0003c3 (unchanged)
  ["CR-0003c3", "Member 0003", "SOCIAL", "ACTIVE", "N", "2022-06-01", "2022-06-01", "", "", "", "Y"],
  // CR-0005e5 ABSENT — the resolver MUST NOT auto-flip to RESIGNED.
];
