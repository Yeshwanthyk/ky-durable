/**
 * ky's look for a site's page shown in a card (src/site-routes.ts, `?embed`): its colors as CSS variables, a
 * base stylesheet, and the light or dark mode the chat is in, which the chat posts again when it changes
 * (src/ui/Blocks.tsx). The names are T3 Code's, so a page written for either reads the same. The colors
 * mirror src/ui/scotty.css; test/node/embed-theme.test.ts holds them to it.
 */

type Mode = "light" | "dark";

/** scotty.css's tokens a page draws with, by mode. */
export const PALETTE: Record<Mode, Record<string, string>> = {
  light: {
    surface: "#ffffff",
    raised: "#f3f3f3",
    sunken: "#f7f7f7",
    ink: "#141414",
    muted: "#666666",
    quiet: "#8a8a8a",
    line: "rgb(0 0 0 / 0.075)",
    "line-strong": "rgb(0 0 0 / 0.12)",
    working: "#2f8fdc",
    danger: "#cf3b2e",
    success: "#2f9b62",
    warning: "#b07a12",
    "chart-1": "#2f8fdc",
    "chart-2": "#c98a14",
    "chart-3": "#2f9b62",
    "chart-4": "#8a5cd6",
    "chart-5": "#d4553f",
    "chart-6": "#6b7785"
  },
  dark: {
    surface: "#1b1b1b",
    raised: "#222222",
    sunken: "#0d0d0d",
    ink: "#ededed",
    muted: "#a3a3a3",
    quiet: "#7d7d7d",
    line: "rgb(255 255 255 / 0.07)",
    "line-strong": "rgb(255 255 255 / 0.11)",
    working: "#6cb6f0",
    danger: "#f07266",
    success: "#62c58e",
    warning: "#e0b057",
    "chart-1": "#6cb6f0",
    "chart-2": "#e0b057",
    "chart-3": "#62c58e",
    "chart-4": "#b39af0",
    "chart-5": "#f07a66",
    "chart-6": "#9aa5b1"
  }
};

/** The variables a page reads, by the token each takes. */
const NAMES: ReadonlyArray<[string, string]> = [
  ["background", "surface"],
  ["foreground", "ink"],
  ["card", "raised"],
  ["muted", "raised"],
  ["muted-foreground", "muted"],
  ["quiet", "quiet"],
  ["border", "line"],
  ["border-strong", "line-strong"],
  ["accent", "working"],
  ["success", "success"],
  ["warning", "warning"],
  ["destructive", "danger"],
  ["code-background", "sunken"],
  ...[1, 2, 3, 4, 5, 6].map((n): [string, string] => [`chart-${n}`, `chart-${n}`])
];

const variables = (mode: Mode) => NAMES.map(([name, token]) => `--${name}:${PALETTE[mode][token]};`).join("");

const FONTS =
  '--radius:10px;--font-sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",system-ui,sans-serif;' +
  '--font-mono:ui-monospace,"SF Mono",SFMono-Regular,"JetBrains Mono",Menlo,monospace;';

/**
 * What goes at the top of the page: the variables and a base the page's own CSS overrides, and a script that
 * takes the mode from `?embed=dark` and then from the chat's messages. The page's background stays clear, so
 * it sits on the card; `color-scheme` matches the chat's, or the browser would paint the frame opaque.
 */
export const EMBED_HEAD =
  `<style>:root{color-scheme:light dark;${FONTS}${variables("light")}}` +
  `:root[data-ky-mode="dark"]{${variables("dark")}}` +
  "html{background:transparent;color:var(--foreground);font:14px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased}body{margin:0}</style>" +
  `<script>(() => {
  const root = document.documentElement;
  const set = (mode) => { if (mode === "dark" || mode === "light") root.dataset.kyMode = mode; };
  set(new URLSearchParams(location.search).get("embed"));
  addEventListener("message", (event) => { if (event.source === parent && event.data) set(event.data.kyMode); });
})();</script>`;
