/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // DRH-1 (2026-09-19) — standalone output. Next.js traces the runtime
  // dependency graph and emits a minimal server bundle under
  // .next/standalone/, cutting the runner image from ~2.3 GB to
  // ~350 MB.
  //
  // Earlier in DRH-1 this was reverted because the tracer step
  // (`Collecting build traces`) is silent for 10+ min inside Windows
  // Docker Desktop and tripped the deployment controller's watchdog.
  // The canonical staging deploy path is now a Linux CI runner
  // (.github/workflows/deploy-staging.yml), where the tracer completes
  // in reasonable time. Standalone is safe on that path.
  //
  // Prisma runtime + CLI are added explicitly in the Dockerfile — they
  // are not traced because no server route imports the CLI.
  output: "standalone",
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
  // WEB-1A (2026-09-22) — allow Unsplash CDN for marketing photography.
  // Unsplash's license permits commercial use without attribution
  // (https://unsplash.com/license). Only images explicitly referenced by
  // photo id in src/components/marketing/** are used; no user upload
  // path or dynamic import from Unsplash exists.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
    ],
  },
};

module.exports = nextConfig;
