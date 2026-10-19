import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDocument } from "../../src/browse";

/**
 * What the browse tool reads from a page (src/browse.ts `readDocument`), run in real Chromium as
 * Kitesurf runs it: innerText follows the layout, which no fake DOM does.
 */

const CHROME = `
  <header>Site header</header>
  <nav><a href="https://example.com/home">Home</a> <a href="https://example.com/about">About</a></nav>
  <div id="cookie-banner">We use cookies. Accept all?</div>
  <aside>Related sidebar</aside>
  <footer>Footer links</footer>`;

const paragraphs = (count: number) =>
  Array.from({ length: count }, (_, index) => `<p>Paragraph ${index + 1} of the story, long enough to be the content of the page.</p>`).join("");

let browser: Browser;

let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(() => browser.close());

async function read(html: string) {
  await page.setContent(`<html><head><title>A page</title></head><body>${html}</body></html>`);

  return page.evaluate(readDocument, 60);
}

describe("browse reads a page's main content", () => {
  it("reads the article without the navigation, header, footer, sidebar or cookie banner", async () => {
    const result = await read(`${CHROME}<article><h1>The story</h1>${paragraphs(10)}<footer>Article byline</footer></article>`);

    expect(result.text).toMatch(/^The story\n\nParagraph 1 of the story/);
    expect(result.text).toContain("Paragraph 10 of the story");
    expect(result.text).not.toMatch(/Site header|Home|cookies|sidebar|Footer links|byline/);
    expect(result.links).toEqual([
      { text: "Home", href: "https://example.com/home" },
      { text: "About", href: "https://example.com/about" }
    ]);
    // The live page keeps its chrome, for the screenshot taken after.
    expect(await page.evaluate(() => document.body.innerText)).toContain("We use cookies");
  });

  it("reads the body without its chrome when there is no main or article", async () => {
    const result = await read(`${CHROME}<div>${paragraphs(4)}</div>`);

    expect(result.text).toMatch(/^Paragraph 1 of the story.*\n\n.*\n\n.*\n\nParagraph 4 of the story[^\n]*$/);
  });

  it("keeps the article's own header, where its headline is", async () => {
    const result = await read(`${CHROME}<article><header><h1>The headline</h1></header>${paragraphs(10)}</article>`);

    expect(result.text).toMatch(/^The headline\n\nParagraph 1 of the story/);
    expect(result.text).not.toContain("Site header");
  });

  it("reads the article with the most text when there are several", async () => {
    const result = await read(`${CHROME}<article><p>A teaser for another story.</p></article><article><h1>The story</h1>${paragraphs(10)}</article>`);

    expect(result.text).toMatch(/^The story\n\nParagraph 1 of the story/);
    expect(result.text).not.toContain("teaser");
  });

  it("reads the body when the largest article holds little of the page", async () => {
    const result = await read(`${CHROME}<article><h1>A side story</h1>${paragraphs(6)}</article><div>${paragraphs(12)}</div>`);

    expect(result.text).toMatch(/^A side story\n\n/);
    expect(result.text).toContain("Paragraph 12 of the story");
    expect(result.text).not.toMatch(/Site header|cookies|Footer links/);
  });

  it("passes over a hidden article", async () => {
    const hidden = Array.from({ length: 20 }, () => "<p>Hidden text that is not on the screen.</p>").join("");
    const result = await read(`${CHROME}<article hidden>${hidden}</article><main><h1>The story</h1>${paragraphs(10)}</main>`);

    expect(result.text).toMatch(/^The story\n\nParagraph 1 of the story/);
    expect(result.text).not.toContain("Hidden text");
  });

  it("passes over a display: contents main inside a hidden element", async () => {
    const hidden = Array.from({ length: 20 }, () => "<p>Hidden text that is not on the screen.</p>").join("");
    const result = await read(`${CHROME}<div hidden><main style="display: contents">${hidden}</main></div><article><h1>The story</h1>${paragraphs(10)}</article>`);

    expect(result.text).toMatch(/^The story\n\nParagraph 1 of the story/);
    expect(result.text).not.toContain("Hidden text");
  });

  it("reads a main laid out with display: contents line by line", async () => {
    const result = await read(`${CHROME}<main style="display: contents"><h1>The story</h1>${paragraphs(10)}</main>`);

    expect(result.text).toMatch(/^The story\n\nParagraph 1 of the story[^\n]*\n\nParagraph 2/);
  });

  it("reads the whole body when the page is mostly chrome", async () => {
    const result = await read(`${CHROME}<p>Short note.</p>`);

    expect(result.text).toContain("Site header");
    expect(result.text).toContain("Short note.");
  });
});
