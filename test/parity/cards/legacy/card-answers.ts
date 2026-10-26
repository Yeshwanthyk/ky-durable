import { decodeOr, parseOr } from "../../../../src/core/decode";
import { type CardAnswer, type UiBlock, UiBlockSchema, type UiCard, UiCardShown } from "./ui-blocks";
import type { Tool } from "../../../../src/ui/conversation";

/**
 * A ui card's questions and the message that answers them (src/ui/Blocks.tsx).
 * The answer is the user's next message: the one question's value as it is, a
 * multiple choice's options joined by ", ", or with several questions one
 * "label: value" line each. Beside it the page keeps what was chosen, by the
 * card's call (CardAnswer), which is what the card reads back; a card from
 * before those records reads its answer back from the message's words.
 */

export type Choice = Extract<UiBlock, { type: "choice" }>;

export type Input = Extract<UiBlock, { type: "input" }>;

export type Question = Choice | Input;

/** What a question holds: the options ticked, or the one text typed. */
export type Value = readonly string[];

/** The card a ui call showed, from its arguments, each block checked on its own; arguments that do not read yet show none. */
export function card(tool: Tool): UiCard | null {
  const shown = parseOr(UiCardShown, tool.input, null);

  if (shown === null) return null;
  const blocks = shown.blocks.flatMap((block) => decodeOr(UiBlockSchema, block, []));

  return blocks.length > 0 ? { ...shown, blocks } : null;
}

/** The keys that pick a choice's options, in order; a choice has at most this many. */
export const LETTERS = "ABCDEFGHIJKL";

/** The option a key picks, by its letter. */
export const lettered = (choice: Choice, key: string) => (key.length === 1 ? choice.options[LETTERS.indexOf(key.toUpperCase())] : undefined);

/** A choice's value once `label` is tapped: the one option, or with multiple, it ticked or unticked. */
export function toggled(value: Value, label: string, multiple: boolean): Value {
  if (!multiple) return [label];

  return value.includes(label) ? value.filter((each) => each !== label) : [...value, label];
}

export const isQuestion = (block: UiBlock): block is Question => block.type === "choice" || block.type === "input";

/** A single-choice question alone sends on the tap; anything else waits for Send or ✓. */
export const sendsOnTap = (questions: readonly Question[]) => {
  const [only] = questions;

  return questions.length === 1 && only?.type === "choice" && only.multiple !== true;
};

/** What a card was answered with: each question's value, in order, and the reply of the button tapped. */
export type Answered = { readonly values: readonly Value[]; readonly button: string | undefined };

/**
 * A card's answer: the record kept beside the message that answered it, or with `next` (the turn's following
 * message, given only when no card in the turn has a record, so the card is from before them) its words read back.
 */
export function answeredWith(questions: readonly Question[], record: CardAnswer | undefined, next: string | null): Answered | null {
  if (record !== undefined) return { values: record.values, button: record.button };

  return next === null ? null : { values: decompose(questions, next), button: next };
}

/** A card takes taps while it is the chat's latest word, unanswered, and nothing was sent from it yet. */
export const takesTaps = (open: boolean, answer: Answered | null, sent: boolean) => open && answer === null && !sent;

/** A lone single choice sends on the tap and a lone field has its own ✓; any other card with questions waits for Send. */
export const needsSend = (questions: readonly Question[]) => {
  const [only] = questions;

  return questions.length > 1 || only?.type === "choice" && only.multiple === true;
};

/** What a card is called: its title, else its first question. */
export const cardName = (ui: UiCard) => ui.title ?? ui.blocks.find(isQuestion)?.label ?? "Card from ky";

/**
 * How an option shows: pressed for a multiple choice, or once the card is
 * answered; once the card takes no taps, only what was chosen stays bright.
 */
export const optionState = (on: boolean, multiple: boolean, answeredCard: boolean, live: boolean) => ({
  pressed: multiple || answeredCard ? on : undefined,
  dim: !live && !on,
  ticked: on && multiple
});

/** The answer as the user's message. */
export function compose(questions: readonly Question[], values: readonly Value[]): string {
  const text = (index: number) => (values[index] ?? []).join(", ").trim();

  if (questions.length === 1) return text(0);

  return questions.flatMap((question, index) => (text(index) ? [`${question.label}: ${text(index)}`] : [])).join("\n");
}

/** Every question has something in it. */
export const answered = (questions: readonly Question[], values: readonly Value[]) =>
  questions.length > 0 && questions.every((_, index) => (values[index] ?? []).some((value) => value.trim()));

function valueOf(question: Question, text: string): Value {
  if (question.type === "input") return [text];
  const labels = question.options.map((option) => option.label);

  return labels.includes(text) ? [text] : text.split(", ").filter((part) => labels.includes(part));
}

/** What an answer gave each question, read back from the message that sent it. */
export function decompose(questions: readonly Question[], answer: string): Value[] {
  const [only] = questions;

  if (questions.length === 1 && only !== undefined) return [valueOf(only, answer)];
  const lines = answer.split("\n");

  return questions.map((question) => {
    const line = lines.find((each) => each.startsWith(`${question.label}: `));

    return line === undefined ? [] : valueOf(question, line.slice(question.label.length + 2));
  });
}
