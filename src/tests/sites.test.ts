import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ASSERTION } from "../access/contract";
import { call, inside, prompt } from "./drive";

/**
 * Sites (src/sites.ts, src/site-routes.ts): the agent publishes a page or a workspace folder, the signed-in user
 * opens it at /s/<id>/, and anyone opens it at /p/<token>/ while it is public.
 */

const SANDBOX = "sandbox allow-scripts allow-forms allow-popups";

/** What the site tool said to `args`, in the chat of the agent `name`. */
async function site(name: string, args: Record<string, string>): Promise<string> {
  return (await prompt(name, `tool site ${JSON.stringify(args)}`)).text ?? "";
}

const idOf = (said: string) => /id ([0-9a-f]{32})/.exec(said)?.[1] ?? "";

const publicPath = (said: string) => /\/p\/[A-Za-z0-9_-]{22}\//.exec(said)?.[0] ?? "";

const signedOut = (path: string) => call(path, { headers: { [ASSERTION]: "" }, redirect: "manual" });

/** Write `files` into the workspace of the agent `name`. */
function write(name: string, files: Record<string, string>): Promise<void> {
  return inside(name, async (instance) => {
    for (const [path, content] of Object.entries(files)) {
      await instance.workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await instance.workspace.fs.writeFile(path, content);
    }
  });
}

