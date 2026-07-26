"use server";

// Member-hub server actions. Resolve the principal's memberId from the
// session — never trust a memberId passed from the client. Each action
// performs a tenant-safety check inside the service before writing.

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/session";
import { isAppError } from "@/lib/errors";
import { addWidget, removeWidget, reorderWidgets, setWidgetSize } from "@/lib/member-widgets";

function unauthorized() {
  return { ok: false as const, error: "Not signed in" };
}

export async function reorderHubWidgetsAction(orderedKeys: string[]) {
  const user = await getCurrentUser();
  if (!user || !user.memberId) return unauthorized();
  try {
    await reorderWidgets({
      principalMemberId: user.memberId,
      memberId: user.memberId,
      orderedKeys,
      actorUserId: user.id,
    });
    // Deliberately NOT revalidating /app/member here. The client already
    // shows the new order optimistically; a server re-render mid-animation
    // would swap React element references out from under dnd-kit and
    // corrupt its element registry, breaking subsequent drags.
    // /app/member/widgets DOES need refresh — its "On your hub" markers
    // depend on the currently-enabled set.
    revalidatePath("/app/member/widgets");
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: isAppError(err) ? err.safeMessage : "Could not save layout" };
  }
}

export async function addHubWidgetAction(widgetType: string) {
  const user = await getCurrentUser();
  if (!user || !user.memberId) return unauthorized();
  try {
    await addWidget({ principalMemberId: user.memberId, memberId: user.memberId, widgetType, actorUserId: user.id });
    revalidatePath("/app/member");
    revalidatePath("/app/member/widgets");
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: isAppError(err) ? err.safeMessage : "Could not add widget" };
  }
}

export async function removeHubWidgetAction(widgetType: string) {
  const user = await getCurrentUser();
  if (!user || !user.memberId) return unauthorized();
  try {
    await removeWidget({ principalMemberId: user.memberId, memberId: user.memberId, widgetType, actorUserId: user.id });
    revalidatePath("/app/member");
    revalidatePath("/app/member/widgets");
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: isAppError(err) ? err.safeMessage : "Could not remove widget" };
  }
}

export async function setHubWidgetSizeAction(widgetType: string, size: string) {
  const user = await getCurrentUser();
  if (!user || !user.memberId) return unauthorized();
  try {
    await setWidgetSize({
      principalMemberId: user.memberId,
      memberId: user.memberId,
      widgetType, size,
      actorUserId: user.id,
    });
    // Same reasoning as reorder: don't revalidate /app/member during the
    // resize animation — the client owns the layout optimistically.
    revalidatePath("/app/member/widgets");
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: isAppError(err) ? err.safeMessage : "Could not change widget size" };
  }
}
