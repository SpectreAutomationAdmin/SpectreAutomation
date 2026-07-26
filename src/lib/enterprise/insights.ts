// Phase 6K — Cross-module insights.
//
// A rule engine that scans across modules and emits Insights. Each registered
// rule is a function that returns 0..N candidate Insight records. The engine
// dedupes by entityType+entityId+key so rerunning is idempotent within a
// reasonable window.
//
// Real AI inference is intentionally NOT wired here — the architecture leaves
// commentary hooks (Insight.body) and alert routing (InsightAlert) so a future
// adapter can enrich insights with model-generated narrative without rewrites.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { tenantWhere } from "../services/tenant";

// ---------------------------------------------------------------------------
// Rule registry
// ---------------------------------------------------------------------------
export type InsightCandidate = {
  ruleKey: string;
  kind: string;
  severity: "INFO" | "WATCH" | "WARN" | "CRITICAL";
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
};

export type InsightRuleFn = (clubId: string) => Promise<InsightCandidate[]>;

// Six baked-in rules covering the examples in the Phase 6K brief.
export const INSIGHT_RULES: Record<string, { definition: { name: string; kind: string; severity: string; description: string }; run: InsightRuleFn }> = {
  member_growing_balance_declining_spend: {
    definition: {
      name: "Members with growing balances and declining spend",
      kind: "MEMBERSHIP",
      severity: "WATCH",
      description: "Flags members whose account balance is rising while monthly charges trend down — a leading indicator of disengagement risk.",
    },
    async run(clubId) {
      const accounts = await prisma.memberAccount.findMany({
        where: { clubId, currentBalance: { gt: 250 } },
        include: { member: true },
      });
      const out: InsightCandidate[] = [];
      for (const a of accounts) {
        const sixty = Number(a.sixtyDayBalance.toString());
        const ninety = Number(a.ninetyDayBalance.toString());
        if (sixty + ninety > Number(a.currentBalance.toString()) * 0.5) {
          out.push({
            ruleKey: "member_growing_balance_declining_spend",
            kind: "MEMBERSHIP",
            severity: "WATCH",
            title: `${a.member.firstName} ${a.member.lastName} — disengagement watch`,
            body: `Account aged: ${sixty + ninety} of ${a.currentBalance} is older than 60 days. Consider a member-services check-in before this becomes a collections matter.`,
            entityType: "Member",
            entityId: a.memberId,
            meta: { currentBalance: a.currentBalance.toString(), aged60Plus: sixty + ninety },
          });
        }
      }
      return out;
    },
  },
  vendor_invoice_trend_anomaly: {
    definition: {
      name: "Vendors with abnormal invoice trends",
      kind: "FINANCIAL",
      severity: "WATCH",
      description: "Flags vendors whose recent invoice total is more than 2x their trailing average.",
    },
    async run(clubId) {
      const vendors = await prisma.vendor.findMany({ where: { clubId, status: "ACTIVE" } });
      const out: InsightCandidate[] = [];
      const since30 = new Date(Date.now() - 30 * 86400000);
      const since180 = new Date(Date.now() - 180 * 86400000);
      for (const v of vendors) {
        const recent = await prisma.aPInvoice.aggregate({ where: { clubId, vendorId: v.id, invoiceDate: { gte: since30 } }, _sum: { total: true } });
        const trailing = await prisma.aPInvoice.aggregate({ where: { clubId, vendorId: v.id, invoiceDate: { gte: since180, lt: since30 } }, _sum: { total: true } });
        const recentTotal = Number(recent._sum?.total?.toString() ?? "0");
        const trailingTotal = Number(trailing._sum?.total?.toString() ?? "0");
        const trailingMonthlyAvg = trailingTotal / 5; // 5 months of trailing window
        if (trailingMonthlyAvg > 0 && recentTotal > trailingMonthlyAvg * 2) {
          out.push({
            ruleKey: "vendor_invoice_trend_anomaly",
            kind: "FINANCIAL",
            severity: "WATCH",
            title: `Vendor ${v.legalName}: invoice volume ${(recentTotal / trailingMonthlyAvg).toFixed(1)}x trailing average`,
            body: `Recent 30-day invoices total $${recentTotal.toFixed(2)} versus trailing monthly average $${trailingMonthlyAvg.toFixed(2)}. Confirm the activity is expected.`,
            entityType: "Vendor",
            entityId: v.id,
            meta: { recentTotal, trailingMonthlyAvg },
          });
        }
      }
      return out;
    },
  },
  labour_exceeds_budget: {
    definition: {
      name: "Labour costs exceeding budget",
      kind: "FINANCIAL",
      severity: "WARN",
      description: "Flags departments where actual wages exceed the budgeted wages for the current fiscal period.",
    },
    async run(clubId) {
      const labourBudgets = await prisma.labourBudget.findMany({ where: { clubId }, include: { department: true } });
      const out: InsightCandidate[] = [];
      for (const lb of labourBudgets) {
        const period = await prisma.payrollPeriod.findFirst({ where: { clubId, label: lb.periodLabel } });
        if (!period) continue;
        const lines = await prisma.payrollLine.findMany({ where: { clubId, run: { periodId: period.id } } });
        const actual = lines.reduce((s, l) => s + Number(l.grossPay.toString()), 0);
        const budget = Number(lb.budgetedCost.toString());
        if (budget > 0 && actual > budget * 1.1) {
          out.push({
            ruleKey: "labour_exceeds_budget",
            kind: "FINANCIAL",
            severity: "WARN",
            title: `Labour overrun: ${lb.department?.code ?? "ALL"} — ${((actual / budget - 1) * 100).toFixed(1)}% over`,
            body: `Actual wages $${actual.toFixed(2)} vs budget $${budget.toFixed(2)} for period ${lb.periodLabel}.`,
            entityType: "LabourBudget",
            entityId: lb.id,
            meta: { actual, budget },
          });
        }
      }
      return out;
    },
  },
  inventory_shrinkage_spike: {
    definition: {
      name: "Inventory shrinkage spikes",
      kind: "OPERATIONAL",
      severity: "WARN",
      description: "Flags items with shrinkage adjustments exceeding 5% of on-hand quantity in 30 days.",
    },
    async run(clubId) {
      const since = new Date(Date.now() - 30 * 86400000);
      const adjustments = await prisma.inventoryAdjustment.findMany({
        where: { clubId, reasonCode: { in: ["SHRINKAGE", "DAMAGE", "WRITE_OFF"] }, postedAt: { gte: since } },
        include: { item: true },
      });
      const byItem = new Map<string, number>();
      for (const a of adjustments) {
        const change = Math.abs(Number(a.quantityChange.toString()));
        byItem.set(a.itemId, (byItem.get(a.itemId) ?? 0) + change);
      }
      const out: InsightCandidate[] = [];
      for (const [itemId, shrink] of byItem.entries()) {
        const item = adjustments.find((a) => a.itemId === itemId)!.item;
        const onHand = Number(item.quantityOnHand.toString());
        if (onHand > 0 && shrink / onHand > 0.05) {
          out.push({
            ruleKey: "inventory_shrinkage_spike",
            kind: "OPERATIONAL",
            severity: "WARN",
            title: `${item.sku} · ${item.name} — shrinkage ${((shrink / onHand) * 100).toFixed(1)}% (30d)`,
            body: `Shrinkage of ${shrink} units exceeds 5% of on-hand quantity (${onHand}). Recommend a count.`,
            entityType: "InventoryItem",
            entityId: item.id,
            meta: { shrink, onHand },
          });
        }
      }
      return out;
    },
  },
  member_failed_payments_repeat: {
    definition: {
      name: "Members with repeated failed payments",
      kind: "RISK",
      severity: "WARN",
      description: "Flags members with two or more failed payments in 90 days.",
    },
    async run(clubId) {
      const since = new Date(Date.now() - 90 * 86400000);
      const failed = await prisma.payment.findMany({
        where: { clubId, status: "FAILED", paymentDate: { gte: since } },
        include: { member: true },
      });
      const byMember = new Map<string, number>();
      for (const p of failed) {
        if (!p.memberId) continue;
        byMember.set(p.memberId, (byMember.get(p.memberId) ?? 0) + 1);
      }
      const out: InsightCandidate[] = [];
      for (const [memberId, count] of byMember.entries()) {
        if (count >= 2) {
          const member = failed.find((p) => p.memberId === memberId)!.member;
          if (!member) continue;
          out.push({
            ruleKey: "member_failed_payments_repeat",
            kind: "RISK",
            severity: "WARN",
            title: `${member.firstName} ${member.lastName} — ${count} failed payments (90d)`,
            body: `Recommend a payment-method review before further collection action.`,
            entityType: "Member",
            entityId: memberId,
            meta: { count },
          });
        }
      }
      return out;
    },
  },
  financing_default_risk: {
    definition: {
      name: "Financing default risk",
      kind: "RISK",
      severity: "WATCH",
      description: "Flags financing agreements with any past-due schedule rows.",
    },
    async run(clubId) {
      const overdue = await prisma.financingPaymentSchedule.findMany({
        where: { clubId, status: "SCHEDULED", dueDate: { lt: new Date() } },
        include: { agreement: { include: { member: true } } },
      });
      const byAgreement = new Map<string, number>();
      for (const s of overdue) byAgreement.set(s.financingAgreementId, (byAgreement.get(s.financingAgreementId) ?? 0) + 1);
      const out: InsightCandidate[] = [];
      for (const [agreementId, count] of byAgreement.entries()) {
        const agreement = overdue.find((s) => s.financingAgreementId === agreementId)!.agreement;
        out.push({
          ruleKey: "financing_default_risk",
          kind: "RISK",
          severity: count > 2 ? "WARN" : "WATCH",
          title: `${agreement.member.firstName} ${agreement.member.lastName} — ${count} past-due schedule rows`,
          body: `Financing default watch — initiate a member-services call.`,
          entityType: "FinancingAgreement",
          entityId: agreementId,
          meta: { count },
        });
      }
      return out;
    },
  },
};

