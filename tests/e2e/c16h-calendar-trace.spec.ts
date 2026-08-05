// Sprint 3 · Checkpoint 16H — one-off Playwright script to hit the
// temporary diagnostic endpoint with an authenticated cookie and
// print the trace to stdout. Not committed to CI.

import { test } from "@playwright/test";
import { sealData } from "iron-session";
import fs from "node:fs";
import path from "node:path";

const STAGING = "https://staging.spectreautomation.com";
function readEnvStagingLocal(): Record<string, string> {
  const envPath = path.join(process.cwd(), ".env.staging.local");
  if (!fs.existsSync(envPath)) return {};
  const raw = fs.readFileSync(envPath, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const envLocal = readEnvStagingLocal();
const STAGING_SECRET = process.env.SPECTRE_STAGING_SESSION_SECRET
  ?? envLocal.SPECTRE_STAGING_SESSION_SECRET
  ?? envLocal.SPECTRE_SESSION_SECRET;
const STAGING_USER_ID = "cmrvdenz700034437agp7gqs5";
const STAGING_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? "spectre_session";

test.use({ baseURL: STAGING });

test("calendar trace", async ({ context, request }) => {
  test.skip(!STAGING_SECRET, "no staging secret");
  const sealed = await sealData(
    { userId: STAGING_USER_ID, activeClubId: STAGING_CLUB_ID, generation: 1 },
    { password: STAGING_SECRET! },
  );
  await context.addCookies([{
    name: SESSION_COOKIE_NAME, value: sealed, url: STAGING,
    httpOnly: true, sameSite: "Lax", secure: true,
  }]);
  const res = await context.request.get("/api/admin/_diag/c16h-calendar-trace");
  const body = await res.json();
  throw new Error("TRACE:\n" + JSON.stringify(body, null, 2));
});
