"use server";

// Server actions for the Governance → Board & Committees admin
// surface.
//
// Three row-level actions (assign / update / delete). All wrap the
// library functions, which carry the tenant + `packages:write`
// permission gates. Flash messaging via redirect-with-search-params
// — same pattern the Monthly Package archive uses, since Server
// Components can't mutate cookies during render.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import {
  assignBoardRole,
  deleteBoardRole,
  updateBoardRole,
  type BoardRoleStatus,
} from "@/lib/governance/board-roles";
import { getActiveClubId } from "@/lib/active-club";
import { isAppError } from "@/lib/errors";
import { getCurrentPrincipal } from "@/lib/services/principal";

const ROSTER_PATH = "/app/admin/governance/board-committees";

function redirectWithFlash(
  kind: "notice" | "error",
  message: string,
): never {
  revalidatePath(ROSTER_PATH);
  redirect(`${ROSTER_PATH}?${kind}=${encodeURIComponent(message)}`);
}

function parseDateInput(raw: FormDataEntryValue | null): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // <input type="date"> emits YYYY-MM-DD. Build a UTC midnight Date
  // so the boundary check (term-start vs today) doesn't drift across
  // timezones.
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(s);
  if (!match) return null;
  const [, y, m, d] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

// ---------------------------------------------------------------------------
// assign
// ---------------------------------------------------------------------------

export async function assignBoardRoleAction(formData: FormData): Promise<void> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });

  const memberId = String(formData.get("memberId") ?? "").trim();
  const roleTitle = String(formData.get("roleTitle") ?? "").trim();
  const committeeNameRaw = String(formData.get("committeeName") ?? "").trim();
  const termStartDate = parseDateInput(formData.get("termStartDate"));
  const termEndDate = parseDateInput(formData.get("termEndDate"));
  const statusRaw = String(formData.get("status") ?? "").trim();
  const status = statusRaw && ["UPCOMING", "ACTIVE", "EXPIRED"].includes(statusRaw)
    ? (statusRaw as BoardRoleStatus)
    : undefined;

  if (!memberId) redirectWithFlash("error", "Pick a member before saving.");
  if (!roleTitle) redirectWithFlash("error", "Choose a board title or committee role.");
  if (!termStartDate) redirectWithFlash("error", "Term start date is required.");
  if (!termEndDate) redirectWithFlash("error", "Term end date is required.");

  try {
    await assignBoardRole(principal, {
      clubId,
      memberId,
      roleTitle,
      committeeName: committeeNameRaw || null,
      termStartDate: termStartDate!,
      termEndDate: termEndDate!,
      status,
    });
  } catch (err) {
    if (isAppError(err)) redirectWithFlash("error", err.safeMessage);
    throw err;
  }
  redirectWithFlash("notice", `Assigned ${roleTitle}.`);
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

export async function updateBoardRoleAction(
  roleId: string,
  formData: FormData,
): Promise<void> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  const roleTitle = String(formData.get("roleTitle") ?? "").trim();
  const committeeNameRaw = String(formData.get("committeeName") ?? "").trim();
  const termStartDate = parseDateInput(formData.get("termStartDate"));
  const termEndDate = parseDateInput(formData.get("termEndDate"));
  const statusRaw = String(formData.get("status") ?? "").trim();
  const status = statusRaw && ["UPCOMING", "ACTIVE", "EXPIRED"].includes(statusRaw)
    ? (statusRaw as BoardRoleStatus)
    : undefined;

  try {
    await updateBoardRole(principal, roleId, {
      ...(roleTitle ? { roleTitle } : {}),
      committeeName: committeeNameRaw || null,
      ...(termStartDate ? { termStartDate } : {}),
      ...(termEndDate ? { termEndDate } : {}),
      ...(status ? { status } : {}),
    });
  } catch (err) {
    if (isAppError(err)) redirectWithFlash("error", err.safeMessage);
    throw err;
  }
  redirectWithFlash("notice", "Board role updated.");
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

export async function deleteBoardRoleAction(roleId: string): Promise<void> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  try {
    await deleteBoardRole(principal, roleId);
  } catch (err) {
    if (isAppError(err)) redirectWithFlash("error", err.safeMessage);
    throw err;
  }
  redirectWithFlash("notice", "Board role removed.");
}
