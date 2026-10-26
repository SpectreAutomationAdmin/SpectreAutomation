// SIGNUP-2 Phase 2D (2026-10-25) -- Shared parsing + response helpers.
//
// The four operator POST routes accept both JSON (for Playwright +
// scripted callers) and application/x-www-form-urlencoded /
// multipart/form-data (for the HTML forms rendered on the review
// page).  When the request accepts HTML, we 303-redirect back to
// the review page with a result flag; otherwise we return JSON.

import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";

export async function readOperatorBody(req: NextRequest): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (ct.startsWith("application/json")) {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(body ?? {})) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }
  // Form POST path (HTML).
  try {
    const form = await req.formData();
    const out: Record<string, string> = {};
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function wantsHtmlRedirect(req: NextRequest): boolean {
  const accept = req.headers.get("accept")?.toLowerCase() ?? "";
  return accept.includes("text/html");
}

export function reviewRedirect(registrationId: string, result: string): NextResponse {
  const url = new URL(
    `/app/admin/signup-ops/registration/${encodeURIComponent(registrationId)}?result=${encodeURIComponent(result)}`,
    env.APP_URL,
  );
  return NextResponse.redirect(url, { status: 303 });
}
