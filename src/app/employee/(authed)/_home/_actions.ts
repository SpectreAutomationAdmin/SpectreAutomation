// HR-2C Home refinement (2026-08-24) — Home-notification dismissal.
//
// Thin server-action wrapper over `dismissHomeNotification`. The action
// only records that the employee has dismissed a specific notification
// key on their Home page. It NEVER touches training, availability, or
// scheduling state — the canonical resolver remains authoritative.

"use server";

import { revalidatePath } from "next/cache";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { dismissHomeNotification } from "@/lib/hr/home-notifications";

interface Ok { ok: true }
interface Err { ok: false; error: string }

export async function dismissHomeNotificationAction(key: string): Promise<Ok | Err> {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) return { ok: false, error: "Your session has expired. Please sign in again." };
  try {
    await dismissHomeNotification(principal, key);
    revalidatePath("/employee");
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not dismiss." };
  }
}
