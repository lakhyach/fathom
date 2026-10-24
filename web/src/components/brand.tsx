/* Nunatak brand mark — the summit rendered as an orchestration graph: two base
   nodes feed a central coordinator that resolves to the peak. Product identity,
   not an icon; Phase 8 re-inks it into the reference lime ramp. */
import type { SVGProps } from "react";

export function NunatakMark({
  size = 24,
  ...rest
}: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      {...rest}
    >
      <g
        fill="none"
        stroke="url(#nunatakmark)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 8 24 16 16 24 8 16 16 8Z" />
        <path
          d="M16 8v5M16 19v5M8 16h5M19 16h5"
          strokeWidth="1.8"
          opacity="0.5"
        />
      </g>
      <g fill="url(#nunatakmark)">
        <circle cx="16" cy="8" r="2.7" />
        <circle cx="8" cy="16" r="2.2" />
        <circle cx="24" cy="16" r="2.2" />
        <circle cx="16" cy="24" r="2.2" />
      </g>
      <circle
        cx="16"
        cy="16"
        r="2"
        fill="none"
        stroke="url(#nunatakmark)"
        strokeWidth="1.8"
      />
      <defs>
        <linearGradient
          id="nunatakmark"
          x1="6"
          y1="6"
          x2="26"
          y2="26"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--lime-bright)" />
          <stop offset="1" stopColor="var(--primary)" />
        </linearGradient>
      </defs>
    </svg>
  );
}
