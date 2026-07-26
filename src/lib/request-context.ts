import { headers } from "next/headers";
import { env } from "./env";

// Extract caller IP and user-agent for audit logs. Honors TRUST_PROXY so that
// behind a load balancer/CDN we record the original client IP instead of the
// proxy's. On platforms like Vercel, X-Forwarded-For is already cleaned.
export function getRequestContext(): { ip: string | null; userAgent: string | null } {
  try {
    const h = headers();
    const userAgent = h.get("user-agent");
    let ip: string | null = null;
    if (env.TRUST_PROXY) {
      const xff = h.get("x-forwarded-for");
      if (xff) ip = xff.split(",")[0].trim();
    }
    if (!ip) {
      ip = h.get("x-real-ip") ?? h.get("cf-connecting-ip") ?? null;
    }
    return { ip, userAgent };
  } catch {
    // headers() throws outside request scope (e.g. background jobs).
    return { ip: null, userAgent: null };
  }
}
