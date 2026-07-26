// Phase 14H — Cross-club implementation playbook.
//
// Static, evergreen content for the implementation team. Each playbook entry
// becomes a task in a PilotOnboardingProject when `cloneIntoProject()` is
// called. The order matches the real-world implementation calendar.
//
// Updates to the playbook take effect for new projects only — already-cloned
// tasks remain stable so an in-flight implementation doesn't get its plan
// rewritten under it.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { isSuperAdmin, requirePermission, type Principal } from "../rbac";
import { ForbiddenError, NotFoundError } from "../errors";

export type PlaybookEntry = {
  stepKey: string;       // pairs with the wizard step in pilot-onboarding
  ordering: number;
  title: string;         // becomes the PilotOnboardingTask.title
  description: string;
  ownerRole: "IMPLEMENTATION_LEAD" | "FINANCE_LEAD" | "OPS_LEAD" | "MEMBERSHIP_LEAD" | "CLUB_GM";
  estimateDays: number;
};

export const PLAYBOOK: PlaybookEntry[] = [
  // --- Pre-kickoff --------------------------------------------------------
  { stepKey: "club_profile", ordering: 10, title: "Confirm legal entity name + DBA, fiscal year, currency", description: "Gather club legal name, doing-business-as name, registered region (sales-tax jurisdiction), fiscal-year start month. Will drive Spectre's club + accounting setup.", ownerRole: "IMPLEMENTATION_LEAD", estimateDays: 1 },
  { stepKey: "branding", ordering: 20, title: "Collect logo + colors + email-from address", description: "Hi-res logo (SVG preferred), primary brand color, the no-reply email address used for member portal invites. Configure in /app/admin/settings.", ownerRole: "MEMBERSHIP_LEAD", estimateDays: 1 },

  // --- Finance setup ------------------------------------------------------
  { stepKey: "fiscal", ordering: 30, title: "Open the first fiscal year + monthly periods", description: "Create the fiscal year that will own the opening journal, then seed the 12 monthly periods. Period 1 will hold opening balances.", ownerRole: "FINANCE_LEAD", estimateDays: 1 },
  { stepKey: "tax", ordering: 40, title: "Activate jurisdiction tax codes (GST/HST/PST/state)", description: "Confirm which tax codes apply at the club's region. Tax codes can't be retroactively edited after the first posted journal — get them right now.", ownerRole: "FINANCE_LEAD", estimateDays: 1 },
  { stepKey: "membership_categories", ordering: 50, title: "Define membership categories + dues amounts", description: "Each membership category becomes a billing rule. Confirm with the club: dues frequency, initiation fee policy, capital assessment cadence.", ownerRole: "MEMBERSHIP_LEAD", estimateDays: 2 },
  { stepKey: "coa", ordering: 60, title: "Map the legacy chart of accounts into the Spectre COA template", description: "Run /app/admin/imports with the 'Jonas — Chart of accounts' template (or generic CSV). Reconcile every legacy account to a Spectre account or mark it archived.", ownerRole: "FINANCE_LEAD", estimateDays: 3 },
  { stepKey: "departments", ordering: 70, title: "Seed departments + cost centers", description: "Pro Shop, F&B, Course Maintenance, Administration at a minimum. Each posting will be department-tagged for the operating P&L.", ownerRole: "OPS_LEAD", estimateDays: 1 },

  // --- Data migration -----------------------------------------------------
  { stepKey: "opening_balances", ordering: 80, title: "Stage and post opening balances", description: "Upload trial balance via /app/admin/imports (OPENING_TRIAL_BALANCE), upload AR + AP subledgers, validate reconciliation, post the opening journal, lock the set.", ownerRole: "FINANCE_LEAD", estimateDays: 3 },
  { stepKey: "members_import", ordering: 90, title: "Import the member roster", description: "Run /app/admin/imports with the 'Jonas — Members export' template. Dry-run, fix errors, commit. Verify member counts before issuing invites.", ownerRole: "MEMBERSHIP_LEAD", estimateDays: 2 },
  { stepKey: "vendors_import", ordering: 100, title: "Import vendors + payment terms", description: "Run /app/admin/imports with the 'Jonas — Vendors export' template. Vendors arrive as DRAFT; finance reviews and activates each.", ownerRole: "FINANCE_LEAD", estimateDays: 2 },

  // --- People + access ----------------------------------------------------
  { stepKey: "staff", ordering: 110, title: "Create staff users + assign roles", description: "Add Controller, GM, department managers. Use the least-privilege role for each. Send invites; staff will set up MFA on first login.", ownerRole: "CLUB_GM", estimateDays: 1 },
  { stepKey: "feature_flags", ordering: 120, title: "Pick the pilot feature set", description: "/app/admin/pilot — turn off modules the club won't use at launch (e.g. tournaments if golf is dormant in shoulder season). Reduces training surface area.", ownerRole: "IMPLEMENTATION_LEAD", estimateDays: 1 },

  // --- Integrations -------------------------------------------------------
  { stepKey: "integrations", ordering: 130, title: "Wire email + storage + (optional) POS", description: "Configure SES / Postmark adapter, storage provider (S3 or local), and any POS integration. Verify with a test send + a test upload.", ownerRole: "OPS_LEAD", estimateDays: 2 },
  { stepKey: "billing", ordering: 140, title: "Activate SaaS billing / Stripe customer", description: "Create the BillingCustomer + ClubSubscription with the pilot's negotiated plan. Confirm webhook endpoint is reachable.", ownerRole: "IMPLEMENTATION_LEAD", estimateDays: 1 },

  // --- Readiness ----------------------------------------------------------
  { stepKey: "readiness", ordering: 150, title: "Run /app/admin/pilot/go-live/<projectId> and clear all hard blocks", description: "Smoke tests must pass, all required steps + signoffs complete, training mode disabled, no open HIGH/CRITICAL blockers. Then GO recommendation appears.", ownerRole: "IMPLEMENTATION_LEAD", estimateDays: 1 },
];

