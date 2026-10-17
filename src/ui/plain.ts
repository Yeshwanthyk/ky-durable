const CODE = [/`([^`]+)`/g, "$1"] as const;

/** The markdown a one-line preview drops, each mark with what it leaves behind. Underscores stay, so `__init__.py` does too. Order matters: bold before italic. */
const MARKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/```\w*/g, ""],
  [/!?\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, ""],
  [/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1"],
  [/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, "$1"],
  [/~~(.+?)~~/g, "$1"],
  CODE,
  // A mark cut off mid-pair, as a title clipped at "**Summary*…" is.
  [/(?<=^|\s)\*+(?=\S)|(?<=\S)\*+(?=\s|$|…)/g, ""],
  [/\s+/g, " "],
];

/** Text without its markdown, on one line, for a title, step or summary preview: `**Summary**` reads "Summary". */
export const plain = (text: string): string => MARKS.reduce((out, [mark, kept]) => out.replace(mark, kept), text).trim();

/** The same, keeping `quoted` code for a timeline title to show in mono. */
export const plainKeepingCode = (text: string): string => MARKS.reduce((out, [mark, kept]) => (mark === CODE[0] ? out : out.replace(mark, kept)), text).trim();
