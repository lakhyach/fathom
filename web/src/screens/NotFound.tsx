/* 404 — honest "no such route" with a single real action. */
import { Link } from "react-router";

import { EmptyState } from "../components/ui";
import { IconOverview } from "../icons";

export function NotFound() {
  return (
    <div className="fx-404">
      <EmptyState
        icon={<IconOverview size={22} />}
        title="This route doesn’t exist"
        hint="The cockpit exposes Overview, Workflows, Dead Letter, Events & Audit, Metrics and Settings."
        action={
          <Link className="btn btn-primary btn-sm" to="/">
            Back to overview
          </Link>
        }
      />
    </div>
  );
}
