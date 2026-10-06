/** The markdown a one-line preview drops, each mark with what it leaves behind. Underscores stay, so `__init__.py` does too. Order matters: bold before italic. */
const MARKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/```\w*/g, ""],
  [/!?\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, ""],
  [/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1"],
  [/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, "$1"],
  [/~~(.+?)~~/g, "$1"],
  [/`([^`]+)`/g, "$1"],
  // A mark cut off mid-pair, as a title clipped at "**Summary*…" is.
  [/(?<=^|\s)\*+(?=\S)|(?<=\S)\*+(?=\s|$|…)/g, ""],
  [/\s+/g, " "],
];

/** Text without its markdown, on one line, for a title, step or summary preview: `**Summary**` reads "Summary". */
export const plain = (text: string): string => MARKS.reduce((out, [mark, kept]) => out.replace(mark, kept), text).trim();
