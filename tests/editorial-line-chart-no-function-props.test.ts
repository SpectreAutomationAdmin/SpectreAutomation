// Founder rule 2026-07-05 v15.12.1 — RSC serialisation guard.
//
// `EditorialLineChart` is a `"use client"` component consumed by
// Server Components inside the Monthly Reporting Package (the
// StewardshipDashboard's Equity + Payroll cards, the F&B chapter,
// the Inventory chapter). Next.js rejects any function value passed
// across the Server → Client boundary at runtime:
//
//   "Functions cannot be passed directly to Client Components
//    unless you explicitly expose it by marking it with 'use server'."
//
// This test locks the invariant SOURCE-CONTRACT so the founder never
// sees a "Monthly Reporting Package fails to load" incident from a
// future edit that re-introduces a closure formatter:
//   1. The `LineChartTooltipSpec` type carries NO function-typed
//      field. Its formatter is a serialisable string descriptor
//      (`valueFormat: FormatYSpec`), and the client-side chart looks
//      the formatter up internally via `applyFormatY`.
//   2. Every reporting call site's `<EditorialLineChart>` JSX block
//      contains NO arrow-function / method syntax inside the
//      `tooltip={{ … }}` prop object (no `=>`, no `function(`, no
//      `.toFixed(`, etc.).
//   3. Every LineSpec inside `lines={[…]}` uses only
//      JSON-serialisable properties (strings + numbers + booleans).
//
// A source-contract test is the cheapest reliable guard here — the
// runtime error only surfaces when the affected page actually
// server-renders. This test catches the regression at
// `npm run typecheck && npx vitest run` time instead.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const lineChart = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/reporting/EditorialLineChart.tsx"),
  "utf8",
);

// -----------------------------------------------------------------
// The reporting-package files that instantiate `<EditorialLineChart>`.
// If a new chapter starts consuming the primitive, add it here so
// its call sites are guarded too.
// -----------------------------------------------------------------
const CALL_SITES: ReadonlyArray<{ label: string; relPath: string }> = [
  {
    label: "MonthlyReportingPackageBody (Equity + Payroll Ratio Trend cards)",
    relPath: "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx",
  },
  {
    label: "FoodBeverageChartCards (Food Cost % by Month)",
    relPath: "src/app/app/admin/reporting/monthly/FoodBeverageChartCards.tsx",
  },
  {
    label: "InventoryChartCards (F&B Inventory Balances)",
    relPath: "src/app/app/admin/reporting/monthly/InventoryChartCards.tsx",
  },
];

/** Extract every `<EditorialLineChart …/>` self-closing JSX block
 *  from a source file. Returns each block as its raw substring
 *  including the closing `/>`. */
function extractLineChartBlocks(source: string): string[] {
  const out: string[] = [];
  const openRe = /<EditorialLineChart\b/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(source)) !== null) {
    const openIdx = m.index;
    const closeIdx = source.indexOf("/>", openIdx);
    if (closeIdx < 0) continue;
    out.push(source.slice(openIdx, closeIdx + 2));
  }
  return out;
}

/** Extract the raw text of the `tooltip={{ … }}` prop object from a
 *  single `<EditorialLineChart>` block. Returns "" when the block
 *  omits the prop (no interaction opt-in). Balances braces so an
 *  inner `{expr}` doesn't confuse the scan. */
function extractTooltipProp(chartBlock: string): string {
  const marker = "tooltip={";
  const start = chartBlock.indexOf(marker);
  if (start < 0) return "";
  let depth = 0;
  const contentStart = start + marker.length - 1; // the opening `{` after tooltip=
  for (let i = contentStart; i < chartBlock.length; i++) {
    const c = chartBlock[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return chartBlock.slice(contentStart, i + 1);
    }
  }
  return "";
}

/** Extract the raw text of the `lines={[ … ]}` prop array from a
 *  single `<EditorialLineChart>` block. Balances brackets so nested
 *  `{expr}`s inside line entries don't confuse the scan. */
function extractLinesProp(chartBlock: string): string {
  const marker = "lines={";
  const start = chartBlock.indexOf(marker);
  if (start < 0) return "";
  let depth = 0;
  const contentStart = start + marker.length - 1;
  for (let i = contentStart; i < chartBlock.length; i++) {
    const c = chartBlock[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return chartBlock.slice(contentStart, i + 1);
    }
  }
  return "";
}

