import { eslintCompatPlugin } from "@oxlint/plugins";

import { noUncheckedParseRule } from "./no-unchecked-parse.ts";

/** ky's own rules, kept apart from the vendored anti-slop plugin. */
const kyPlugin = eslintCompatPlugin({
  meta: { name: "ky" },
  rules: { "no-unchecked-parse": noUncheckedParseRule }
});

export default kyPlugin;
