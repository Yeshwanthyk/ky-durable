import { afterEach, describe, expect, it, vi } from "vitest";
import { pdfReply, reached } from "../browse";

/**
 * The browse tool's PDF reply (src/browse.ts), on the Worker runtime unpdf runs on: what counts as a PDF,
 * the text, title and page count of one the browser showed or downloaded, and the 15 MB cap.
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

const MB = 1024 * 1024;

/** The browser's response for a PDF it showed: `bytes`, declared as `length` bytes, or with no size when null. */
function shown(bytes: Uint8Array, length: number | null = bytes.length) {
  const type = { "content-type": "application/pdf" };
  const headers = length === null ? type : { ...type, "content-length": String(length) };
  const body = vi.fn(async () => bytes);

  return { headers: () => headers, body };
}

const plain = { url: "" };

const live = () => new AbortController().signal;

afterEach(() => vi.restoreAllMocks());

describe("what a navigation reached", () => {
  it("is a PDF by its content type or its first bytes, and otherwise the page, or a file it downloaded", () => {
    const magic = new TextEncoder().encode("%PDF-1.7");
    const html = new TextEncoder().encode("<html>");

    expect(reached(false, "application/pdf; charset=binary")).toBe("pdf");
    expect(reached(false, "text/html")).toBe("page");
    expect(reached(false, undefined)).toBe("page");
    expect(reached(true, "application/octet-stream", magic)).toBe("pdf");
    expect(reached(true, "application/octet-stream", html)).toBe("file");
    expect(reached(true, undefined, new Uint8Array())).toBe("file");
  });
});

describe("browse reads a PDF", () => {
  it("returns its title, page count and text", async () => {
    const url = "https://example.com/papers/report.pdf";
    const result = await pdfReply(url, shown(pdf(["First page words", "Second page words"], "Quarterly report")), plain, live());

    expect(result.isError).toBe(false);
    expect(text(result)).toBe("Quarterly report\nhttps://example.com/papers/report.pdf (PDF, 2 pages)\n\nFirst page words\nSecond page words");
  });

  it("is titled by its file name when it has no title, and says steps and screenshot were skipped", async () => {
    const result = await pdfReply("https://example.com/papers/notes.pdf", shown(pdf(["Only page"])), { url: "", screenshot: true }, live());

    expect(text(result)).toBe(
      "notes.pdf\nhttps://example.com/papers/notes.pdf (PDF, 1 page)\n\n" +
        "Steps and screenshot don't apply to a PDF, so they were skipped.\n\nOnly page"
    );
  });

  it("cuts long text with the same note as a page", async () => {
    const page = Array.from({ length: 60 }, () => "word ".repeat(15).trim()).join("\n");
    const result = await pdfReply("https://example.com/long.pdf", shown(pdf(Array.from({ length: 40 }, () => page))), plain, live());

    expect(text(result)).toMatch(/\(PDF, 40 pages\)\n\n[word \n]{20000}\n\[cut at 20000 characters\]$/);
  });

  it("downloads a PDF the browser downloaded instead of showing, and knows it by its first bytes", async () => {
    const file = new Response(pdf(["Fetched words"], "Fetched"), { headers: { "content-type": "application/octet-stream" } });
    const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(file);
    const signal = live();

    const result = await pdfReply("https://example.com/download?id=7", null, plain, signal);

    expect(fetched).toHaveBeenCalledWith("https://example.com/download?id=7", expect.objectContaining({ signal }));
    expect(text(result)).toBe("Fetched\nhttps://example.com/download?id=7 (PDF, 1 page)\n\nFetched words");
  });

  it("says so when the browser downloaded a file that isn't a PDF", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("PK zip bytes", { headers: { "content-type": "application/zip" } }));

    const result = await pdfReply("https://example.com/report.pdf", null, plain, live());

    expect(result).toEqual({
      content: [{ type: "text", text: "https://example.com/report.pdf downloads a file that is neither a page nor a PDF, so browse can't read it." }],
      isError: true
    });
  });

  it("refuses a PDF over 15 MB", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array(16 * MB)));

    const result = await pdfReply("https://example.com/huge.pdf", null, plain, live());

    expect(result).toEqual({
      content: [{ type: "text", text: "https://example.com/huge.pdf is a PDF over 15 MB, too large to read." }],
      isError: true
    });
  });

  it("never takes the browser's copy of a PDF over 15 MB, or of one with no size, into memory", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array(16 * MB)));
    const large = shown(new Uint8Array(), 16 * MB);
    const unsized = shown(new Uint8Array(), null);

    expect(text(await pdfReply("https://example.com/huge.pdf", large, plain, live()))).toContain("is a PDF over 15 MB");
    expect(text(await pdfReply("https://example.com/huge.pdf", unsized, plain, live()))).toContain("is a PDF over 15 MB");
    expect(large.body).not.toHaveBeenCalled();
    expect(unsized.body).not.toHaveBeenCalled();
  });
});
