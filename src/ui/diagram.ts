import type { RenderOptions } from "pele/lazy";

/**
 * A ```mermaid fence, drawn by pele (pele.run): flowcharts, sequences, timelines, gantt, and pie and xy charts
 * as SVG in ky's own page. Its source is the model's text, so options never come from it: no images, so a
 * diagram fetches nothing; links only to https; and the SVG passes `clean` before it goes in. Words treats a
 * plugin's HTML as trusted, so `clean` is the only lock between pele's output and the page.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** What a diagram never needs: script, embedded HTML, and anything that loads another document. */
const DROPPED = new Set(["script", "foreignObject", "iframe", "object", "embed", "image"]);

/** A diagram's link goes to an https page or a spot in the diagram, nowhere else. */
const safeHref = (value: string) => value.startsWith("#") || /^https:\/\//i.test(value);

/** pele escapes text and filters links itself; this is the second lock pele's security page asks for. */
function clean(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;

  if (root.namespaceURI !== SVG_NS || root.localName !== "svg") return "";

  for (const element of [root, ...root.querySelectorAll("*")]) {
    if (DROPPED.has(element.localName) || element.namespaceURI !== SVG_NS) {
      element.remove();
      continue;
    }

    // A list of names, not the live attribute map, so removing one doesn't skip the next.
    for (const name of element.getAttributeNames()) {
      const href = name === "href" || name === "xlink:href";

      if (name.toLowerCase().startsWith("on") || (href && !safeHref(element.getAttribute(name) ?? ""))) element.removeAttribute(name);
    }
  }

  return new XMLSerializer().serializeToString(root);
}

const OPTIONS: RenderOptions = { fontSize: 14, images: false, linkSchemes: ["https"], linkRel: "noopener noreferrer" };

type Pele = typeof import("pele/lazy");

let pele: Pele | undefined;

let loading: Promise<Pele> | undefined;

/** Not drawable yet: pele, or this diagram type's code, is still loading. Words then shows the fence as code. */
class NotLoaded extends Error {}

/**
 * The renderer `createMermaidPlugin` calls. It must answer synchronously, so the first fence of a type
 * throws while that type's code loads, and `ready` asks Markdown to render again once it has.
 */
export function diagrams(ready: () => void) {
  return {
    render(source: string) {
      if (!pele) {
        loading ??= import("pele/lazy").then((loaded) => (pele = loaded));
        loading.then(ready, () => (loading = undefined));
        throw new NotLoaded();
      }

      const type = pele.detectType(source);

      if (type && !pele.registered(type)) {
        pele.load(type).then(ready, () => {});
        throw new NotLoaded();
      }

      const svg = clean(pele.render(source, OPTIONS).svg);

      if (!svg) throw new Error("pele drew no SVG");

      return { svg: `<div class="pele diagram" role="img" aria-label="Diagram">${svg}</div>` };
    }
  };
}
