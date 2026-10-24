import { afterEach, describe, expect, it, vi } from "vitest";
import { keepShots, pdfReply, reached } from "../browse";

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

const text = (result: { output?: Array<{ type: string; text?: string }> }) => (result.output ?? []).map((part) => part.text).join("\n");

const MB = 1024 * 1024;

/** The browser's response for a PDF it showed: `bytes`, declared as `length` bytes (none when null), sent in `encoding`. */
function shown(bytes: Uint8Array, length: number | null = bytes.length, encoding = "identity") {
  const type = { "content-type": "application/pdf", "content-encoding": encoding };
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

  it("keeps long text whole past the old 20,000 characters, for guardrails to spill", async () => {
    const page = Array.from({ length: 60 }, () => "word ".repeat(15).trim()).join("\n");
    const result = await pdfReply("https://example.com/long.pdf", shown(pdf(Array.from({ length: 40 }, () => page))), plain, live());

    expect(text(result)).toMatch(/\(PDF, 40 pages\)\n\n[word \n]{170000,}$/);
    expect(text(result)).not.toContain("[cut at");
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
      output: [{ type: "text", text: "https://example.com/report.pdf downloads a file that is neither a page nor a PDF, so browse can't read it." }],
      isError: true
    });
  });

  it("refuses a PDF over 15 MB", async () => {
    const huge = new Uint8Array(16 * MB);
    huge.set(new TextEncoder().encode("%PDF-1.7"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(huge));

    const result = await pdfReply("https://example.com/huge.pdf", null, plain, live());

    expect(result).toEqual({
      output: [{ type: "text", text: "https://example.com/huge.pdf is a PDF over 15 MB, too large to read." }],
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

  it("downloads a compressed PDF itself, since its length counts the compressed bytes", async () => {
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array(16 * MB)));
    const gzipped = shown(new Uint8Array(), MB, "gzip");

    expect(text(await pdfReply("https://example.com/huge.pdf", gzipped, plain, live()))).toContain("is a PDF over 15 MB");
    expect(gzipped.body).not.toHaveBeenCalled();
    expect(fetched).toHaveBeenCalled();
  });

  it("stops downloading at the first bytes of a large file that isn't a PDF", async () => {
    let pulled = 0;

    const zip = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode(`PK${"x".repeat(MB)}`));
      }
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(zip, { headers: { "content-type": "application/zip" } }));

    expect(text(await pdfReply("https://example.com/archive", null, plain, live()))).toBe(
      "https://example.com/archive downloads a file that is neither a page nor a PDF, so browse can't read it."
    );
    expect(pulled).toBeLessThan(4);
  });

  it("says a page whose navigation the browser aborted was aborted, not a download", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>hi</html>", { headers: { "content-type": "text/html" } }));

    expect(text(await pdfReply("https://example.com/page", null, plain, live()))).toBe(
      "https://example.com/page aborted its navigation in the browser, so browse can't read it."
    );
  });

  it("says when the URL answers with nothing to read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    expect(text(await pdfReply("https://example.com/empty", null, plain, live()))).toBe("https://example.com/empty answered HTTP 204 with nothing to read.");
  });

  it("stops reading a PDF when the call is stopped", async () => {
    const stop = new AbortController();
    stop.abort(new Error("the browse call was stopped"));

    await expect(pdfReply("https://example.com/report.pdf", shown(pdf(["Words"])), plain, stop.signal)).rejects.toThrow("the browse call was stopped");
  });
});

describe("a screenshot", () => {
  const shot = { type: "image" as const, data: btoa("png bytes"), mimeType: "image/png" };

  it("is saved as a file, its id named after it, and still read", async () => {
    const saved: string[] = [];

    const save = async (png: Uint8Array) => {
      saved.push(new TextDecoder().decode(png));

      return "0123456789abcdef0123456789abcdef";
    };

    const result = await keepShots({ output: [{ type: "text", text: "Page" }, shot], isError: false }, save);

    expect(saved).toEqual(["png bytes"]);
    expect(result.output?.map((part) => part.type)).toEqual(["text", "image", "text"]);
    const note = result.output?.[2];
    expect(note?.type === "text" ? note.text : "").toContain("file 0123456789abcdef0123456789abcdef");
  });

  it("is still read when it could not be saved", async () => {
    const result = await keepShots({ output: [shot], isError: false }, () => Promise.reject(new Error("bucket down")));

    expect(result.output).toEqual([shot]);
  });
});
