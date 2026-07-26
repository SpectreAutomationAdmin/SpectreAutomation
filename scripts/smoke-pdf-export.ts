// End-to-end smoke for the PDF export pipeline.
//
// Mints an iron-session cookie outside of Next.js (using the same
// SPECTRE_SESSION_SECRET the app uses), then issues a GET against
// /api/reporting/monthly/pdf and asserts the response is a real PDF.
//
// This bypasses the /login form action (which uses Next.js's
// server-action protocol that isn't trivial to invoke from a
// plain HTTP client) but talks to the production API path exactly
// as the browser would.

import { PrismaClient } from "@prisma/client";
import { sealData } from "iron-session";
import fs from "node:fs";

const BASE = "http://localhost:3000";

async function main() {
  const prisma = new PrismaClient();

  const adminRole = await prisma.userClubRole.findFirst({
    where: { roleKey: "CLUB_ADMIN" },
    include: { user: true },
  });
  if (!adminRole?.user) throw new Error("No CLUB_ADMIN user found in dev DB.");

  const livePkg = await prisma.monthlyPackage.findFirst({
    where: { status: { in: ["PUBLISHED", "SENT"] } },
    orderBy: [{ reportingYear: "desc" }, { reportingMonth: "desc" }],
  });
  if (!livePkg) throw new Error("No live MonthlyPackage in dev DB.");
  await prisma.$disconnect();

  const secret = process.env.SPECTRE_SESSION_SECRET;
  const cookieName = process.env.SESSION_COOKIE_NAME ?? "spectre_session";
  if (!secret || secret.length < 32) {
    throw new Error("SPECTRE_SESSION_SECRET missing or too short. Source .env first.");
  }

  const sealed = await sealData(
    { userId: adminRole.user.id, activeClubId: adminRole.clubId, generation: 1 },
    { password: secret, ttl: 60 * 60 * 24 * 7 },
  );
  const cookie = `${cookieName}=${sealed}`;
  console.log(`Minted session cookie for ${adminRole.user.email} (${adminRole.user.id})`);

  console.log(
    `Requesting PDF for package ${livePkg.id} (${livePkg.reportingYear}-${String(livePkg.reportingMonth).padStart(2, "0")})…`,
  );
  const start = Date.now();
  const res = await fetch(
    `${BASE}/api/reporting/monthly/pdf?id=${encodeURIComponent(livePkg.id)}`,
    { headers: { cookie } },
  );
  const elapsedMs = Date.now() - start;
  console.log(`\nHTTP ${res.status} in ${elapsedMs}ms`);
  console.log(`Content-Type:        ${res.headers.get("content-type")}`);
  console.log(`Content-Disposition: ${res.headers.get("content-disposition")}`);

  if (res.status !== 200) {
    const text = await res.text();
    console.log("Body (first 500 chars):", text.slice(0, 500));
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`PDF size:            ${buf.length} bytes (${(buf.length / 1024).toFixed(1)} KB)`);
  const magic = buf.subarray(0, 5).toString("utf8");
  if (magic !== "%PDF-") {
    console.error(`Response is NOT a PDF. First 5 bytes: ${JSON.stringify(magic)}`);
    process.exit(1);
  }
  console.log(`Magic bytes:         ${magic} ✓`);
  fs.mkdirSync("test-results", { recursive: true });
  const path = "test-results/smoke-monthly-package.pdf";
  fs.writeFileSync(path, buf);
  console.log(`Saved to             ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
