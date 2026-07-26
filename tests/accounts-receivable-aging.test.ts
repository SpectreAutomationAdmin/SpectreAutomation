// Accounts Receivable Aging service tests — shape + reactive
// collection notes + period sensitivity.

import { describe, it, expect } from "vitest";

import {
  buildSilverSpringsAccountsReceivableAging,
  buildCollectionNotes,
} from "@/lib/reporting/accounts-receivable-aging";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

const MAY_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));
const SILVER_SPRINGS = "Silver Springs Golf & Country Club";

describe("buildCollectionNotes — reactive narrative", () => {
  it("AR note 1 quotes the total balance, current %, and 30-60 bucket label", () => {
    const notes = buildCollectionNotes({
      totalArBalanceLabel: "$984,200",
      currentPctLabel: "99.9%",
      bucket30to60Label: "$820",
      netMemberAdditionsLabel: "5",
      periodQuarterLabel: "Q1",
      initiationFeeYtdLabel: "$480,000",
      newMembershipsYtdLabel: "7",
      annualForecastLabel: "28",
      paceAheadOfPriorYear: true,
    });
    expect(notes).toHaveLength(2);
    expect(notes[0].text).toMatch(/\$984,200 outstanding/);
    expect(notes[0].text).toMatch(/99\.9% is current/);
    expect(notes[0].text).toMatch(/\$820 in the 30-60 day bucket/);
  });

  it("AR note 2 quotes the period quarter + new members + ahead/behind pace flag", () => {
    const ahead = buildCollectionNotes({
      totalArBalanceLabel: "$984,200",
      currentPctLabel: "99.9%",
      bucket30to60Label: "$820",
      netMemberAdditionsLabel: "5",
      periodQuarterLabel: "Q2",
      initiationFeeYtdLabel: "$480,000",
      newMembershipsYtdLabel: "7",
      annualForecastLabel: "28",
      paceAheadOfPriorYear: true,
    });
    expect(ahead[1].text).toMatch(/Net additions of 5 members in Q2/);
    expect(ahead[1].text).toMatch(/ahead of the prior year's Q2 pace/);
    expect(ahead[1].text).toMatch(/\$480,000 reflects 7 new memberships/);
    expect(ahead[1].text).toMatch(/Annual forecast of 28 net new memberships/);

    const behind = buildCollectionNotes({
      totalArBalanceLabel: "$984,200",
      currentPctLabel: "99.9%",
      bucket30to60Label: "$820",
      netMemberAdditionsLabel: "5",
      periodQuarterLabel: "Q2",
      initiationFeeYtdLabel: "$480,000",
      newMembershipsYtdLabel: "7",
      annualForecastLabel: "28",
      paceAheadOfPriorYear: false,
    });
    expect(behind[1].text).toMatch(/behind the prior year's Q2 pace/);
  });
});

describe("buildSilverSpringsAccountsReceivableAging — service contract", () => {
  it("ships the Saguaro header chrome — period derived from ReportingPeriod (no Q1/March hardcodes)", () => {
    const ara = buildSilverSpringsAccountsReceivableAging({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(ara.eyebrow).toBe("Silver Springs Golf & Country Club · AR Aging");
    expect(ara.title).toBe("Accounts Receivable Aging");
    expect(ara.periodLabel).toBe("May 2026 · For the period ended May 31, 2026 · Year to Date");
    expect(ara.periodLabel).not.toMatch(/Q1/);
    expect(ara.periodLabel).not.toMatch(/March/);
    expect(ara.statementNumber).toBe("Statement 10 of 14");
    expect(ara.documentChip).toBe("AR Aging");
    expect(ara.preparedFor).toBe("Finance Committee");
    expect(ara.introNote).toMatch(/Member account balances/);
  });

  it("4 KPI cards in canonical order with correct tone classification", () => {
    const ara = buildSilverSpringsAccountsReceivableAging({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(ara.kpiCards).toHaveLength(4);
    expect(ara.kpiCards[0].key).toBe("total-ar-balance");
    expect(ara.kpiCards[0].valueLabel).toBe("$984,200");
    expect(ara.kpiCards[1].key).toBe("current-pct");
    expect(ara.kpiCards[1].valueLabel).toBe("99.9%");
    expect(ara.kpiCards[1].tone).toBe("favorable");
    expect(ara.kpiCards[2].key).toBe("bucket-30-60");
    expect(ara.kpiCards[2].valueLabel).toBe("$820");
    expect(ara.kpiCards[3].key).toBe("over-90");
    expect(ara.kpiCards[3].valueLabel).toBe("$—");
    expect(ara.kpiCards[3].tone).toBe("empty");
  });

  it("aging table — 4 category rows + total reconcile to $984,200", () => {
    const ara = buildSilverSpringsAccountsReceivableAging({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const dues = ara.agingRows.find((r) => r.key === "membership-dues")!;
    expect(dues.values!.current).toBe(844_200);
    expect(dues.values!.days31to60).toBe(400);
    expect(dues.values!.totalBalance).toBe(844_600);
    expect(dues.status?.tone).toBe("current");

    const fb = ara.agingRows.find((r) => r.key === "fb-charges")!;
    expect(fb.values!.totalBalance).toBe(98_480);

    const golf = ara.agingRows.find((r) => r.key === "golf-pro-shop")!;
    expect(golf.values!.totalBalance).toBe(28_540);

    const amenities = ara.agingRows.find((r) => r.key === "amenities-other")!;
    expect(amenities.values!.totalBalance).toBe(12_580);
    expect(amenities.values!.days31to60).toBe(0);

    const total = ara.agingRows.find((r) => r.key === "total-ar")!;
    expect(total.values!.current).toBe(983_380);
    expect(total.values!.days31to60).toBe(820);
    expect(total.values!.totalBalance).toBe(984_200);
  });

  it("every aging category row carries the CURRENT status pill in this seed", () => {
    const ara = buildSilverSpringsAccountsReceivableAging({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const categoryRows = ara.agingRows.filter((r) => r.kind === "category");
    expect(categoryRows).toHaveLength(4);
    for (const row of categoryRows) {
      expect(row.status?.tone).toBe("current");
      expect(row.status?.label).toBe("Current");
    }
  });

  it("membership activity table — 4 rows with Saguaro reference values", () => {
    const ara = buildSilverSpringsAccountsReceivableAging({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(ara.membershipRows).toHaveLength(4);
    const newMems = ara.membershipRows.find((r) => r.key === "new-memberships")!;
    expect(newMems.currentLabel).toBe("7");
    expect(newMems.comparativeLabel).toBe("6");
    expect(newMems.changeLabel).toBe("+1");
    expect(newMems.annualForecastLabel).toBe("28");

    const netChange = ara.membershipRows.find((r) => r.key === "net-membership-change")!;
    expect(netChange.currentLabel).toBe("+5");
    expect(netChange.comparativeLabel).toBe("+3");

    const active = ara.membershipRows.find((r) => r.key === "active-membership-count")!;
    expect(active.currentLabel).toBe("342");
    expect(active.annualForecastLabel).toBe("362 projected");
  });

  it("membership column headers — Q[N] {year} flows from period.currentYearQuarterLabel (May → Q2 2026 / Q2 2025)", () => {
    const ara = buildSilverSpringsAccountsReceivableAging({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(ara.membershipColumnHeaders.current).toBe("Q2 2026");
    expect(ara.membershipColumnHeaders.comparative).toBe("Q2 2025");
  });

  it("REGRESSION: changing the reporting period flips the membership column quarters (March 2026 → Q1 2026 / Q1 2025)", () => {
    const MAR_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 2, 31)));
    const ara = buildSilverSpringsAccountsReceivableAging({ clubName: SILVER_SPRINGS, period: MAR_2026 });
    expect(ara.periodLabel).toMatch(/March 2026/);
    expect(ara.membershipColumnHeaders.current).toBe("Q1 2026");
    expect(ara.membershipColumnHeaders.comparative).toBe("Q1 2025");
  });

  it("REGRESSION: Dec 2027 → Q4 2027 / Q4 2026 + collection note references Q4", () => {
    const DEC_2027 = buildReportingPeriod(new Date(Date.UTC(2027, 11, 31)));
    const ara = buildSilverSpringsAccountsReceivableAging({ clubName: SILVER_SPRINGS, period: DEC_2027 });
    expect(ara.membershipColumnHeaders.current).toBe("Q4 2027");
    expect(ara.membershipColumnHeaders.comparative).toBe("Q4 2026");
    expect(ara.collectionNotes.notes[1].text).toMatch(/in Q4/);
    expect(ara.collectionNotes.notes[1].text).toMatch(/prior year's Q4 pace/);
  });

  it("collection notes are REACTIVE — quote the total balance + current % + initiation fee YTD from the seed data", () => {
    const ara = buildSilverSpringsAccountsReceivableAging({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(ara.collectionNotes.notes).toHaveLength(2);
    expect(ara.collectionNotes.notes[0].text).toMatch(/\$984,200 outstanding/);
    expect(ara.collectionNotes.notes[0].text).toMatch(/99\.9% is current/);
    expect(ara.collectionNotes.notes[0].text).toMatch(/\$820 in the 30-60 day bucket/);
    expect(ara.collectionNotes.notes[1].text).toMatch(/\$480,000/);
    expect(ara.collectionNotes.notes[1].text).toMatch(/7 new memberships/);
  });
});
