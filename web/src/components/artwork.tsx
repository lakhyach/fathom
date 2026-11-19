/* ============================================================================
   KPI artwork — the decorative object family for prominent summary cards.

   These are the reference's "lit objects on the card": dimensional, glossy,
   self-luminous forms that give each metric a recognisable silhouette. They are
   deliberately NOT charts. Nothing here encodes a value — no arc length, bar
   height or node count tracks the data — because a decorative object that
   quietly agrees with the number next to it is how a dashboard starts lying.
   Every measurement on a KPI card is drawn by the components in flow.tsx from
   real ledger fields; these draw identity.

   Subject matter is workflow operations, never finance: execution nodes, a
   completion torus, an in-flight pipeline, a fractured form for failures, a
   queue stack. Shapes are built from theme tokens so they re-hue with the
   system, and every gradient id is namespaced with useId() because five of
   these render on one page at once.
   ========================================================================== */
import { useId } from "react";

/** Shared 128 box; artwork is sized by the card, never by itself. */
const FRAME = "0 0 128 128";

type ArtProps = { className?: string };

/* ------------------------------ 1. executions ------------------------------ */

/** Three glass execution nodes chained by a luminous conduit, one node ahead of
    the others — sequence, not quantity. */
export function ExecutionsOrb({ className }: ArtProps) {
  const u = useId().replace(/:/g, "");
  return (
    <svg
      viewBox={FRAME}
      aria-hidden="true"
      className={className}
      fill="none"
    >
      <defs>
        <radialGradient id={`${u}n`} cx="34%" cy="26%" r="78%">
          <stop offset="0%" stopColor="oklch(0.92 0.14 132 / 92%)" />
          <stop offset="46%" stopColor="oklch(0.62 0.17 137 / 62%)" />
          <stop offset="100%" stopColor="oklch(0.24 0.06 145 / 34%)" />
        </radialGradient>
        <linearGradient id={`${u}c`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="oklch(0.86 0.16 133 / 8%)" />
          <stop offset="55%" stopColor="oklch(0.9 0.17 130 / 70%)" />
          <stop offset="100%" stopColor="oklch(0.86 0.16 133 / 14%)" />
        </linearGradient>
        <filter id={`${u}g`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="4.4" />
        </filter>
      </defs>

      {/* bloom behind the chain */}
      <ellipse
        cx="64"
        cy="70"
        rx="44"
        ry="26"
        fill="oklch(0.7 0.19 140 / 26%)"
        filter={`url(#${u}g)`}
      />
      {/* conduit */}
      <path
        d="M22 84C34 84 34 52 48 52s14 30 28 30 14-40 30-40"
        stroke={`url(#${u}c)`}
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      {/* nodes, back to front: the furthest is dimmest */}
      <g opacity="0.5">
        <circle cx="22" cy="84" r="9" fill={`url(#${u}n)`} />
        <circle cx="22" cy="84" r="9" stroke="oklch(0.93 0.1 132 / 40%)" />
      </g>
      <g opacity="0.78">
        <circle cx="48" cy="52" r="12" fill={`url(#${u}n)`} />
        <circle cx="48" cy="52" r="12" stroke="oklch(0.93 0.1 132 / 45%)" />
      </g>
      <g>
        <circle cx="76" cy="82" r="15.5" fill={`url(#${u}n)`} />
        <circle
          cx="76"
          cy="82"
          r="15.5"
          stroke="oklch(0.95 0.11 130 / 55%)"
        />
        {/* specular chip */}
        <ellipse
          cx="70"
          cy="74"
          rx="5.4"
          ry="3.2"
          fill="oklch(0.99 0.03 130 / 78%)"
          transform="rotate(-28 70 74)"
        />
      </g>
      {/* the head node, ahead of the chain */}
      <g className="art-pulse">
        <circle cx="106" cy="42" r="8.6" fill={`url(#${u}n)`} />
        <circle
          cx="106"
          cy="42"
          r="13.4"
          stroke="oklch(0.88 0.17 132 / 34%)"
          strokeWidth="1.4"
        />
      </g>
    </svg>
  );
}

/* ----------------------------- 2. success rate ----------------------------- */

/** A dimensional torus: a lit band over a dark body with an inner bevel. The
    sweep is a fixed decorative proportion and carries no percentage. */
export function SuccessTorus({ className }: ArtProps) {
  const u = useId().replace(/:/g, "");
  return (
    <svg viewBox={FRAME} aria-hidden="true" className={className} fill="none">
      <defs>
        <linearGradient id={`${u}r`} x1="0" y1="0" x2="0.9" y2="1">
          <stop offset="0%" stopColor="oklch(0.95 0.16 128)" />
          <stop offset="42%" stopColor="oklch(0.72 0.19 142)" />
          <stop offset="100%" stopColor="oklch(0.42 0.12 152)" />
        </linearGradient>
        <radialGradient id={`${u}h`} cx="50%" cy="50%" r="50%">
          <stop offset="60%" stopColor="oklch(0.16 0.02 145 / 0%)" />
          <stop offset="100%" stopColor="oklch(0.06 0.01 145 / 70%)" />
        </radialGradient>
        <filter id={`${u}b`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
      </defs>
      <circle
        cx="64"
        cy="66"
        r="38"
        stroke="oklch(0.74 0.19 140 / 30%)"
        strokeWidth="13"
        filter={`url(#${u}b)`}
      />
      {/* body ring, unlit */}
      <circle
        cx="64"
        cy="64"
        r="38"
        stroke="oklch(0.26 0.03 145 / 92%)"
        strokeWidth="13"
      />
      {/* lit band, deliberately a fixed 240° so it cannot be read as a value */}
      <g className="art-spin" style={{ transformOrigin: "64px 64px" }}>
        <circle
          cx="64"
          cy="64"
          r="38"
          stroke={`url(#${u}r)`}
          strokeWidth="13"
          strokeLinecap="round"
          strokeDasharray="159 80"
          transform="rotate(-96 64 64)"
        />
      </g>
      {/* bevel + inner shadow give the ring thickness */}
      <circle
        cx="64"
        cy="64"
        r="44.5"
        stroke="oklch(0.96 0.06 132 / 22%)"
        strokeWidth="1"
      />
      <circle
        cx="64"
        cy="64"
        r="31.5"
        stroke="oklch(0.96 0.06 132 / 16%)"
        strokeWidth="1"
      />
      <circle cx="64" cy="64" r="38" fill={`url(#${u}h)`} />
      {/* gloss */}
      <ellipse
        cx="46"
        cy="36"
        rx="13"
        ry="5.6"
        fill="oklch(0.99 0.04 130 / 46%)"
        transform="rotate(-34 46 36)"
      />
    </svg>
  );
}

/* ------------------------------- 3. active -------------------------------- */

/** An in-flight pipeline: five stations on a conduit with one travelling
    pulse. The count of stations is a shape, not a census. */
export function ActivePipeline({ className }: ArtProps) {
  const u = useId().replace(/:/g, "");
  return (
    <svg viewBox={FRAME} aria-hidden="true" className={className} fill="none">
      <defs>
        <linearGradient id={`${u}p`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="oklch(0.84 0.16 168 / 26%)" />
          <stop offset="50%" stopColor="oklch(0.88 0.17 150 / 66%)" />
          <stop offset="100%" stopColor="oklch(0.84 0.16 168 / 22%)" />
        </linearGradient>
        <radialGradient id={`${u}s`} cx="36%" cy="30%" r="80%">
          <stop offset="0%" stopColor="oklch(0.96 0.12 150 / 96%)" />
          <stop offset="100%" stopColor="oklch(0.46 0.13 160 / 52%)" />
        </radialGradient>
        <filter id={`${u}f`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5.2" />
        </filter>
      </defs>
      <ellipse
        cx="64"
        cy="66"
        rx="46"
        ry="20"
        fill="oklch(0.72 0.17 152 / 22%)"
        filter={`url(#${u}f)`}
      />
      <path
        d="M14 78Q40 78 44 56T70 40 114 50"
        stroke={`url(#${u}p)`}
        strokeWidth="3"
        strokeLinecap="round"
      />
      {[
        [14, 78],
        [44, 56],
        [70, 40],
        [92, 43],
        [114, 50],
      ].map(([cx, cy], i) => (
        <g key={i} opacity={0.44 + i * 0.14}>
          <circle cx={cx} cy={cy} r={5 + i * 0.9} fill={`url(#${u}s)`} />
          <circle
            cx={cx}
            cy={cy}
            r={5 + i * 0.9}
            stroke="oklch(0.95 0.09 150 / 38%)"
            strokeWidth="0.9"
          />
        </g>
      ))}
      {/* the pulse in flight */}
      <g className="art-drift">
        <circle
          cx="70"
          cy="40"
          r="10"
          fill="oklch(0.9 0.19 148 / 22%)"
          stroke="oklch(0.93 0.16 145 / 52%)"
        />
      </g>
    </svg>
  );
}

/* ------------------------------ 4. failures ------------------------------- */

/** A fractured form: dark glass split by a clean break with coral bleeding out
    of the seam and a magenta chip adrift. Damage is implied by the fracture,
    never by a size. */
export function FracturedForm({ className }: ArtProps) {
  const u = useId().replace(/:/g, "");
  return (
    <svg viewBox={FRAME} aria-hidden="true" className={className} fill="none">
      <defs>
        <linearGradient id={`${u}a`} x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0%" stopColor="oklch(0.34 0.03 150 / 96%)" />
          <stop offset="100%" stopColor="oklch(0.17 0.02 148 / 96%)" />
        </linearGradient>
        <linearGradient id={`${u}b`} x1="1" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.3 0.03 152 / 96%)" />
          <stop offset="100%" stopColor="oklch(0.14 0.02 148 / 96%)" />
        </linearGradient>
        <linearGradient id={`${u}k`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="oklch(0.86 0.13 20)" />
          <stop offset="100%" stopColor="oklch(0.72 0.19 328)" />
        </linearGradient>
        <filter id={`${u}m`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5.6" />
        </filter>
      </defs>
      <ellipse
        cx="64"
        cy="70"
        rx="40"
        ry="30"
        fill="oklch(0.66 0.19 20 / 24%)"
        filter={`url(#${u}m)`}
      />
      {/* two halves, pushed apart along the break */}
      <path
        d="M60 20L28 44l8 44 26 12-6-26z"
        fill={`url(#${u}a)`}
        stroke="oklch(0.9 0.05 140 / 14%)"
      />
      <path
        d="M68 18l32 26-8 46-26 10 8-26z"
        fill={`url(#${u}b)`}
        stroke="oklch(0.9 0.05 140 / 14%)"
      />
      {/* the seam: light escaping */}
      <path
        d="M60 20l-2 60 6 20"
        stroke={`url(#${u}k)`}
        strokeWidth="3.4"
        strokeLinecap="round"
        className="art-flicker"
      />
      <path
        d="M68 18l3 62-5 20"
        stroke={`url(#${u}k)`}
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.7"
      />
      {/* a chip broken free, magenta */}
      <path
        d="M100 30l10 8-4 12-10-6z"
        fill="oklch(0.72 0.19 328 / 78%)"
        className="art-drift"
      />
      {/* top facet highlight */}
      <path
        d="M60 20l8-2 2 10-8 4z"
        fill="oklch(0.96 0.03 130 / 26%)"
      />
    </svg>
  );
}

/* ------------------------------ 5. queue ---------------------------------- */

/** A layered stack seen in three-quarter depth: queued work sitting on top of
    queued work. Slab count is fixed composition, not backlog size. */
export function QueueStack({ className }: ArtProps) {
  const u = useId().replace(/:/g, "");
  const slabs = [
    { y: 92, o: 0.34, fill: "oklch(0.28 0.03 148 / 92%)" },
    { y: 76, o: 0.56, fill: "oklch(0.33 0.04 146 / 94%)" },
    { y: 60, o: 0.78, fill: "oklch(0.4 0.06 144 / 96%)" },
    { y: 44, o: 1, fill: "oklch(0.52 0.11 140 / 98%)" },
  ];
  return (
    <svg viewBox={FRAME} aria-hidden="true" className={className} fill="none">
      <defs>
        <linearGradient id={`${u}t`} x1="0" y1="0" x2="1" y2="0.6">
          <stop offset="0%" stopColor="oklch(0.95 0.15 118)" />
          <stop offset="60%" stopColor="oklch(0.78 0.17 132)" />
          <stop offset="100%" stopColor="oklch(0.55 0.13 145)" />
        </linearGradient>
        <filter id={`${u}q`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
      </defs>
      <ellipse
        cx="64"
        cy="58"
        rx="42"
        ry="22"
        fill="oklch(0.8 0.16 126 / 22%)"
        filter={`url(#${u}q)`}
      />
      {slabs.map((s, i) => (
        <g key={i} opacity={s.o} className={i === 3 ? "art-lift" : undefined}>
          {/* top face */}
          <path
            d={`M64 ${s.y - 16}L100 ${s.y - 4}L64 ${s.y + 8}L28 ${s.y - 4}Z`}
            fill={i === 3 ? `url(#${u}t)` : s.fill}
            stroke="oklch(0.96 0.05 132 / 18%)"
            strokeWidth="0.8"
          />
          {/* front-left and front-right faces give the slab body */}
          <path
            d={`M28 ${s.y - 4}L64 ${s.y + 8}L64 ${s.y + 16}L28 ${s.y + 4}Z`}
            fill="oklch(0.16 0.02 146 / 88%)"
          />
          <path
            d={`M100 ${s.y - 4}L64 ${s.y + 8}L64 ${s.y + 16}L100 ${s.y + 4}Z`}
            fill="oklch(0.21 0.025 146 / 84%)"
          />
        </g>
      ))}
    </svg>
  );
}
