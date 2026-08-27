// Employee Portal Quick Links reorder (2026-08-27).

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { reorderQuickLinks } from "@/lib/employee-portal/quick-links";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "settings:write")) return NOT_FOUND;
  let body: { orderedIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.orderedIds)) {
    return NextResponse.json({ error: "orderedIds must be an array" }, { status: 400 });
  }
  try {
    const links = await reorderQuickLinks(principal, params.id, body.orderedIds);
    return NextResponse.json({ links });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
