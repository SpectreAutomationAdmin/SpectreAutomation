/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // DRH-1 (2026-09-19) — `output: "standalone"` was attempted here to
  // shrink the runner image, but the standalone tracer step
  // (`Collecting build traces`) is silent for 10+ min inside the
  // Windows Docker Desktop / buildkit environment and tripped the
  // deployment controller's BUILD idle watchdog. Reverted. The size
  // reduction is deferred to the CI-runner path (DRH-1 §21) where a
  // Linux runner completes the trace in reasonable time.
  //
  // The deployment controller (`scripts/deploy-staging.mjs`) — which
  // is the actual reliability improvement — remains in place.
  // Sprint 3 · Phase 4 Slice 5.7B follow-up (2026-08-09) — Slice
  // 5.7B's added modules pushed the "Collecting page data" phase
  // past 3840 MB on Fly's shared-cpu-2x remote builder, causing
  // silent OOM (exit 0, missing .next BUILD_ID). We already run
  // `npm run typecheck` (via tsc --noEmit) as a hard gate before
  // every deploy, so the Next.js build's tsc pass is duplicated
  // work — disabling it saves ~1 GB of heap during "Collecting
  // page data" without weakening the type-safety gate.
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  // pdfkit reads its standard-font `.afm` files from disk at runtime
  // via `fs.readFileSync`. Webpack bundles pdfkit's JS but not the
  // sibling `data/` directory, so the bundled server crashes the
  // first time `new PDFDocument()` initialises Helvetica. Marking
  // pdfkit (and the related fontkit + exceljs which have the same
  // pattern) as server externals tells Next to `require()` them
  // directly from `node_modules`, where the `.afm` files live next
  // to the JS as they do at install time.
  experimental: {
    serverComponentsExternalPackages: ["pdfkit", "fontkit", "exceljs", "pptxgenjs"],
  },
};

module.exports = nextConfig;
