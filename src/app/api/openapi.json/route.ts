// Phase 9H — OpenAPI spec endpoint.

import { NextRequest, NextResponse } from "next/server";
import { buildOpenAPI } from "@/lib/api/openapi";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  return NextResponse.json(buildOpenAPI(`${url.protocol}//${url.host}`));
}
