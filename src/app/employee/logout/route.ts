// HR-2B.5 §7 — Employee Portal logout endpoint.
//
// POST-only. Clears the spectre_employee_session cookie and
// redirects the browser back to the login page. Uses the request
// URL as the base so we don't rely on an env var — works locally,
// on staging, and in prod without extra config.

import { NextResponse, type NextRequest } from "next/server";
import { destroyEmployeePortalSession } from "@/lib/employee-portal-session";

export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  await destroyEmployeePortalSession();
  const url = new URL("/employee/login", req.url);
  // 303 See Other — the correct code to convert a POST into a GET.
  return NextResponse.redirect(url, 303);
}
