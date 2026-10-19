import type { RenderOptions } from "pele/lazy";
import { useEffect, useRef, useState } from "react";

/**
 * A ```mermaid fence, drawn by pele (pele.run): flowcharts, sequences, timelines, gantt, and pie and xy charts
 * as SVG in ky's own page. Its source is the model's text, so options never come from it: no images, so a
 * diagram fetches nothing; links only to https; and the SVG passes `clean` before it goes in. Each diagram
 * type's code loads with the first diagram of that type.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** What a diagram never needs: script, embedded HTML, and anything that loads another document. */
const DROPPED = new Set(["script", "foreignObject", "iframe", "object", "embed", "image"]);

/** A diagram's link goes to an https page or a spot in the diagram, nowhere else. */
const safeHref = (value: string) => value.startsWith("#") || /^https:\/\//i.test(value);

/** pele escapes text and filters links itself; this is the second lock pele's security page asks for. */
function clean(svg: string): Node {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;

  if (root.namespaceURI !== SVG_NS || root.localName !== "svg") return document.createTextNode("");

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

  return document.importNode(root, true);
}

const OPTIONS: RenderOptions = { fontSize: 14, images: false, linkSchemes: ["https"], linkRel: "noopener noreferrer" };

/**
 * Streamdown's custom renderer for the fence. While the fence is still streaming, or while pele can't draw its
 * latest source, it reads as code. Only the latest source's drawing goes in: one that finishes after a newer
 * source arrived is dropped, so a half-streamed fence never replaces the finished one.
 */
export function Diagram({ code, isIncomplete }: { code: string; isIncomplete: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const element = box.current;

    if (isIncomplete || !element) return;
    let latest = true;

    void import("pele/lazy")
      .then(({ renderAsync }) => renderAsync(code, { ...OPTIONS, maxWidth: element.clientWidth || undefined }))
      .then(
        ({ svg }) => {
          if (!latest) return;
          element.replaceChildren(clean(svg));
          setDrawn(true);
        },
        () => latest && setDrawn(false)
      );

    return () => {
      latest = false;
    };
  }, [code, isIncomplete]);

  const shown = drawn && !isIncomplete;

  // The box stays in the layout while hidden, so it has a width to draw to.
  return (
    <>
      <div ref={box} className="pele diagram" role="img" aria-label="Diagram" data-drawn={shown || undefined} aria-hidden={!shown} />
      {shown ? null : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </>
  );
}
