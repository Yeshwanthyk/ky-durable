/** What deciding pill or card needs from the textarea's style, read once per state rather than per keystroke. */
export type Metrics = {
  /** Taller than this means the text wrapped: one line and its padding; the line grows with the text size. */
  readonly oneLine: number;
  readonly font: string;
  readonly paddingX: number;
};

export function measure(element: HTMLElement): Metrics {
  const style = getComputedStyle(element);
  const line = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);

  return {
    oneLine: Math.max(parseFloat(style.minHeight), line) + 2,
    font: `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
    paddingX: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
  };
}

let ruler: CanvasRenderingContext2D | null = null;

let rulerFont = "";

/** Whether the text fits on one line of a textarea this wide, padding and a little slack included. */
export function fitsOneLine(metrics: Metrics, text: string, width: number): boolean {
  ruler ??= document.createElement("canvas").getContext("2d");

  if (ruler === null) return text === "";

  // Setting a canvas font parses it, so only when it changes.
  if (rulerFont !== metrics.font) {
    ruler.font = metrics.font;
    rulerFont = metrics.font;
  }

  return ruler.measureText(text).width < width - metrics.paddingX - 8;
}
