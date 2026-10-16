/**
 * `ky <command> [flags]`: parses the arguments, runs the command, and returns the exit code. A
 * failure, a bad flag among them, prints its message rather than a stack.
 *
 * Each command's module is imported when it runs, not before. The cloud machine runs only `ky
 * runner cloud`, `ky attach` and `ky diff` (./runner/commands.ts), so only what those load can
 * change what it does: container/image.inputs lists it, and a release builds a new image only when
 * one of those files changed (scripts/image/inputs.ts).
 */
import { parseArgs } from "node:util";
import { isCancel, text } from "@clack/prompts";
import type { Context } from "./commands.ts";
import { namedOverlay, overlayAs } from "./config.ts";
import { bold, Cancelled, dim } from "./output.ts";

/**
 * What `ky --version` prints after the version. install.sh and the brew formula look for it in a
 * `ky` already on the PATH, so another program named ky is never taken for this one.
 */
export const IDENTITY = "ky-durable-cli";

const help = (settings: string) => `${bold("ky")}: your own durable agent, on your Cloudflare account

  ${bold("ky login")}       check a Cloudflare token can deploy ky, and keep it for the commands below; ${bold("ky logout")} forgets it
  ${bold("ky init")}        sign in, pick the account, deploy ky behind Access, and open it; run again, it fills in what's missing
                 ${dim("[--account <id or name>] [--name <worker>] [--email <you@example.com>] [--subdomain <name>] [--mail <domain>] [--as <name>]")}
  ${bold("ky deploy")}      deploy this ky's release with your settings ${dim("[name]")}
  ${bold("ky upgrade")}     deploy this ky's release, when the Worker runs another one ${dim("[name]")}
  ${bold("ky doctor")}      check each piece of the deploy and print what fixes the first one missing ${dim("[name] [--json]")}
  ${bold("ky teardown")}    delete the Worker with its chats and files, its bucket and Access apps ${dim("[name] [--confirm <worker>]")}
                 ${dim("[name] on any of these: another ky on this computer, set up with `ky init --as <name>`, or the first one by its Worker's name")}
  ${bold("ky backup")}      download a copy of ky, chats, memory, skills and files, to ~/ky-backups ${dim("[--out <file>] [--url <ky>]")}
  ${bold("ky restore")}     put a backup into a fresh ky; refuses one with chats or memory ${dim("<file> [--url <ky>] [--force]")}
  ${bold("ky skill")}       the guide for agents that run ky
  ${bold("ky version")}     this ky's release ${dim("[--version]")}

  ${bold("ky runner add")}  pair this computer with ky, pick what it shares, and run it as a service ${dim("[<ky url> <code>] [--name <machine>] [--as <runner>] [--replace] [--yes] [--no-service]")}
  ${bold("ky runner run")}  run the runner here, in the foreground (the service runs this)
  ${bold("ky runner ls")}   this computer's runner, and whether it's online
  ${bold("ky runner status")} what it shares, where its token, service and log are ${dim("[--json]")}
  ${bold("ky runner logs")} its log ${dim("[--follow]")}
  ${bold("ky runner rm")}   take it off this computer: its service, token and settings
                 ${dim("--as <runner> on any of these: a second runner beside the first, for another ky, with its own service, token, settings and ~/ky-work-<runner>")}

  ${bold("ky attach")}      inside a task: show the user an image or video ${dim("<file> [caption]")}
  ${bold("ky diff")}        inside a task: share the repository's changes ${dim("[base]")}
  ${bold("ky github")}      inside a task on ky's cloud machine: open, view and merge a ky/ PR, and watch or roll back its deploy ${dim("<tool> <owner/repo> …")}

${dim(`Cloudflare login: CLOUDFLARE_API_TOKEN, else the token \`ky login\` kept, else \`wrangler login\` (which can't manage Access).
Settings: ${settings}`)}`;

const OPTIONS = {
  account: { type: "string" },
  name: { type: "string" },
  as: { type: "string" },
  replace: { type: "boolean" },
  email: { type: "string" },
  subdomain: { type: "string" },
  mail: { type: "string" },
  confirm: { type: "string" },
  out: { type: "string", short: "o" },
  url: { type: "string" },
  force: { type: "boolean" },
  json: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  "no-service": { type: "boolean" },
  follow: { type: "boolean", short: "f" },
  version: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" }
} as const;

/** The Worker's name, typed at a prompt, when teardown runs in a terminal without --confirm. */
async function typedName(confirm: string | undefined): Promise<string | undefined> {
  if (confirm !== undefined || !process.stdin.isTTY) return confirm;
  const answer = await text({ message: "This deletes ky's Worker, its chats and files, and its Access apps. Type the Worker's name to go on" });

  return isCancel(answer) ? undefined : answer;
}

async function versionCommand(context: Context): Promise<number> {
  context.print(`ky ${(await context.release()).version} (${IDENTITY})`);

  return 0;
}

export async function ky(args: string[], context: Context): Promise<number> {
  try {
    const { positionals, values } = parseArgs({ args, allowPositionals: true, options: OPTIONS });
    // The ky a deploy command is for: another one on this computer, by name, else the first.
    const named = async () => (positionals[1] ? { ...context, overlay: await namedOverlay(context.overlay, positionals[1]) } : context);
    const initAs = async () => (values.as ? { ...context, overlay: overlayAs(context.overlay, values.as) } : context);

    // Each command's module loads only when it runs. fallow doesn't follow `(await import(…)).name`:
    // a module whose commands load only here is in .fallowrc.json's dynamicallyLoaded.
    const commands = new Map<string, () => Promise<number>>([
      ["login", async () => (await import("./login.ts")).loginCommand(context, await context.stdin())],
      ["logout", async () => (await import("./login.ts")).logoutCommand(context)],
      // A second ky's Worker is named for it, unless --name says otherwise.
      ["init", async () => (await import("./init.ts")).initCommand(await initAs(), { ...values, name: values.name ?? values.as })],
      ["deploy", async () => (await import("./commands.ts")).deployCommand(await named())],
      ["upgrade", async () => (await import("./commands.ts")).upgradeCommand(await named())],
      ["doctor", async () => (await import("./commands.ts")).doctorCommand(await named(), values.json ?? false)],
      ["teardown", async () => (await import("./commands.ts")).teardownCommand(await named(), await typedName(values.confirm))],
      ["backup", async () => (await import("./backup.ts")).backupCommand(context, values)],
      ["restore", async () => (await import("./backup.ts")).restoreCommand(context, positionals[1], values)],
      ["skill", async () => (await import("./commands.ts")).skillCommand(context)],
      ["version", () => versionCommand(context)],
      // What the cloud machine runs.
      ["runner", async () => (await import("./runner/commands.ts")).runnerCommand(context, positionals.slice(1), values)],
      ["attach", async () => (await import("./runner/commands.ts")).shareCommand(context, "attach", positionals.slice(1))],
      ["diff", async () => (await import("./runner/commands.ts")).shareCommand(context, "diff", positionals.slice(1))],
      ["github", async () => (await import("./runner/commands.ts")).githubCommand(context, positionals.slice(1))]
    ]);

    const command = commands.get(values.version ? "version" : (positionals[0] ?? ""));

    if (values.help || !command) {
      context.print(help(context.overlay));

      return values.help ? 0 : 2;
    }

    return await command();
  } catch (error) {
    // A cancelled prompt has said so already.
    if (!(error instanceof Cancelled)) context.fail(`ky: ${error instanceof Error ? error.message : String(error)}`);

    return 1;
  }
}
