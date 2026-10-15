import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Type from "typebox";
import { parseOr } from "../../src/core/decode.ts";

/** How many recent seqs are kept; the object only redelivers commands it has not seen acked. */
const KEEP = 1_000;

/**
 * The seqs of the commands this runner has acted on, kept in a JSON file so a
 * restarted runner does not run a redelivered command again. `add` writes the
 * file (a temp file, then a rename) before it returns, and the runner acks
 * only after it. Seqs are numbered by one object, so the file names it
 * (`owner`: the URL and machine) and is ignored if another object owns it.
 *
 * Resetting the object (a new one under the same URL) numbers seqs from 1
 * again, and this file would skip them: delete ~/.ky/handled-*.json (or the
 * file in KY_STATE_DIR) when the object is reset.
 */
export class HandledSeqs {
  readonly #file: string;
  readonly #owner: string;
  #seqs: number[];
  #known: Set<number>;

  constructor(file: string, owner: string) {
    this.#file = file;
    this.#owner = owner;
    this.#seqs = load(file, owner);
    this.#known = new Set(this.#seqs);
  }

  has(seq: number): boolean {
    return this.#known.has(seq);
  }

  /** Record `seq` on disk; if that throws, it is not recorded. */
  add(seq: number): void {
    if (this.#known.has(seq)) return;
    const seqs = [...this.#seqs, seq].slice(-KEEP);
    mkdirSync(dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, JSON.stringify({ owner: this.#owner, seqs }), { flush: true });
    replace(temp, this.#file);

    this.#seqs = seqs;
    this.#known = new Set(seqs);
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

  const saved = parseOr(SavedSchema, text, undefined);

  if (saved?.owner !== owner) return [];

  return saved.seqs.filter((seq): seq is number => Number.isInteger(seq));
}

/** The file as `add` writes it; one that isn't, or another object's, is none. */
const SavedSchema = Type.Object({ owner: Type.Unknown(), seqs: Type.Array(Type.Unknown()) });
