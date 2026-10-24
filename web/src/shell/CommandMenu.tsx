/* Nunatak command menu (⌘K / Ctrl+K) — Built on shadcn/ui Command:
   cmdk's typeahead listbox engine inside a Radix Dialog (real focus trap,
   scroll lock, restore-focus, Escape + outside-pointer dismissal handled by
   Radix). Every entry is real: fixed navigation routes, the two genuine
   global actions (New workflow, present a key), and the 8 most-recent
   workflows read from the same live list query the Overview already uses.
   The result filter is client-side over those already-fetched records — it is
   explicitly NOT a server fuzzy search (the API only matches exact
   business_key), and the footer says so. */
import { useMemo } from "react";
import { useNavigate } from "react-router";
import {
  ChartLine,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  MailWarning,
  Plus,
  ScrollText,
  Settings,
  Workflow,
} from "lucide-react";

import { useWorkflows } from "../api/hooks";
import { RelTime, StatusBadge, truncate } from "../components/ui";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

const ROUTES = [
  {
    to: "/",
    label: "Overview",
    hint: "Operations command centre",
    Icon: LayoutDashboard,
    kw: "dashboard home census pulse",
  },
  {
    to: "/workflows",
    label: "Workflows",
    hint: "Explorer & filters",
    Icon: ListChecks,
    kw: "list table explore",
  },
  {
    to: "/dlq",
    label: "Dead Letter",
    hint: "Incident workspace",
    Icon: MailWarning,
    kw: "failures manual intervention resolve",
  },
  {
    to: "/events",
    label: "Events & Audit",
    hint: "Per-workflow trail",
    Icon: ScrollText,
    kw: "audit trail log",
  },
  {
    to: "/metrics",
    label: "Metrics",
    hint: "Telemetry & health",
    Icon: ChartLine,
    kw: "prometheus health observability",
  },
  {
    to: "/settings",
    label: "Settings",
    hint: "Keys, probes, definitions",
    Icon: Settings,
    kw: "config api key register definition",
  },
];

export function CommandMenu({
  open,
  onClose,
  onNewWorkflow,
}: {
  open: boolean;
  onClose: () => void;
  onNewWorkflow: () => void;
}) {
  const navigate = useNavigate();
  const recent = useWorkflows({ limit: 8 });
  const items = useMemo(() => recent.data?.items ?? [], [recent.data]);

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="Nunatak command menu"
      className="bg-popover sm:max-w-xl"
    >
      <Command label="Nunatak command menu">
        <CommandInput
          placeholder="Jump to a page, run an action, open a recent workflow…"
          aria-label="Search commands"
        />
        <CommandList>
          <CommandEmpty>No matching command.</CommandEmpty>

          <CommandGroup heading="Navigate">
            {ROUTES.map(({ to, label, hint, Icon, kw }) => (
              <CommandItem
                key={to}
                value={`${label} ${to} ${kw}`}
                onSelect={() => go(to)}
                className="gap-2.5"
              >
                <Icon
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm">{label}</span>
                  <span className="text-xs text-muted-foreground">{hint}</span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Actions">
            <CommandItem
              value="New workflow create place start"
              onSelect={() => {
                onClose();
                onNewWorkflow();
              }}
              className="gap-2.5"
            >
              <Plus
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-sm">New workflow</span>
                <span className="text-xs text-muted-foreground">
                  Open the placement dialog
                </span>
              </span>
            </CommandItem>
            <CommandItem
              value="Present API key settings authenticate role"
              onSelect={() => go("/settings")}
              className="gap-2.5"
            >
              <KeyRound
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-sm">Present an API key</span>
                <span className="text-xs text-muted-foreground">
                  Bearer key + role, stored in this browser only
                </span>
              </span>
            </CommandItem>
          </CommandGroup>

          {items.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading={`Recent workflows (${items.length})`}>
                {items.map((w) => (
                  <CommandItem
                    key={w.id}
                    value={`${w.def_name} ${w.business_key} ${w.state} ${w.id}`}
                    onSelect={() => go(`/workflows/${w.id}`)}
                    className="gap-2.5"
                  >
                    <Workflow
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm">
                        {w.def_name}
                        <span className="text-muted-foreground">
                          {" "}
                          · {truncate(w.business_key, 26)}
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        <span className="font-mono">{w.id.slice(0, 8)}</span> ·{" "}
                        <RelTime iso={w.updated_at} />
                      </span>
                    </span>
                    <StatusBadge
                      state={w.state}
                      kind="workflow"
                      size="sm"
                      className="ml-auto"
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
        </CommandList>

        <div className="flex items-center gap-4 border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border/70 bg-chip px-1 font-mono">
              ↑
            </kbd>
            <kbd className="rounded border border-border/70 bg-chip px-1 font-mono">
              ↓
            </kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border/70 bg-chip px-1 font-mono">
              ↵
            </kbd>
            select
          </span>
          <span className="ml-auto min-w-0 truncate text-right">
            {items.length > 0
              ? `Client-side filter over the ${items.length} most-recent workflows — not a server search`
              : "Recent workflows appear once the list loads"}
          </span>
        </div>
      </Command>
    </CommandDialog>
  );
}
