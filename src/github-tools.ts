import Type, { type Static, type TSchema } from "typebox";
import { parseAs, parseOr } from "./core/decode";
import type { GithubFetch, GithubLogin } from "./github";

/**
 * github.internal's GitHub tools: what a cloud task does on GitHub beyond git, since nothing in the
 * container holds a token. A task runs `ky github …` (cli/runner/github.ts), which posts JSON to
 * `http://github.internal/api/github/<tool>`; the CloudMachine routes that to the Worker's
 * GithubProxy, which knows the machine from its props. Each tool checks the repo is one the
 * machine may reach, then calls GitHub's REST API with the Vault's token.
 *
 * Exactly what ky's self-edit steps need (src/prompt.ts), and nothing else:
 *
 *   pr-create  { repo, base, head, title, body }  open a PR from a ky/ branch of the repo into its default branch
 *   pr-merge   { repo, number }                   squash it, then delete its branch: ky's own repo only
 *   pr-view    { repo, number }                   its state, and its merge commit once merged
 *   parent     { repo, sha }                      a commit's first parent: the rollback point
 *   runs       { repo, commit? }                  the deploy workflow's runs, of a commit or the latest
 *   run        { repo, id }                       one run of the deploy workflow: status and conclusion
 *   rollback   { repo, sha }                      run the deploy workflow for a commit of the default branch: ky's own repo only
 *
 * Merging and rolling back deploy, so they reach only ky's own repo (Settings › Self-edits, the repo
 * the prompt names): a task told otherwise can open a PR in another picked repo, which a person merges.
 */

/** The branches a PR may come from, as pushes may only reach them (src/github.ts); never with `..`, which a URL would resolve. */
const HEAD = /^ky\/(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/** The workflow `runs`, `run` and `rollback` reach: the deploy, and only on the default branch. */
const DEPLOY_WORKFLOW = "deploy.yml";

/** A run's `path` when it is the deploy workflow's. */
const DEPLOY_PATH = `.github/workflows/${DEPLOY_WORKFLOW}`;

/** The tools that deploy: only in ky's own repo. */
const SELF_EDIT_ONLY: ReadonlySet<string> = new Set(["pr-merge", "rollback"]);

const API = "https://api.github.com";

const Repo = Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" });

const Sha = Type.String({ pattern: "^[0-9a-f]{7,40}$" });

const Positive = Type.Integer({ minimum: 1 });

const TOOLS = {
  "pr-create": Type.Object({
    repo: Repo,
    base: Type.String({ pattern: "^[A-Za-z0-9._/-]+$", maxLength: 255 }),
    head: Type.String({ maxLength: 255 }),
    title: Type.String({ minLength: 1, maxLength: 256 }),
    body: Type.String({ maxLength: 65_536 })
  }),
  "pr-merge": Type.Object({ repo: Repo, number: Positive }),
  "pr-view": Type.Object({ repo: Repo, number: Positive }),
  parent: Type.Object({ repo: Repo, sha: Sha }),
  runs: Type.Object({ repo: Repo, commit: Type.Optional(Sha) }),
  run: Type.Object({ repo: Repo, id: Positive }),
  rollback: Type.Object({ repo: Repo, sha: Sha })
} satisfies Record<string, TSchema>;

type GithubTool = keyof typeof TOOLS;

type GithubToolInput<T extends GithubTool> = Static<(typeof TOOLS)[T]>;

/** A refusal or GitHub's own error, as the task sees it: the status, and why. */
class Refused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const Text = Type.String();

const Nullable = <Schema extends TSchema>(schema: Schema) => Type.Union([schema, Type.Null()]);

/** The parts of a pull request the tools read. */
const PullSchema = Type.Object({
  number: Type.Number(),
  html_url: Text,
  title: Text,
  state: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  merged: Type.Boolean(),
  merge_commit_sha: Nullable(Text),
  head: Type.Object({ ref: Text, repo: Nullable(Type.Object({ full_name: Text })) }),
  base: Type.Object({ ref: Text })
});

type Pull = Static<typeof PullSchema>;

/** The parts of a workflow run the tools read. */
const RunSchema = Type.Object({
  id: Type.Number(),
  path: Text,
  status: Text,
  conclusion: Nullable(Text),
  head_sha: Text,
  event: Text,
  html_url: Text,
  created_at: Text
});

type Run = Static<typeof RunSchema>;

/** The other answers of GitHub's the tools read. */
const CommitSchema = Type.Object({ sha: Text, parents: Type.Array(Type.Object({ sha: Text })) });

const RunsSchema = Type.Object({ workflow_runs: Type.Array(RunSchema) });

const CompareSchema = Type.Object({ status: Text });

const RepoSchema = Type.Object({ default_branch: Text });

/** GitHub's error body, when it is JSON. */
const ErrorSchema = Type.Object({ message: Type.Optional(Text) });

/** An answer the tools don't read, as a merge's or a dispatch's. */
const Ignored = Type.Unknown();

/** What the tools answer. */
type PullView = { number: number; url: string; title: string; state: "open" | "closed" | "merged"; head: string; base: string; mergeCommit: string | null };

type RunView = { id: number; status: string; conclusion: string | null; commit: string; event: string; url: string; createdAt: string };

type ToolAnswer = PullView | RunView | { commit: string; parent: string | null } | { runs: RunView[] } | { started: true; workflow: string; ref: string; sha: string };

/** What the tools send GitHub. */
type RestBody = Record<string, string | Record<string, string>>;

const run = ({ id, status, conclusion, head_sha, event, html_url, created_at }: Run): RunView => ({ id, status, conclusion, commit: head_sha, event, url: html_url, createdAt: created_at });

const pull = (pr: Pull): PullView => ({
  number: pr.number,
  url: pr.html_url,
  title: pr.title,
  state: pr.merged ? "merged" : pr.state,
  head: pr.head.ref,
  base: pr.base.ref,
  // GitHub fills merge_commit_sha with a test merge while a PR is open: only a merged PR's is real.
  mergeCommit: pr.merged ? pr.merge_commit_sha : null
});

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** GitHub's REST API with `token`, never following a redirect; GitHub's error, if it answers one, as Refused. */
function rest(fetch: GithubFetch, token: string) {
  return async <Schema extends TSchema>(method: string, path: string, schema: Schema, body?: RestBody): Promise<Static<Schema>> => {
    const answer = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "ky",
        "x-github-api-version": "2022-11-28",
        ...(body !== undefined && { "content-type": "application/json" })
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      redirect: "manual"
    });

    if (!answer.ok) {
      const text = await answer.text();
      // GitHub's errors are JSON with a message; anything else is shown as it came.
      const message = parseOr(ErrorSchema, text, undefined)?.message ?? text;

      throw new Refused(answer.status, `GitHub answered ${answer.status}: ${message}`);
    }

    // A 204 has no body: null, which only Ignored takes.
    const text = answer.status === 204 ? "null" : await answer.text();

    return parseAs(schema, text, `GitHub's answer to ${method} ${path}`);
  };
}

