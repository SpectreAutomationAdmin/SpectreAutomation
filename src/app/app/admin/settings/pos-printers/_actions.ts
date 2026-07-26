"use server";

// Server actions for the POS Printers admin settings page.

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isAppError } from "@/lib/errors";
import {
  createPrinter,
  deletePrinter,
  updatePrinter,
  type PrinterKind,
  type PrinterRole,
} from "@/lib/pos/printers";

type Ok<T> = { ok: true; data: T };
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

function fail(err: unknown, fallback: string): Err {
  return { ok: false, error: isAppError(err) ? err.safeMessage : fallback };
}

export type PrinterInput = {
  name: string;
  role: PrinterRole;
  kind: PrinterKind;
  location?: string | null;
  driverHint?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
};

export async function createPrinterAction(input: PrinterInput): Promise<Result<{ id: string }>> {
  const p = await getCurrentPrincipal();
  if (!p) return { ok: false, error: "Not signed in" };
  try {
    const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
    const created = await createPrinter(p, clubId, input);
    revalidatePath("/app/admin/settings/pos-printers");
    return { ok: true, data: { id: created.id } };
  } catch (err) {
    return fail(err, "Could not add printer");
  }
}

export async function updatePrinterAction(
  printerId: string,
  patch: Partial<PrinterInput>
): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return { ok: false, error: "Not signed in" };
  try {
    await updatePrinter(p, printerId, patch);
    revalidatePath("/app/admin/settings/pos-printers");
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not update printer");
  }
}

export async function deletePrinterAction(printerId: string): Promise<Result<{ ok: true }>> {
  const p = await getCurrentPrincipal();
  if (!p) return { ok: false, error: "Not signed in" };
  try {
    await deletePrinter(p, printerId);
    revalidatePath("/app/admin/settings/pos-printers");
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return fail(err, "Could not delete printer");
  }
}