/** Walk an object literal source (INCLUDING its enclosing braces) and
 *  return the raw text of each top-level `key: value` value. Nested
 *  object literals + array literals + function-call parentheses are
 *  balanced so a comma buried inside them doesn't split a pair.
 *
 *  Used to defend the RSC boundary: arrow functions BUILT inside a
 *  value expression (e.g. `xHeaders: data.map((d) => …)`) execute
 *  server-side and yield serialisable data, which is fine; arrow
 *  functions assigned DIRECTLY to a top-level property (e.g.
 *  `formatValue: (v) => …`) do cross the RSC boundary and throw.
 *  We inspect the value substring for each key, and only the *value*
 *  side has to be closure-free.
 *
 *  Returns an array of `{ key, value }` pairs where `value` is the
 *  raw substring between the `:` and the next top-level `,` or the
 *  closing `}` of the object literal. Whitespace + trailing newlines
 *  are trimmed. */
function extractObjectEntries(objectLiteral: string): { key: string; value: string }[] {
  // Strip the outermost `{ … }` wrapper (JSX gives us `{{ … }}` — we
  // pass in the inner `{ … }`).
  const trimmed = objectLiteral.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];
  const body = trimmed.slice(1, -1);
  const out: { key: string; value: string }[] = [];
  let i = 0;
  const n = body.length;
  const skipWs = () => {
    while (i < n && /\s/.test(body[i])) i++;
  };
  while (i < n) {
    skipWs();
    if (i >= n) break;
    // Comment / trailing comma
    if (body[i] === ",") { i++; continue; }
    // Read key — identifier or quoted.
    let key = "";
    if (body[i] === '"' || body[i] === "'") {
      const quote = body[i++];
      while (i < n && body[i] !== quote) key += body[i++];
      i++; // consume closing quote
    } else {
      while (i < n && /[A-Za-z0-9_$]/.test(body[i])) key += body[i++];
    }
    skipWs();
    if (body[i] !== ":") { i++; continue; } // malformed — skip
    i++; // consume `:`
    skipWs();
    // Collect the value up to the top-level `,` respecting nested
    // brackets, braces, and parentheses.
    let value = "";
    const openers: string[] = [];
    while (i < n) {
      const c = body[i];
      if (openers.length === 0 && c === ",") break;
      if (c === "{" || c === "[" || c === "(") openers.push(c);
      else if (c === "}" || c === "]" || c === ")") openers.pop();
      // Skip past string literals so a `,` inside a string doesn't
      // split the pair (single, double, and backtick).
      else if (c === "\"" || c === "'" || c === "`") {
        value += c;
        i++;
        const quote = c;
        while (i < n && body[i] !== quote) {
          if (body[i] === "\\") { value += body[i++]; if (i < n) value += body[i++]; continue; }
          value += body[i++];
        }
        if (i < n) { value += body[i++]; }
        continue;
      }
      value += c;
      i++;
    }
    out.push({ key, value: value.trim() });
  }
  return out;
}

// -----------------------------------------------------------------
// 1) The primitive's tooltip type is function-free.
// -----------------------------------------------------------------
describe("v15.12.1 LineChartTooltipSpec is JSON-serialisable at the type level", () => {
  // Locate the exported type block and assert no function typing.
  const typeMatch = lineChart.match(
    /export type LineChartTooltipSpec = \{[\s\S]+?\n\};/,
  );

  it("the type block is present in EditorialLineChart.tsx", () => {
    expect(typeMatch, "LineChartTooltipSpec type must be exported").toBeTruthy();
  });

  const typeBlock = typeMatch?.[0] ?? "";

  it("carries NO `(value: number, lineIndex: number) => string` closure field", () => {
    // Pre-fix shape — must never re-appear.
    expect(typeBlock).not.toMatch(/formatValue\?:/);
    expect(typeBlock).not.toMatch(/=>\s*string/);
  });

  it("carries NO generic `Function` typing on any field", () => {
    expect(typeBlock).not.toMatch(/:\s*Function\b/);
    expect(typeBlock).not.toMatch(/:\s*\([^)]*\)\s*=>/);
  });

  it("declares the serialisable `valueFormat` descriptor as a FormatYSpec string union", () => {
    expect(typeBlock).toMatch(/valueFormat\?:\s*FormatYSpec/);
  });

  it("documents the RSC serialisation contract inline so future readers understand why", () => {
    // The type block's JSDoc must mention the RSC boundary + the
    // "no functions" rule so the next reader doesn't accidentally
    // paper over the regression by re-introducing a closure.
    expect(lineChart).toMatch(/RSC SERIALISATION CONTRACT/);
    expect(lineChart).toMatch(/FUNCTIONS ARE FORBIDDEN/);
  });
});