type Rest = ReturnType<typeof rest>;

/** `repo`'s default branch, which PRs go into and deploys run on. */
async function defaultBranch(call: Rest, repo: string): Promise<string> {
  return (await call("GET", `/repos/${repo}`, RepoSchema)).default_branch;
}

/**
 * `pr`, if ky may merge it: from a branch ky pushed, under ky/ and in `repo` itself (a fork's PR
 * has another head repo), into `base`, the default branch.
 */
function kyPull(pr: Pull, repo: string, base: string): Pull {
  if (!pr.head.repo || !same(pr.head.repo.full_name, repo) || !HEAD.test(pr.head.ref)) {
    throw new Refused(403, `ky merges only PRs from its own ky/ branches: #${pr.number} is from ${pr.head.repo?.full_name ?? "a deleted repo"}:${pr.head.ref}`);
  }

  if (pr.base.ref !== base) throw new Refused(403, `ky merges only PRs into ${base}, the default branch: #${pr.number} is into ${pr.base.ref}`);

  return pr;
}

/** Delete a merged PR's branch; one already gone, as when the repo deletes merged branches itself, is fine. */
async function deleteBranch(call: Rest, repo: string, ref: string): Promise<void> {
  try {
    await call("DELETE", `/repos/${repo}/git/refs/heads/${ref}`, Ignored);
  } catch (error) {
    if (!(error instanceof Refused && error.status === 422)) throw error;
  }
}

type Handler<T extends GithubTool> = (call: Rest, input: GithubToolInput<T>) => Promise<ToolAnswer>;

/** One handler for each tool. */
type Handlers = { readonly [T in GithubTool]: Handler<T> };

