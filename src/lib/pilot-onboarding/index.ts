// Phase 13A — Pilot onboarding wizard.
//
// Walks SUPER_ADMIN / implementation staff through configuring a new pilot
// club. Saves progress per step so they can resume later. Steps are seeded
// once per project; the wizard fills the per-step dataJson and toggles status.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { isSuperAdmin, requirePermission, type Principal } from "../rbac";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";

export const ONBOARDING_STEPS: ReadonlyArray<{ key: string; label: string; required: boolean }> = [
  { key: "club_profile", label: "Club profile", required: true },
  { key: "branding", label: "Branding", required: false },
  { key: "fiscal", label: "Fiscal year + periods", required: true },
  { key: "tax", label: "Tax codes", required: true },
  { key: "membership_categories", label: "Membership categories", required: true },
  { key: "coa", label: "Chart of accounts", required: true },
  { key: "departments", label: "Departments / cost centers", required: true },
  { key: "opening_balances", label: "Opening balances", required: true },
  { key: "members_import", label: "Member import", required: true },
  { key: "vendors_import", label: "Vendor import", required: false },
  { key: "staff", label: "Staff / admin user setup", required: true },
  { key: "feature_flags", label: "Feature flags", required: false },
  { key: "integrations", label: "Integrations", required: false },
  { key: "billing", label: "Billing / subscription", required: true },
  { key: "readiness", label: "Readiness confirmation", required: true },
];

function ensureCanManage(principal: Principal, clubId: string) {
  // Only SUPER_ADMIN or implementation staff (settings:write) can run the wizard.
  if (isSuperAdmin(principal)) return;
  requirePermission(principal, clubId, "settings:write");
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
export const createProjectSchema = z.object({
  clubId: z.string(),
  name: z.string().min(1).max(160),
  targetGoLiveAt: z.string().datetime().optional(),
  ownerUserId: z.string().optional(),
});

export async function createProject(principal: Principal, raw: unknown) {
  const parsed = createProjectSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  ensureCanManage(principal, parsed.data.clubId);
  const club = await prisma.club.findUnique({ where: { id: parsed.data.clubId } });
  if (!club) throw new NotFoundError("Club", parsed.data.clubId);
  const existing = await prisma.pilotOnboardingProject.findUnique({ where: { clubId_name: { clubId: parsed.data.clubId, name: parsed.data.name } } });
  if (existing) throw new ConflictError(`Onboarding project ${parsed.data.name} already exists`);
  const project = await prisma.$transaction(async (tx) => {
    const p = await tx.pilotOnboardingProject.create({
      data: {
        clubId: parsed.data.clubId,
        name: parsed.data.name,
        status: "DRAFT",
        targetGoLiveAt: parsed.data.targetGoLiveAt ? new Date(parsed.data.targetGoLiveAt) : null,
        ownerUserId: parsed.data.ownerUserId ?? null,
        createdByUserId: principal.id,
      },
    });
    await tx.pilotOnboardingStep.createMany({
      data: ONBOARDING_STEPS.map((s, i) => ({
        clubId: parsed.data.clubId, projectId: p.id, stepKey: s.key, label: s.label,
        ordering: i, status: "PENDING",
      })),
    });
    // Seed default signoff slots (one per category).
    for (const category of ["FINANCE", "OPS", "MEMBERSHIP", "SECURITY", "EXECUTIVE"] as const) {
      await tx.pilotGoLiveSignoff.create({
        data: { clubId: parsed.data.clubId, projectId: p.id, category, status: "PENDING" },
      });
    }
    return p;
  });
  await audit(principal, { action: "pilot.onboarding.create", entityType: "PilotOnboardingProject", entityId: project.id, clubId: parsed.data.clubId, after: { name: project.name } });
  return project;
}

export async function getProject(principal: Principal, projectId: string) {
  const project = await prisma.pilotOnboardingProject.findUnique({
    where: { id: projectId },
    include: {
      steps: { orderBy: { ordering: "asc" } },
      tasks: { orderBy: { createdAt: "desc" } },
      blockers: { orderBy: { openedAt: "desc" } },
      notes: { orderBy: { createdAt: "desc" }, take: 20 },
      signoffs: true,
    },
  });
  if (!project) throw new NotFoundError("PilotOnboardingProject", projectId);
  ensureCanManage(principal, project.clubId);
  return project;
}

export async function listProjects(principal: Principal, clubId?: string) {
  if (clubId) ensureCanManage(principal, clubId);
  else if (!isSuperAdmin(principal)) throw new ForbiddenError("Cross-club project list is super-admin only");
  return prisma.pilotOnboardingProject.findMany({
    where: clubId ? { clubId } : {},
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { blockers: true, tasks: true } },
      steps: { select: { status: true } },
    },
  });
}

