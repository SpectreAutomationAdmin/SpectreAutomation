// Phase 9H — Shared handler wrapper for API v1 routes.
//
// Wraps a Next.js route handler in:
//   - API key authentication (Bearer)
//   - Required-permission check
//   - Rate-limit (download profile)
//   - Request logging (ApiRequestLog)
//   - Correlation ID forwarding

import { NextRequest, NextResponse } from "next/server";
import { authenticate, logApiRequest } from "./keys";
import { consumeRate } from "../security/rate-limit";

type HandlerArgs = {
  req: NextRequest;
  clubId: string;
  apiKeyId: string;
  permissions: string[];
};

export function apiRoute(requiredPermission: string, handler: (args: HandlerArgs) => Promise<unknown>) {
  return async function route(req: NextRequest) {
    const started = Date.now();
    const ip = req.headers.get("x-forwarded-for") ?? "unknown";
    const ua = req.headers.get("user-agent") ?? undefined;
    const path = new URL(req.url).pathname;

    const limit = await consumeRate("download", `api:${ip}`);
    if (!limit.allowed) {
      return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": Math.ceil((limit.retryAfterMs ?? 60_000) / 1000).toString() } });
    }
    const authz = req.headers.get("authorization");
    const auth = await authenticate({ authorization: authz, ip });
    if ("error" in auth) {
      return NextResponse.json({ error: "unauthorized", detail: auth.error }, { status: 401 });
    }
    if (!auth.permissions.includes(requiredPermission)) {
      await logApiRequest({ clubId: auth.apiKey.clubId, apiKeyId: auth.apiKey.id, method: req.method, path, status: "DENIED", responseCode: 403, durationMs: Date.now() - started, ip, userAgent: ua });
      return NextResponse.json({ error: "forbidden", missing: requiredPermission }, { status: 403 });
    }
    try {
      const result = await handler({ req, clubId: auth.apiKey.clubId, apiKeyId: auth.apiKey.id, permissions: auth.permissions });
      await logApiRequest({ clubId: auth.apiKey.clubId, apiKeyId: auth.apiKey.id, method: req.method, path, status: "SUCCESS", responseCode: 200, durationMs: Date.now() - started, ip, userAgent: ua });
      return NextResponse.json(result, { status: 200 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logApiRequest({ clubId: auth.apiKey.clubId, apiKeyId: auth.apiKey.id, method: req.method, path, status: "ERROR", responseCode: 500, durationMs: Date.now() - started, ip, userAgent: ua, errorMessage: message });
      return NextResponse.json({ error: "internal", detail: message }, { status: 500 });
    }
  };
}
