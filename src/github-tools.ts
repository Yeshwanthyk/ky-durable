import Type, { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
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
 *   pr-create  { repo, base, head, title, body }  open a PR; head must be a ky/ branch of the repo
 *   pr-merge   { repo, number }                   squash it, then delete its branch; only a ky/ head
 *   pr-view    { repo, number }                   its state, and its merge commit once merged
 *   parent     { repo, sha }                      a commit's first parent: the rollback point
 *   runs       { repo, commit? }                  the deploy workflow's runs, of a commit or the latest
 *   run        { repo, id }                       one run's status and conclusion
 *   rollback   { repo, sha }                      run the deploy workflow on main for sha
 */

/** The branches a PR may come from, as pushes may only reach them (src/github.ts); never with `..`, which a URL would resolve. */
const HEAD = /^ky\/(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/** The workflow `runs`, `run` and `rollback` reach: the deploy, and only on main. */
const DEPLOY_WORKFLOW = "deploy.yml";

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

/** The parts of a pull request the tools read. */
type Pull = {
  number: number;
  html_url: string;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  merge_commit_sha: string | null;
  head: { ref: string; repo: { full_name: string } | null };
  base: { ref: string };
};

/** The parts of a workflow run the tools read. */
type Run = { id: number; status: string; conclusion: string | null; head_sha: string; event: string; html_url: string; created_at: string };

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
  return async <T>(method: string, path: string, body?: RestBody): Promise<T> => {
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
      let message = text;

      try {
        // SAFETY: GitHub's errors are JSON with a message; anything else is shown as it came.
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // Not JSON: the text itself.
      }

      throw new Refused(answer.status, `GitHub answered ${answer.status}: ${message}`);
    }

    // SAFETY: each caller names the shape GitHub's REST API answers for its route.
    return (answer.status === 204 ? undefined : await answer.json()) as T;
  };
}

type Rest = ReturnType<typeof rest>;

/** `pr`, if its branch is one ky pushed: under ky/, and in `repo` itself, where a fork's PR has another head repo. */
function kyPull(pr: Pull, repo: string): Pull {
  if (pr.head.repo && same(pr.head.repo.full_name, repo) && HEAD.test(pr.head.ref)) return pr;

  throw new Refused(403, `ky merges only PRs from its own ky/ branches: #${pr.number} is from ${pr.head.repo?.full_name ?? "a deleted repo"}:${pr.head.ref}`);
}

/** Delete a merged PR's branch; one already gone, as when the repo deletes merged branches itself, is fine. */
async function deleteBranch(call: Rest, repo: string, ref: string): Promise<void> {
  try {
    await call("DELETE", `/repos/${repo}/git/refs/heads/${ref}`);
  } catch (error) {
    if (!(error instanceof Refused && error.status === 422)) throw error;
  }
}

type Handler<T extends GithubTool> = (call: Rest, input: GithubToolInput<T>) => Promise<ToolAnswer>;

/** Each tool, given input already checked against its schema and a repo the machine may reach. */
const HANDLERS = {
  "pr-create": async (call, { repo, base, head, title, body }) => {
    if (!HEAD.test(head)) throw new Refused(403, `A PR's branch must be under ky/ in ${repo} itself, as pushes are: not ${head}`);

    return pull(await call<Pull>("POST", `/repos/${repo}/pulls`, { title, head, base, body }));
  },
  "pr-merge": async (call, { repo, number }) => {
    const pr = kyPull(await call<Pull>("GET", `/repos/${repo}/pulls/${number}`), repo);

    if (pr.merged) return pull(pr);

    if (pr.state !== "open") throw new Refused(409, `#${number} is closed without being merged`);
    await call("PUT", `/repos/${repo}/pulls/${number}/merge`, { merge_method: "squash" });
    await deleteBranch(call, repo, pr.head.ref);

    return pull(await call<Pull>("GET", `/repos/${repo}/pulls/${number}`));
  },
  "pr-view": async (call, { repo, number }) => pull(await call<Pull>("GET", `/repos/${repo}/pulls/${number}`)),
  parent: async (call, { repo, sha }) => {
    const commit = await call<{ sha: string; parents: { sha: string }[] }>("GET", `/repos/${repo}/commits/${sha}`);

    return { commit: commit.sha, parent: commit.parents[0]?.sha ?? null };
  },
  runs: async (call, { repo, commit }) => {
    const query = new URLSearchParams({ per_page: "5", ...(commit && { head_sha: commit }) });
    const listed = await call<{ workflow_runs: Run[] }>("GET", `/repos/${repo}/actions/workflows/${DEPLOY_WORKFLOW}/runs?${query}`);

    return { runs: listed.workflow_runs.map(run) };
  },
  run: async (call, { repo, id }) => run(await call<Run>("GET", `/repos/${repo}/actions/runs/${id}`)),
  rollback: async (call, { repo, sha }) => {
    await call("POST", `/repos/${repo}/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`, { ref: "main", inputs: { sha } });

    return { started: true, workflow: DEPLOY_WORKFLOW, ref: "main", sha };
  }
} satisfies { [T in GithubTool]: Handler<T> };

const isTool = (name: string): name is GithubTool => Object.hasOwn(TOOLS, name);

const refuse = (status: number, error: string) => Response.json({ error }, { status });

/**
 * One tool call from a cloud task, `POST /api/github/<tool>` with its JSON input, answered with the
 * tool's JSON, or `{ error }`: 404 for no such tool, 401 with no GitHub login, 400 for bad input,
 * 403 for a repo the machine may not reach or a branch outside ky/, else GitHub's own status.
 */
export async function githubTool(request: Request, login: GithubLogin | null, fetch: GithubFetch): Promise<Response> {
  const name = /^\/api\/github\/([a-z-]+)$/.exec(new URL(request.url).pathname)?.[1];

  if (!name || !isTool(name)) return refuse(404, "No such GitHub tool");

  if (request.method !== "POST") return refuse(405, "Use POST");

  if (!login) return refuse(401, "GitHub isn't connected to ky: add a token in Settings › Subscriptions");
  let input: unknown;

  try {
    input = await request.json();
  } catch {
    return refuse(400, "The input must be JSON");
  }

  if (!Value.Check(TOOLS[name], input)) return refuse(400, `Bad input for ${name}`);
  // SAFETY: checked against TOOLS[name] just above.
  const checked = input as GithubToolInput<typeof name>;
  const repo = login.repos.find((allowed) => same(allowed, checked.repo));

  if (!repo) return refuse(403, `ky's GitHub token isn't for ${checked.repo}: pick it in Settings › Subscriptions`);

  try {
    // SAFETY: HANDLERS[name] takes TOOLS[name]'s input, which `checked` is; the repo is the picked one's spelling.
    const handler = HANDLERS[name] as Handler<GithubTool>;

    return Response.json(await handler(rest(fetch, login.token), { ...checked, repo }));
  } catch (error) {
    if (error instanceof Refused) return refuse(error.status, error.message);
    throw error;
  }
}
