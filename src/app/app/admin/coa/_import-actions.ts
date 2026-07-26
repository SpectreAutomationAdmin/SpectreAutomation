// Sprint 1 correction (2026-07-19d) — CoA-specific import server
// action, invoked by the Import modal that lives inside the CoA
// workspace.
//
// This is NOT a parallel import engine. Every non-trivial step
// delegates to the exact same library primitives the generic
// `/app/admin/imports` action uses:
//
//   • src/lib/imports/xlsx-parse.ts   — parseXlsxRows / looksLikeXlsx / isLikelyTextual
//   • src/lib/imports/csv-parse.ts    — parseCsvRows
//   • src/lib/imports/index.ts        — createBatch / applyCoaAutoMapping / validateBatch
//
// The only reason this file exists at all is that the founder wants
// the operator to STAY on `/app/admin/coa` when they hit "Import",
// not be shoved into the generic multi-domain import screen. When
// the upload succeeds we `redirect(...)` into the same batch-detail
// page (`/app/admin/imports/<batchId>`) the generic action already
// uses — that's the existing CoA mapping + validation workflow.
// When it fails, we bounce back to `/app/admin/coa?modal=import`
// with a `&error=...` query so the modal shows the message inline
// instead of dumping the operator on a different page.
//
// File-type + size limits mirror the generic action exactly. Do
// NOT let these constants drift; a divergence would produce a
// bug where the modal accepts a file the generic path rejects.

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  createBatch,
  applyCoaAutoMapping,
  validateBatch,
} from "@/lib/imports";
import { parseXlsxRows, looksLikeXlsx, isLikelyTextual } from "@/lib/imports/xlsx-parse";
import { parseCsvRows } from "@/lib/imports/csv-parse";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { isAppError } from "@/lib/errors";

// Same 10 MB cap the generic action uses. Keep these two constants
// in lockstep — if one moves, move the other.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function bounceWithError(message: string): never {
  const q = new URLSearchParams({ modal: "import", error: message });
  redirect(`/app/admin/coa?${q.toString()}`);
}

export async function createCoaImportBatchFromModalAction(
  formData: FormData,
): Promise<void> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  // The generic imports action gates every mutation on `settings:write`
  // via `ensureWrite()` inside the library. The modal enforces the same
  // key server-side here so a hand-crafted POST cannot bypass the UI's
  // permission gate. Read-only users get bounced with a clear message.
  if (!hasPermission(principal, clubId, "settings:write")) {
    bounceWithError("Your role does not have permission to import accounts.");
  }

  const fileEntry = formData.get("file");
  if (!(fileEntry instanceof File) || fileEntry.size === 0 || fileEntry.name.length === 0) {
    bounceWithError("Choose an .xlsx or .csv file before submitting.");
  }
  const file = fileEntry as File;
  if (file.size > MAX_FILE_BYTES) {
    bounceWithError(
      `Uploaded file is larger than ${(MAX_FILE_BYTES / (1024 * 1024)).toFixed(0)} MB. Split it into smaller batches.`,
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);
  const isXlsx = looksLikeXlsx(file.name, buf);
  if (!isXlsx && !isLikelyTextual(buf)) {
    bounceWithError("Unsupported file type. Upload an .xlsx workbook or a .csv file.");
  }

  let rows: Array<Record<string, string>>;
  try {
    if (isXlsx) {
      rows = await parseXlsxRows(buf, { domain: "COA" });
    } else {
      rows = parseCsvRows(buf.toString("utf8"), { domain: "COA" });
    }
  } catch (err) {
    bounceWithError(`Chart of accounts file could not be parsed. ${(err as Error).message}`);
  }
  if (rows!.length === 0) {
    bounceWithError("File had a header row but no data rows.");
  }

  let createdBatchId: string;
  try {
    const created = await createBatch(principal, {
      clubId,
      domain: "COA",
      rows: rows!,
      source: isXlsx ? "XLSX" : "CSV",
      fileName: file.name,
    });
    createdBatchId = created.id;
    // Same post-upload sequence the generic action uses for COA:
    // intelligent auto-mapping, then validate against the predictions
    // so the mapping page opens with populated confidence rather than
    // a misleading "0 valid / 0 errors" state. NOT a re-implementation
    // — these are the same two library functions.
    await applyCoaAutoMapping(principal, createdBatchId);
    await validateBatch(principal, createdBatchId);
  } catch (err) {
    if (isAppError(err)) bounceWithError(err.safeMessage);
    throw err;
  }
  revalidatePath("/app/admin/imports");
  revalidatePath("/app/admin/coa");
  // Handoff into the SAME batch-detail page the generic action ships
  // to. That page auto-scrolls to the first mapping error and renders
  // the CoaMappingTable inline. There is no parallel mapping UI.
  redirect(`/app/admin/imports/${createdBatchId}`);
}
