/**
 * Names for chats and tasks, written on the background purpose: a small, cheap model.
 *
 * Nothing waits on it. A chat or task shows its first line at once, and the
 * name replaces that line when the model answers, only if nothing else has
 * renamed it meanwhile. When the model fails, the first line stays.
 */

/** One short request to the background model: a system prompt and a text, back comes its answer. */
export type Complete = (system: string, text: string) => Promise<string>;

const TITLE_CHARS = 60;

const SUMMARY_CHARS = 140;

/** The model reads at most this much of a long message or report. */
const INPUT_CHARS = 6_000;

const TITLE_PROMPT = `You name things for a list. Reply with a title of two to six words for the text the user sends: what it is about, in sentence case, with no quotes and no final period. Reply with the title alone.`;

const SUMMARY_PROMPT = `You summarize a finished task's report for a list. Reply with one plain sentence of at most 20 words that says what was found or done, with no preamble and no markdown. Reply with the sentence alone.`;

/** The model's first line, without quotes, a label or markdown, trimmed to fit. */
function clean(answer: string, limit: number): string {
  const line = answer.trim().split("\n").find((part) => part.trim() !== "")?.trim() ?? "";

  const bare = line
    .replace(/^(title|summary)\s*:\s*/i, "")
    .replace(/^[#*_`>\s-]+|[*_`\s]+$/g, "")
    .replace(/^["'“‘](.*)["'”’]$/, "$1")
    .trim();

  return bare.length > limit ? `${bare.slice(0, limit - 1)}…` : bare;
}

export class Titler {
  readonly #complete: Complete;

  constructor(complete: Complete) {
    this.#complete = complete;
  }

  /** A short title for a message or prompt; null when the model has none. */
  async title(text: string): Promise<string | null> {
    return this.#ask(TITLE_PROMPT, text, TITLE_CHARS);
  }

  /** One sentence for a finished task's report; null when the model has none. */
  async summary(text: string): Promise<string | null> {
    return this.#ask(SUMMARY_PROMPT, text, SUMMARY_CHARS);
  }

  async #ask(system: string, text: string, limit: number): Promise<string | null> {
    if (text.trim() === "") return null;

    try {
      return clean(await this.#complete(system, text.slice(0, INPUT_CHARS)), limit) || null;
    } catch (error) {
      console.warn("ky titles failed", error);

      return null;
    }
  }
}