describe("sites", () => {
  it("publishes one page, served signed in with the sandbox and no cookie, and refused signed out", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => instance.setup.opened("https://ky.test/"));
    const said = await site(name, { action: "publish", title: "Hello", html: "<h1>Hi</h1>" });
    const id = idOf(said);
    expect(said).toContain(`https://ky.test/s/${id}/`);

    const page = await call(`/s/${id}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<h1>Hi</h1>");
    expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("Content-Security-Policy")).toBe(SANDBOX);
    expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(page.headers.get("Set-Cookie")).toBeNull();

    const bare = await call(`/s/${id}`, { redirect: "manual" });
    expect(bare.status).toBe(301);
    expect(bare.headers.get("Location")).toBe(`https://ky.test/s/${id}/`);

    expect((await signedOut(`/s/${id}/`)).status).toBe(401);
    expect(await site(name, { action: "list" })).toContain(`${id} "Hello" https://ky.test/s/${id}/`);
  });

  it("serves a page with ?embed in ky's theme, with a script that posts its height after it, keeping the sandbox, and nothing else changed", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => instance.setup.opened("https://ky.test/"));
    const id = idOf(await site(name, { action: "publish", title: "Embedded", html: "<h1>Hi</h1>" }));

    const embedded = await call(`/s/${id}/?embed`);
    const text = await embedded.text();
    expect(text).toMatch(/^<style>:root\{color-scheme:light dark;[\s\S]*--foreground:#141414;[\s\S]*<\/script><h1>Hi<\/h1><script>[\s\S]*kySiteHeight[\s\S]*<\/script>$/);
    expect(embedded.headers.get("Content-Length")).toBe(String(new TextEncoder().encode(text).byteLength));
    expect(embedded.headers.get("Content-Security-Policy")).toBe(SANDBOX);

    expect(await (await call(`/s/${id}/`)).text()).toBe("<h1>Hi</h1>");
    expect((await signedOut(`/s/${id}/?embed`)).status).toBe(401);
  });

  it("keeps a page's doctype first when it themes it, so the page stays in standards mode", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => instance.setup.opened("https://ky.test/"));
    const id = idOf(await site(name, { action: "publish", title: "Typed", html: "<!DOCTYPE html><html><body>Hi</body></html>" }));

    const text = await (await call(`/s/${id}/?embed=dark`)).text();

    expect(text.startsWith("<!DOCTYPE html><style>:root{")).toBe(true);
    expect(text).toContain("</script><html><body>Hi</body></html><script>");
  });

  it("publishes a folder with nested assets by type, leaving out hidden files, and never serves traversal or its metadata", async () => {
    const name = crypto.randomUUID();
    await write(name, {
      "/workspace/web/index.html": "<link rel=stylesheet href=css/app.css>",
      "/workspace/web/css/app.css": "h1 { color: red }",
      "/workspace/web/js/app.js": "console.log(1)",
      "/workspace/web/v1.2/LICENSE": "MIT",
      "/workspace/web/.env": "KEY=secret",
      "/workspace/web/.git/config": "[core]",
      "/workspace/secret.txt": "not the site's"
    });
    const said = await site(name, { action: "publish", title: "Web", dir: "/workspace/./web/" });
    const id = idOf(said);
    expect(said).toContain("4 files");
    expect(await env.FILES.head(`sites/${id}/.env`)).toBeNull();
    expect(await env.FILES.head(`sites/${id}/.git/config`)).toBeNull();
    expect((await call(`/s/${id}/v1.2/LICENSE`)).headers.get("Content-Type")).toBe("application/octet-stream");

    const head = await call(`/s/${id}/css/app.css`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(head.headers.get("Content-Security-Policy")).toBe(SANDBOX);
    expect(head.headers.get("Content-Length")).toBe("17");
    expect(await head.text()).toBe("");
    const get = await call(`/s/${id}/css/app.css`);
    expect(get.headers.get("Content-Length")).toBe("17");
    expect(get.headers.get("ETag")).toMatch(/^".+"$/);
    expect(get.headers.get("ETag")).toBe(head.headers.get("ETag"));

    expect((await call(`/s/${id}/`)).headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const css = await call(`/s/${id}/css/app.css`);
    expect(await css.text()).toBe("h1 { color: red }");
    expect(css.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect((await call(`/s/${id}/js/app.js`)).headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");

    for (const path of [`/s/${id}/css/..%2fapp.css`, `/s/${id}/%2e%2e/secret.txt`, `/s/${id}/css%2F..%2F..%2Fsecret.txt`, `/s/${id}/.site`, `/s/${id}/..`]) {
      expect((await call(path)).status, path).toBe(404);
    }
  });

  it("serves a public site signed out until it is made private, and never by the old token again", async () => {
    const name = crypto.randomUUID();
    const id = idOf(await site(name, { action: "publish", title: "Shared", html: "<p>shared</p>" }));
    const open = publicPath(await site(name, { action: "make_public", id }));

    const page = await signedOut(open);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<p>shared</p>");
    expect(page.headers.get("Content-Security-Policy")).toBe(SANDBOX);
    expect(page.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(page.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(page.headers.get("Set-Cookie")).toBeNull();
    expect((await signedOut(`${open}..%2f..%2f`)).status).toBe(404);
    expect((await signedOut(`${open}.site`)).status).toBe(404);
    expect((await signedOut("/p/AAAAAAAAAAAAAAAAAAAAAA/")).status).toBe(404);
    expect((await signedOut("/p/abc/")).status).toBe(404);

    expect(await site(name, { action: "make_private", id })).toContain("Private again");
    expect((await signedOut(open)).status).toBe(404);

    const again = publicPath(await site(name, { action: "make_public", id }));
    expect(again).not.toBe(open);
    expect((await signedOut(open)).status).toBe(404);
    expect((await signedOut(again)).status).toBe(200);

    await site(name, { action: "delete", id });
    expect((await signedOut(again)).status).toBe(404);
    expect((await call(`/s/${id}/`)).status).toBe(404);
  });

  it("replaces a site's files entirely when published again with its id", async () => {
    const name = crypto.randomUUID();
    await write(name, { "/workspace/v1/index.html": "v1", "/workspace/v1/old.css": "old" });
    const id = idOf(await site(name, { action: "publish", title: "Versions", dir: "/workspace/v1" }));
    expect((await call(`/s/${id}/old.css`)).status).toBe(200);

    expect(await site(name, { action: "publish", id, html: "v2" })).toContain(`/s/${id}/`);
    expect(await (await call(`/s/${id}/`)).text()).toBe("v2");
    expect((await call(`/s/${id}/old.css`)).status).toBe(404);
    expect(await site(name, { action: "list" })).toContain(`${id} "Versions"`);
  });

  it("deletes a site a publish left without its metadata", async () => {
    const name = crypto.randomUUID();
    const id = crypto.randomUUID().replaceAll("-", "");
    await env.FILES.put(`sites/${id}/index.html`, "cut off");

    expect(await site(name, { action: "delete", id })).toBe(`tool said: Deleted the site ${id}.`);
    expect((await env.FILES.list({ prefix: `sites/${id}/` })).objects).toEqual([]);
  });

  it("refuses in a conversation that is no chat, like a subagent's", async () => {
    const name = crypto.randomUUID();

    const said = await inside(name, async (instance) => {
      const { id } = await instance.harness.sessions.create();

      return (await instance.harness.session(String(id)).prompt('tool site {"action":"list"}')).text;
    });

    expect(said).toBe("tool said: Not done: only a chat with the user may publish sites.");
  });
});