// ---------------------------------------------------------------------------
// Step updates — save progress & toggle status
// ---------------------------------------------------------------------------
export const saveStepSchema = z.object({
  projectId: z.string(),
  stepKey: z.string(),
  status: z.enum(["PENDING", "IN_PROGRESS", "COMPLETED", "BLOCKED", "SKIPPED"]),
  dataJson: z.string().optional(), // arbitrary opaque step payload
});

export async function saveStep(principal: Principal, raw: unknown) {
  const parsed = saveStepSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const project = await prisma.pilotOnboardingProject.findUnique({ where: { id: parsed.data.projectId } });
  if (!project) throw new NotFoundError("PilotOnboardingProject", parsed.data.projectId);
  ensureCanManage(principal, project.clubId);
  const step = await prisma.pilotOnboardingStep.findUnique({
    where: { projectId_stepKey: { projectId: parsed.data.projectId, stepKey: parsed.data.stepKey } },
  });
  if (!step) throw new NotFoundError("PilotOnboardingStep", parsed.data.stepKey);
  const updated = await prisma.pilotOnboardingStep.update({
    where: { id: step.id },
    data: {
      status: parsed.data.status,
      dataJson: parsed.data.dataJson ?? step.dataJson,
      completedAt: parsed.data.status === "COMPLETED" ? new Date() : null,
      completedByUserId: parsed.data.status === "COMPLETED" ? principal.id : null,
    },
  });
  // Bump project status to IN_PROGRESS the first time any step starts.
  if (project.status === "DRAFT") {
    await prisma.pilotOnboardingProject.update({ where: { id: project.id }, data: { status: "IN_PROGRESS" } });
  }
  await audit(principal, { action: "pilot.onboarding.step", entityType: "PilotOnboardingStep", entityId: step.id, clubId: project.clubId, after: { stepKey: step.stepKey, status: parsed.data.status } });
  return updated;
}

// ---------------------------------------------------------------------------
// Notes, tasks, blockers
// ---------------------------------------------------------------------------
export async function addNote(principal: Principal, projectId: string, body: string) {
  if (body.trim().length === 0) throw new ValidationError([{ path: "body", message: "Note body required" }]);
  const project = await prisma.pilotOnboardingProject.findUnique({ where: { id: projectId } });
  if (!project) throw new NotFoundError("PilotOnboardingProject", projectId);
  ensureCanManage(principal, project.clubId);
  return prisma.pilotOnboardingNote.create({
    data: { clubId: project.clubId, projectId, body: body.trim().slice(0, 4000), byUserId: principal.id },
  });
}

export const taskSchema = z.object({
  projectId: z.string(),
  stepKey: z.string().optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  ownerUserId: z.string().optional(),
  dueDate: z.string().datetime().optional(),
});

export async function addTask(principal: Principal, raw: unknown) {
  const parsed = taskSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const project = await prisma.pilotOnboardingProject.findUnique({ where: { id: parsed.data.projectId } });
  if (!project) throw new NotFoundError("PilotOnboardingProject", parsed.data.projectId);
  ensureCanManage(principal, project.clubId);
  return prisma.pilotOnboardingTask.create({
    data: {
      clubId: project.clubId, projectId: parsed.data.projectId,
      stepKey: parsed.data.stepKey ?? null, title: parsed.data.title,
      description: parsed.data.description ?? null,
      ownerUserId: parsed.data.ownerUserId ?? null,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
    },
  });
}

export async function setTaskStatus(principal: Principal, taskId: string, status: "PENDING" | "IN_PROGRESS" | "DONE" | "BLOCKED") {
  const task = await prisma.pilotOnboardingTask.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("PilotOnboardingTask", taskId);
  ensureCanManage(principal, task.clubId);
  return prisma.pilotOnboardingTask.update({
    where: { id: task.id },
    data: { status, completedAt: status === "DONE" ? new Date() : null },
  });
}

