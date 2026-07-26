// Next.js edge middleware:
//   1. Set hard security headers (CSP w/ per-request nonce, HSTS, etc.).
//   2. Cookie-presence auth gate on /app/**.
//   3. Inject x-correlation-id (Phase 9 — flows into structured logger).
//
// Edge-runtime constraint: no Prisma, no Node 'crypto'. We use Web Crypto.

import { NextResponse, type NextRequest } from "next/server";

const TRUSTED_DOMAINS: string[] = [
  // Add CDN, payment, POS, analytics domains here as needed.
  // "https://js.stripe.com",
];

function buildCsp(nonce: string, isDev: boolean): string {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    `script-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-eval'" : ""} ${TRUSTED_DOMAINS.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${TRUSTED_DOMAINS.join(" ")}`.trim(),
    "frame-ancestors 'none'",
    "form-action 'self'",
    // Sprint 3 Checkpoint 15H Unified Remediation (2026-07-25) — the
    // DocumentPreviewModal renders PDFs into an <iframe src=blob:...>.
    // Chrome's built-in PDF viewer draws the PDF into an <embed>
    // element inside that iframe. `object-src 'none'` was blocking
    // that <embed>, so the iframe opened but the PDF was invisible.
    // `object-src 'self' blob:` still forbids third-party plugins /
    // Flash / cross-origin <embed>, but lets Chrome's own PDF plugin
    // render same-origin + blob content. `frame-src 'self' blob:` is
    // added explicitly so browsers that don't inherit frame-src from
    // default-src (Safari/Firefox variants) still allow the blob
    // iframe navigation itself.
    "object-src 'self' blob:",
    "frame-src 'self' blob:",
  ];
  return directives.join("; ");
}

function generateNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin);
}

function newCorrelationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function requiresAuth(pathname: string): boolean {
  return pathname.startsWith("/app");
}

export function middleware(req: NextRequest) {
  const url = req.nextUrl;
  const isDev = process.env.NODE_ENV !== "production";
  const nonce = generateNonce();
  const correlationId = req.headers.get("x-correlation-id") ?? newCorrelationId();

  // Auth gate
  if (requiresAuth(url.pathname)) {
    const hasCookie = req.cookies.get(process.env.SESSION_COOKIE_NAME ?? "spectre_session");
    if (!hasCookie) {
      const login = new URL("/login", req.url);
      login.searchParams.set("next", url.pathname);
      return NextResponse.redirect(login);
    }
  }

  // Forward nonce + correlation ID via request headers so server components
  // can pick them up.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-correlation-id", correlationId);
  // White-label: stamp the resolved request host so server components can
  // route per-tenant. Edge runtime can't query Prisma; we only forward the
  // raw host. The actual ClubDomain lookup happens in a server component
  // (see src/lib/tenant-resolver). x-spectre-host is normalized: lowercase,
  // no port.
  const rawHost = req.headers.get("host") ?? "";
  const normalizedHost = rawHost.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  requestHeaders.set("x-spectre-host", normalizedHost);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(self), interest-cohort=(), payment=()");
  res.headers.set("Content-Security-Policy", buildCsp(nonce, isDev));
  res.headers.set("X-Correlation-Id", correlationId);
  if (!isDev) {
    res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  return res;
}

// Skip middleware on static assets / Next internals for performance.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|offline.html|icons/).*)"],
};