// ---------------------------------------------------------------------------
// Read API — used by the Playbook UI.
// ---------------------------------------------------------------------------
export function getPlaybook() {
  return [...PLAYBOOK].sort((a, b) => a.ordering - b.ordering);
}

// ---------------------------------------------------------------------------
// Clone — copies the playbook into a project's task list.
// Idempotent: titles + stepKeys are matched on existing tasks to avoid dupes.
// ---------------------------------------------------------------------------
export async function cloneIntoProject(principal: Principal, projectId: string) {
  const project = await prisma.pilotOnboardingProject.findUnique({ where: { id: projectId } });
  if (!project) throw new NotFoundError("PilotOnboardingProject", projectId);
  if (!isSuperAdmin(principal)) requirePermission(principal, project.clubId, "settings:write");

  // Build a "(title|stepKey)" set of what's already on the project.
  const existing = await prisma.pilotOnboardingTask.findMany({
    where: { projectId },
    select: { title: true, stepKey: true },
  });
  const seen = new Set(existing.map((t) => `${t.stepKey ?? ""}|${t.title}`));

  let created = 0;
  for (const entry of getPlaybook()) {
    const key = `${entry.stepKey}|${entry.title}`;
    if (seen.has(key)) continue;
    await prisma.pilotOnboardingTask.create({
      data: {
        clubId: project.clubId,
        projectId: project.id,
        stepKey: entry.stepKey,
        title: entry.title,
        description: `[${entry.ownerRole}] ${entry.description}`,
        status: "PENDING",
      },
    });
    created++;
  }
  await audit(principal, {
    action: "pilot.playbook.clone",
    entityType: "PilotOnboardingProject",
    entityId: project.id,
    clubId: project.clubId,
    after: { created, total: PLAYBOOK.length },
  });
  return { created, skipped: PLAYBOOK.length - created };
}

// ---------------------------------------------------------------------------
// Export to plaintext markdown — for the implementation team to share.
// ---------------------------------------------------------------------------
export function exportMarkdown(): string {
  const lines: string[] = ["# Spectre — Pilot Implementation Playbook", ""];
  lines.push("This playbook is the canonical step-by-step for onboarding a new private club onto Spectre. Each entry maps to a step in the in-app /app/admin/pilot/onboarding wizard.");
  lines.push("");
  let lastSection = "";
  for (const entry of getPlaybook()) {
    const section = entry.stepKey;
    if (section !== lastSection) {
      lines.push(`## ${section}`);
      lines.push("");
      lastSection = section;
    }
    lines.push(`### ${entry.title}`);
    lines.push("");
    lines.push(`- **Owner:** ${entry.ownerRole}`);
    lines.push(`- **Estimate:** ${entry.estimateDays} day(s)`);
    lines.push("");
    lines.push(entry.description);
    lines.push("");
  }
  return lines.join("\n");
}
