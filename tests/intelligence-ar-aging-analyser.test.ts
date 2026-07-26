// Sprint 3 Checkpoint 15B (2026-07-24) — AR-aging analyser rule tests.
//
// Pure-function tests — no Prisma. The analyser accepts a subject
// shape and produces findings + recommendation deterministically.

import { describe, expect, it } from "vitest";
import {
  analyseArAging,
  composeArAgingRecommendation,
  dominantBucket,
  AR_AGING_RULE_VERSION,
  type ArAgingSubject,
} from "@/lib/intelligence/analysers/ar-aging";

const CLUB_ID = "cl_test";
const INTAKE_ID = "wi_test";
const ACC_ID = "acc_test";
const MEMBER_ID = "mem_test";
const NOW = new Date("2026-07-24T12:00:00Z");

function makeSubject(overrides: Partial<ArAgingSubject["memberAccount"]> = {}, extras: Partial<Omit<ArAgingSubject, "memberAccount">> = {}): ArAgingSubject {
  return {
    memberAccount: {
      id: ACC_ID,
      memberId: MEMBER_ID,
      currentBalance: 0,
      thirtyDayBalance: 0,
      sixtyDayBalance: 0,
      ninetyDayBalance: 0,
      oneTwentyDayBalance: 0,
      creditBalance: 0,
      lastPaymentDate: null,
      ...overrides,
    },
    recentPayment: extras.recentPayment ?? null,
    recentNotice: extras.recentNotice ?? null,
  };
}

describe("dominantBucket", () => {
  it("returns 120 when 120-day balance is positive (dominant over lower buckets)", () => {
    expect(dominantBucket({ ...makeSubject().memberAccount, sixtyDayBalance: 100, ninetyDayBalance: 100, oneTwentyDayBalance: 100 })).toBe(120);
  });
  it("returns 90 when 90-day balance is positive but not 120", () => {
    expect(dominantBucket({ ...makeSubject().memberAccount, sixtyDayBalance: 100, ninetyDayBalance: 100 })).toBe(90);
  });
  it("returns 60 when only 60-day balance is positive", () => {
    expect(dominantBucket({ ...makeSubject().memberAccount, sixtyDayBalance: 100 })).toBe(60);
  });
  it("returns null when no bucket has a positive balance", () => {
    expect(dominantBucket({ ...makeSubject().memberAccount, currentBalance: 500 })).toBeNull();
  });
});

describe("analyseArAging — bucket findings", () => {
  it("120-day breach dominates — no separate 60 or 90 findings emitted", () => {
    const subject = makeSubject({ sixtyDayBalance: 100, ninetyDayBalance: 200, oneTwentyDayBalance: 300 });
    const run = analyseArAging({ clubId: CLUB_ID, workIntakeItemId: INTAKE_ID, subject, now: NOW });
    const keys = run.findings.map((f) => f.key);
    expect(keys).toContain("ar.policy.120_day_breach");
    expect(keys).not.toContain("ar.policy.90_day_breach");
    expect(keys).not.toContain("ar.policy.60_day_breach");
  });

  it("90-day breach: severity HIGH, materiality in cents matches ninetyDayBalance", () => {
    const subject = makeSubject({ ninetyDayBalance: 250 });
    const run = analyseArAging({ clubId: CLUB_ID, workIntakeItemId: INTAKE_ID, subject, now: NOW });
    const finding = run.findings.find((f) => f.key === "ar.policy.90_day_breach");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("HIGH");
    expect(finding?.materialityCents).toBe(BigInt(25000));
    expect(finding?.ruleVersion).toBe(AR_AGING_RULE_VERSION);
    // Evidence points at MEMBER_ACCOUNT + MEMBER only for the breach finding
    expect(finding?.evidenceRefs.map((r) => r.kind).sort()).toEqual(["MEMBER", "MEMBER_ACCOUNT"]);
  });

  it("60-day breach: severity MEDIUM", () => {
    const subject = makeSubject({ sixtyDayBalance: 150 });
    const run = analyseArAging({ clubId: CLUB_ID, workIntakeItemId: INTAKE_ID, subject, now: NOW });
    const finding = run.findings.find((f) => f.key === "ar.policy.60_day_breach");
    expect(finding?.severity).toBe("MEDIUM");
  });

  it("no-breach subject emits observed observation, never a breach finding", () => {
    const subject = makeSubject({ currentBalance: 100 });
    const run = analyseArAging({ clubId: CLUB_ID, workIntakeItemId: INTAKE_ID, subject, now: NOW });
    expect(run.findings.some((f) => f.key.startsWith("ar.policy."))).toBe(false);
    expect(run.findings.map((f) => f.key)).toContain("ar.analysis.no_breach_but_situation_present");
  });
});

