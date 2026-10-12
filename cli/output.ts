/**
 * How `ky` looks. With a person at a terminal: the wordmark, clack's prompts, a spinner for each
 * step that ends ✓ or ✗, and color (none under NO_COLOR). Piped, as when an agent runs it: plain
 * lines, with no escape codes, each through the run's `print`.
 */
import { execFile } from "node:child_process";
import { cancel, intro, log, note, outro, spinner } from "@clack/prompts";
import { renderUnicodeCompact } from "uqr";

/** Whether a person is at the terminal: ky asks questions and draws spinners only then. */
export function terminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Opens the URL in the browser, when there's one to open it in. */
export function open(url: string): void {
  if (!terminal()) return;
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});
}

function color(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
}

const paint = (code: string) => (text: string) => (color() ? `\u001b[${code}m${text}\u001b[0m` : text);

export const bold = paint("1");

export const dim = paint("2");

export const green = paint("32");

export const red = paint("31");

/** The wordmark in half-block letters, shaded amber to violet like a sky at dusk, under a few dim stars. */
const LETTERS = ["█  ▄  ▄  ▄", "█▄▀   ▀▄▄█", "█ ▀▄  ▄▄▄▀"];

const STARS = ["   ˚     ·          ·    ˚", ["    ·", "  ˚", "       ·"], "       ·      ˚        ·"] as const;

const DUSK = [214, 209, 204, 169, 134, 99, 63];

/** A letter's cell, shaded by how far it is along the diagonal from the top left. */
function shade(line: string, row: number): string {
  const reach = LETTERS[0].length + 2 * (LETTERS.length - 1);

  return [...line]
    .map((cell, column) => (cell === " " ? cell : paint(`38;5;${DUSK[Math.floor(((column + 2 * row) * DUSK.length) / reach)]}`)(cell)))
    .join("");
}

const star = paint("38;5;240");

export function banner(): string {
  const [above, beside, below] = STARS;

  return ["", star(above), ...LETTERS.map((line, row) => `      ${shade(line, row)}${star(beside[row])}`), star(below), ""].join("\n");
}

/** The URL as a QR code, to open it on a phone. */
export function qr(url: string): string {
  return renderUnicodeCompact(url, { border: 2, invert: true }).trimEnd();
}

/** A prompt the user cancelled with Esc or Ctrl-C; clack has said so, so `ky` exits 1 without a message. */
export class Cancelled extends Error {
  constructor() {
    super("Cancelled");
  }
}

/** Ends the run the user cancelled at a prompt, before anything was changed. */
export function cancelled(): never {
  cancel("Cancelled. Nothing was changed.");
  throw new Cancelled();
}

/** Names each step as it starts. */
export type Say = (step: string) => void;

/** What a command shows as it runs; `output` picks the terminal's or the plain one. */
export type Output = {
  /** Opens the run, with the wordmark for `ky init`. */
  intro: (title: string, wordmark?: boolean) => void;
  /** Something found or settled on the way. */
  done: (line: string) => void;
  note: (title: string, lines: string[]) => void;
  /** Runs `work` while a spinner says what it waits for. */
  waiting: <T>(text: string, work: () => Promise<T>) => Promise<T>;
  /**
   * Runs the steps `work` names with `say`, each shown until the next starts; `stopped` is what
   * Ctrl-C leaves behind and how to go on.
   */
  steps: <T>(stopped: string, work: (say: Say) => Promise<T>) => Promise<T>;
  /** The run's last word. */
  outro: (line: string) => void;
};

const plain = (print: (line: string) => void): Output => ({
  intro: () => {},
  done: (line) => print(`· ${line}`),
  note: (title, lines) => print([`${title}:`, ...lines.map((line) => `  ${line}`)].join("\n")),
  waiting: (_, work) => work(),
  steps: (_, work) => work((step) => print(`· ${step}`)),
  outro: print
});

/** How long since `since` (a `performance.now()`), as `42s` or `3m 5s`. */
function elapsed(since: number): string {
  const seconds = Math.round((performance.now() - since) / 1000);

  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** clack's spinner, which Ctrl-C ends with `stopped` and exit 130, as it would end ky without one. */
function spinning(stopped: string) {
  return spinner({
    indicator: "timer",
    withGuide: false,
    cancelMessage: "Stopped",
    onCancel: () => {
      cancel(stopped);
      process.exit(130);
    }
  });
}

const drawn: Output = {
  intro: (title, wordmark) => {
    if (wordmark) console.log(banner());
    intro(bold(` ${title} `));
  },
  done: (line) => log.success(line),
  note: (title, lines) => note(lines.join("\n"), title),
  waiting: async (text, work) => {
    const spin = spinning("Nothing was changed.");

    spin.start(text);

    try {
      const result = await work();

      spin.clear();

      return result;
    } catch (error) {
      spin.clear();
      log.error(`${text} failed`);
      throw error;
    }
  },
  steps: async (stopped, work) => {
    let running: { step: string; since: number; spin: ReturnType<typeof spinning> } | undefined;
    let first = true;

    /** Ends the running step with its mark and how long it took. */
    const end = (mark: string) => {
      if (!running) return;
      running.spin.clear();
      log.message(`${running.step} ${dim(elapsed(running.since))}`, { symbol: mark, spacing: first ? 1 : 0 });
      first = false;
      running = undefined;
    };

    try {
      const result = await work((step) => {
        end(green("✓"));
        running = { step, since: performance.now(), spin: spinning(stopped) };
        running.spin.start(step);
      });

      end(green("✓"));

      return result;
    } catch (error) {
      end(red("✗"));
      throw error;
    }
  },
  outro: (line) => outro(line)
};

/** How this run shows itself: drawn at a terminal, else plain lines through `print`. */
export function output(print: (line: string) => void): Output {
  return terminal() ? drawn : plain(print);
}
