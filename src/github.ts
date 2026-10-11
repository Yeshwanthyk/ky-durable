import { WorkerEntrypoint } from "cloudflare:workers";
import { CLOUD } from "./cloud-facts";
import { githubTool } from "./github-tools";

/**
 * github.internal: git's smart HTTP to github.com for the cloud machine, as Scotty's creds proxy
 * does it. The container's git is set to fetch and push `https://github.com/<owner>/<repo>` through
 * `http://github.internal/api/git/<owner>/<repo>`, which the CloudMachine routes here; this adds the
 * Vault's GitHub token, so nothing in the container ever holds it.
 *
 * Its GitHub tools are there too, under `/api/github/` (src/github-tools.ts).
 *
 * Which machine is asking comes only from the props the CloudMachine registered the route with,
 * never from the request. Only the repos that machine may reach are fetched (`allowedRepos`), and a
 * push may only update branches under `ky/`: the work happens on a branch, and the user merges it.
 */

/** The upstream ref every pushed update must name. */
const PUSH_PREFIX = "refs/heads/ky/";

const PATH = /^\/api\/git\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

/** Credentials from the container and hop-by-hop headers never reach GitHub. */
const DROPPED = [
  "host",
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "x-github-token",
  "x-forwarded-for",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length"
];

/** The GitHub login the proxy fetches and pushes with: a token and the repos (owner/name) it may touch. */
export type GithubLogin = { token: string; repos: readonly string[] };

/**
 * Who calls the proxy, as the CloudMachine registers its route (`ctx.exports.GithubProxy({ props })`):
 * the container can't set or forge it. `machine` is the name that never changes, today only `cloud`.
 */
export type GithubProps = { machine: string };

/**
 * The login `machine` reaches GitHub with: the token, and the repos it may touch. Today the one
 * cloud machine may touch every repo picked in Settings; a per-machine list narrows this, never
 * widens it. Any other machine, or none, gets nothing.
 */
export function allowedRepos(login: GithubLogin | null, machine: string | undefined): GithubLogin | null {
  if (!login || machine !== CLOUD) return null;

  return login;
}

const refuse = (status: number, text: string) => new Response(`${text}\n`, { status });

/**
 * Whether a push only updates branches under `ky/`. Its ref updates are the pkt-lines before the
 * first flush-pkt; a body that is only a flush-pkt is git's probe, and harmless.
 */
export function kyRefsOnly(body: Uint8Array): boolean {
  const text = new TextDecoder("latin1");
  let offset = 0;

  while (offset + 4 <= body.length) {
    const size = text.decode(body.subarray(offset, offset + 4));

    if (!/^[0-9a-f]{4}$/.test(size)) return false;
    const length = Number.parseInt(size, 16);

    if (length === 0) return true;

    if (length < 4 || offset + length > body.length) return false;
    const line = text.decode(body.subarray(offset + 4, offset + length)).split("\0")[0] ?? "";

    offset += length;

    if (line.startsWith("shallow ")) continue;

    if (!line.trimEnd().split(" ")[2]?.startsWith(PUSH_PREFIX)) return false;
  }

  return false;
}

const rateLimited = (headers: Headers) => headers.has("retry-after") || headers.get("x-ratelimit-remaining") === "0";

/**
 * One git request from the container, sent on to `upstream` (github.com) with `login`'s token; a
 * repo the user didn't pick, a push to a branch outside `ky/`, or anything but git's three routes
 * is refused with 403.
 */
