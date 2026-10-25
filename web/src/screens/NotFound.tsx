/* 404 — honest "no such route". Rather than a dead end, it names the six real
   destinations in the cockpit and offers one primary action. */
import { ArrowRight, Compass, LayoutDashboard } from "lucide-react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

const ROUTES = [
  { to: "/", label: "Overview" },
  { to: "/workflows", label: "Workflows" },
  { to: "/dlq", label: "Dead Letter" },
  { to: "/events", label: "Events & Audit" },
  { to: "/metrics", label: "Metrics" },
  { to: "/settings", label: "Settings" },
];

export function NotFound() {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <div className="surface-card w-full max-w-lg rounded-xl px-6 py-8 text-center">
        <Compass
          className="mx-auto size-7 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="mt-3 block font-mono text-4xl leading-none font-semibold tracking-tight text-muted-foreground/70">
          404
        </span>
        <span className="mt-3 block text-xs text-muted-foreground">
          Off the ridge line
        </span>
        <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-foreground">
          This route doesn’t exist
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The cockpit exposes six views — pick one below or return to the
          overview.
        </p>

        <Separator className="my-5" />

        <nav
          aria-label="Cockpit routes"
          className="flex flex-wrap justify-center gap-2"
        >
          {ROUTES.map((r) => (
            <Link
              key={r.to}
              to={r.to}
              className="rounded-md border border-border/70 bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {r.label}
            </Link>
          ))}
        </nav>

        <Button asChild size="sm" className="mt-5">
          <Link to="/">
            <LayoutDashboard data-slot="icon" />
            <span>Back to overview</span>
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
