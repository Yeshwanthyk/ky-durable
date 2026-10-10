/**
 * A fake github.com for git, in node: `git http-backend` serving bare repos (one per `GITHUB_REPOS`
 * entry, each with a `main` branch), taking only `token`, which GitHub reads from Basic auth as
 * `x-access-token:<token>`. Pushes are allowed: what may be pushed is ky's proxy's to refuse.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { GITHUB_REPOS } from "./github.ts";
import { portOf } from "./port.ts";

export type GitServer = {
  url: string;
  /** Where the bare repos are: `<root>/<owner>/<name>.git`. */
  root: string;
  /** The branches of a repo, by name. */
  branches: (repo: string) => string[];
  /** The commit a branch of a repo is at. */
  head: (repo: string, branch: string) => string;
  close: () => Promise<void>;
};

const git = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** A bare repo with one commit on main. */
function seed(root: string, repo: string): void {
  const bare = path.join(root, `${repo}.git`);
  const work = mkdtempSync(path.join(tmpdir(), "fake-git-seed-"));

  mkdirSync(bare, { recursive: true });
  git(["init", "-q", "--bare", "-b", "main", bare]);
  git(["config", "http.receivepack", "true"], bare);
  git(["init", "-q", "-b", "main", work]);
  writeFileSync(path.join(work, "README.md"), `# ${repo}\n`);
  git(["add", "."], work);
  git(["-c", "user.name=fake", "-c", "user.email=fake@example.com", "commit", "-qm", "start"], work);
  git(["push", "-q", bare, "main"], work);
}

export async function serveGit(token: string): Promise<GitServer> {
  const root = mkdtempSync(path.join(tmpdir(), "fake-github-"));

  for (const repo of GITHUB_REPOS) seed(root, repo);
  const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

  const server: Server = createServer((request, response) => {
    if (request.headers.authorization !== expected) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' }).end("Bad credentials\n");

      return;
    }

    const url = new URL(request.url ?? "/", "http://github.test");

    const backend = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
        GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
        REMOTE_USER: "x-access-token",
        REMOTE_ADDR: "127.0.0.1"
      },
      stdio: ["pipe", "pipe", "inherit"]
    });

    request.pipe(backend.stdin);
    let head = Buffer.alloc(0);
    let headed = false;

    backend.stdout.on("data", (chunk: Buffer) => {
      if (headed) return void response.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");

      if (end === -1) return;
      headed = true;
      const headers: Record<string, string> = {};
      let status = 200;

      for (const line of head.subarray(0, end).toString("latin1").split("\r\n")) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();

        if (name === "status") status = Number.parseInt(value, 10);
        else headers[name] = value;
      }

      response.writeHead(status, headers);
      response.write(head.subarray(end + 4));
    });
    backend.on("close", () => response.end());
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = portOf(server);

  return {
    url: `http://127.0.0.1:${port}`,
    root,
    branches: (repo) =>
      git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], path.join(root, `${repo}.git`))
        .split("\n")
        .filter((line) => line !== ""),
    head: (repo, branch) => git(["rev-parse", `refs/heads/${branch}`], path.join(root, `${repo}.git`)).trim(),
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
