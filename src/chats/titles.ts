type Complete = (system: string, text: string) => Promise<string>;

const TITLE_CHARS = 60;

const SUMMARY_CHARS = 140;

const INPUT_CHARS = 6_000;

const TITLE_PROMPT = `You name things for a list. Reply with a title of two to six words for the text the user sends: what it is about, in sentence case, with no quotes and no final period. Reply with the title alone.`;

const SUMMARY_PROMPT = `You summarize a finished task's report for a list. Reply with one plain sentence of at most 20 words that says what was found or done, with no preamble and no markdown. Reply with the sentence alone.`;

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

  async title(text: string): Promise<string | null> {
    return this.#ask(TITLE_PROMPT, text, TITLE_CHARS);
  }

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
