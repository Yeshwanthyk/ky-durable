/**
 * `ky`: sets up ky on the user's own Cloudflare account and keeps it running. Run from a checkout
 * with `pnpm ky …` (after `pnpm compile` gathers the release), or as the compiled binary, which
 * carries its release (cli/binary.ts).
 */
import { parseArgs } from "node:util";
import { isCancel, text } from "@clack/prompts";
import { login } from "./cloudflare.ts";
import { type Context, deployCommand, doctorCommand, skillCommand, teardownCommand, upgradeCommand } from "./commands.ts";
import { overlayPath } from "./config.ts";
import { initCommand } from "./init.ts";
import { loadRelease } from "./release.ts";

const HELP = `ky: your own durable agent, on your Cloudflare account

  ky init        sign in, pick the account, deploy ky behind Access, and open it
                 [--account <id or name>] [--name <worker>] [--email <you@example.com>] [--subdomain <name>]
  ky deploy      deploy this ky's release with your settings
  ky upgrade     deploy this ky's release, when the Worker runs another one
  ky doctor      check each piece of the deploy and print the command that fixes it [--json]
  ky teardown    delete the Worker with its chats and files, its bucket and Access apps [--confirm <worker>]
  ky skill       the guide for agents that run ky

Cloudflare login: CLOUDFLARE_API_TOKEN, or \`wrangler login\`. ky keeps no token.
Settings: ${overlayPath()}`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    account: { type: "string" },
    name: { type: "string" },
    email: { type: "string" },
    subdomain: { type: "string" },
    confirm: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" }
  }
});

const context: Context = { overlay: overlayPath(), release: loadRelease, login, print: (line) => console.log(line) };

/** The Worker's name, typed at a prompt, when teardown runs in a terminal without --confirm. */
async function typedName(): Promise<string | undefined> {
  if (values.confirm !== undefined || !process.stdin.isTTY) return values.confirm;
  const answer = await text({ message: "This deletes ky's Worker, its chats and files, and its Access apps. Type the Worker's name to go on" });

  return isCancel(answer) ? undefined : answer;
}

const commands = new Map<string, () => Promise<number>>([
  ["init", () => initCommand(context, values)],
  ["deploy", () => deployCommand(context)],
  ["upgrade", () => upgradeCommand(context)],
  ["doctor", () => doctorCommand(context, values.json ?? false)],
  ["teardown", async () => teardownCommand(context, await typedName())],
  ["skill", () => skillCommand(context)]
  // C: `ky runner …` joins here.
]);

const command = commands.get(positionals[0] ?? "");

if (values.help) console.log(HELP);
else if (!command) {
  console.log(HELP);
  process.exitCode = 2;
} else {
  try {
    process.exitCode = await command();
  } catch (error) {
    console.error(`ky: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