/** Each tool, by name, given input already checked against its schema and a repo the machine may reach. */
const HANDLERS = {
  "pr-create": async (call, { repo, base, head, title, body }) => {
    if (!HEAD.test(head)) throw new Refused(403, `A PR's branch must be under ky/ in ${repo} itself, as pushes are: not ${head}`);
    const branch = await defaultBranch(call, repo);

    if (base !== branch) throw new Refused(403, `A PR goes into ${branch}, ${repo}'s default branch: not ${base}`);

    return pull(await call("POST", `/repos/${repo}/pulls`, PullSchema, { title, head, base, body }));
  },
  "pr-merge": async (call, { repo, number }) => {
    const pr = kyPull(await call("GET", `/repos/${repo}/pulls/${number}`, PullSchema), repo, await defaultBranch(call, repo));

    if (pr.merged) return pull(pr);

    if (pr.state !== "open") throw new Refused(409, `#${number} is closed without being merged`);
    await call("PUT", `/repos/${repo}/pulls/${number}/merge`, Ignored, { merge_method: "squash" });
    await deleteBranch(call, repo, pr.head.ref);

    return pull(await call("GET", `/repos/${repo}/pulls/${number}`, PullSchema));
  },
  "pr-view": async (call, { repo, number }) => pull(await call("GET", `/repos/${repo}/pulls/${number}`, PullSchema)),
  parent: async (call, { repo, sha }) => {
    const commit = await call("GET", `/repos/${repo}/commits/${sha}`, CommitSchema);

    return { commit: commit.sha, parent: commit.parents[0]?.sha ?? null };
  },
  runs: async (call, { repo, commit }) => {
    const query = new URLSearchParams({ per_page: "5", ...(commit && { head_sha: commit }) });
    const listed = await call("GET", `/repos/${repo}/actions/workflows/${DEPLOY_WORKFLOW}/runs?${query}`, RunsSchema);

    return { runs: listed.workflow_runs.map(run) };
  },
  run: async (call, { repo, id }) => {
    const found = await call("GET", `/repos/${repo}/actions/runs/${id}`, RunSchema);

    if (found.path !== DEPLOY_PATH) throw new Refused(403, `Run ${id} isn't of ${DEPLOY_PATH}`);

    return run(found);
  },
  rollback: async (call, { repo, sha }) => {
    const branch = await defaultBranch(call, repo);
    // From the branch to sha: "behind" or "identical" only when sha is one of its commits.
    const { status } = await call("GET", `/repos/${repo}/compare/${branch}...${sha}`, CompareSchema);

    if (status !== "behind" && status !== "identical") throw new Refused(403, `${sha} isn't a commit of ${branch}: ky rolls back only to one`);
    await call("POST", `/repos/${repo}/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`, Ignored, { ref: branch, inputs: { sha } });

    return { started: true, workflow: DEPLOY_WORKFLOW, ref: branch, sha };
  }
} satisfies Handlers;

/** Tool `name`'s handler: Handlers is keyed by tool, so it takes exactly that tool's input. */
const handlerOf = <T extends GithubTool>(name: T, handlers: Handlers): Handler<T> => handlers[name];

const isTool = (name: string): name is GithubTool => Object.hasOwn(TOOLS, name);

const refuse = (status: number, error: string) => Response.json({ error }, { status });

/**
 * One tool call from a cloud task, `POST /api/github/<tool>` with its JSON input, answered with the
 * tool's JSON, or `{ error }`: 404 for no such tool, 401 with no GitHub login, 400 for bad input,
 * 403 for a repo the machine may not reach, a deploy outside `selfEdit` (ky's own repo, or null
 * until Settings has it) or a branch outside ky/, else GitHub's own status.
 */
export async function githubTool(request: Request, login: GithubLogin | null, fetch: GithubFetch, selfEdit: string | null): Promise<Response> {
  const name = /^\/api\/github\/([a-z-]+)$/.exec(new URL(request.url).pathname)?.[1];

  if (!name || !isTool(name)) return refuse(404, "No such GitHub tool");

  if (request.method !== "POST") return refuse(405, "Use POST");

  if (!login) return refuse(401, "GitHub isn't connected to ky: add a token in Settings › Subscriptions");

  return runTool(name, await request.text(), login, fetch, selfEdit);
}

/** Run tool `name` on the JSON `text` it was posted, once its input and repo check out. */
async function runTool<T extends GithubTool>(name: T, text: string, login: GithubLogin, fetch: GithubFetch, selfEdit: string | null): Promise<Response> {
  const input: GithubToolInput<T> | undefined = parseOr(TOOLS[name], text, undefined);

  if (input === undefined) return refuse(400, `Bad input for ${name}`);
  const repo = login.repos.find((allowed) => same(allowed, input.repo));

  if (!repo) return refuse(403, `ky's GitHub token isn't for ${input.repo}: pick it in Settings › Subscriptions`);

  if (SELF_EDIT_ONLY.has(name) && !(selfEdit && same(selfEdit, repo))) {
    return refuse(403, `ky's ${name} reaches only its own repo (${selfEdit ?? "not set in Settings"}): not ${repo}`);
  }

  try {
    // The repo as the picked one spells it.
    return Response.json(await handlerOf(name, HANDLERS)(rest(fetch, login.token), { ...input, repo }));
  } catch (error) {
    if (error instanceof Refused) return refuse(error.status, error.message);
    throw error;
  }
}
