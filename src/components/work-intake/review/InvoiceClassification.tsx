// WI-2A — extracted invoice information + classification rows,
// occupying the right half of the Invoice Details card.

import type { ClassificationRow, DocMetaRow } from "./review-scaffold-data";
import {
  INVOICE_CLASSIFICATION,
  INVOICE_DOC_META,
  INVOICE_LINE_ITEMS_SUMMARY,
} from "./review-scaffold-data";

function VendorMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 8l6-4 6 4v8H4z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 16v-4h4v4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// Compact rounded-square icon tiles per classification type. Colours
// match the accepted reference: purple capex, teal irrigation, green
// GL, neutral project, gold cost-center, gold location.
function ClassificationIcon({ tone }: { tone: ClassificationRow["iconTone"] }) {
  const common = { width: 18, height: 18, viewBox: "0 0 20 20", "aria-hidden": true } as const;
  if (tone === "vendor") {
    return <div className="wi-review-cls-icon wi-review-cls-icon--vendor"><VendorMark /></div>;
  }
  if (tone === "capex") {
    return (
      <div className="wi-review-cls-icon wi-review-cls-icon--capex">
        <svg {...common}>
          <path d="M4 10h12M10 4v12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
    );
  }
  if (tone === "irrigation") {
    return (
      <div className="wi-review-cls-icon wi-review-cls-icon--irrigation">
        <svg {...common}>
          <path d="M10 3c3 3.5 5 6 5 9a5 5 0 0 1-10 0c0-3 2-5.5 5-9z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      </div>
    );
  }
  if (tone === "gl") {
    return (
      <div className="wi-review-cls-icon wi-review-cls-icon--gl">
        <svg {...common}>
          <rect x="4" y="4" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M7 10h6M7 13h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </div>
    );
  }
  if (tone === "project") {
    return (
      <div className="wi-review-cls-icon wi-review-cls-icon--project">
        <svg {...common}>
          <path d="M4 6.5l3-2h10v11H4z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      </div>
    );
  }
  if (tone === "cost-center") {
    return (
      <div className="wi-review-cls-icon wi-review-cls-icon--cost-center">
        <svg {...common}>
          <circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10 6v4l3 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
        </svg>
      </div>
    );
  }
  // location
  return (
    <div className="wi-review-cls-icon wi-review-cls-icon--location">
      <svg {...common}>
        <path d="M10 3c3 0 5 2 5 5 0 3.5-5 9-5 9s-5-5.5-5-9c0-3 2-5 5-5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <circle cx="10" cy="8" r="1.6" fill="currentColor" />
      </svg>
    </div>
  );
}

function ArrowRight() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 6h6M7 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckDotSmall() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="5" fill="#dff0dd" />
      <path d="M3.5 6.2l1.7 1.6L8.6 4.4" stroke="#1f6f3f" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DocMetaRowEl({ row }: { row: DocMetaRow }) {
  return (
    <div className="wi-review-doc-meta-row">
      <div className="wi-review-doc-meta-label">{row.label}</div>
      <div className="wi-review-doc-meta-value">
        {row.iconTone === "vendor" && <ClassificationIcon tone="vendor" />}
        <span>{row.value}</span>
        {row.pill && (
          <span className={`wi-review-pill wi-review-pill--${row.pill.tone}`}>
            <CheckDotSmall /> <span>{row.pill.label}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function ClassificationRowEl({ row }: { row: ClassificationRow }) {
  return (
    <div className="wi-review-cls-row">
      <div className="wi-review-cls-label">{row.label}</div>
      <div className="wi-review-cls-value">
        <ClassificationIcon tone={row.iconTone} />
        <span>{row.value}</span>
        {row.pill && (
          <span className={`wi-review-pill wi-review-pill--${row.pill.tone}`}>
            {row.pill.tone !== "confidence" && <CheckDotSmall />}
            <span>{row.pill.label}</span>
          </span>
        )}
      </div>
    </div>
  );
}

export default function InvoiceClassification() {
  return (
    <div className="wi-review-classify" aria-label="Extracted invoice information">
      {INVOICE_DOC_META.map((row) => (
        <DocMetaRowEl key={row.label} row={row} />
      ))}
      <div className="wi-review-doc-meta-row">
        <div className="wi-review-doc-meta-label">Line Items</div>
        <div className="wi-review-doc-meta-value wi-review-doc-meta-value--items">
          <span>{INVOICE_LINE_ITEMS_SUMMARY.count} items</span>
          <span className="wi-review-doc-meta-sep" aria-hidden="true">|</span>
          <button type="button" className="wi-review-linklike">
            View breakdown <ArrowRight />
          </button>
        </div>
      </div>
      <div className="wi-review-classify-divider" role="presentation" />
      {INVOICE_CLASSIFICATION.map((row) => (
        <ClassificationRowEl key={row.label} row={row} />
      ))}
    </div>
  );
}
