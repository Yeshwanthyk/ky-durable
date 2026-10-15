import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseOr } from "../../src/core/decode";
import { AnswerBody, AskBody, PairBody, Paired, PEER_TOOL, PEER_TOOLS, PEERS_TABLES, Responders } from "../../src/peers/contract";

/** The peers domain's contract: its tables, its stored JSON, its tool allowlist, and the replies it takes from other kys. */

const SRC = path.join(import.meta.dirname, "../../src");

/** The domain's files, but its contract, by name. */
const domainFiles = () => readdirSync(path.join(SRC, "peers")).filter((file) => file !== "contract.ts").map((file) => [file, readFileSync(path.join(SRC, "peers", file), "utf8")] as const);

describe("the peers domain's tables", () => {
  it("keep the names a backup restores them by", () => {
    // A backup restores each table through ky_restore__<table>, by name: these never change.
    expect(PEERS_TABLES).toEqual({
      peers: "ky_peers",
      asks: "ky_peer_asks",
      chatMembers: "ky_chat_members",
      seats: "ky_specialist_seats",
      groupMessages: "ky_group_messages"
    });
  });

  it("are named only in the contract, made only if not there, and never dropped or altered", () => {
    for (const [file, text] of domainFiles()) {
      expect(text.match(/\bky_[a-z_]+\b/g) ?? [], file).toEqual([]);
      expect(text, file).not.toMatch(/\b(DROP|ALTER)\s+TABLE\b/i);
      expect(text, file).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    }

    // src/tests/peers.test.ts checks each is there on a started Durable Object.
    const made = domainFiles().flatMap(([, text]) => [...text.matchAll(/CREATE TABLE IF NOT EXISTS \$\{(\w+)\}/g)].map((match) => match[1]));
    expect(made).toHaveLength(Object.keys(PEERS_TABLES).length);
  });
});

describe("the JSON columns the peers domain keeps", () => {
  it.each(["{", "null", `{"to":["a"]}`, "[1,2]", ""])("reads a corrupt ky_group_messages.responders %j as no responders", (corrupt) => {
    // GroupChats.decided reads the column this way; src/tests/peers.test.ts checks it on a Durable Object.
    expect(parseOr(Responders, corrupt, [])).toEqual([]);
  });

  it("are only ky_group_messages.responders: no other column is parsed as JSON", () => {
    const parsed = domainFiles().flatMap(([, text]) => [...text.matchAll(/parse(?:Or|As)\((\w+),/g)].map((match) => match[1]));

    expect(new Set(parsed)).toEqual(new Set(["Responders", "PairBody", "Paired", "schema"]));
  });
});

/**
 * Every tool name ky defines, read from its sources: each `defineTool({ name: ... })`, as a string or
 * as a constant a contract names (`export const MEMORY_NOTE = "memory_note"`), or as a key of a contract's
 * names object (`TOOLS.skillView`, from `skillView: "skill_view"`).
 */
function registeredTools(): Set<string> {
  const texts: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);

      if (entry.isDirectory() && entry.name !== "tests") walk(at);
      else if (entry.name.endsWith(".ts")) texts.push(readFileSync(at, "utf8"));
    }
  };

  walk(SRC);

  const named = (pattern: RegExp) => new Map(texts.flatMap((text) => [...text.matchAll(pattern)].map(([, key = "", value = ""]) => [key, value] as const)));

  const constants = named(/export const ([A-Z_]+) = "([a-z_]+)"/g);

  const keys = named(/\b([a-z][A-Za-z]+): "([a-z]+_[a-z_]+)"/g);

  return new Set(
    texts.flatMap((text) =>
      [...text.matchAll(/defineTool\(\{\s*name:\s*(?:"([a-z_]+)"|[A-Z_]+\.(\w+)|([A-Z_]+))/g)].map(
        ([, literal, key, constant]) => literal ?? keys.get(key ?? "") ?? constants.get(constant ?? "") ?? ""
      )
    )
  );
}

describe("the tools a peer conversation may call", () => {
  it("are all tools ky registers", () => {
    const registered = registeredTools();

    expect(registered.size).toBeGreaterThan(5);
    expect(PEER_TOOLS.filter((name) => !registered.has(name))).toEqual([]);
  });

  it("name the peer tool as it is registered", () => {
    expect(readFileSync(path.join(SRC, "peers/peers.ts"), "utf8")).toMatch(/defineTool\(\{\s*name: PEER_TOOL,/);
    expect(PEER_TOOL).toBe("peer");
  });
});

describe("what another ky sends", () => {
  it.each([
    ["a pairing answer without a token", Paired, `{}`],
    ["a pairing answer with a short token", Paired, `{"token":"abc"}`],
    ["a pairing answer that isn't JSON", Paired, "<html>"],
    ["a pairing with no code", PairBody, `{"address":"https://a.test","token":"${"0".repeat(64)}"}`],
    ["an empty question", AskBody, `{"id":"q","question":""}`],
    ["a question without an id", AskBody, `{"question":"hi?"}`],
    ["an answer too long", AnswerBody, JSON.stringify({ id: "q", answer: "x".repeat(8_001) })],
    ["an answer that isn't text", AnswerBody, `{"id":"q","answer":7}`]
  ])("refuses %s", (_what, schema, body) => {
    expect(parseOr(schema, body, "refused")).toBe("refused");
  });

  it("takes one that fits", () => {
    expect(parseOr(Paired, JSON.stringify({ token: "a".repeat(64) }), null)).toEqual({ token: "a".repeat(64) });
    expect(parseOr(AnswerBody, `{"id":"q","answer":""}`, null)).toEqual({ id: "q", answer: "" });
  });
});
