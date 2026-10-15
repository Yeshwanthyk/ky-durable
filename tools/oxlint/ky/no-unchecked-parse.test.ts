import { RuleTester } from "oxlint/plugins-dev";

import { noUncheckedParseRule } from "./no-unchecked-parse.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("ky/no-unchecked-parse", noUncheckedParseRule, {
  valid: [
    "const value = parseAs(Schema, text, 'the row');",
    "const body = await bodyAs(response, Schema, 'the reply');",
    "const rows = sql.exec('SELECT 1').toArray();",
    "const text = JSON.stringify(value);",
    "const json = format.json(value);"
  ],
  invalid: [
    { code: "const value = JSON.parse(text) as Row;", errors: [{ messageId: "parse" }] },
    { code: "const body = await response.json();", errors: [{ messageId: "json" }] },
    { code: "const rows = sql.exec<Row>('SELECT * FROM t').toArray();", errors: [{ messageId: "exec" }] }
  ]
});
