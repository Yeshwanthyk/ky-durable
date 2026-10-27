import type { Json } from "../kit";
import { type FakeBucket, sortedMeta, type Tool } from "./world";

type Request = (method: string, path: string) => Promise<Json>;

export async function readsOf(bucket: FakeBucket, tool: Tool, request: Request): Promise<Json> {
  const ids = [...new Set([...bucket.objects.keys()].flatMap((key) => (key.startsWith("sites/") ? [key.split("/")[1] ?? ""] : [])))].sort((a, b) => (a < b ? -1 : 1));
  const tokens = [...bucket.objects.keys()].flatMap((key) => (key.startsWith("sites-public/") ? [key.slice("sites-public/".length)] : [])).sort((a, b) => (a < b ? -1 : 1));
  const pages: Json[] = [];
  const opened: Json[] = [];
  const rewritten: Json[] = [];

  for (const id of ids) for (const rest of ["/", "/?embed", "/css/app.css", "/.site"]) pages.push(await request("GET", `/s/${id}${rest}`));

  for (const token of tokens) for (const rest of ["/", "/css/app.css"]) opened.push(await request("GET", `/p/${token}${rest}`));
  const listed = { sites: await request("GET", "/api/sites"), list: await tool({ action: "list" }) };

  for (const id of ids) {
    const said = await tool({ action: "make_public", id });

    rewritten.push({ said, private: await tool({ action: "make_private", id }), republished: await tool({ action: "publish", id, html: `<p>${id}</p>` }) });
  }

  return { listed, pages, opened, rewritten, after: sortedMeta(bucket.dump()) };
}
