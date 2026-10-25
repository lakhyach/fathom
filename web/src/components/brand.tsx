/* Nunatak brand mark — an alpine nunatak: a two-peak ridge with a lit snow cap
   over a shaded body. One geometry is shared by the rail, the favicon and every
   web-app icon, so the product identity is the same shape at 16px and 26px.
   The gradient runs through CSS variables in the app and through literal hex in
   the standalone favicon, where no stylesheet is attached. */
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
      <path
        d="M2.6 26.2 11.6 8.2l4.8 8.9 3.3-5.7 9.7 14.8z"
        fill="url(#nunatak-body)"
      />
      <path
        d="M11.6 8.2 8.7 14.3l2.9-1 2.6 2.1z"
        fill="var(--lime-bright, #aee762)"
      />
      <defs>
        <linearGradient
          id="nunatak-body"
          x1="6"
          y1="9"
          x2="26"
          y2="27"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--primary, #67c352)" />
          <stop offset="1" stopColor="var(--moss, #40913d)" />
        </linearGradient>
      </defs>
    </svg>
  );
}