export const blockerSchema = z.object({
  projectId: z.string(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
});

export async function openBlocker(principal: Principal, raw: unknown) {
  const parsed = blockerSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const project = await prisma.pilotOnboardingProject.findUnique({ where: { id: parsed.data.projectId } });
  if (!project) throw new NotFoundError("PilotOnboardingProject", parsed.data.projectId);
  ensureCanManage(principal, project.clubId);
  const blocker = await prisma.pilotOnboardingBlocker.create({
    data: {
      clubId: project.clubId, projectId: parsed.data.projectId,
      severity: parsed.data.severity, title: parsed.data.title,
      description: parsed.data.description ?? null, status: "OPEN",
      openedByUserId: principal.id,
    },
  });
  await audit(principal, { action: "pilot.onboarding.blocker.open", entityType: "PilotOnboardingBlocker", entityId: blocker.id, clubId: project.clubId, after: { severity: blocker.severity, title: blocker.title } });
  return blocker;
}

export async function resolveBlocker(principal: Principal, blockerId: string, status: "RESOLVED" | "WONT_FIX" = "RESOLVED") {
  const b = await prisma.pilotOnboardingBlocker.findUnique({ where: { id: blockerId } });
  if (!b) throw new NotFoundError("PilotOnboardingBlocker", blockerId);
  ensureCanManage(principal, b.clubId);
  const updated = await prisma.pilotOnboardingBlocker.update({
    where: { id: b.id },
    data: { status, resolvedAt: new Date(), resolvedByUserId: principal.id },
  });
  await audit(principal, { action: "pilot.onboarding.blocker.resolve", entityType: "PilotOnboardingBlocker", entityId: b.id, clubId: b.clubId, after: { status } });
  return updated;
}

// ---------------------------------------------------------------------------
// Readiness summary + go-live approval
// ---------------------------------------------------------------------------
export async function readinessSummary(principal: Principal, projectId: string) {
  const project = await getProject(principal, projectId);
  const requiredKeys = new Set(ONBOARDING_STEPS.filter((s) => s.required).map((s) => s.key));
  const incompleteRequired = project.steps.filter((s) => requiredKeys.has(s.stepKey) && s.status !== "COMPLETED" && s.status !== "SKIPPED");
  const openBlockers = project.blockers.filter((b) => b.status === "OPEN");
  const pendingSignoffs = project.signoffs.filter((s) => s.status !== "SIGNED");
  const hardBlocks = [
    ...incompleteRequired.map((s) => ({ kind: "STEP", label: s.label })),
    ...openBlockers.filter((b) => b.severity === "HIGH" || b.severity === "CRITICAL").map((b) => ({ kind: "BLOCKER", label: b.title })),
    ...pendingSignoffs.map((s) => ({ kind: "SIGNOFF", label: s.category })),
  ];
  return {
    project,
    canGoLive: hardBlocks.length === 0,
    hardBlocks,
    openBlockers,
    pendingSignoffs,
    incompleteRequired,
  };
}

export async function recordSignoff(principal: Principal, args: { projectId: string; category: string; notes?: string; status: "SIGNED" | "REJECTED" }) {
  const project = await prisma.pilotOnboardingProject.findUnique({ where: { id: args.projectId } });
  if (!project) throw new NotFoundError("PilotOnboardingProject", args.projectId);
  ensureCanManage(principal, project.clubId);
  const signoff = await prisma.pilotGoLiveSignoff.findUnique({
    where: { projectId_category: { projectId: args.projectId, category: args.category } },
  });
  if (!signoff) throw new NotFoundError("PilotGoLiveSignoff", args.category);
  const updated = await prisma.pilotGoLiveSignoff.update({
    where: { id: signoff.id },
    data: {
      status: args.status, signedAt: new Date(),
      signedByUserId: principal.id, notes: args.notes ?? signoff.notes,
    },
  });
  await audit(principal, { action: "pilot.onboarding.signoff", entityType: "PilotGoLiveSignoff", entityId: signoff.id, clubId: project.clubId, after: { category: args.category, status: args.status } });
  return updated;
}

export async function approveGoLive(principal: Principal, projectId: string) {
  const summary = await readinessSummary(principal, projectId);
  if (!summary.canGoLive) {
    throw new ConflictError(`Go-live blocked by ${summary.hardBlocks.length} item(s)`);
  }
  const project = summary.project;
  const updated = await prisma.pilotOnboardingProject.update({
    where: { id: project.id },
    data: {
      status: "GO_LIVE",
      goLiveApprovedAt: new Date(),
      goLiveApprovedByUserId: principal.id,
    },
  });
  await audit(principal, { action: "pilot.onboarding.go_live", entityType: "PilotOnboardingProject", entityId: project.id, clubId: project.clubId });
  return updated;
}
