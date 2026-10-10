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
