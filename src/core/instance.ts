/** The agent's name where nothing names it: `pnpm start`, the local stack, tests. */
const UNNAMED = "ky";

/**
 * What the owner's agent is called: the name they gave this ky's Worker at `ky init` ("squarey"), which
 * `ky deploy` passes as KY_NAME. The web app reads the same name off its address (src/ui/open-chat.ts).
 */
export function instanceName(vars: { readonly KY_NAME?: string }): string {
  return vars.KY_NAME?.trim() || UNNAMED;
}
