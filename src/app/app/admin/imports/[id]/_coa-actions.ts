"use server";

// COA mapping — server action wrapper.
//
// Called by the in-page CoaMappingTable client component to persist
// the operator's per-row type/category/fs-group/department selections
// before they click Validate. All tenant + permission checks live in
// `saveCoaRowMappings` (src/lib/imports/index.ts).
//
// On success the page revalidates and the operator sees the batch
// back in DRAFT state, ready to be validated.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { isAppError } from "@/lib/errors";
import { saveCoaRowMappings } from "@/lib/imports";
import { getCurrentPrincipal } from "@/lib/services/principal";

export type CoaRowMappingInput = {
  rowId: string;
  type: string | null;
  categoryKey: string | null;
  fsGroupKey: string | null;
  departmentCodes: string[];
};

export async function saveCoaMappingAction(
  batchId: string,
  mappings: ReadonlyArray<CoaRowMappingInput>,
): Promise<{ ok: true; rowsUpdated: number } | { ok: false; message: string }> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  try {
    const result = await saveCoaRowMappings(principal, { batchId, mappings });
    revalidatePath(`/app/admin/imports/${batchId}`);
    return { ok: true, rowsUpdated: result.rowsUpdated };
  } catch (err) {
    if (isAppError(err)) {
      cookies().set("spectre_import_error", err.safeMessage, {
        httpOnly: true,
        sameSite: "strict",
        maxAge: 30,
      });
      return { ok: false, message: err.safeMessage };
    }
    throw err;
  }
}
