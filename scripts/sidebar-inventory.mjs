// Enumerate the admin sidebar inventory directly from the data source
// of truth (sidebar-nav-data.ts). This is the regression contract for
// the Payroll dark-navy sidebar restyle. After the styling change we
// re-run this and diff — any label / href / icon / hierarchy change
// is a failure.
//
// Usage: `node scripts/sidebar-inventory.mjs before|after`

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import Module from "node:module";

const SRC = path.resolve("src/components/sidebar-nav-data.ts");
const OUT = path.resolve("test-results/payroll-integration");
mkdirSync(OUT, { recursive: true });

let source = readFileSync(SRC, "utf8");
source = source.replace(/import type[\s\S]*?from "\.\/spectre\/SidebarIcon";\s*/g, "");

const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const m = new Module("inline");
m._compile(js, "sidebar-nav-data.js");
const { ADMIN_TOP_LEVEL, ADMIN_SECTIONS, ADMIN_PERSONAL } = m.exports;

const inventory = {
  timestamp: new Date().toISOString(),
  source: "src/components/sidebar-nav-data.ts",
  totals: {
    topLevelItems: ADMIN_TOP_LEVEL.length,
    sections: ADMIN_SECTIONS.length,
    sectionItemsTotal: ADMIN_SECTIONS.reduce((s, sec) => s + sec.items.length, 0),
    personalItems: ADMIN_PERSONAL.length,
    itemsWithIcons:
      ADMIN_TOP_LEVEL.filter(i => i.icon).length +
      ADMIN_SECTIONS.reduce((s, sec) => s + sec.items.filter(i => i.icon).length + (sec.icon ? 1 : 0), 0) +
      ADMIN_PERSONAL.filter(i => i.icon).length,
  },
  topLevel: ADMIN_TOP_LEVEL.map(i => ({ href: i.href, label: i.label, icon: i.icon ?? null, perm: i.perm ?? null })),
  sections: ADMIN_SECTIONS.map(s => ({
    id: s.id,
    label: s.label,
    icon: s.icon ?? null,
    items: s.items.map(i => ({ href: i.href, label: i.label, icon: i.icon ?? null, perm: i.perm ?? null })),
  })),
  personal: ADMIN_PERSONAL.map(i => ({ href: i.href, label: i.label, icon: i.icon ?? null, perm: i.perm ?? null })),
};

const stamp = process.argv[2] || "snapshot";
const outPath = path.join(OUT, `menu-inventory-${stamp}.json`);
writeFileSync(outPath, JSON.stringify(inventory, null, 2));
console.log(`WROTE ${outPath}`);
console.log(`totals=${JSON.stringify(inventory.totals)}`);
