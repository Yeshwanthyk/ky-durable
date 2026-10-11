/**
 * Fakes of GitHub, for the cloud machine's git and Settings › Subscriptions.
 *
 * - `fakeGithubApi` answers GitHub's REST API as the Vault calls it (`GET /user/repos`), in the
 *   Worker, so the stack's Vault's `github` is its `fetch`.
 * - `serveGit` (node only) is github.com's smart HTTP: `git http-backend` over a directory of bare
 *   repos, taking only the token it is given, as GitHub takes a token through Basic auth. The
 *   harness points the stack's github.internal route at it.
 */

/** The repos every fake token reaches. */
export const GITHUB_REPOS = ["me/app", "me/site"];

/** A fine-grained token the fake API refuses, as GitHub does an expired one. */
export const REVOKED_GITHUB_TOKEN = "github_pat_revoked";

export function fakeGithubApi(): (input: string, init: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = new URL(input);
    const token = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "");

    if (url.origin !== "https://api.github.com" || url.pathname !== "/user/repos") return Response.json({ message: "Not Found" }, { status: 404 });

    if (!token || token === REVOKED_GITHUB_TOKEN) return Response.json({ message: "Bad credentials" }, { status: 401 });

    return Response.json(url.searchParams.get("page") === "1" ? GITHUB_REPOS.map((full_name) => ({ full_name })) : []);
  };
}

/** A pull request as the fake REST API keeps it. */
type FakePull = {
  number: number;
  html_url: string;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  merge_commit_sha: string | null;
  head: { ref: string; repo: { full_name: string } };
  base: { ref: string };
};

const notFound = () => Response.json({ message: "Not Found" }, { status: 404 });

/** One route of the fake REST API: the repo, its pull request if the path names one, and the request. */
type RestRoute = (repo: string, pull: FakePull | undefined, init: RequestInit) => Response;

/**
 * GitHub's REST API as ky's GitHub tools call it (src/github-tools.ts), in memory: every repo's
 * default branch is main, and a pull request opens, merges and loses its branch. It takes any
 * token but the revoked one, and answers 404 for anything else.
 */
export function fakeGithubRest(): (input: string, init: RequestInit) => Promise<Response> {
  const pulls = new Map<string, FakePull>();
  let made = 0;

  const routes = new Map<string, RestRoute>([
    ["GET ", (repo) => Response.json({ full_name: repo, default_branch: "main" })],
    ["POST /pulls", (repo, _pull, init) => {
      // SAFETY: the tools send pr-create's checked input as JSON.
      const { title, head, base } = JSON.parse(String(init.body)) as { title: string; head: string; base: string };
      const number = ++made;

      const created: FakePull = {
        number,
        html_url: `https://github.com/${repo}/pull/${number}`,
        title,
        state: "open",
        merged: false,
        merge_commit_sha: null,
        head: { ref: head, repo: { full_name: repo } },
        base: { ref: base }
      };

      pulls.set(`${repo}#${number}`, created);

      return Response.json(created, { status: 201 });
    }],
    ["GET /pulls/:n", (_repo, pull) => (pull ? Response.json(pull) : notFound())],
    ["PUT /pulls/:n/merge", (_repo, pull) => {
      if (!pull || pull.state !== "open") return Response.json({ message: "Pull Request is not mergeable" }, { status: 405 });
      Object.assign(pull, { state: "closed", merged: true, merge_commit_sha: "f".repeat(40) });

      return Response.json({ merged: true, sha: pull.merge_commit_sha });
    }],
    ["DELETE /git/refs/heads/:ref", () => new Response(null, { status: 204 })]
  ]);

  return async (input, init) => {
    const url = new URL(input);
    const token = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "");
    const [, repo, rest = ""] = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname) ?? [];

    if (!token || token === REVOKED_GITHUB_TOKEN) return Response.json({ message: "Bad credentials" }, { status: 401 });

    if (url.origin !== "https://api.github.com" || !repo) return notFound();
    const route = routes.get(`${init.method ?? "GET"} ${rest.replace(/\/\d+/, "/:n").replace(/\/git\/refs\/heads\/.*/, "/git/refs/heads/:ref")}`);

    return route ? route(repo, pulls.get(`${repo}#${/\/pulls\/(\d+)/.exec(rest)?.[1]}`), init) : notFound();
  };
}
