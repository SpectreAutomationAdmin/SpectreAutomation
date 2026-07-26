// Inspect the smoke-generated PDF: count pages, dump the first
// ~600 bytes of stream text to confirm the title page + TOC are
// present.

import fs from "node:fs";
import path from "node:path";

const PDF_PATH = path.join("test-results", "smoke-monthly-package.pdf");
const bytes = fs.readFileSync(PDF_PATH);
const text = bytes.toString("binary");

// Count Page objects (excludes Pages parent — uses `/Type /Page` with
// optional whitespace/newlines but NOT followed by 's' which would
// indicate the Pages catalog).
const pageMatches = text.match(/\/Type\s*\/Page(?![s])/g) ?? [];
console.log("Page object count:", pageMatches.length);
console.log("Total size:", bytes.length, "bytes");

// Look for known title-page strings the print route emits. These
// won't always be plain text in the PDF stream (Chromium may
// compress streams), but uncompressed text frequently shows up
// directly and is enough to confirm content presence here.
const probes = [
  "Spectre Executive Reporting",
  "Monthly Board Reporting Package",
  "Table of Contents",
  "Period",
  "Finance Committee",
  "Prepared using the Spectre Framework",
  "Confidential",
];
for (const p of probes) {
  console.log(`  ${text.includes(p) ? "✓" : "✗"} ${p}`);
}
