// Fetch the print HTML with an admin cookie + assert the front
// matter sections render. Cheaper than a full PDF generation cycle.

import { PrismaClient } from "@prisma/client";
import { sealData } from "iron-session";

const BASE = "http://localhost:3000";

async function main() {
  const prisma = new PrismaClient();
  const adminRole = await prisma.userClubRole.findFirst({
    where: { roleKey: "CLUB_ADMIN" },
    include: { user: true },
  });
  const livePkg = await prisma.monthlyPackage.findFirst({
    where: { status: { in: ["PUBLISHED", "SENT"] } },
    orderBy: [{ reportingYear: "desc" }, { reportingMonth: "desc" }],
  });
  await prisma.$disconnect();
  if (!adminRole?.user || !livePkg) throw new Error("Missing fixture");

  const secret = process.env.SPECTRE_SESSION_SECRET!;
  const cookieName = process.env.SESSION_COOKIE_NAME ?? "spectre_session";
  const sealed = await sealData(
    { userId: adminRole.user.id, activeClubId: adminRole.clubId, generation: 1 },
    { password: secret, ttl: 60 * 60 * 24 * 7 },
  );

  const res = await fetch(
    `${BASE}/app/print/monthly-package?id=${livePkg.id}`,
    { headers: { cookie: `${cookieName}=${sealed}` } },
  );
  const html = await res.text();
  console.log("HTTP", res.status, "·", html.length, "chars\n");

  const probes: Array<[string, string]> = [
    ["title-page section", 'data-testid="pdf-title-page"'],
    ["TOC section", 'data-testid="pdf-toc-page"'],
    ["title-page eyebrow", "Spectre Executive Reporting"],
    ["doc title", "Monthly Board Reporting Package"],
    ["TOC heading", "Table of Contents"],
    ["TOC group: Member Overview", "Member Overview"],
    ["TOC group: Financial Statements", "Financial Statements"],
    ["TOC group: Operations & Analytics", "Operations &amp; Analytics"],
    ["TOC entry: Executive Opening", "Executive Opening"],
    ["TOC entry: Statement of Activities", "Statement of Activities"],
    ["TOC entry: Inventory Analysis", "Inventory Analysis"],
    ["target-counter CSS (Chromium GCPM)", "target-counter("],
    ["TOC page-ref slot", 'class="page-ref"'],
    ["TOC anchor: #executive-opening", 'href="#executive-opening"'],
    ["confidentiality copy", "Confidential"],
    ["framework attribution", "Spectre Framework"],
    ["finance committee line", "Finance Committee"],
    ["board of directors line", "Board of Directors"],
    ["body still present", 'data-testid="print-monthly-package"'],
    ["body still uses chapter anchor", 'id="executive-opening"'],
  ];
  let pass = 0;
  for (const [label, needle] of probes) {
    const ok = html.includes(needle);
    if (ok) pass++;
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  }
  console.log(`\n${pass}/${probes.length} probes pass`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