// ---------------------------------------------------------------------------
// Run rules
// ---------------------------------------------------------------------------
export async function runInsights(clubId: string, principal?: Principal | null) {
  const ruleRecords = await prisma.insightRule.findMany({ where: { clubId, isActive: true } });
  const ruleByKey = new Map(ruleRecords.map((r) => [r.key, r]));
  let raised = 0;
  for (const [key, rule] of Object.entries(INSIGHT_RULES)) {
    const dbRule = ruleByKey.get(key);
    if (dbRule && !dbRule.isActive) continue;
    const candidates = await rule.run(clubId);
    for (const c of candidates) {
      // Dedupe: don't raise the same insight twice within the same week.
      const recent = await prisma.insight.findFirst({
        where: {
          clubId,
          ruleId: dbRule?.id ?? null,
          entityType: c.entityType ?? null, entityId: c.entityId ?? null,
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
          raisedAt: { gte: new Date(Date.now() - 7 * 86400000) },
        },
      });
      if (recent) continue;
      await prisma.insight.create({
        data: {
          clubId,
          ruleId: dbRule?.id ?? null,
          kind: c.kind, severity: c.severity,
          title: c.title, body: c.body,
          entityType: c.entityType ?? null, entityId: c.entityId ?? null,
          metaJson: c.meta ? JSON.stringify(c.meta) : null,
          status: "OPEN",
        },
      });
      raised++;
    }
  }
  if (principal) {
    await audit(principal, { action: "insights.run", entityType: "Club", entityId: clubId, clubId, after: { raised } });
  }
  return { raised };
}

