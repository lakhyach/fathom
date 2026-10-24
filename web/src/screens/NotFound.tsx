/* 404 — honest "no such route" with a single real action, given the cockpit's
   alpine identity: a gradient ridge glyph over the midnight field. */
import { Link } from "react-router";

import { IconArrowRight, IconOverview } from "../icons";

export function NotFound() {
  return (
    <div className="fx-404">
      <div className="fx-404__inner">
        <span className="fx-404__glyph" aria-hidden="true">404</span>
        <span className="kicker">Off the ridge line</span>
        <h1 className="fx-404__title">This route doesn’t exist</h1>
        <p className="fx-404__hint">
          The cockpit exposes Overview, Workflows, Dead Letter, Events &amp; Audit, Metrics and Settings.
        </p>
        <Link className="btn btn-primary btn-sm fx-404__cta" to="/">
          <IconOverview size={14} />
          <span>Back to overview</span>
          <IconArrowRight size={13} />
        </Link>
      </div>
    </div>
  );
}
