// WI-SYNC-1e-close §1 (2026-10-18) — Spectre→Outlook mark-as-unread.
// Delegates to the mark-read handler with isRead=false.

import type { NextRequest } from "next/server";
import { markReadImpl } from "../mark-read-email/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  return markReadImpl(params.id, false);
}
