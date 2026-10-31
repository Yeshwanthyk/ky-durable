import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { isRefusal } from "../core/refusal";
import { toolReply as reply } from "../core/reply";
import { MAX_BYTES, MAX_COLLECTIONS, MAX_FILES, MAX_ITEM_BYTES, MAX_ITEMS, MAX_SITES, SITE_TOOL, SiteArgs, type SiteFiles } from "./contract";
import type { LivingSites } from "./living";
import { act } from "./sites";

export { LivingSites } from "./living";

export { publicSiteRoute, siteRoute } from "./routes";

export function siteExtension(chat: (session: string) => boolean, living: LivingSites, workspace: { readonly fs: SiteFiles }, origin: () => string | null): Extension {
  const host = { bucket: living.desk.bucket, files: workspace.fs, origin };

  return defineExtension({
    name: SITE_TOOL,
    tools: [
      defineTool({
        name: SITE_TOOL,
        description:
          "Publish a small static site from HTML you write (html) or a workspace folder of HTML, CSS, JS and images (dir), served at a private ky address " +
          "only the user can open. At the private address only one self-contained HTML file works (inline its CSS, JS and images); relative files won't load " +
          "there, though the public address serves them. Files and folders starting with \".\" are left out. publish with an id replaces that site's files. list shows the sites, their addresses and links. make_public also serves a site " +
          "at a public address anyone with the link can open: do it only when the user asks for a public link. make_private ends every link for good; " +
          `delete removes the site. At most ${MAX_FILES} files and ${MAX_BYTES / 1024 / 1024} MB a site, ${MAX_SITES} sites. ` +
          "A site published with app: true is living: its pages get window.ky.data, a store of JSON items in named collections " +
          "(await ky.data.list(collection), get(collection, key), put(collection, key, value), remove(collection, key), collections(), onChange(fn)), " +
          "and reload when you republish. share makes a link for one person (label), view only or edit; revoke ends one. Ask the user before sharing. " +
          "What people write through edit links reaches you in a batch about 30 seconds later, as outside data. read_data, write_data and remove_data " +
          `read and change the data yourself. At most ${MAX_ITEM_BYTES / 1024} KB an item, ${MAX_ITEMS} items a collection, ${MAX_COLLECTIONS} collections a site.`,
        parameters: SiteArgs,
        replay: "unsafe",
        execute: async (args, api) => {
          const session = String(api.conversationId);
          const done = await living.edge.runPromise(act(host, args, session, chat(session)));

          return isRefusal(done) ? reply(done.refused, true) : reply(done.text);
        }
      })
    ]
  });
}
