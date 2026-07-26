"use server";

// Step 32 — Floor-plan editor server actions.
// Thin try/catch wrappers around src/lib/hospitality/floor-plan.ts.
// Step 33 — adds defense-in-depth permission re-checks at the action
// boundary and preserves ValidationError detail so the editor can
// show admins which specific rows / fields blocked publish.

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isAppError, ValidationError } from "@/lib/errors";
import { requirePermission } from "@/lib/rbac";
import type { PermissionKey } from "@/lib/permissions";
import {
  getOrCreateDraftForArea,
  addDraftTable,
  addDraftTableFromPalette,
  updateDraftTable,
  archiveDraftTable,
  discardDraft,
  publishDraft,
  validateDraftForPublish,
} from "@/lib/hospitality/floor-plan";

type Ok<T> = { ok: true; data: T };
type Err = { ok: false; error: string; issues?: Array<{ path: string; message: string }> };
type Result<T> = Ok<T> | Err;

// Step 33 — surface ValidationError.issues so the editor can show
// per-field errors instead of a generic "Validation failed".
function fail(err: unknown, fallback: string): Err {
  if (err instanceof ValidationError) {
    return {
      ok: false,
      error: err.issues.length > 0
        ? err.issues.map((i) => i.message).join("; ")
        : err.safeMessage,
      issues: err.issues,
    };
  }
  return { ok: false, error: isAppError(err) ? err.safeMessage : fallback };
}
function unauthorized(): Err { return { ok: false, error: "Not signed in" }; }

async function ctx() {
  const p = await getCurrentPrincipal();
  if (!p) return null;
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  return { p, clubId };
}

// Defense-in-depth: each action re-asserts its required permission at
// the action boundary, even though the service layer also calls
// requirePermission. Catches future refactors that bypass the service.
function gate(c: { p: import("@/lib/rbac").Principal; clubId: string }, perm: PermissionKey) {
  requirePermission(c.p, c.clubId, perm);
}

function reval() {
  revalidatePath("/app/admin/ops/floor-plans");
  revalidatePath("/app/admin/hospitality/reservations/floor");
}

export async function startDraftAction(diningAreaId: string): Promise<Result<{ planId: string }>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    gate(c, "hospitality:floor:edit");
    const plan = await getOrCreateDraftForArea(c.p, c.clubId, diningAreaId);
    reval();
    return { ok: true, data: { planId: plan.id } };
  } catch (err) { return fail(err, "Could not open draft"); }
}

export async function addTableAction(planId: string, input: {
  tableNumber: string;
  displayName?: string | null;
  shape: "ROUND" | "SQUARE" | "RECTANGLE";
  capacity: number;
  xPos: number;
  yPos: number;
  width: number;
  height: number;
  rotation?: number;
}): Promise<Result<{ id: string }>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    gate(c, "hospitality:floor:edit");
    const row = await addDraftTable(c.p, planId, input);
    reval();
    return { ok: true, data: { id: row.id } };
  } catch (err) { return fail(err, "Could not add table"); }
}

// Step 35/36 — palette drop. Auto-names + sizes + delegates to add.
// `kind` is the palette vocabulary (Round/Square/Rectangle/Bar Stool).
export async function addTableFromPaletteAction(planId: string, input: {
  kind: "ROUND" | "SQUARE" | "RECTANGLE" | "BAR_STOOL";
  xPos: number;
  yPos: number;
}): Promise<Result<{ id: string; tableNumber: string; displayName: string | null }>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    gate(c, "hospitality:floor:edit");
    const row = await addDraftTableFromPalette(c.p, planId, input);
    reval();
    return {
      ok: true,
      data: { id: row.id, tableNumber: row.tableNumber, displayName: row.displayName },
    };
  } catch (err) { return fail(err, "Could not add table from palette"); }
}

export async function updateTableAction(planTableId: string, patch: {
  tableNumber?: string;
  displayName?: string | null;
  shape?: "ROUND" | "SQUARE" | "RECTANGLE";
  capacity?: number;
  xPos?: number;
  yPos?: number;
  width?: number;
  height?: number;
  rotation?: number;
}): Promise<Result<{ ok: true }>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    gate(c, "hospitality:floor:edit");
    await updateDraftTable(c.p, planTableId, patch);
    reval();
    return { ok: true, data: { ok: true } };
  } catch (err) { return fail(err, "Could not update table"); }
}

export async function archiveTableAction(planTableId: string): Promise<Result<{ ok: true }>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    gate(c, "hospitality:floor:edit");
    await archiveDraftTable(c.p, planTableId);
    reval();
    return { ok: true, data: { ok: true } };
  } catch (err) { return fail(err, "Could not archive table"); }
}

export async function discardDraftAction(planId: string): Promise<Result<{ ok: true }>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    gate(c, "hospitality:floor:edit");
    await discardDraft(c.p, planId);
    reval();
    return { ok: true, data: { ok: true } };
  } catch (err) { return fail(err, "Could not discard draft"); }
}

export async function validatePublishAction(planId: string): Promise<Result<{
  issues: Array<{ planTableId: string | null; tableNumber: string | null; message: string }>;
}>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    gate(c, "hospitality:floor:view");
    const issues = await validateDraftForPublish(c.p, planId);
    return { ok: true, data: { issues } };
  } catch (err) { return fail(err, "Could not validate"); }
}

export async function publishDraftAction(planId: string): Promise<Result<{ summary: {
  created: number; updated: number; archived: number;
}}>> {
  const c = await ctx(); if (!c) return unauthorized();
  try {
    gate(c, "hospitality:floor:publish");
    const r = await publishDraft(c.p, planId);
    reval();
    return { ok: true, data: { summary: r.summary } };
  } catch (err) { return fail(err, "Could not publish draft"); }
}
