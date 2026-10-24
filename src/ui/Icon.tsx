// One small hand-drawn set on a 16px grid, 1.5 stroke, round joins. Paths stay simple on purpose.
const paths = {
  plus: "M8 3.25v9.5M3.25 8h9.5",
  minus: "M3.25 8h9.5",
  search: "M7 11.75a4.75 4.75 0 1 0 0-9.5 4.75 4.75 0 0 0 0 9.5ZM10.5 10.5l3.25 3.25",
  sidebar: "M2.75 3.25h10.5v9.5H2.75zM6.25 3.25v9.5",
  panel: "M2.75 3.25h10.5v9.5H2.75zM9.75 3.25v9.5",
  settings: "M2.75 4.75h6.5M11.75 4.75h1.5M2.75 11.25h1.5M6.75 11.25h6.5M10.5 3.25v3M5.5 9.75v3",
  chevronRight: "M6.5 4.25 10.25 8 6.5 11.75",
  chevronDown: "M4.25 6.5 8 10.25l3.75-3.75",
  lock: "M5 7.25V5.5a3 3 0 0 1 6 0v1.75M4.25 7.25h7.5v5.5h-7.5z",
  chevronUpDown: "M5.25 6.25 8 3.5l2.75 2.75M5.25 9.75 8 12.5l2.75-2.75",
  arrowUp: "M8 12.75V3.5M4 7.25 8 3.25l4 4",
  arrowDown: "M8 3.25v9.25M4 8.75l4 4 4-4",
  check: "m3.5 8.25 2.75 2.75 6.25-6.5",
  checkCircle: "M8 13.75a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5ZM5.6 8.1l1.6 1.6 3.2-3.4",
  x: "M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5",
  alert: "M8 13.75a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5ZM8 5v3.5M8 10.75v.25",
  file: "M4.25 2.75h4.5l3 3v7.5h-7.5zM8.75 2.75v3h3",
  pencil:
    "M9.75 3.75l2.5 2.5M3.25 12.75l.5-2.75 6.75-6.75a1.06 1.06 0 0 1 1.5 0l1 1a1.06 1.06 0 0 1 0 1.5L6.25 12.5z",
  terminal: "M2.75 3.25h10.5v9.5H2.75zM5 6.25 7 8l-2 1.75M8.5 10h2.5",
  globe:
    "M8 13.75a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5ZM2.5 8h11M8 2.25c1.5 1.6 2.25 3.5 2.25 5.75S9.5 12.15 8 13.75C6.5 12.15 5.75 10.25 5.75 8S6.5 3.85 8 2.25Z",
  nodes:
    "M4.5 6a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5ZM11.5 13.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5ZM4.5 6v2.5c0 1.5 1 2.5 2.5 2.5h2.75",
  eye: "M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8ZM8 9.75a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5Z",
  copy: "M5.75 5.75h7v7h-7zM3.25 10.25v-7h7",
  external: "M6.75 3.25h-3.5v9.5h9.5v-3.5M9.25 2.75h4v4M13.25 2.75 7.75 8.25",
  stop: "M4.5 4.5h7v7h-7z",
  pause: "M4.75 4h2v8h-2zM9.25 4h2v8h-2z",
  play: "M5.25 3.75v8.5L12 8z",
  mic: "M8 2.25a2 2 0 0 0-2 2v3.5a2 2 0 0 0 4 0v-3.5a2 2 0 0 0-2-2ZM4.25 7.75a3.75 3.75 0 0 0 7.5 0M8 11.5v2.25",
  image:
    "M2.75 3.25h10.5v9.5H2.75zM2.75 10.5l3-3 3.5 3.5M9.25 9.5l1.25-1.25 2.75 2.75M10.25 6a.25.25 0 1 0 0-.5.25.25 0 0 0 0 .5Z",
  list: "M5.75 4.25h7.5M5.75 8h7.5M5.75 11.75h7.5M2.75 4.25h.01M2.75 8h.01M2.75 11.75h.01",
  compress: "M5.25 2.75v2.5h-2.5M10.75 2.75v2.5h2.5M5.25 13.25v-2.5h-2.5M10.75 13.25v-2.5h2.5",
  refresh: "M13.25 8a5.25 5.25 0 1 1-1.54-3.71M13.25 2.75v2.5h-2.5",
  pin: "M5.75 2.75h4.5M6.75 2.75v3.5L4.75 9h6.5l-2-2.75v-3.5M8 9v4.25",
  clock: "M8 13.75a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5ZM8 5v3l2 1.25",
  circle: "M8 13.25a5.25 5.25 0 1 0 0-10.5 5.25 5.25 0 0 0 0 10.5Z",
  send: "M8 12.75V3.5M4 7.25 8 3.25l4 4",
  steer: "M3.25 12.75v-3.5a3 3 0 0 1 3-3h7M10.25 3.25l3 3-3 3",
  moon: "M13.25 9.6A5.5 5.5 0 1 1 6.4 2.75a4.5 4.5 0 0 0 6.85 6.85Z",
  sparkle: "M8 2.25c.4 2.9 1.85 4.35 4.75 4.75-2.9.4-4.35 1.85-4.75 4.75-.4-2.9-1.85-4.35-4.75-4.75 2.9-.4 4.35-1.85 4.75-4.75ZM12.5 10.75v2.5M11.25 12h2.5",
  sun: "M8 10.75a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5ZM8 1.75v1M8 13.25v1M1.75 8h1M13.25 8h1M3.6 3.6l.7.7M11.7 11.7l.7.7M3.6 12.4l.7-.7M11.7 4.3l.7-.7",
  menu: "M2.75 4.75h10.5M2.75 8h10.5M2.75 11.25h10.5",
  arrowLeft: "M12.75 8H3.5M7.25 4 3.25 8l4 4",
  monitor: "M2.75 3.25h10.5v7.5H2.75zM6 13.25h4M8 10.75v2.5",
  cloud: "M4.5 12.25a2.75 2.75 0 0 1-.35-5.48 3.75 3.75 0 0 1 7.3-.6 2.75 2.75 0 0 1 .3 6.08z",
  plug: "M5.75 2.75v2.5M10.25 2.75v2.5M3.75 5.25h8.5v2a4.25 4.25 0 0 1-8.5 0zM8 11.5v1.75",
  gear: "M6.86 3.24L7.17 1.81L8.83 1.81L9.14 3.24L10.56 3.82L11.79 3.03L12.97 4.21L12.18 5.44L12.76 6.86L14.19 7.17L14.19 8.83L12.76 9.14L12.18 10.56L12.97 11.79L11.79 12.97L10.56 12.18L9.14 12.76L8.83 14.19L7.17 14.19L6.86 12.76L5.44 12.18L4.21 12.97L3.03 11.79L3.82 10.56L3.24 9.14L1.81 8.83L1.81 7.17L3.24 6.86L3.82 5.44L3.03 4.21L4.21 3.03L5.44 3.82ZM8 10.1a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2Z",
  chat: "M2.75 3.25h10.5v7.5H7.5l-3 2.25v-2.25H2.75z",
  // The activity pill's tools.
  thought: "M3.25 7.5a4.75 4 0 1 1 2.5 3.5l-2.5 1.25.75-2.25A3.9 3.9 0 0 1 3.25 7.5Z",
  branch: "M4.75 2.75v10.5M11.25 6.25a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM11.25 6.25c0 3-6.5 2.5-6.5 5.5",
  filePlus: "M4.25 2.75h4.5l3 3v7.5h-7.5zM8.75 2.75v3h3M8 8v3.5M6.25 9.75h3.5",
  fileMinus: "M4.25 2.75h4.5l3 3v7.5h-7.5zM8.75 2.75v3h3M6.25 9.75h3.5",
  // A side chat's archive and unarchive.
  archive: "M2.75 3.25h10.5v2.5H2.75zM3.75 5.75v7h8.5v-7M6.5 8.25h3",
  unarchive: "M2.75 3.25h10.5v2.5H2.75zM3.75 5.75v7h8.5v-7M8 11.25v-3.5M6.25 9.5 8 7.75l1.75 1.75",
  repo: "M3.75 12.25V3.75c0-.55.45-1 1-1h7.5v8.5h-7.5a1 1 0 0 0-1 1Zm0 0c0 .55.45 1 1 1h7.5",
  // SOUL.md: its tab, its card, and its sheet's menu.
  fingerprint:
    "M4.25 4.5A4.75 4.75 0 0 1 12.6 6.5M3.25 8a4.75 4.75 0 0 1 .3-1.6M5.5 13a7 7 0 0 0 .75-3.25 1.75 1.75 0 0 1 3.5 0c0 1.25-.2 2.4-.6 3.5M8 9.75c0 1.6-.35 3-1 4.25M11.5 12.25c.3-.8.5-1.6.5-2.5a4 4 0 0 0-6.6-3",
  heart: "M8 13.25S2.25 10 2.25 6.1A2.85 2.85 0 0 1 8 4.6a2.85 2.85 0 0 1 5.75 1.5C13.75 10 8 13.25 8 13.25Z",
  more: "M3.75 8h.01M8 8h.01M12.25 8h.01",
  // ky's own address: Settings › Mail.
  mail: "M2.75 4.25h10.5v7.5H2.75zM2.75 4.75 8 8.75l5.25-4",
} as const;

export type IconName = keyof typeof paths;

// Filled glyphs read better than outlines at this size.
const filled = new Set<IconName>(["stop", "play", "pause"]);

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
