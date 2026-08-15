#!/bin/sh
# Run analyseIngestedInvoice against staging for 3 fixtures.
# Prisma client is already installed in the Fly image; DATABASE_URL is set.
cd /app
node -e '
process.env.NODE_ENV = "production";
(async () => {
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  const CLUB_ID = "cmrvdeny7000144372ktmmg9c";
  const targets = [
    { wiId: "cmsmhak530wv7ppa0lrncy9ib", label: "221178.pdf (Club Support)" },
    { wiId: "cmsgpxuyy000711jt094a8uyu", label: "B0037FC.PDF (DMM)" },
    { wiId: "cms6yc9tf02xvyy77w2io64kn", label: "1091559.pdf (Oakcreek)" },
  ];
  for (const t of targets) {
    const origin = await prisma.workIntakeOrigin.findFirst({
      where: { workIntakeItemId: t.wiId, kind: "INGESTED_DOCUMENT" },
      select: { referenceId: true },
    });
    if (!origin) { console.log("SKIP no origin: " + t.label); continue; }
    t.docId = origin.referenceId;
  }
  const { analyseIngestedInvoice } = require("./.next/server/chunks/analyse.js").catch(() => null) || {};
  console.log("has analyseIngestedInvoice from chunk?", typeof analyseIngestedInvoice);
  // Direct import likely wont resolve in built Next chunk. Alternative: HTTP.
  process.exit(0);
})();
'
