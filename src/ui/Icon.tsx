// One small hand-drawn set on a 16px grid, 1.5 stroke, round joins. Paths stay simple on purpose.
const paths = {
  plus: "M8 3.25v9.5M3.25 8h9.5",
  search: "M7 11.75a4.75 4.75 0 1 0 0-9.5 4.75 4.75 0 0 0 0 9.5ZM10.5 10.5l3.25 3.25",
  filter: "M2.75 4.25h10.5M4.75 8h6.5M6.75 11.75h2.5",
  sidebar: "M2.75 3.25h10.5v9.5H2.75zM6.25 3.25v9.5",
  panel: "M2.75 3.25h10.5v9.5H2.75zM9.75 3.25v9.5",
  settings: "M2.75 4.75h6.5M11.75 4.75h1.5M2.75 11.25h1.5M6.75 11.25h6.5M10.5 3.25v3M5.5 9.75v3",
  branch:
    "M4.75 2.75v10.5M11.25 6.25a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM11.25 6.25c0 3-6.5 2.5-6.5 5.5",
  repo: "M3.75 12.25V3.75c0-.55.45-1 1-1h7.5v8.5h-7.5a1 1 0 0 0-1 1Zm0 0c0 .55.45 1 1 1h7.5",
  chevronRight: "M6.5 4.25 10.25 8 6.5 11.75",
  chevronLeft: "M9.5 4.25 5.75 8l3.75 3.75",
  chevronDown: "M4.25 6.5 8 10.25l3.75-3.75",
  arrowUp: "M8 12.75V3.5M4 7.25 8 3.25l4 4",
  arrowDown: "M8 3.25v9.25M4 8.75l4 4 4-4",
  check: "m3.5 8.25 2.75 2.75 6.25-6.5",
  x: "M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5",
  alert: "M8 13.75a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5ZM8 5v3.5M8 10.75v.25",
  file: "M4.25 2.75h4.5l3 3v7.5h-7.5zM8.75 2.75v3h3",
  filePlus: "M4.25 2.75h4.5l3 3v7.5h-7.5zM8.75 2.75v3h3M8 8v3.5M6.25 9.75h3.5",
  fileMinus: "M4.25 2.75h4.5l3 3v7.5h-7.5zM8.75 2.75v3h3M6.25 9.75h3.5",
  pencil:
    "M9.75 3.75l2.5 2.5M3.25 12.75l.5-2.75 6.75-6.75a1.06 1.06 0 0 1 1.5 0l1 1a1.06 1.06 0 0 1 0 1.5L6.25 12.5z",
  terminal: "M2.75 3.25h10.5v9.5H2.75zM5 6.25 7 8l-2 1.75M8.5 10h2.5",
  play: "M5 3.5v9l7-4.5z",
  globe:
    "M8 13.75a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5ZM2.5 8h11M8 2.25c1.5 1.6 2.25 3.5 2.25 5.75S9.5 12.15 8 13.75C6.5 12.15 5.75 10.25 5.75 8S6.5 3.85 8 2.25Z",
  nodes:
    "M4.5 6a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5ZM11.5 13.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5ZM4.5 6v2.5c0 1.5 1 2.5 2.5 2.5h2.75",
  eye: "M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8ZM8 9.75a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5Z",
  gauge: "M8 13.75a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5ZM5.75 8.25 7.25 9.75 10.5 6.25",
  copy: "M5.75 5.75h7v7h-7zM3.25 10.25v-7h7",
  trash: "M3 4.5h10M6.25 4.5V3h3.5v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5",
  stop: "M4.5 4.5h7v7h-7z",
  resume: "M13.25 8a5.25 5.25 0 1 1-1.54-3.71M13.25 2.75v2.5h-2.5",
  more: "M2.5 8a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0M6.75 8a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0M11 8a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0",
  image:
    "M2.75 3.25h10.5v9.5H2.75zM2.75 10.5l3-3 3.5 3.5M9.25 9.5l1.25-1.25 2.75 2.75M10.25 6a.25.25 0 1 0 0-.5.25.25 0 0 0 0 .5Z",
  list: "M5.75 4.25h7.5M5.75 8h7.5M5.75 11.75h7.5M2.75 4.25h.01M2.75 8h.01M2.75 11.75h.01",
  thought: "M3.25 7.5a4.75 4 0 1 1 2.5 3.5l-2.5 1.25.75-2.25A3.9 3.9 0 0 1 3.25 7.5Z",
  compress: "M5.25 2.75v2.5h-2.5M10.75 2.75v2.5h2.5M5.25 13.25v-2.5h-2.5M10.75 13.25v-2.5h2.5",
  external: "M9.25 2.75h4v4M13.25 2.75 7.5 8.5M11.25 9.25v4h-8.5v-8.5h4",
  refresh: "M13.25 8a5.25 5.25 0 1 1-1.54-3.71M13.25 2.75v2.5h-2.5",
  diff: "M4.75 2.75v6.5M1.75 6h6M8.25 13h6M11.25 4.25V13",
  circle: "M8 13.25a5.25 5.25 0 1 0 0-10.5 5.25 5.25 0 0 0 0 10.5Z",
  send: "M8 12.75V3.5M4 7.25 8 3.25l4 4",
  moon: "M13.25 9.6A5.5 5.5 0 1 1 6.4 2.75a4.5 4.5 0 0 0 6.85 6.85Z",
} as const;

export type IconName = keyof typeof paths;

// Filled glyphs read better than outlines at this size.
const filled = new Set<IconName>(["stop", "play", "more"]);

export function Icon({
  name,
  size = 16,
  label,
  className,
}: {
  name: IconName;
  size?: number;
  label?: string;
  className?: string;
}) {
  const fill = filled.has(name);
  return (
    <svg
      className={className === undefined ? "icon" : `icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={fill ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={fill ? 1 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label === undefined ? undefined : "img"}
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
    >
      <path d={paths[name]} />
    </svg>
  );
}

// A thin arc: calmer than a dotted spinner, and it reads at 12px.
export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.75" />
      <path
        d="M8 2.25A5.75 5.75 0 0 1 13.75 8"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
