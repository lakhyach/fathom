/* Fathom mark: a luminous depth pin above three steady contour lines. */
import type { SVGProps } from "react";

export function FathomMark({
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
        d="M16 4.5v8.2"
        stroke="var(--lime-bright, #aee762)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="16" cy="5" r="3" fill="var(--lime-bright, #aee762)" />
      <path
        d="M5.5 15.2c3.1-2.3 6.6-3.4 10.5-3.4s7.4 1.1 10.5 3.4M7.8 20.1c2.5-1.5 5.2-2.3 8.2-2.3s5.7.8 8.2 2.3M10.2 24.8c1.8-.8 3.7-1.2 5.8-1.2s4 .4 5.8 1.2"
        stroke="var(--primary, #67c352)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
