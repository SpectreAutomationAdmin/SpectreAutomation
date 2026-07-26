/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
