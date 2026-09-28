// WI-2A — invoice document preview. Scaffold reproduction of a real
// invoice page (not a placeholder icon), rendered in HTML/CSS so the
// review page matches the approved reference visually per §10.

import { INVOICE_PREVIEW } from "./review-scaffold-data";

function ChevronL() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M9 3l-4 4 4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ChevronR() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function InvoiceDocumentPreview() {
  const p = INVOICE_PREVIEW;
  return (
    <div className="wi-review-doc-wrap">
      <article className="wi-review-doc" aria-label="Invoice document preview">
        <div className="wi-review-doc-head">
          <div className="wi-review-doc-brand">
            <div className="wi-review-doc-brand-mark">{p.brand}</div>
            <div className="wi-review-doc-brand-sub">{p.brandSub}</div>
          </div>
          <div className="wi-review-doc-title">{p.documentTitle}</div>
        </div>
        <div className="wi-review-doc-body">
          <div className="wi-review-doc-vendor">
            <div>{p.vendor.name}</div>
            <div>{p.vendor.address1}</div>
            <div>{p.vendor.address2}</div>
          </div>
          <dl className="wi-review-doc-fields">
            {p.fields.map((f) => (
              <div key={f.label} className="wi-review-doc-field">
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <table className="wi-review-doc-table">
          <thead>
            <tr>
              <th>Description</th>
              <th className="wi-review-doc-num">Qty</th>
              <th className="wi-review-doc-num">Unit Price</th>
              <th className="wi-review-doc-num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l) => (
              <tr key={l.description}>
                <td>{l.description}</td>
                <td className="wi-review-doc-num">{l.qty}</td>
                <td className="wi-review-doc-num">{l.unitPrice}</td>
                <td className="wi-review-doc-num">{l.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="wi-review-doc-totals">
          {p.totals.map((t) => (
            <div key={t.label} className={`wi-review-doc-total${t.strong ? " wi-review-doc-total--strong" : ""}`}>
              <div>{t.label}</div>
              <div>{t.value}</div>
            </div>
          ))}
        </div>
      </article>
      <div className="wi-review-doc-toolbar">
        <button type="button" className="wi-review-doc-link">View full document</button>
        <div className="wi-review-doc-pager">
          <button type="button" className="wi-review-doc-page-btn" aria-label="Previous page"><ChevronL /></button>
          <span className="wi-review-doc-page">
            {p.page.current} / {p.page.of}
          </span>
          <button type="button" className="wi-review-doc-page-btn" aria-label="Next page"><ChevronR /></button>
        </div>
      </div>
    </div>
  );
}
