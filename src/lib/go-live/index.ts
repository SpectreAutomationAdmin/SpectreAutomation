// Phase 13L — Pilot go-live control center.
//
// Aggregates everything an implementation team needs to see before flipping
// a pilot club to GO_LIVE. Combines:
//   - PilotOnboardingProject (steps, blockers, signoffs)
//   - ImportBatch status by domain
//   - OpeningBalanceSet status
//   - MemberPortalInvite stats
//   - Training scenario completion
//   - SupportTicket open count
//   - SmokeTest summary
//   - Launch readiness checks

import { prisma } from "../prisma";
import { type Principal } from "../rbac";
import { readinessSummary } from "../pilot-onboarding";
import { runSmokeTests, summarizeResults, type SmokeResult } from "../smoke";
import { runLaunchChecks, type LaunchCheck } from "../launch";
import { hasPermission } from "../rbac";

export type GoLiveSnapshot = {
  project: Awaited<ReturnType<typeof readinessSummary>>;
  imports: { domain: string; status: string; count: number }[];
  openingBalances: { status: string; count: number }[];
  invites: Record<string, number>;
  training: { enabled: boolean; scenariosTotal: number; scenariosCompleted: number };
  openTickets: number;
  openIncidents: number;
  smoke: { results: SmokeResult[]; summary: ReturnType<typeof summarizeResults> };
  launch: LaunchCheck[];
  recommendation: "GO" | "CAUTION" | "NO_GO";
  hardBlocks: string[];
  warnings: string[];
};

export async function buildSnapshot(principal: Principal, projectId: string): Promise<GoLiveSnapshot> {
  const project = await readinessSummary(principal, projectId);
  const clubId = project.project.clubId;

  const [
    imports, openingBalances, invitesByStatus, trainingMode, scenarios, tickets, incidents,
    // Phase 14I additions
    importTemplates, emailProviderConfigured, bounceCount24h, retroExists,
    publishedTemplateCount, openBalancesPosted,
  ] = await Promise.all([
    prisma.importBatch.groupBy({ by: ["domain", "status"], where: { clubId }, _count: true }),
    prisma.openingBalanceSet.groupBy({ by: ["status"], where: { clubId }, _count: true }),
    prisma.memberPortalInvite.groupBy({ by: ["status"], where: { clubId }, _count: true }),
    prisma.clubTrainingMode.findUnique({ where: { clubId } }),
    prisma.trainingScenario.findMany({ where: { clubId }, select: { status: true } }),
    prisma.supportTicket.count({ where: { clubId, status: { in: ["OPEN", "IN_PROGRESS"] } } }),
    prisma.incident.count({ where: { clubId, status: { in: ["OPEN", "TRIAGING", "IN_PROGRESS"] } } }),
    // 14I
    prisma.importTemplate.count({ where: { OR: [{ scope: "GLOBAL" }, { clubId }], status: "PUBLISHED" } }),
    prisma.integrationSetting.count({ where: { clubId, scope: "EMAIL", isActive: true } }),
    prisma.emailDeliveryEvent.count({ where: { clubId, kind: { in: ["HARD_BOUNCE", "SPAM_COMPLAINT"] }, occurredAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }),
    prisma.pilotRetrospective.count({ where: { clubId } }),
    prisma.importTemplate.count({ where: { OR: [{ scope: "GLOBAL" }, { clubId }], status: "PUBLISHED" } }),
    prisma.openingBalanceSet.count({ where: { clubId, status: { in: ["POSTED", "LOCKED"] } } }),
  ]);
  void publishedTemplateCount; void openBalancesPosted;

  const smokeResults = await runSmokeTests();
  const smokeSummary = summarizeResults(smokeResults);
  const launch: LaunchCheck[] = hasPermission(principal, clubId, "settings:read")
    ? await runLaunchChecks(principal, clubId)
    : [];

  // Hard blocks + warnings.
  const hardBlocks: string[] = [];
  const warnings: string[] = [];
  for (const hb of project.hardBlocks) hardBlocks.push(`${hb.kind}: ${hb.label}`);
  if (smokeSummary.fail > 0) hardBlocks.push(`Smoke test failures: ${smokeResults.filter((r) => r.status === "FAIL").map((r) => r.key).join(", ")}`);
  const launchHardFails = launch.filter((c) => c.severity === "HARD_BLOCK" && c.status === "FAIL");
  for (const c of launchHardFails) hardBlocks.push(`Launch: ${c.label}`);
  if (smokeSummary.warn > 0) warnings.push(`${smokeSummary.warn} smoke warning(s)`);
  const launchWarn = launch.filter((c) => c.status === "FAIL" && c.severity === "WARNING");
  for (const c of launchWarn) warnings.push(`Launch: ${c.label}`);
  if (incidents > 0) warnings.push(`${incidents} open incident(s)`);
  if (tickets > 5) warnings.push(`${tickets} open support tickets`);
  // Phase 14I — additional hard blocks
  if (importTemplates === 0) warnings.push("No import templates published — Jonas migration will be slow");
  if (emailProviderConfigured === 0) hardBlocks.push("Email provider not configured — member invites will not deliver");
  if (bounceCount24h > 10) warnings.push(`${bounceCount24h} hard email bounces in last 24h — investigate before bulk invite`);
  if (retroExists === 0) warnings.push("No retrospective scheduled — plan Day 1 / Week 1 reviews");

  const recommendation: GoLiveSnapshot["recommendation"] =
    hardBlocks.length > 0 ? "NO_GO" : warnings.length > 0 ? "CAUTION" : "GO";

  return {
    project,
    imports: imports.map((g) => ({ domain: g.domain, status: g.status, count: g._count })),
    openingBalances: openingBalances.map((g) => ({ status: g.status, count: g._count })),
    invites: Object.fromEntries(invitesByStatus.map((g) => [g.status, g._count])),
    training: {
      enabled: trainingMode?.enabled ?? false,
      scenariosTotal: scenarios.length,
      scenariosCompleted: scenarios.filter((s) => s.status === "COMPLETED").length,
    },
    openTickets: tickets,
    openIncidents: incidents,
    smoke: { results: smokeResults, summary: smokeSummary },
    launch,
    recommendation,
    hardBlocks,
    warnings,
  };
}
