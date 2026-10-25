/**
 * `node --experimental-strip-types test/visual/diff.ts <a> <b> [--threshold 0.0001]`: compares two sets of
 * screenshots test/visual/capture.ts wrote, page by page, and exits 1 when any page differs too much.
 *
 * `a` and `b` are labels under test-results/visual/, or directories. A page's ratio is the share of its
 * pixels whose colour differs, by more than TOLERANCE in some channel; it is over when the ratio is above the threshold, or when the
 * page is missing from one set or changed size. Each page with a difference gets a diff PNG under
 * test-results/visual/diff/: `a` faded, the differing pixels red. Everything lands in
 * test-results/visual/report.json as [{ page, ratio, over }].
 *
 * The pixels are compared in Chromium's canvas, which Playwright already ships, so it needs no image
 * library of its own.
 */
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO } from "../harness/stack.ts";

type Row = { readonly page: string; readonly ratio: number; readonly over: boolean; readonly note?: string };

const ROOT = path.join(REPO, "test-results/visual");

/**
 * How far a channel (0 to 255) may move before its pixel counts as changed. Two runs of one commit
 * still differ by 1 on a few anti-aliased edges (the composer's + button); a change anyone could see
 * moves far more.
 */
const TOLERANCE = 2;

const setOf = (arg: string) => (existsSync(path.join(ROOT, arg)) ? path.join(ROOT, arg) : path.resolve(arg));

const pngs = (dir: string) => readdirSync(dir).filter((file) => file.endsWith(".png"));

/** In the page: the share of pixels that differ, and a data URL of the diff image when any do. */
async function compare({ a, b, tolerance }: { a: string; b: string; tolerance: number }): Promise<{ ratio: number; size: boolean; image: string | null }> {
  const decode = async (url: string) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });

    if (context === null) throw new Error("No 2d canvas");
    context.drawImage(bitmap, 0, 0);

    return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
  };

  const [left, right] = await Promise.all([decode(a), decode(b)]);

  if (left.width !== right.width || left.height !== right.height) return { ratio: 1, size: false, image: null };
  const out = new ImageData(left.width, left.height);
  let differ = 0;

  for (let at = 0; at < left.data.length; at += 4) {
    let same = true;

    for (let channel = at; channel < at + 4; channel += 1) {
      if (Math.abs((left.data[channel] ?? 0) - (right.data[channel] ?? 0)) > tolerance) same = false;
    }

    if (same) {
      // The unchanged page, faded toward white, so the red reads against it.
      const grey = ((left.data[at] ?? 0) + (left.data[at + 1] ?? 0) + (left.data[at + 2] ?? 0)) / 3;
      out.data.fill(Math.round(255 - (255 - grey) * 0.25), at, at + 3);
    } else {
      differ += 1;
      out.data.set([255, 0, 0], at);
    }

    out.data[at + 3] = 255;
  }

  if (differ === 0) return { ratio: 0, size: true, image: null };
  const canvas = new OffscreenCanvas(left.width, left.height);
  canvas.getContext("2d")?.putImageData(out, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return { ratio: differ / (left.width * left.height), size: true, image: btoa(binary) };
}

/** Compare every page in either set; the rows, in page order. */
export async function diff(a: string, b: string, threshold: number): Promise<Row[]> {
  const [left, right] = [setOf(a), setOf(b)];
  const out = path.join(ROOT, "diff");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const pages = [...new Set([...pngs(left), ...pngs(right)])].sort();
  const browser = await chromium.launch();
  const rows: Row[] = [];

  try {
    const page = await browser.newPage();
    const url = (file: string) => `data:image/png;base64,${readFileSync(file, "base64")}`;

    for (const file of pages) {
      const name = file.replace(/\.png$/, "");
      const [x, y] = [path.join(left, file), path.join(right, file)];

      if (!existsSync(x) || !existsSync(y)) {
        rows.push({ page: name, ratio: 1, over: true, note: `only in ${existsSync(x) ? a : b}` });
        continue;
      }

      const { ratio, size, image } = await page.evaluate(compare, { a: url(x), b: url(y), tolerance: TOLERANCE });

      if (image !== null) writeFileSync(path.join(out, file), Buffer.from(image, "base64"));
      const row: Row = { page: name, ratio, over: ratio > threshold };
      rows.push(size ? row : { ...row, note: "sizes differ" });
    }
  } finally {
    await browser.close();
  }

  writeFileSync(path.join(ROOT, "report.json"), `${JSON.stringify(rows, null, 2)}\n`);

  return rows;
}

/** Print a line a page and the verdict; the exit code, 1 when any page is over. */
export function print(rows: readonly Row[], title: string, threshold: number): number {
  for (const row of rows) console.log(`${row.over ? "OVER" : "ok  "} ${row.page.padEnd(16)} ${(row.ratio * 100).toFixed(4)}%${row.note === undefined ? "" : ` (${row.note})`}`);
  const over = rows.filter((row) => row.over);
  console.log(over.length === 0 ? `${title}: ${rows.length} pages, none over ${threshold}` : `${title}: ${over.length} of ${rows.length} pages over ${threshold}, look at ${over.map((row) => row.page).join(", ")}`);

  return over.length === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf("--threshold");
  const threshold = at === -1 ? 0.0001 : Number(args[at + 1]);
  const [a, b] = args.filter((_, index) => at === -1 || (index !== at && index !== at + 1));

  if (a === undefined || b === undefined || !Number.isFinite(threshold)) throw new Error("Usage: diff.ts <a> <b> [--threshold 0.0001]");
  process.exitCode = print(await diff(a, b, threshold), `${a} vs ${b}`, threshold);
}

if (import.meta.filename === process.argv[1]) await main();
