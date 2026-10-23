/* Nunatak iconography — hand-drawn on a 24px grid, 1.5px stroke, round caps.
   One system: quiet technical line icons, no third-party library.
   Every icon is aria-hidden by default; the surrounding control carries the
   accessible name. `title` opts into a labelled <svg> for standalone use. */
import type { SVGProps } from "react";

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
  title?: string;
}

function Svg({ size = 16, title, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/* ---- brand ---- */

/** Nunatak mark: a summit whose ridgeline vertices are orchestration nodes —
   a peak that is simultaneously a three-node flow graph. */
export function NunatakMark({ size = 24, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" {...rest}>
      <g fill="none" stroke="url(#nkmark)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 24 16 6 26 24" />
        <path d="M11 24 16 15 21 24" strokeWidth="1.6" opacity="0.4" />
      </g>
      <g fill="url(#nkmark)">
        <circle cx="16" cy="6" r="2.4" />
        <circle cx="6" cy="24" r="2.1" />
        <circle cx="26" cy="24" r="2.1" />
      </g>
      <defs>
        <linearGradient id="nkmark" x1="6" y1="6" x2="26" y2="26" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--fx-blue-bright)" />
          <stop offset="1" stopColor="var(--fx-violet-bright)" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/* ---- navigation ---- */
export const IconOverview = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 12a8.5 8.5 0 0 1 17 0" />
    <path d="M12 12l3.8-3.2" />
    <path d="M3.5 12h2M18.5 12h2M12 3.5v2" />
    <path d="M8 17.5h8" />
  </Svg>
);
export const IconWorkflows = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="6" height="5" rx="1.5" />
    <rect x="15" y="15" width="6" height="5" rx="1.5" />
    <rect x="15" y="4" width="6" height="5" rx="1.5" opacity="0.55" />
    <path d="M9 6.5h6M9 8.8c0 4.7 2.5 8.7 6 8.7" />
  </Svg>
);
export const IconExecution = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="6.5" r="2.5" />
    <circle cx="18" cy="12" r="2.5" />
    <circle cx="6" cy="17.5" r="2.5" />
    <path d="M8.4 7.6 15.6 11M8.4 16.4l7.2-3.4" />
  </Svg>
);
export const IconDeadLetter = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 13.5 6 4.5h12l2 9" />
    <path d="M4 13.5v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
    <path d="M4 13.5h5l1.2 2.3h3.6l1.2-2.3h5" />
    <path d="M12 8.5v2.5" opacity="0.9" />
    <circle cx="12" cy="7" r="0.4" fill="currentColor" />
  </Svg>
);
export const IconEvents = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h3.5L9 5.5l3 13 2.5-9 1.7 2.5H21" />
  </Svg>
);
export const IconMetrics = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20V9M9.3 20V4M14.7 20v-8M20 20V6.5" />
  </Svg>
);
export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" />
  </Svg>
);

