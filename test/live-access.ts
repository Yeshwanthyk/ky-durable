import { spawnSync } from "node:child_process";

/**
 * The deployed ky a live script runs against, KY_URL, and the headers that sign in to it as the
 * owner: Access takes a `cloudflared access token` in place of the browser's cookie. Exits 2 with
 * what to do when there's no KY_URL or no token.
 */
export function liveTarget(usage: string) {
  const url = present(process.env.KY_URL?.replace(/\/$/, ""), `usage: ${usage}`);
  const login = spawnSync("cloudflared", ["access", "token", `-app=${url}`], { encoding: "utf8" });
  const token = present(login.status === 0 ? login.stdout.trim() : "", `No Access token for ${url}: run \`cloudflared access login ${url}\`, then try again.\n${login.stderr ?? ""}`);

  return { url, signedIn: { "cf-access-token": token } };
}

/** The value, or exit 2 saying `otherwise` when it's missing. */
function present(value: string | undefined, otherwise: string): string {
  if (value) return value;
  console.error(otherwise);
  process.exit(2);
}
