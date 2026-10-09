/**
 * `ky <command> [flags]`: parses the arguments, runs the command, and returns the exit code. A
 * failure, a bad flag among them, prints its message rather than a stack.
 */
import { parseArgs } from "node:util";
import { isCancel, text } from "@clack/prompts";
import { type Context, deployCommand, doctorCommand, skillCommand, teardownCommand, upgradeCommand } from "./commands.ts";
import { initCommand } from "./init.ts";

const help = (settings: string) => `ky: your own durable agent, on your Cloudflare account

  ky init        sign in, pick the account, deploy ky behind Access, and open it; run again, it fills in what's missing
                 [--account <id or name>] [--name <worker>] [--email <you@example.com>] [--subdomain <name>]
  ky deploy      deploy this ky's release with your settings
  ky upgrade     deploy this ky's release, when the Worker runs another one
  ky doctor      check each piece of the deploy and print what fixes the first one missing [--json]
  ky teardown    delete the Worker with its chats and files, its bucket and Access apps [--confirm <worker>]
  ky skill       the guide for agents that run ky

Cloudflare login: CLOUDFLARE_API_TOKEN, or \`wrangler login\`. ky keeps no token.
Settings: ${settings}`;

const OPTIONS = {
  account: { type: "string" },
  name: { type: "string" },
  email: { type: "string" },
  subdomain: { type: "string" },
  confirm: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" }
} as const;

/** The Worker's name, typed at a prompt, when teardown runs in a terminal without --confirm. */
async function typedName(confirm: string | undefined): Promise<string | undefined> {
  if (confirm !== undefined || !process.stdin.isTTY) return confirm;
  const answer = await text({ message: "This deletes ky's Worker, its chats and files, and its Access apps. Type the Worker's name to go on" });

  return isCancel(answer) ? undefined : answer;
}

export async function ky(args: string[], context: Context): Promise<number> {
  try {
    const { positionals, values } = parseArgs({ args, allowPositionals: true, options: OPTIONS });

    const commands = new Map<string, () => Promise<number>>([
      ["init", () => initCommand(context, values)],
      ["deploy", () => deployCommand(context)],
      ["upgrade", () => upgradeCommand(context)],
      ["doctor", () => doctorCommand(context, values.json ?? false)],
      ["teardown", async () => teardownCommand(context, await typedName(values.confirm))],
      ["skill", () => skillCommand(context)]
      // C: `ky runner …` joins here.
    ]);

    const command = commands.get(positionals[0] ?? "");

    if (values.help || !command) {
      context.print(help(context.overlay));

      return values.help ? 0 : 2;
    }

    return await command();
  } catch (error) {
    context.fail(`ky: ${error instanceof Error ? error.message : String(error)}`);

    return 1;
  }
}
