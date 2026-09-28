// WI-2A — Invoice Details card. Two-column layout:
//   left  = document preview (InvoiceDocumentPreview)
//   right = extracted / classified information (InvoiceClassification)

import InvoiceDocumentPreview from "./InvoiceDocumentPreview";
import InvoiceClassification from "./InvoiceClassification";

export default function InvoiceDetailsCard() {
  return (
    <section className="wi-review-card wi-review-card--details" aria-label="Invoice Details">
      <div className="wi-review-card-head">
        <h2 className="wi-review-card-title">Invoice Details</h2>
      </div>
      <div className="wi-review-details-grid">
        <div className="wi-review-details-doc">
          <InvoiceDocumentPreview />
        </div>
        <div className="wi-review-details-meta">
          <InvoiceClassification />
        </div>
      </div>
    </section>
  );
}