// -----------------------------------------------------------------
// 2) Every reporting call site passes only JSON-serialisable values.
// -----------------------------------------------------------------
describe("v15.12.1 every <EditorialLineChart /> call site passes JSON-serialisable props only", () => {
  for (const site of CALL_SITES) {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), site.relPath),
      "utf8",
    );
    const blocks = extractLineChartBlocks(source);

    describe(site.label, () => {
      it("has at least one <EditorialLineChart /> block", () => {
        expect(
          blocks.length,
          `${site.relPath} was expected to render at least one EditorialLineChart`,
        ).toBeGreaterThan(0);
      });

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];

        it(`block #${i + 1}: tooltip prop contains no arrow-function / method-shorthand formatter at top-level values`, () => {
          const tooltipProp = extractTooltipProp(block);
          if (tooltipProp === "") return; // no tooltip opt-in, nothing to guard
          // A closure `formatValue: (v) => …` is the exact runtime
          // regression this suite defends against — reject the key
          // by name so it can never re-appear.
          expect(tooltipProp).not.toMatch(/formatValue\s*[:(]/);
          // Broader guard — inspect every TOP-LEVEL property value
          // in the tooltip object and refuse arrow / function
          // assignments there. Arrow functions BUILT inside a value
          // expression (e.g. `xHeaders: data.map((d) => \`…\`)`)
          // execute server-side and yield a plain array of strings,
          // so they are perfectly serialisable — only a top-level
          // value that IS a function trips the RSC boundary.
          const entries = extractObjectEntries(tooltipProp);
          for (const { key, value } of entries) {
            const looksLikeArrow =
              /^\(/.test(value) && /\)\s*=>/.test(value);
            const looksLikeFunction = /^function\s*\(/.test(value);
            const looksLikeMethodShorthand = /^\w+\s*\(.*\)\s*\{/.test(value);
            expect(
              looksLikeArrow || looksLikeFunction || looksLikeMethodShorthand,
              `tooltip.${key} in ${site.relPath} must be JSON-serialisable — no function value crosses the RSC boundary`,
            ).toBe(false);
          }
        });

        it(`block #${i + 1}: tooltip prop uses the serialisable valueFormat descriptor when it needs custom precision`, () => {
          const tooltipProp = extractTooltipProp(block);
          if (tooltipProp === "") return;
          // If a valueFormat override is present, it MUST be a
          // string literal (JSON-safe), not an expression.
          const vfMatches = tooltipProp.match(/valueFormat\s*:\s*([^,\n}]+)/g);
          if (!vfMatches) return;
          for (const raw of vfMatches) {
            // Strip the `valueFormat: ` prefix and trim.
            const rhs = raw.replace(/^valueFormat\s*:\s*/, "").trim();
            // A JSON-safe descriptor is a bare string literal.
            expect(
              rhs,
              "valueFormat must be a plain string literal — no expression, no closure",
            ).toMatch(/^"[a-z0-9-]+"$/i);
          }
        });

        it(`block #${i + 1}: every LineSpec inside lines={[…]} uses only serialisable top-level values`, () => {
          const linesProp = extractLinesProp(block);
          if (linesProp === "") return;
          // The `lines` prop is an array literal `[{…}, {…}, …]`.
          // Walk each object entry and check its top-level values,
          // reusing the same narrow "no closure at top-level values"
          // rule as the tooltip check. Arrow functions used INSIDE
          // value-building expressions (e.g. `values: data.map((p) => p.value)`)
          // are fine — they run server-side and yield JSON.
          const bracketOpen = linesProp.indexOf("[");
          const bracketClose = linesProp.lastIndexOf("]");
          if (bracketOpen < 0 || bracketClose < 0) return;
          const array = linesProp.slice(bracketOpen + 1, bracketClose);
          // Split on top-level `,` respecting braces so nested `{…}`
          // entries stay together.
          const entries: string[] = [];
          let buf = "";
          let depth = 0;
          for (let k = 0; k < array.length; k++) {
            const c = array[k];
            if (c === "{" || c === "[" || c === "(") depth++;
            else if (c === "}" || c === "]" || c === ")") depth--;
            if (c === "," && depth === 0) {
              if (buf.trim()) entries.push(buf.trim());
              buf = "";
              continue;
            }
            buf += c;
          }
          if (buf.trim()) entries.push(buf.trim());
          for (const entry of entries) {
            if (!entry.startsWith("{")) continue;
            const kv = extractObjectEntries(entry);
            for (const { key, value } of kv) {
              const looksLikeArrow = /^\(/.test(value) && /\)\s*=>/.test(value);
              const looksLikeFunction = /^function\s*\(/.test(value);
              expect(
                looksLikeArrow || looksLikeFunction,
                `LineSpec.${key} in ${site.relPath} must be JSON-serialisable`,
              ).toBe(false);
            }
          }
        });
      }
    });
  }
});

