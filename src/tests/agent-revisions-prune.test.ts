import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import { agentModel } from "../providers/contract";
import { pruneAgentRevisions } from "../revisions";
import { connect, inside, prompt } from "./drive";

/**
 * The agent documents' revisions no rewind or fork can read are deleted once: what each entry reads of its
 * conversation's agent document stays the same, and the newest revision stays.
 */

const GLM = { provider: "workers-ai", modelId: "workers-ai/@cf/zai-org/glm-5.3-flash", thinkingLevel: "off" } as const;

const GPT_OSS = { provider: "workers-ai", modelId: "workers-ai/@cf/openai/gpt-oss-120b", thinkingLevel: "off" } as const;

const AGENT_KIND = '"pi.agent"';

/** Every agent document's revision count, and what each entry reads of its conversation's agent document. */
function snapshot(name: string): Promise<{ revisions: number; reads: string[]; newest: string[] }> {
  return inside(name, (_instance, state) => {
    const sql = state.storage.sql;
    const revisions = sql.exec<{ n: number }>("SELECT count(*) AS n FROM pi_document_revisions r JOIN pi_documents d ON d.id = r.document_id WHERE d.kind = ?", AGENT_KIND).one().n;

    // pi-durable reads a document as of a seq: its newest base at or before it.
    const reads = sql
      .exec<{ read: string }>(
        `SELECT e.id || ':' || d.id || ':' || coalesce((SELECT r.content FROM pi_document_revisions r WHERE r.document_id = d.id AND r.kind = 'base' AND r.seq <= e.commit_seq ORDER BY r.seq DESC LIMIT 1), '-') AS read
         FROM pi_entries e JOIN pi_documents d ON d.kind = ? ORDER BY e.id, d.id`,
        AGENT_KIND
      )
      .toArray()
      .map((row) => row.read);

    const newest = sql
      .exec<{ content: string }>("SELECT (SELECT content FROM pi_document_revisions r WHERE r.document_id = d.id ORDER BY seq DESC LIMIT 1) AS content FROM pi_documents d WHERE d.kind = ? ORDER BY d.id", AGENT_KIND)
      .toArray()
      .map((row) => row.content);

    return { revisions, reads, newest };
  });
}

/** Move the main conversation's model `times` times, as a blinking provider did before slots. */
function flip(name: string, times: number): Promise<void> {
  return inside(name, async (instance) => {
    const conversation = await instance.harness.conversation(ROOT_SESSION);

    for (let index = 0; index < times; index++) {
      await conversation.configure(agentModel(index % 2 === 0 ? GPT_OSS : GLM), BACKGROUND_CONTEXT);
    }
  });
}

/** Prune as a start does, but again: the first start already did, on an empty ky. */
function prune(name: string): Promise<void> {
  return inside(name, async (_instance, state) => {
    await state.storage.delete("ky:agent-revisions-pruned");
    await pruneAgentRevisions(state.storage);
  });
}

describe("pruning the agent documents' revisions", () => {
  it("deletes the ones no entry reads, and every entry reads what it did", async () => {
    const name = crypto.randomUUID();
    (await connect(name)).close();
    await flip(name, 6);
    await prompt(name, "one");
    await flip(name, 7);
    await prompt(name, "two");
    await flip(name, 5);
    const before = await snapshot(name);

    await prune(name);
    const after = await snapshot(name);

    expect(after.revisions).toBe(before.revisions - 15);
    expect(after.reads).toEqual(before.reads);
    expect(after.newest).toEqual(before.newest);
    expect((await prompt(name, "three")).text).toBe("echo: three");
  });

  it("runs once", async () => {
    const name = crypto.randomUUID();
    (await connect(name)).close();
    await prompt(name, "one");
    await flip(name, 4);
    const before = await snapshot(name);

    await inside(name, (_instance, state) => pruneAgentRevisions(state.storage));
    expect((await snapshot(name)).revisions).toBe(before.revisions);
  });
});
