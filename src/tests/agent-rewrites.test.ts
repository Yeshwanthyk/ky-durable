import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_SESSION } from "agents/harness/pi";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { agentModel } from "../providers/contract";
import { agent, connect, inside, prompt, snapshotView } from "./drive";

/**
 * What each chat's agent document stores of its model. Its history is rewindable, so every change stays as a
 * revision for good: a chat stores the slot it follows, `ky/main`, and the model main resolves to is read at each call.
 */

const MAC_UP_KEY = "test:mac-up";

const SLOT = { provider: "ky", modelId: "main" };

/** Every revision of every conversation's agent document. */
function agentRevisions(name: string): Promise<number> {
  return inside(name, (_instance, state) => state.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM pi_document_revisions r JOIN pi_documents d ON d.id = r.document_id WHERE d.kind = '"pi.agent"'`).one().n);
}

/** The Mac's VibeProxy answers again, or stops: only the next probe sees it, as when a Wi-Fi drop ends. */
function macAnswers(name: string, up: boolean): Promise<void> {
  return inside(name, (_instance, state) => state.storage.put(MAC_UP_KEY, up));
}

/** Start the object over, as a deploy or an eviction does. */
async function restart(name: string): Promise<void> {
  await evictDurableObject(agent(name));
  (await connect(name)).close();
}

describe("the chats' model", () => {
  it("stays on the main slot while the Mac blinks, and each call runs on what main is then", async () => {
    const name = crypto.randomUUID();
    await agent(name).mac(true);
    (await connect(name)).close();
    expect((await snapshotView(name)).model).toEqual(SLOT);
    const before = await agentRevisions(name);

    await macAnswers(name, false);
    expect((await prompt(name, "hello")).text).toBe("echo: hello");
    await macAnswers(name, true);
    expect((await prompt(name, "again")).text).toContain("Claude claude-opus-5-5");

    expect(await agentRevisions(name)).toBe(before);
  });

  it("moves a chat from before slots onto the main slot once, then writes nothing on each start", async () => {
    const name = crypto.randomUUID();
    (await connect(name)).close();
    await inside(name, async (instance) => {
      const conversation = await instance.harness.conversation(ROOT_SESSION);
      await conversation.configure(agentModel({ provider: "workers-ai", modelId: "@cf/zai-org/glm-4.7-flash", thinkingLevel: "off" }), BACKGROUND_CONTEXT);
    });
    expect((await snapshotView(name)).model).toMatchObject({ provider: "workers-ai" });

    await restart(name);
    expect((await snapshotView(name)).model).toEqual(SLOT);
    const migrated = await agentRevisions(name);

    await restart(name);
    expect(await agentRevisions(name)).toBe(migrated);
    expect((await prompt(name, "hello")).text).toBe("echo: hello");
  });
});
