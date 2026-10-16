import { describe, expect, it } from "vitest";
import { type BloubSpec, checkSpec, EXAMPLES, rollSpec } from "../avatar-spec";
import { connect, follow, inside, prompt } from "./drive";
import { FRESH } from "./stack";
import { advance, aim, newMotion, poke, poseOf } from "../ui/bloub-motion";
import { bloubsIn } from "../ui/Bloub";

/** Bloub avatars: the spec check, rolls, the avatar tool through ky's real agent, and the frame the page draws from. */

/** An avatar tool call as the fake model makes it from the user's message. */
type Call = { readonly action: string; readonly for?: string; readonly spec?: BloubSpec; readonly count?: number };

const tool = (args: Call) => `tool avatar ${JSON.stringify(args)}`;

describe("a bloub spec", () => {
  it("keeps the examples as they are", () => {
    for (const spec of Object.values(EXAMPLES)) expect(checkSpec(spec)).toEqual(spec);
  });

  it("pulls sizes into range and refuses parts that aren't on the list", () => {
    const huge = { body: { w: 400, h: 10, corner: 999, color: "#ABCDEF" }, eyes: { count: 2, size: 90 }, top: { kind: "none" }, cheeks: true, feet: false };
    expect(checkSpec(huge)).toEqual({ body: { w: 124, h: 80, corner: 40, color: "#abcdef" }, eyes: { count: 2, size: 18 }, top: { kind: "none" }, cheeks: true, feet: false });

    expect(checkSpec({ ...huge, top: { kind: "horns" } })).toHaveProperty("refused");
    expect(checkSpec({ ...huge, body: { ...huge.body, color: "red" } })).toHaveProperty("refused");
    expect(checkSpec({ ...huge, eyes: { count: 3, size: 10 } })).toHaveProperty("refused");
    expect(checkSpec("<svg onload=alert(1)>")).toHaveProperty("refused");
  });

  it("rolls the same bloub for the same seed, and a valid one for any", () => {
    expect(rollSpec("engineer")).toEqual(rollSpec("engineer"));
    expect(rollSpec("engineer")).not.toEqual(rollSpec("researcher"));

    for (let i = 0; i < 200; i++) {
      const spec = rollSpec(`seed-${i}`);
      expect(checkSpec(spec)).toEqual(spec);
    }
  });
});

describe("a bloub's motion", () => {
  it("is glad of the pointer only at rest, and dizzy after five quick pokes", () => {
    const motion = newMotion("idle", "pip");
    expect(poseOf(motion, "idle", true)).toBe("hover");
    expect(poseOf(motion, "working", true)).toBe("working");

    for (let i = 0; i < 4; i++) poke(motion);
    expect(poseOf(motion, "idle", false)).toBe("idle");
    expect(motion.hearts).toHaveLength(4);

    poke(motion);
    expect(poseOf(motion, "working", false)).toBe("dizzy");

    // It shakes it off, and the hearts float away.
    for (let i = 0; i < 100; i++) advance(motion, poseOf(motion, "idle", false), 0.05);
    expect(poseOf(motion, "idle", false)).toBe("idle");
    expect(motion.hearts).toEqual([]);
    expect(motion.p.squish).toBeLessThan(0.01);
  });

  it("eases toward its mood, and looks toward a far pointer fully, a near one partly", () => {
    const motion = newMotion("idle", "tok");

    for (let i = 0; i < 60; i++) advance(motion, "failed", 1 / 60);
    expect(motion.p.drop).toBeGreaterThan(0.99);
    expect(motion.p.rate).toBe(1.4);

    expect(aim(640, 0)).toEqual([1, 0]);
    expect(aim(0, 160)[1]).toBeCloseTo(0.5);
  });
});

describe("the chat's bloub previews", () => {
  it("reads the specs an avatar result carries, and nothing from other output", () => {
    expect(bloubsIn(`Rolled 1.\n\n\`\`\`bloubs\n${JSON.stringify([EXAMPLES.fern])}\n\`\`\``)).toEqual([EXAMPLES.fern]);
    expect(bloubsIn("```bloubs\n<svg/>\n```")).toBeUndefined();
    expect(bloubsIn("hello")).toBeUndefined();
  });
});

describe("the avatar tool", () => {
  it("saves a picked bloub for ky, sends it to the page, and clears it", async () => {
    const name = crypto.randomUUID();
    const socket = await connect(name);
    const client = follow(socket);
    await client.until(() => client.frames.some((frame) => frame.type === "avatars"));
    expect(client.frames.find((frame) => frame.type === "avatars")).toEqual({ type: "avatars", avatars: {} });

    const set = await prompt(name, tool({ action: "set", for: "ky", spec: EXAMPLES.squarey }));
    expect(set.text).toContain("Saved as ky's avatar.");
    expect(set.text).toContain("```bloubs\n");
    await client.until(() => client.frames.some((frame) => frame.type === "avatars" && "ky" in frame.avatars));
    expect(await inside(name, (instance) => instance.avatars.all())).toEqual({ ky: EXAMPLES.squarey });

    expect((await prompt(name, tool({ action: "clear", for: "ky" }))).text).toBe("tool said: ky looks as before again.");
    expect(await inside(name, (instance) => instance.avatars.all())).toEqual({});
    socket.close();
  });

  it("refuses someone who isn't ky or a specialist, and rolls options to pick from", async () => {
    const name = crypto.randomUUID();
    expect((await prompt(name, tool({ action: "set", for: "nobody", spec: EXAMPLES.pip }))).text).toContain("No one is called nobody");

    const rolled = (await prompt(name, tool({ action: "roll", count: 3 }))).text ?? "";
    expect(rolled).toContain("Rolled 3.");
    const block = rolled.match(/```bloubs\n([\s\S]*?)\n```/)?.[1] ?? "[]";
    expect(block.split('"body"').length - 1).toBe(3);
  });

  it("ships the make-avatar skill on", async () => {
    const name = `${FRESH}${crypto.randomUUID()}`;
    await prompt(name, "hello");
    expect(await inside(name, (instance) => instance.skills.get("make-avatar")?.status)).toBe("active");
  });
});
