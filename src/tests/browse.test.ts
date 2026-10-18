import { afterEach, describe, expect, it, vi } from "vitest";
import { readPdf } from "../browse";

/**
 * The browse tool's PDF reply (src/browse.ts), on the Worker runtime unpdf runs on: the text, title and
 * page count of a PDF the browser gave or the Worker fetched, and the size cap on the fetch.
 */

/** A PDF with one page per string, each line of it a line of the page, titled `title` when given. */
function pdf(pages: string[], title?: string): Uint8Array<ArrayBuffer> {
  const pageIds = pages.map((_, index) => 4 + index * 2);

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pages.flatMap((text, index) => {
      const stream = `BT /F1 8 Tf 10 TL 36 756 Td ${text.split("\n").map((line) => `(${line}) '`).join(" ")} ET`;

      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
      ];
    }),
    ...(title ? [`<< /Title (${title}) >>`] : [])
  ];

  let body = "%PDF-1.4\n";

  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;

    return offset;
  });

  const xref = body.length;
  const entries = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  const info = title ? ` /Info ${objects.length} 0 R` : "";
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${info} >>\nstartxref\n${xref}\n%%EOF\n`;

  return new TextEncoder().encode(body);
}

const text = (result: { content: Array<{ type: "text"; text: string }> }) => result.content.map((part) => part.text).join("\n");

const live = () => new AbortController().signal;

afterEach(() => vi.restoreAllMocks());

describe("browse reads a PDF", () => {
  it("returns its title, page count and text", async () => {
    const result = await readPdf("https://example.com/papers/report.pdf", pdf(["First page words", "Second page words"], "Quarterly report"), false, live());

    expect(result.isError).toBe(false);
    expect(text(result)).toBe("Quarterly report\nhttps://example.com/papers/report.pdf (PDF, 2 pages)\n\nFirst page words\nSecond page words");
  });

  it("is titled by its file name when it has no title, and says steps and screenshot were skipped", async () => {
    const result = await readPdf("https://example.com/papers/notes.pdf", pdf(["Only page"]), true, live());

    expect(text(result)).toBe(
      "notes.pdf\nhttps://example.com/papers/notes.pdf (PDF, 1 page)\n\n" +
        "Steps and screenshot don't apply to a PDF, so they were skipped.\n\nOnly page"
    );
  });

  it("cuts long text with the same note as a page", async () => {
    const page = Array.from({ length: 60 }, () => "word ".repeat(15).trim()).join("\n");
    const result = await readPdf("https://example.com/long.pdf", pdf(Array.from({ length: 6 }, () => page)), false, live());

    expect(text(result)).toMatch(/\(PDF, 6 pages\)\n\n[word \n]{20000}\n\[cut at 20000 characters\]$/);
  });

  it("fetches the PDF itself when the browser gives no bytes", async () => {
    const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(pdf(["Fetched words"], "Fetched")));

    const signal = live();
    const result = await readPdf("https://example.com/fetched.pdf", undefined, false, signal);

    expect(fetched).toHaveBeenCalledWith("https://example.com/fetched.pdf", { signal });
    expect(text(result)).toBe("Fetched\nhttps://example.com/fetched.pdf (PDF, 1 page)\n\nFetched words");
  });

  it("refuses a PDF over 15 MB", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array(16 * 1024 * 1024)));

    const result = await readPdf("https://example.com/huge.pdf", undefined, false, live());

    expect(result).toEqual({
      content: [{ type: "text", text: "https://example.com/huge.pdf is a PDF over 15 MB, too large to read." }],
      isError: true
    });
  });
});