export async function proxyGit(request: Request, login: GithubLogin | null, upstream = "https://github.com"): Promise<Response> {
  const url = new URL(request.url);
  const [, repo, route] = PATH.exec(url.pathname) ?? [];

  if (!repo || !route) return refuse(404, "Not a git route");

  if (!login) return refuse(401, "GitHub isn't connected to ky: add a token in Settings › Subscriptions");

  if (!login.repos.some((allowed) => allowed.toLowerCase() === repo.toLowerCase()))
    return refuse(403, `ky's GitHub token isn't for ${repo}: pick it in Settings › Subscriptions`);
  const service = route === "info/refs" ? url.searchParams.get("service") : route;

  if (service === null || !SERVICES.has(service) || request.method !== (route === "info/refs" ? "GET" : "POST")) return refuse(403, "Forbidden");
  let body: BodyInit | null = request.body;

  if (route === "git-receive-pack") {
    if (request.headers.has("content-encoding")) return refuse(403, "A compressed push can't be checked");
    const bytes = new Uint8Array(await request.arrayBuffer());

    if (!kyRefsOnly(bytes)) return refuse(403, `ky pushes only to branches under ky/: push to ${PUSH_PREFIX.slice("refs/heads/".length)}<name>`);
    body = bytes;
  }

  const headers = new Headers(request.headers);

  for (const name of DROPPED) headers.delete(name);
  headers.set("authorization", `Basic ${btoa(`x-access-token:${login.token}`)}`);
  // Manual: GitHub redirects a renamed or moved repo, and the token must not follow it there.
  const answer = await fetch(`${upstream}/${repo}.git/${route}${url.search}`, { method: request.method, headers, body, redirect: "manual" });

  // GitHub says some rate limits with 403; git retries only 429.
  if (answer.status === 403 && rateLimited(answer.headers)) {
    await answer.body?.cancel();

    return refuse(429, "GitHub rate limit");
  }

  return answer;
}

/** What GitHub's API is reached with; tests answer instead. */
export type GithubFetch = (input: string, init: RequestInit) => Promise<Response>;

/** How many pages of 100 repos Settings lists; a token for more picks from these. */
const REPO_PAGES = 5;

const TOKEN = /^(github_pat_|ghp_|gho_|ghu_|ghs_)[\w]+$/;

/**
 * The repos (owner/name) `token` reaches, most recently pushed first, or why GitHub refused it.
 * A fine-grained token lists only the repos it was given.
 */
export async function listRepos(fetch: GithubFetch, token: string): Promise<{ repos: string[] } | { refused: string }> {
  if (!TOKEN.test(token)) return { refused: "That isn't a GitHub token. Make a fine-grained one at github.com/settings/personal-access-tokens." };
  const repos: string[] = [];

  for (let page = 1; page <= REPO_PAGES; page++) {
    const answer = await fetch(`https://api.github.com/user/repos?per_page=100&sort=pushed&page=${page}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "ky", "x-github-api-version": "2022-11-28" }
    });

    if (answer.status === 401) return { refused: "GitHub didn't take that token: it may be expired or revoked." };

    if (!answer.ok) return { refused: `GitHub answered ${answer.status} listing the token's repos; try again.` };
    // SAFETY: GitHub's list repositories for the authenticated user answers an array of repositories.
    const listed = (await answer.json()) as { full_name: string }[];

    repos.push(...listed.map((repo) => repo.full_name));

    if (listed.length < 100) break;
  }

  return { repos };
}

/**
 * What the CloudMachine routes github.internal to; exported from server.ts so `ctx.exports` has it.
 * Without the props the CloudMachine gives it, it answers nothing: 404, as no route.
 */
export class GithubProxy extends WorkerEntrypoint<Env, Partial<GithubProps>> {
  override async fetch(request: Request): Promise<Response> {
    const { machine } = this.ctx.props;

    if (!machine) return refuse(404, "Not found");
    const login = allowedRepos(await this.env.Vault.getByName("owner").githubToken(), machine);

    if (!new URL(request.url).pathname.startsWith("/api/github/")) return proxyGit(request, login);

    // ky's own repo, as the prompt names it: the only one the tools merge in or roll back.
    return githubTool(request, login, (input, init) => fetch(input, init), await this.env.PiAgent.getByName("me").selfEditRepo());
  }
}
