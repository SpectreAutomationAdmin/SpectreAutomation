// Helper for optional runtime-only imports. Each integration adapter
// (S3, KMS, mailer, queue, etc.) loads a heavy SDK through this helper
// so dev / test environments can miss the SDK without crashing.
//
// EPW-1 hotfix (2026-09-20) — Next.js standalone tracing (enabled in
// DRH-1) cannot analyse an indirect `new Function("return import(s)")`
// call: the specifier is opaque, so none of the optional SDKs got
// traced into `.next/standalone/node_modules`. At runtime `optionalImport`
// then returned `null` for every SDK, breaking the S3 photo streamer,
// KMS-encrypted SIN / banking / TD1, mailbox integration, background
// queue, and every other optional integration.
//
// The fix is a static specifier dispatch: every specifier appears as a
// literal string argument to `import(...)`, which the tracer CAN see
// and include. Adding a new SDK now means adding one line to the table
// below AND ensuring the package is in package.json.
//
// Packages listed in package.json but NOT yet imported statically here
// (openai, stripe, sentry, twilio, web-push, opentelemetry, etc.) will
// return null — the caller treats null as "SDK unavailable" and the
// integration falls back to its no-op stub. Add a table entry the
// first time an environment actually needs one of those integrations.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModule = any;

/**
 * Every optional package the app dynamically loads at runtime AND that
 * is currently installed as a dependency. If a new integration needs
 * another optional SDK, install it AND add one line here so the
 * standalone tracer includes it.
 */
const IMPORT_DISPATCH: Record<string, () => Promise<AnyModule>> = {
  // Storage — required by the profile-photo streamer + AP intake
  // attachment persistence + AR statement uploads.
  "@aws-sdk/client-s3":               () => import("@aws-sdk/client-s3"),
  // KMS — required by SIN + banking + TD1 encryption paths.
  "@aws-sdk/client-kms":              () => import("@aws-sdk/client-kms"),
  // Anthropic SDK — AP intelligence + reporting narrative generation.
  "@anthropic-ai/sdk":                () => import("@anthropic-ai/sdk"),
  // Mailbox transport.
  "nodemailer":                       () => import("nodemailer"),
  // Background queue (mailbox sync, AP intelligence workers).
  "bullmq":                           () => import("bullmq"),
  "ioredis":                          () => import("ioredis"),
};

export async function optionalImport(specifier: string): Promise<AnyModule | null> {
  const loader = IMPORT_DISPATCH[specifier];
  if (!loader) return null;
  try {
    return await loader();
  } catch {
    // The package was in the dispatch table but its actual runtime load
    // failed (native binding, transitive missing peer, etc.). Callers
    // already treat null as "SDK unavailable" — same shape as before.
    return null;
  }
}
