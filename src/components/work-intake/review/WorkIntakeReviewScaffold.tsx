// WI-2A — Work Intake review page root. Composes the header, tabs,
// primary content grid (Invoice Details full-width; Line Items +
// Context in a 2-col row; Workflow full-width) with the Spectre
// intelligence rail on the right.

import type { ReviewWorkItem } from "./review-scaffold-data";
import WorkItemReviewHeader from "./WorkItemReviewHeader";
import WorkItemReviewTabs from "./WorkItemReviewTabs";
import InvoiceDetailsCard from "./InvoiceDetailsCard";
import LineItemsCard from "./LineItemsCard";
import WorkItemContextCard from "./WorkItemContextCard";
import WorkItemWorkflow from "./WorkItemWorkflow";
import SpectreReviewRail from "./SpectreReviewRail";

export default function WorkIntakeReviewScaffold({ item }: { item: ReviewWorkItem }) {
  return (
    <div className="wi-review-root" data-testid="wi-review-root">
      <div className="wi-review-grid">
        <div className="wi-review-main">
          <WorkItemReviewHeader item={item} />
          <WorkItemReviewTabs active="overview" />
          <div className="wi-review-body">
            <InvoiceDetailsCard />
            <div className="wi-review-two-col">
              <LineItemsCard />
              <WorkItemContextCard />
            </div>
            <WorkItemWorkflow />
          </div>
        </div>
        <SpectreReviewRail />
      </div>
    </div>
  );
}