export async function ensureSystemRules(clubId: string) {
  for (const [key, rule] of Object.entries(INSIGHT_RULES)) {
    await prisma.insightRule.upsert({
      where: { clubId_key: { clubId, key } },
      update: { name: rule.definition.name, kind: rule.definition.kind, severity: rule.definition.severity, description: rule.definition.description, isActive: true },
      create: { clubId, key, name: rule.definition.name, kind: rule.definition.kind, severity: rule.definition.severity, description: rule.definition.description },
    });
  }
}

export async function listInsights(principal: Principal, clubId: string, opts?: { status?: string }) {
  requirePermission(principal, clubId, "insights:read");
  return prisma.insight.findMany({
    where: { ...tenantWhere(principal, clubId), ...(opts?.status ? { status: opts.status } : { status: "OPEN" }) },
    include: { rule: true },
    orderBy: [{ severity: "desc" }, { raisedAt: "desc" }],
    take: 200,
  });
}

export async function acknowledgeInsight(principal: Principal, insightId: string) {
  const i = await prisma.insight.findUnique({ where: { id: insightId } });
  if (!i) return null;
  requirePermission(principal, i.clubId, "insights:read");
  return prisma.insight.update({
    where: { id: insightId },
    data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedByUserId: principal.id },
  });
}

export async function resolveInsight(principal: Principal, insightId: string) {
  const i = await prisma.insight.findUnique({ where: { id: insightId } });
  if (!i) return null;
  requirePermission(principal, i.clubId, "insights:write");
  return prisma.insight.update({
    where: { id: insightId },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
}
