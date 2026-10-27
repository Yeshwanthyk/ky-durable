import * as Schema from "effect/Schema";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { answerOf, cardOf } from "../../../src/cards/contract";

const AtB = Schema.Struct({
  stored: Schema.Struct({
    inputs: Schema.Array(Schema.String),
    answers: Schema.Array(Schema.MutableJson),
    runCards: Schema.Struct({ run: Schema.Boolean, cards: Schema.Array(Schema.Struct({ call: Schema.String, card: Schema.String })) })
  }),
  reads: Schema.Json
});

const atB = Schema.decodeUnknownSync(AtB)(JSON.parse(readFileSync(new URL("at-b.json", import.meta.url), "utf8")));

describe("cards written at B", () => {
  it("read under the port as B read them: the ui calls' cards, the answers kept beside messages, and a run's kept cards", () => {
    const reads = {
      cards: atB.stored.inputs.map(cardOf),
      answers: atB.stored.answers.map(answerOf),
      kept: atB.stored.runCards.cards.map((each) => cardOf(each.card))
    };

    expect(JSON.stringify(reads, null, 2)).toBe(JSON.stringify(atB.reads, null, 2));
  });
});
