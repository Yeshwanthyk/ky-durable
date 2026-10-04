import { describe, expect, it } from "vitest";
import { checkInput, imageSupport, MAX_IMAGE_CHARS, MAX_IMAGES } from "../images";
import type { SettingsView } from "../settings";

const image = (data = "aGk=", mimeType = "image/png") => ({ type: "image" as const, data, mimeType });

const settings = (mainImages: boolean, connected = true): SettingsView => ({
  providers: [
    {
      id: "a",
      name: "A",
      connected,
      models: [{ modelId: "seer", name: "Seer", levels: [], images: mainImages }]
    },
    {
      id: "b",
      name: "B",
      connected: true,
      models: [{ modelId: "blind", name: "Blind", levels: [], images: false }]
    }
  ],
  slots: {
    main: { provider: "a", modelId: "seer", thinkingLevel: "off" },
    subagents: { provider: "b", modelId: "blind", thinkingLevel: "off" },
    fallback: { provider: "b", modelId: "blind", thinkingLevel: "off" }
  }
});

describe("checking a message's images", () => {
  it("lets text through, with or without images", () => {
    expect(checkInput("hello", settings(false), "main")).toBeNull();
    expect(checkInput([image()], settings(true), "main")).toBeNull();
    expect(checkInput([image(), { type: "text", text: "what is this?" }], settings(true), "main")).toBeNull();
  });

  it("refuses images the slot's model can't read", () => {
    expect(checkInput([image()], settings(false), "main")).toMatch(/^Seer can't read images/);
    expect(checkInput([image()], settings(true), "subagents")).toMatch(/^Blind can't read images/);
  });

  it("checks the fallback model while the slot's provider is offline", () => {
    expect(imageSupport(settings(true, false), "main")).toMatch(/^Blind can't read images/);
  });

  it("lets through a model the catalog does not list", () => {
    const unknown = { ...settings(false), providers: [] };

    expect(checkInput([image()], unknown, "main")).toBeNull();
  });

  it("refuses too many, too large, or the wrong kind of image", () => {
    const many = Array.from({ length: MAX_IMAGES + 1 }, () => image());

    expect(checkInput(many, settings(true), "main")).toMatch(/at most/);
    expect(checkInput([image("a".repeat(MAX_IMAGE_CHARS + 4))], settings(true), "main")).toMatch(/too large/);
    expect(checkInput([image("aGk=", "image/svg+xml")], settings(true), "main")).toMatch(/JPEG, PNG/);
    expect(checkInput([image("not base64!")], settings(true), "main")).toMatch(/base64/);
  });
});
