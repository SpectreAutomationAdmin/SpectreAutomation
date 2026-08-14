// Phase 7.2N real-COA trace — query staging Neon DB directly.
// Read-only queries. No mutations.
// Located in project so `pg` from node_modules is resolvable.

import pg from "pg";
const { Client } = pg;

const DATABASE_URL = process.env.STAGING_DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Set STAGING_DATABASE_URL env var");
  process.exit(1);
}

const client = new Client({ connectionString: DATABASE_URL });
await client.connect();

// 1. Discover clubs on staging.
const clubs = await client.query(`
  SELECT id, name, slug FROM "Club" ORDER BY "createdAt" ASC LIMIT 20;
`);
console.log("=== CLUBS ===");
for (const c of clubs.rows) console.log(`  ${c.id} | ${c.slug} | ${c.name}`);

// 2. Discover recent work intakes with AP analysis (90d).
const wi = await client.query(`
  SELECT wi.id, wi.subject, wi."createdAt", wi."clubId",
         c.slug as clubslug,
         wi."supplierName", wi."invoiceReference", wi."currency",
         wi."totalAmount"
  FROM "WorkIntake" wi
  JOIN "Club" c ON c.id = wi."clubId"
  WHERE wi."createdAt" > NOW() - INTERVAL '90 days'
    AND (wi."supplierName" ILIKE '%club support%'
      OR wi."supplierName" ILIKE '%oakcreek%'
      OR wi."supplierName" ILIKE '%dmm%'
      OR wi."supplierName" ILIKE '%petroleum%'
      OR wi."invoiceReference" ILIKE '%221178%'
      OR wi."invoiceReference" ILIKE '%1091559%'
      OR wi."invoiceReference" ILIKE '%B0037FC%')
  ORDER BY wi."createdAt" DESC
  LIMIT 30;
`);
console.log("\n=== TARGET WORK INTAKES ===");
for (const w of wi.rows) {
  console.log(`  ${w.id} | ${w.clubslug} | ${w.suppliername || "-"} | ${w.invoicereference || "-"} | ${w.totalamount ?? "-"} ${w.currency ?? ""} | ${w.createdat.toISOString()}`);
}

await client.end();
