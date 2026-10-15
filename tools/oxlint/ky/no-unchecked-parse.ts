import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

type Call = ESTree.CallExpression;

type Unchecked = "parse" | "json" | "exec";

/** The receiver and method name of a plain `receiver.name(...)` call. */
function member(node: Call): { object: ESTree.Expression; name: string } | null {
  const callee = node.callee;

  if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return null;

  return { object: callee.object, name: callee.property.name };
}

/** Which unchecked read the call is, if any. */
function unchecked(node: Call): Unchecked | null {
  const call = member(node);

  if (call === null) return null;

  if (call.name === "parse") return call.object.type === "Identifier" && call.object.name === "JSON" ? "parse" : null;

  if (call.name === "json") return node.arguments.length === 0 ? "json" : null;

  return call.name === "exec" && node.typeArguments ? "exec" : null;
}

/**
 * Ban the three ways an unchecked value enters ky typed: `JSON.parse`, a body's `.json()`, and a
 * `sql.exec<Row>` whose row type nothing checks. Each must go through src/core/decode.ts, which checks
 * the value against its schema, so a damaged column, an old client or a changed vendor fails at the
 * boundary with a message instead of deep inside with a TypeError.
 */
export const noUncheckedParseRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Untrusted JSON goes through src/core/decode.ts, which checks it against a schema." },
    messages: {
      parse: "Parse with `parseAs`/`parseOr` from src/core/decode.ts, which checks the value against a schema.",
      json: "Read the body with `bodyAs` from src/core/decode.ts, which checks it against a schema.",
      exec: "Don't name the row type on `exec<...>`: decode each row with a schema from the owner's contract."
    }
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const messageId = unchecked(node);

        if (messageId !== null) context.report({ node, messageId });
      }
    };
  }
});
