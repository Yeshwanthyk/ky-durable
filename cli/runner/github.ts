/**
 * `ky github <tool> …`: a cloud task's GitHub, since nothing in the container holds a token. Each
 * posts its input to the Worker's GitHub tools at http://github.internal/api/github/<tool>
 * (src/github-tools.ts), which the CloudMachine routes to the Worker: it checks the repo is picked
 * and calls GitHub with ky's token. Each prints the tool's JSON answer.
 *
 *   ky github pr-create <owner/repo> <base> <title> [body]   from the current ky/ branch
 *   ky github pr-merge <owner/repo> <number>                 squash, and delete the branch
 *   ky github pr-view <owner/repo> <number>                  state and merge commit
 *   ky github parent <owner/repo> <sha>                      the commit before it
 *   ky github runs <owner/repo> [commit]                     the deploy workflow's runs
 *   ky github watch <owner/repo> <run id>                    wait for a run; fails unless it succeeded
 *   ky github rollback <owner/repo> <sha>                    run the deploy workflow on main for sha
 *
 * On a computer there is no github.internal: there, `gh` signed in as the user does this.
 */
import { spawnSync } from "node:child_process";
import Type from "typebox";
import { decodeOr, parseOr } from "../../src/core/decode.ts";

/** The tools' names, as src/github-tools.ts serves them. */
type GithubTool = "pr-create" | "pr-merge" | "pr-view" | "parent" | "runs" | "run" | "rollback";

/** Where the CloudMachine routes the Worker's GitHub tools, unless KY_GITHUB_API says (tests). */
const GITHUB_API = "http://github.internal/api/github";

/** How often `watch` asks about a run. */
const WATCH_EVERY_MS = 15_000;

/** How long `watch` waits for a run before it gives up: longer than any deploy. */
const WATCH_WITHIN_MS = 30 * 60_000;

const USAGE = `usage: ky github pr-create <owner/repo> <base> <title> [body]
       ky github pr-merge|pr-view <owner/repo> <number>
       ky github parent|rollback <owner/repo> <sha>
       ky github runs <owner/repo> [commit]
       ky github watch <owner/repo> <run id>`;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A tool's JSON answer, as printed; `watch` reads a run's `status` and `conclusion`. */
type Answer = { [key: string]: Json };

const AnswerSchema = Type.Unsafe<Answer>(Type.Record(Type.String(), Type.Unknown()));

type Call = (tool: GithubTool, input: Record<string, string | number>) => Promise<Answer>;

/** The Worker's tools, at `base`. */
function tools(base: string): Call {
  return async (tool, input) => {
    let answer: Response;

    try {
      answer = await fetch(`${base.replace(/\/$/, "")}/${tool}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    } catch (error) {
      throw new Error(`could not reach ky's GitHub tools at ${base}: ky github runs only on ky's cloud machine (${String(error)})`);
    }

    const text = await answer.text();
    // The tools answer a JSON object, an `{ error }` among them; anything else is reported as text.
    const body = parseOr(AnswerSchema, text, undefined);

    if (!body) throw new Error(`HTTP ${answer.status}: ${text.trim()}`);

    if (!answer.ok) throw new Error(`HTTP ${answer.status}: ${decodeOr(Type.String(), body.error, text.trim())}`);

    return body;
  };
}

/** The current branch, which a PR is opened from. */
function currentBranch(): string {
  const run = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });

  if (run.status !== 0) throw new Error("run ky github pr-create inside the repository, on the ky/ branch you pushed");

  return run.stdout.trim();
}

const count = (text: string | undefined) => {
  const value = Number(text);

  if (!Number.isInteger(value) || value < 1) throw new Error(USAGE);

  return value;
};

/** Each tool's input, from the words after `<owner/repo>`; `branch` is where a PR is opened from. */
const INPUTS: Record<Exclude<GithubTool, "run">, (repo: string, rest: string[], branch: () => string) => Record<string, string | number>> = {
  "pr-create": (repo, [base, title, body = ""], branch) => {
    if (!base || !title) throw new Error(USAGE);

    return { repo, base, head: branch(), title, body };
  },
  "pr-merge": (repo, [number]) => ({ repo, number: count(number) }),
  "pr-view": (repo, [number]) => ({ repo, number: count(number) }),
  parent: (repo, [sha]) => ({ repo, sha: sha ?? usage() }),
  rollback: (repo, [sha]) => ({ repo, sha: sha ?? usage() }),
  runs: (repo, [commit]) => ({ repo, ...(commit && { commit }) })
};

const usage = (): never => {
  throw new Error(USAGE);
};

const isInput = (tool: string): tool is keyof typeof INPUTS => Object.hasOwn(INPUTS, tool);

/** Wait for run `id` to end, asking every WATCH_EVERY_MS: 0 if it succeeded, else 1. */
async function watch(call: Call, repo: string, id: number, show: (body: Answer) => void, sleep: (ms: number) => Promise<void>): Promise<number> {
  const until = Date.now() + WATCH_WITHIN_MS;

  for (;;) {
    const run = await call("run", { repo, id });

    if (run.status === "completed") {
      show(run);

      return run.conclusion === "success" ? 0 : 1;
    }

    if (Date.now() > until) throw new Error(`run ${id} is still ${decodeOr(Type.String(), run.status, "unknown")} after ${WATCH_WITHIN_MS / 60_000} minutes`);
    await sleep(WATCH_EVERY_MS);
  }
}

/** `ky github …`: the exit code. `sleep` waits between `watch`'s questions; tests make it instant. */
export async function github(
  args: string[],
  env: NodeJS.ProcessEnv,
  print: (line: string) => void,
  sleep: (ms: number) => Promise<void>,
  branch: () => string = currentBranch
): Promise<number> {
  const [tool = "", repo, ...rest] = args;

  if (!repo) return usage();
  const call = tools(env.KY_GITHUB_API ?? GITHUB_API);
  const show = (body: Answer) => print(JSON.stringify(body, null, 2));

  if (tool === "watch") return watch(call, repo, count(rest[0]), show, sleep);

  if (!isInput(tool)) return usage();
  show(await call(tool, INPUTS[tool](repo, rest, branch)));

  return 0;
}
