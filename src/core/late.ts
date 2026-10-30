import type { UserInput } from "@earendil-works/pi-durable";

/**
 * A message the page kept while ky was out of reach reaches ky long after it was written. The model is told,
 * in a note after the words, so it doesn't answer "in a minute" to something the user said hours ago. The
 * note is for the model: the thread drops it (transcript.ts), so the user's bubble reads as written.
 */

/** Longer than this between writing a message and ky getting it, and the model is told. */
export const LATE_AFTER_MS = 2 * 60_000;

const TAG = /\s*<ky-late>[^<]*<\/ky-late>\s*$/;

/** How long ago, in the fewest words: "5 min", "3h", "2 days". */
export function agoText(ms: number): string {
  const minutes = Math.round(ms / 60_000);

  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);

  if (hours < 48) return `${hours}h`;

  return `${Math.round(hours / 24)} days`;
}

/** The note for a message that waited `waited` ms on the device before it was sent. */
export const lateNote = (waited: number) => `<ky-late>(written ${agoText(waited)} ago while offline, delivered now)</ky-late>`;

/** The message with the note after its words, when it waited long enough to need one. */
export function withLateNote(input: UserInput, waited: number | undefined): UserInput {
  if (waited === undefined || !Number.isFinite(waited) || waited < LATE_AFTER_MS) return input;
  const note = lateNote(waited);

  if (!Array.isArray(input)) return `${String(input)}\n\n${note}`;

  const last = input.findLastIndex((part) => part.type === "text");

  if (last === -1) return [...input, { type: "text", text: note }];

  return input.map((part, at) => (at === last && part.type === "text" ? { ...part, text: `${part.text}\n\n${note}` } : part));
}

/** The words as the user wrote them, without the note for the model. */
export const withoutLateNote = (text: string) => text.replace(TAG, "");
