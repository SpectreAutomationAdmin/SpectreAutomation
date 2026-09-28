// WI-2A — five-stage horizontal workflow. Connected by thin horizontal
// lines; the active stage is a filled muted-grey circle, completed
// stages are filled warm-gold, remaining stages are outlined.

import { WORKFLOW_STAGES } from "./review-scaffold-data";

export default function WorkItemWorkflow() {
  return (
    <section className="wi-review-card wi-review-card--workflow" aria-label="Workflow">
      <div className="wi-review-card-head">
        <h2 className="wi-review-card-title">Workflow</h2>
      </div>
      <ol className="wi-review-flow" data-testid="wi-review-flow">
        {WORKFLOW_STAGES.map((s, i) => (
          <li key={s.key} className={`wi-review-flow-stage wi-review-flow-stage--${s.state}`}>
            {i > 0 && <span className="wi-review-flow-conn" aria-hidden="true" />}
            <div className="wi-review-flow-head">
              <span className="wi-review-flow-circle" aria-hidden="true">{s.index}</span>
              <span className="wi-review-flow-label">{s.label}</span>
            </div>
            <div className="wi-review-flow-supporting">
              {s.supporting.split("\n").map((line, li) => (
                <div key={li}>{line}</div>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
