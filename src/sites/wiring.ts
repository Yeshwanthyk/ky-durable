import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import * as Layer from "effect/Layer";
import { makeEdge } from "../core/edge";
import { isRefusal } from "../core/refusal";
import { toolReply as reply } from "../core/reply";
import { MAX_BYTES, MAX_FILES, MAX_SITES, SITE_TOOL, SiteArgs, type SiteBucket, type SiteFiles } from "./contract";
import { act } from "./sites";

export { publicSiteRoute, siteRoute } from "./routes";

export function siteExtension(chat: (session: string) => boolean, bucket: SiteBucket, workspace: { readonly fs: SiteFiles }, origin: () => string | null): Extension {
  const edge = makeEdge(Layer.empty);
  const host = { bucket, files: workspace.fs, origin };

  return defineExtension({
    name: SITE_TOOL,
    tools: [
      defineTool({
        name: SITE_TOOL,
        description:
          "Publish a small static site from HTML you write (html) or a workspace folder of HTML, CSS, JS and images (dir), served at a private ky address " +
          "only the user can open. At the private address only one self-contained HTML file works (inline its CSS, JS and images); relative files won't load " +
          "there, though the public address serves them. Files and folders starting with \".\" are left out. publish with an id replaces that site's files. list shows the sites and their addresses. make_public also serves a site " +
          "at a public address anyone with the link can open: do it only when the user asks for a public link. make_private ends the public address for good; " +
          `delete removes the site. At most ${MAX_FILES} files and ${MAX_BYTES / 1024 / 1024} MB a site, ${MAX_SITES} sites.`,
        parameters: SiteArgs,
        replay: "unsafe",
        execute: async (args, api) => {
          const done = await edge.runPromise(act(host, args, chat(String(api.conversationId))));

          return isRefusal(done) ? reply(done.refused, true) : reply(done.text);
        }
      })
    ]
  });
}
