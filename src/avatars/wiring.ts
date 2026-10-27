import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type Edge, makeEdge } from "../core/edge";
import { type Result, isRefusal } from "../core/refusal";
import { toolReply } from "../core/reply";
import { Sql } from "../core/sql";
import { act, AvatarInput, type Reply, Wardrobe } from "./avatars";
import { AVATAR_TOOL, type AvatarsView, KY_AVATAR, type SelfEdit, type SetupView } from "./contract";
import { Places } from "./setup";

export class Avatars {
  readonly #listeners = new Set<() => void>();
  readonly #edge: Edge<Wardrobe>;

  constructor(storage: DurableObjectStorage) {
    this.#edge = makeEdge(Wardrobe.layer(this.#listeners).pipe(Layer.provide(Sql.layer(storage))));
    this.#edge.run(Effect.void);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  all(): AvatarsView {
    return this.#edge.run(Wardrobe.use((wardrobe) => wardrobe.all));
  }

  act(input: AvatarInput, owners: () => readonly string[]): Result<Reply> {
    return this.#edge.run(act(input, owners));
  }
}

export function avatarTools(avatars: Avatars, owners: () => readonly string[]) {
  return defineExtension({
    name: "avatars",
    tools: [
      defineTool({
        name: AVATAR_TOOL,
        description:
          "Make and save avatars: bloubs, small animated characters drawn from a spec of parts, never SVG. " +
          "Actions: preview (specs: show up to six side by side); roll (count: random ones to pick from); " +
          `set (for: "${KY_AVATAR}" or a specialist's id; spec); clear (for); list. ` +
          "Read the make-avatar skill before designing one.",
        parameters: AvatarInput,
        replay: "unsafe",
        execute: async (input) => {
          const reply = avatars.act(input, owners);

          return toolReply(isRefusal(reply) ? reply.refused : reply.text);
        }
      })
    ]
  });
}

export class Setup {
  readonly #listeners = new Set<() => void>();
  readonly #edge: Edge<Places>;

  constructor(storage: DurableObjectStorage) {
    this.#edge = makeEdge(Places.layer(this.#listeners).pipe(Layer.provide(Sql.layer(storage))));
    this.#edge.run(Effect.void);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  setRepo(repo: string, page: string | null): Result<Record<string, never>> {
    return this.#edge.run(Places.use((places) => places.setRepo(repo, page)));
  }

  view(): Omit<SetupView, "missing"> {
    return this.#edge.run(Places.use((places) => places.view));
  }

  selfEdit(): SelfEdit | undefined {
    return this.#edge.run(Places.use((places) => places.selfEdit));
  }

  firstStart(): boolean {
    return this.#edge.run(Places.use((places) => places.firstStart));
  }

  origin(): string | null {
    return this.#edge.run(Places.use((places) => places.origin));
  }

  opened(page: string): void {
    this.#edge.run(Places.use((places) => places.opened(page)));
  }

  moved(origin: string): void {
    this.#edge.run(Places.use((places) => places.moved(origin)));
  }
}