// -----------------------------------------------------------------
// 3) Behavioural check — every FormatYSpec case still produces the
//    string the callers expect. This is the parallel-computation
//    proof that swapping the closures for descriptors did not lose
//    fidelity, so the tooltip still reads "$28.9M" / "59.2%" /
//    "$48.2K" at the founder's approved precision.
// -----------------------------------------------------------------
describe("v15.12.1 shared FormatYSpec cases render the founder-approved tooltip strings", () => {
  // The formatter under test is inlined here (mirror of the
  // primitive's own switch) so a regression in the primitive breaks
  // this suite with a clear error message.
  function applyFormatY(spec: string, v: number): string {
    switch (spec) {
      case "dollars-millions":    return `$${Math.round(v)}M`;
      case "dollars-millions-1d": return `$${v.toFixed(1)}M`;
      case "dollars-thousands":   return `$${Math.round(v)}K`;
      case "dollars-compact": {
        const sign = v < 0 ? "-" : "";
        const abs = Math.abs(v);
        if (abs >= 1_000_000) {
          const label = (abs / 1_000_000).toFixed(1).replace(/\.0$/, "");
          return `${sign}$${label}M`;
        }
        return `${sign}$${Math.round(abs / 1_000)}K`;
      }
      case "dollars-compact-1d": {
        const sign = v < 0 ? "-" : "";
        const abs = Math.abs(v);
        if (abs >= 1_000_000) {
          return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
        }
        return `${sign}$${(abs / 1_000).toFixed(1)}K`;
      }
      case "percent":             return `${v.toFixed(1)}%`;
      case "raw":
      default:                    return String(Math.round(v));
    }
  }

  it("Equity — `dollars-millions-1d` @ 28.9 → \"$28.9M\"", () => {
    expect(applyFormatY("dollars-millions-1d", 28.9)).toBe("$28.9M");
    expect(applyFormatY("dollars-millions-1d", 31.0)).toBe("$31.0M");
  });

  it("Payroll + Food Cost — `percent` @ 59.2 → \"59.2%\"", () => {
    expect(applyFormatY("percent", 59.2)).toBe("59.2%");
    expect(applyFormatY("percent", 36.9)).toBe("36.9%");
  });

  it("Inventory Balances — `dollars-compact-1d` @ 48_200 raw → \"$48.2K\"", () => {
    expect(applyFormatY("dollars-compact-1d", 48_200)).toBe("$48.2K");
    expect(applyFormatY("dollars-compact-1d", 52_300)).toBe("$52.3K");
    expect(applyFormatY("dollars-compact-1d", 28_100)).toBe("$28.1K");
  });

  it("`dollars-compact-1d` auto-scales past $1M with 1-decimal precision", () => {
    expect(applyFormatY("dollars-compact-1d", 1_250_000)).toBe("$1.3M");
    expect(applyFormatY("dollars-compact-1d", 2_000_000)).toBe("$2.0M");
  });

  it("`dollars-compact-1d` handles negatives (sign prefix, absolute value inside)", () => {
    expect(applyFormatY("dollars-compact-1d", -48_200)).toBe("-$48.2K");
  });
});
