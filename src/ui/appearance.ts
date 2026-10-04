import { useEffect, useState } from "react";

/**
 * Text size and font, kept per device like the theme: a phone and a laptop
 * often want different sizes. index.html applies the stored choice before
 * the first paint, so the page never flashes the default.
 */

export type TextSize = "small" | "default" | "large" | "larger";

export const TEXT_SIZES: readonly { readonly id: TextSize; readonly label: string; readonly scale: number }[] = [
  { id: "small", label: "Small", scale: 0.9 },
  { id: "default", label: "Default", scale: 1 },
  { id: "large", label: "Large", scale: 1.1 },
  { id: "larger", label: "Larger", scale: 1.25 }
];

export type FontId = "system" | "inter" | "geist" | "plex" | "serif" | "rounded" | "custom";

type Font = {
  readonly id: Exclude<FontId, "custom">;
  readonly label: string;
  /** A Google Fonts family, loaded on demand. */
  readonly web?: string;
  /** Fonts the device already has, tried first. */
  readonly local?: string;
};

export const FONTS: readonly Font[] = [
  { id: "system", label: "System" },
  { id: "inter", label: "Inter", web: "Inter" },
  { id: "geist", label: "Geist", web: "Geist" },
  { id: "plex", label: "IBM Plex Sans", web: "IBM Plex Sans" },
  { id: "serif", label: "Serif", local: 'ui-serif, "New York", Charter, "Iowan Old Style", Georgia' },
  { id: "rounded", label: "Rounded", local: 'ui-rounded, "SF Pro Rounded", "Nunito"' }
];

export type Appearance = {
  readonly size: TextSize;
  readonly font: FontId;
  /** The family typed under Custom: installed on the device, or on Google Fonts. */
  readonly custom: string;
};

const KEY = "appearance";

const DEFAULT: Appearance = { size: "default", font: "system", custom: "" };

/** A font family name with nothing that could escape the quotes it goes in. */
export function familyName(text: string): string {
  return text.replace(/[^\p{L}\p{N} -]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

function read(): Appearance {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");

    if (stored === null || typeof stored !== "object") return DEFAULT;
    const { size, font, custom } = stored as Partial<Record<keyof Appearance, unknown>>;

    return {
      size: TEXT_SIZES.some((each) => each.id === size) ? (size as TextSize) : DEFAULT.size,
      font: font === "custom" || FONTS.some((each) => each.id === font) ? (font as FontId) : DEFAULT.font,
      custom: typeof custom === "string" ? familyName(custom) : ""
    };
  } catch {
    return DEFAULT;
  }
}

/** The family to load from Google Fonts, if any, and the name to put first in the stack. */
function chosen(appearance: Appearance): { readonly web?: string; readonly first?: string } {
  if (appearance.font === "custom") {
    return appearance.custom === "" ? {} : { web: appearance.custom, first: `"${appearance.custom}"` };
  }

  const font = FONTS.find((each) => each.id === appearance.font);

  return font?.web ? { web: font.web, first: `"${font.web}"` } : { first: font?.local };
}

const loaded = new Map<string, Promise<void>>();

// Google refuses a weight list the family lacks, so ask for less until it answers. A name
// it does not know at all is left to the device, which may have it installed.
function loadWebFont(family: string): Promise<void> {
  const known = loaded.get(family);

  if (known) return known;
  const name = encodeURIComponent(family).replace(/%20/g, "+");
  const load = (async () => {
    for (const weights of [":wght@400;500;600;700", ":wght@400;700", ""]) {
      const href = `https://fonts.googleapis.com/css2?family=${name}${weights}&display=swap`;
      const ok = await fetch(href).then(
        (response) => response.ok,
        () => false
      );

      if (!ok) continue;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);

      return;
    }
  })();

  loaded.set(family, load);

  return load;
}

function apply(appearance: Appearance): void {
  const root = document.documentElement.style;
  const scale = TEXT_SIZES.find((each) => each.id === appearance.size)?.scale ?? 1;
  const { web, first } = chosen(appearance);

  root.setProperty("--text-scale", String(scale));

  if (first) root.setProperty("--font-sans", `${first}, -apple-system, BlinkMacSystemFont, system-ui, sans-serif`);
  else root.removeProperty("--font-sans");

  if (web) void loadWebFont(web);
}

export function useAppearance(): [Appearance, (next: Appearance) => void] {
  const [appearance, setAppearance] = useState(read);

  useEffect(() => {
    apply(appearance);
    localStorage.setItem(KEY, JSON.stringify(appearance));
  }, [appearance]);

  return [appearance, setAppearance];
}

/** What the font row shows: the preset's name, or the custom family. */
export function fontLabel(appearance: Appearance): string {
  if (appearance.font === "custom") return appearance.custom || "Custom";

  return FONTS.find((each) => each.id === appearance.font)?.label ?? "System";
}

/** The stack to preview a preset in, inside the picker. */
export function previewStack(font: Font): string | undefined {
  if (font.web) return `"${font.web}", system-ui, sans-serif`;

  return font.local ? `${font.local}, system-ui, sans-serif` : undefined;
}
