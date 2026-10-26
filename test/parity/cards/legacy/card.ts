import type { JsonValue } from "@earendil-works/chord";
import { decodeOr, parseOr } from "../../../../src/core/decode";
import { CardAnswerSchema, UiBlockSchema, UiCardShown } from "./ui-blocks";

export function card(input: string) {
  const shown = parseOr(UiCardShown, input, null);

  if (shown === null) return null;
  const blocks = shown.blocks.flatMap((block) => decodeOr(UiBlockSchema, block, []));

  return blocks.length > 0 ? { ...shown, blocks } : null;
}

export const answerOf = (data: JsonValue | undefined) => decodeOr(CardAnswerSchema, data, null);
