import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** How many recent seqs are kept; the object only redelivers commands it has not seen acked. */
const KEEP = 1_000;

/**
 * The seqs of the commands this runner has acted on, kept in a JSON file so a
 * restarted runner does not run a redelivered command again. `add` writes the
 * file (a temp file, then a rename) before it returns, and the runner acks
 * only after it. Seqs are numbered by one object, so the file names it
 * (`owner`: the URL and machine) and is ignored if another object owns it.
 */
export class HandledSeqs {
  readonly #file: string;
  readonly #owner: string;
  readonly #seqs: number[];
  readonly #known: Set<number>;

  constructor(file: string, owner: string) {
    this.#file = file;
    this.#owner = owner;
    this.#seqs = load(file, owner);
    this.#known = new Set(this.#seqs);
  }

  has(seq: number): boolean {
    return this.#known.has(seq);
  }

  add(seq: number): void {
    if (this.#known.has(seq)) return;
    this.#seqs.push(seq);
    this.#known.add(seq);

    for (const old of this.#seqs.splice(0, Math.max(0, this.#seqs.length - KEEP))) this.#known.delete(old);
    mkdirSync(dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, JSON.stringify({ owner: this.#owner, seqs: this.#seqs }), { flush: true });
    replace(temp, this.#file);
  }
}

/** Rename `from` over `to`: atomic on POSIX. */
function replace(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    // Only workerd's in-memory fs, where the tests run, will not rename over a file.
    rmSync(to, { force: true });
    renameSync(from, to);
  }
}

function load(file: string, owner: string): number[] {
  let text: string;

  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  try {
    const saved = JSON.parse(text);

    if (saved?.owner !== owner || !Array.isArray(saved.seqs)) return [];

    return saved.seqs.filter((seq: number) => Number.isInteger(seq));
  } catch {
    return [];
  }
}