describe("analyseArAging — recent payment + notice + payment-stale", () => {
  it("recent payment within 21d emits ar.member.recent_payment with MEMBER_TRANSACTION evidence", () => {
    const subject = makeSubject({ sixtyDayBalance: 150 }, {
      recentPayment: { id: "pay_1", paymentDate: new Date("2026-07-23T12:00:00Z"), amount: 75 },
    });
    const run = analyseArAging({ clubId: CLUB_ID, workIntakeItemId: INTAKE_ID, subject, now: NOW });
    const finding = run.findings.find((f) => f.key === "ar.member.recent_payment");
    expect(finding).toBeDefined();
    expect(finding?.evidenceRefs.some((r) => r.kind === "MEMBER_TRANSACTION" && r.referenceId === "pay_1")).toBe(true);
  });

  it("recent notice within 14d emits ar.member.recent_notice with COLLECTION_NOTICE evidence", () => {
    const subject = makeSubject({ sixtyDayBalance: 150 }, {
      recentNotice: { id: "n_1", sentAt: new Date("2026-07-20T12:00:00Z"), noticeType: "OVER_60", stageKey: "STAGE_60" },
    });
    const run = analyseArAging({ clubId: CLUB_ID, workIntakeItemId: INTAKE_ID, subject, now: NOW });
    const finding = run.findings.find((f) => f.key === "ar.member.recent_notice");
    expect(finding).toBeDefined();
    expect(finding?.evidenceRefs.some((r) => r.kind === "COLLECTION_NOTICE" && r.referenceId === "n_1")).toBe(true);
  });

  it("stale last payment (>60d) emits ar.member.payment_stale", () => {
    const subject = makeSubject({
      sixtyDayBalance: 150,
      lastPaymentDate: new Date("2026-05-01T00:00:00Z"), // >60d before NOW
    });
    const run = analyseArAging({ clubId: CLUB_ID, workIntakeItemId: INTAKE_ID, subject, now: NOW });
    expect(run.findings.some((f) => f.key === "ar.member.payment_stale")).toBe(true);
  });

  it("no payment history + breach emits ar.analysis.insufficient_evidence (ERROR state, no fabricated conclusion)", () => {
    const subject = makeSubject({ ninetyDayBalance: 100 });
    const run = analyseArAging({ clubId: CLUB_ID, workIntakeItemId: INTAKE_ID, subject, now: NOW });
    const insufficient = run.findings.find((f) => f.key === "ar.analysis.insufficient_evidence");
    expect(insufficient?.state).toBe("ERROR");
  });
});

describe("analyseArAging — credit offset", () => {
  it("emits informational finding, never nets balances silently", () => {
    const subject = makeSubject({ sixtyDayBalance: 200, creditBalance: 80 });
    const run = analyseArAging({ clubId: CLUB_ID, workIntakeItemId: INTAKE_ID, subject, now: NOW });
    const credit = run.findings.find((f) => f.key === "ar.member.credit_offset");
    expect(credit).toBeDefined();
    expect(credit?.severity).toBe("INFO");
    // Statement explicitly says Spectre does not net
    expect(credit?.statement).toMatch(/does not automatically net/);
  });
});

describe("analyseArAging — determinism", () => {
  it("same inputs produce structurally identical findings across two calls", () => {
    const subject = makeSubject({ ninetyDayBalance: 300, lastPaymentDate: new Date("2026-05-01T00:00:00Z") }, {
      recentPayment: { id: "pay_1", paymentDate: new Date("2026-07-23T12:00:00Z"), amount: 75 },
    });
    const a = analyseArAging({ clubId: CLUB_ID, workIntakeItemId: INTAKE_ID, subject, now: NOW });
    const b = analyseArAging({ clubId: CLUB_ID, workIntakeItemId: INTAKE_ID, subject, now: NOW });
    // Different runIds are expected; findings themselves match.
    expect(a.findings.map((f) => ({ key: f.key, state: f.state, severity: f.severity, mat: f.materialityCents?.toString(), refs: f.evidenceRefs })))
      .toEqual(b.findings.map((f) => ({ key: f.key, state: f.state, severity: f.severity, mat: f.materialityCents?.toString(), refs: f.evidenceRefs })));
  });
});

describe("composeArAgingRecommendation", () => {
  const bucketFindingBase = { state: "CONFIRMED" as const, ruleKey: "x", ruleVersion: 1, evidenceRefs: [] };

  it("120-day breach → IMMEDIATE urgency + escalate statement", () => {
    const rec = composeArAgingRecommendation([
      { ...bucketFindingBase, key: "ar.policy.120_day_breach", statement: "s", severity: "CRITICAL" },
    ]);
    expect(rec?.urgency).toBe("IMMEDIATE");
    expect(rec?.statement).toMatch(/Escalate/);
    // Never PROMISES those actions — the statement may mention them
    // as disclaimed ("does not initiate suspension…"). Assert the
    // disclaimer wording is present.
    expect(rec?.statement).toMatch(/Spectre does not initiate suspension, share sale, legal collection, or write-off/);
  });

  it("90-day breach + recent notice → NORMAL urgency (wait for response window)", () => {
    const rec = composeArAgingRecommendation([
      { ...bucketFindingBase, key: "ar.policy.90_day_breach", statement: "s", severity: "HIGH" },
      { ...bucketFindingBase, key: "ar.member.recent_notice", statement: "s", severity: "INFO" },
    ]);
    expect(rec?.urgency).toBe("NORMAL");
    expect(rec?.statement).toMatch(/response period/);
  });

  it("90-day breach + no recent notice → HIGH urgency + prepare 90-day notice", () => {
    const rec = composeArAgingRecommendation([
      { ...bucketFindingBase, key: "ar.policy.90_day_breach", statement: "s", severity: "HIGH" },
    ]);
    expect(rec?.urgency).toBe("HIGH");
    expect(rec?.statement).toMatch(/90-day collection notice/);
  });

  it("60-day breach + recent payment → LOW urgency", () => {
    const rec = composeArAgingRecommendation([
      { ...bucketFindingBase, key: "ar.policy.60_day_breach", statement: "s", severity: "MEDIUM" },
      { ...bucketFindingBase, key: "ar.member.recent_payment", statement: "s", severity: "INFO" },
    ]);
    expect(rec?.urgency).toBe("LOW");
  });

  it("no breach → null recommendation", () => {
    expect(composeArAgingRecommendation([])).toBeNull();
  });

  it("primaryActionKey always ar.review_collection_notice (never a real send)", () => {
    const rec = composeArAgingRecommendation([
      { ...bucketFindingBase, key: "ar.policy.60_day_breach", statement: "s", severity: "MEDIUM" },
    ]);
    expect(rec?.primaryActionKey).toBe("ar.review_collection_notice");
  });
});
