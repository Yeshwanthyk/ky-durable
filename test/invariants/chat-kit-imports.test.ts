import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

/**
 * The chat kit (src/chat-kit) is a chat's look on its own: it imports react, react-dom and itself, and what is ky's
 * (Markdown, cards, avatars, files) plugs in through its props. Fallow's boundaries keep it out of the rest of the repo
 * (.fallowrc.json); this keeps it off every package but React.
 */
const KIT = path.join(import.meta.dirname, "../../src/chat-kit");

const PACKAGES = new Set(["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);

/** A sibling in the kit, or React. */
const stays = (specifier: string) => (specifier.startsWith(".") ? specifier.startsWith("./") && !specifier.includes("/..") : PACKAGES.has(specifier));

const files = () => readdirSync(KIT).filter((name) => /\.(tsx?|css)$/.test(name));

/** Each import that leaves the kit, as `file → specifier`. */
function leaving(): string[] {
  return files().flatMap((name) => {
    const text = readFileSync(path.join(KIT, name), "utf8");
    const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"|@import\s+(?:url\()?"([^"]+)"/g)].map(([, js, css]) => js ?? css ?? "");

    return specifiers.flatMap((specifier) => (stays(specifier) ? [] : [`${name} → ${specifier}`]));
  });
}

it("finds the kit's files", () => {
  expect(files()).toEqual(expect.arrayContaining(["Composer.tsx", "Thread.tsx", "ToolRow.tsx", "Icon.tsx", "chat.css"]));
});

it("imports only react, react-dom and itself", () => {
  expect(leaving()).toEqual([]);
});
