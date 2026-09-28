// WI-2A — Line Items card. Understated editorial table (no zebra
// striping, no heavy borders) matching the accepted reference.

import {
  INVOICE_LINE_ITEMS_SUMMARY,
  INVOICE_LINES_TABLE,
} from "./review-scaffold-data";

export default function LineItemsCard() {
  return (
    <section className="wi-review-card wi-review-card--lines" aria-label="Line Items">
      <div className="wi-review-card-head wi-review-card-head--split">
        <h2 className="wi-review-card-title">Line Items</h2>
        <div className="wi-review-card-summary">
          <span>{INVOICE_LINE_ITEMS_SUMMARY.count} items</span>
          <span className="wi-review-card-summary-total">{INVOICE_LINE_ITEMS_SUMMARY.total}</span>
        </div>
      </div>
      <table className="wi-review-lines" data-testid="wi-review-lines-table">
        <thead>
          <tr>
            <th className="wi-review-lines-idx">#</th>
            <th>Description</th>
            <th className="wi-review-lines-num">Qty</th>
            <th className="wi-review-lines-num">Unit Price</th>
            <th className="wi-review-lines-num">Amount</th>
            <th className="wi-review-lines-gl">GL Code</th>
          </tr>
        </thead>
        <tbody>
          {INVOICE_LINES_TABLE.map((l) => (
            <tr key={l.n}>
              <td className="wi-review-lines-idx">{l.n}</td>
              <td>{l.description}</td>
              <td className="wi-review-lines-num">{l.qty}</td>
              <td className="wi-review-lines-num">{l.unitPrice}</td>
              <td className="wi-review-lines-num">{l.amount}</td>
              <td className="wi-review-lines-gl">{l.glCode}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