/* ---- actions & status ---- */
export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15 15l5 5" />
  </Svg>
);
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 1 0-.6 4" />
    <path d="M20 5v6h-6" />
  </Svg>
);
export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 4.8v14.4L19.5 12 7 4.8Z" />
  </Svg>
);
export const IconStop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="13" height="13" rx="2" />
  </Svg>
);
export const IconCancel = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M6.5 17.5 17.5 6.5" />
  </Svg>
);
export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 12.5l5 5 10-11" />
  </Svg>
);
export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 5.5l13 13M18.5 5.5l-13 13" />
  </Svg>
);
export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.8 21 19.2H3L12 3.8Z" />
    <path d="M12 9.5v4.2" />
    <circle cx="12" cy="16.4" r="0.5" fill="currentColor" />
  </Svg>
);
export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 5.5H6a1.5 1.5 0 0 0-1.5 1.5v9" />
  </Svg>
);
export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 5.5 16 12l-6.5 6.5" />
  </Svg>
);
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 9.5 12 16l6.5-6.5" />
  </Svg>
);
export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12h15M13.5 6.5 20 12l-6.5 5.5" />
  </Svg>
);
export const IconUndo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.5h9.5a5.5 5.5 0 0 1 0 11H8" />
    <path d="M8 5.5 4 9.5l4 4" />
  </Svg>
);
export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconFilter = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 5.5h17l-6.6 7.6V19l-3.8 2v-7.9L3.5 5.5Z" />
  </Svg>
);
export const IconKey = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="4.5" />
    <path d="M11.2 11.2 20 20M16 16l-2.3 2.3M18.2 13.8 20 15.6" />
  </Svg>
);
export const IconPlug = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 3v5M15 3v5" />
    <path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8Z" />
    <path d="M12 17v4" />
  </Svg>
);
export const IconDatabase = (p: IconProps) => (
  <Svg {...p}>
    <ellipse cx="12" cy="6" rx="7.5" ry="3" />
    <path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
    <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
  </Svg>
);
export const IconJson = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.5 4.5c-2 0-2.5 1-2.5 2.5v2c0 1.5-1 2.5-2 2.5 1 0 2 1 2 2.5v2c0 1.5.5 2.5 2.5 2.5" />
    <path d="M15.5 4.5c2 0 2.5 1 2.5 2.5v2c0 1.5 1 2.5 2 2.5-1 0-2 1-2 2.5v2c0 1.5-.5 2.5-2.5 2.5" />
  </Svg>
);
export const IconScroll = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 3.5h11a1.5 1.5 0 0 1 1.5 1.5v11" />
    <rect x="4.5" y="6" width="12" height="14.5" rx="1.5" />
    <path d="M7.5 10h6M7.5 13h6M7.5 16h4" />
  </Svg>
);
export const IconTrend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 17.5 9 11l3.5 3L20 6.5" />
    <path d="M15.5 6.5H20V11" />
  </Svg>
);
export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 4.5H20V11" />
    <path d="M20 4.5 11 13.5" />
    <path d="M18 13.5v5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 18.5v-10A1.5 1.5 0 0 1 6.5 7h5" />
  </Svg>
);
export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);
export const IconExpand = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4.5h-4a.5.5 0 0 0-.5.5v4M15 19.5h4a.5.5 0 0 0 .5-.5v-4M19.5 9v-4a.5.5 0 0 0-.5-.5h-4M4.5 15v4a.5.5 0 0 0 .5.5h4" />
  </Svg>
);
export const IconSpinner = ({ size = 16, ...rest }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);
export const IconStep = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="7" width="16" height="10" rx="2.5" />
    <path d="M8.5 12h7M12.5 9.5 15.5 12l-3 2.5" />
  </Svg>
);
export const IconLease = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    <circle cx="12" cy="15" r="1.2" fill="currentColor" stroke="none" />
  </Svg>
);

/* ---- inspector view icons ---- */
export const IconLayers = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5 21 8l-9 4.5L3 8l9-4.5Z" />
    <path d="M3 12.5 12 17l9-4.5" />
    <path d="M3 16.5 12 21l9-4.5" opacity="0.55" />
  </Svg>
);
export const IconActivity = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h3.5L9 6l3.5 12 2.5-6H21" />
  </Svg>
);
export const IconLogs = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4.5" width="16" height="15" rx="2" />
    <path d="M7.5 9.5 10 12l-2.5 2.5M12.5 15h4" />
  </Svg>
);
export const IconGauge = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 15a8 8 0 1 1 16 0" />
    <path d="M12 15l3.5-3.5" />
    <circle cx="12" cy="15" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconRoute = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="6.5" r="2.5" />
    <circle cx="18" cy="17.5" r="2.5" />
    <path d="M8.5 6.5H14a3 3 0 0 1 0 6H10a3 3 0 0 0 0 6h5.5" />
  </Svg>
);
export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5" />
    <circle cx="12" cy="8" r="0.5" fill="currentColor" />
  </Svg>
);
export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </Svg>
);
