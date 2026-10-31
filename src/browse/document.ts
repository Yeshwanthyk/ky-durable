import type { PageRead } from "./contract";

/** What the browse tool reads from a page, run inside it by `page.evaluate`: so it imports nothing but types. */
export function readDocument(maxLinks: number): PageRead {
  const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
    .flatMap((a) => {
      const text = (a.textContent ?? "").trim().replace(/\s+/g, " ");

      return text && a.href.startsWith("http") ? [{ text, href: a.href }] : [];
    })
    .slice(0, maxLinks);

  const headings = [...document.querySelectorAll<HTMLElement>("h1, h2, h3")].flatMap((heading) => {
    const text = heading.innerText.trim().replace(/\s+/g, " ");

    return text ? [{ level: Number(heading.tagName.slice(1)), text }] : [];
  });

  const body = document.body;

  if (!body) return { title: document.title, text: "", links, headings };
  const all = body.innerText;

  const largest = [...document.querySelectorAll<HTMLElement>("main, article, [role=main]")]
    .flatMap((element) =>
      element.checkVisibility({ visibilityProperty: true }) ||
      (getComputedStyle(element).display === "contents" && element.parentElement?.checkVisibility({ visibilityProperty: true }) === true)
        ? [{ element, length: element.innerText.length }]
        : []
    )
    .sort((a, b) => b.length - a.length)[0];

  const root = largest && largest.length >= all.length * 0.4 ? largest.element : body;
  const copy = root.cloneNode(true);

  if (!(copy instanceof HTMLElement)) return { title: document.title, text: all, links, headings };

  copy
    .querySelectorAll(
      "nav, header:not(article header), footer, aside, iframe, video, audio, [role=navigation], [role=banner], " +
        "[role=contentinfo], [aria-hidden=true], [id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i]"
    )
    .forEach((element) => element.remove());

  copy.style.cssText = `position: fixed; top: 0; left: -100000px; width: ${root.clientWidth || document.documentElement.clientWidth}px`;
  body.appendChild(copy);
  let text = "";

  try {
    text = copy.innerText.replace(/\n{3,}/g, "\n\n").trim();
  } finally {
    copy.remove();
  }

  return { title: document.title, text: text.length < 200 ? all : text, links, headings };
}
