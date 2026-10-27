import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type Edge, makeEdge, runOrThrow } from "../core/edge";
import { Sql } from "../core/sql";
import type { MachineFacts } from "../machines/contract";
import type { RouteRefused, Sandbox, SandboxChange, SandboxDraft } from "./contract";
import { ownerRoute as owners, pairing, tokenRoute as tokens } from "./routes";
import { Registry } from "./sandboxes";

export class Sandboxes {
  readonly #edge: Edge<Registry>;

  constructor(storage: DurableObjectStorage) {
    this.#edge = makeEdge(Registry.layer.pipe(Layer.provide(Sql.layer(storage))));
    this.#edge.run(Registry.use(() => Effect.void));
  }

  migrate(): void {
    this.#edge.run(Registry.use((registry) => registry.migrate));
  }

  seeded(): void {
    this.#edge.run(Registry.use((registry) => registry.seeded));
  }

  all(): Sandbox[] {
    return this.#edge.run(Registry.use((registry) => registry.all));
  }

  keep(lost: readonly Sandbox[]): void {
    this.#edge.run(Registry.use((registry) => registry.keep(lost)));
  }

  live(): Sandbox[] {
    return this.#edge.run(Registry.use((registry) => registry.live));
  }

  kept(): Sandbox[] {
    return this.#edge.run(Registry.use((registry) => registry.kept));
  }

  get(id: string): Sandbox | undefined {
    return this.#edge.run(Registry.use((registry) => registry.get(id)));
  }

  named(name: string): Sandbox | undefined {
    return this.#edge.run(Registry.use((registry) => registry.named(name)));
  }

  owner(repo: string): Sandbox | undefined {
    return this.#edge.run(Registry.use((registry) => registry.owner(repo)));
  }

  reposFor(id: string): readonly string[] | "all" | null {
    return this.#edge.run(Registry.use((registry) => registry.reposFor(id)));
  }

  create(draft: SandboxDraft, taken: (name: string) => boolean): Sandbox {
    return runOrThrow(this.#edge, Registry.use((registry) => registry.create(draft, taken)));
  }

  change(id: string, change: SandboxChange): Sandbox {
    return runOrThrow(this.#edge, Registry.use((registry) => registry.change(id, change)));
  }

  delete(id: string): Sandbox {
    return runOrThrow(this.#edge, Registry.use((registry) => registry.delete(id)));
  }

  forget(id: string): Sandbox {
    return runOrThrow(this.#edge, Registry.use((registry) => registry.forget(id)));
  }
}

async function answer(route: Effect.Effect<Response, RouteRefused>): Promise<Response> {
  const edge = makeEdge(Layer.empty);

  try {
    return await edge.runPromise(route.pipe(Effect.catch((refused: RouteRefused) => Effect.succeed(new Response(refused.refusal, { status: refused.status })))));
  } finally {
    await edge.dispose();
  }
}

export function tokenRoute(request: Request, env: Env, url: URL): Promise<Response> | undefined {
  const route = tokens(request, env, url);

  return route && answer(route);
}

export function ownerRoute(request: Request, env: Env, url: URL): Promise<Response> | undefined {
  const route = owners(request, env, url);

  return route && answer(route);
}

export async function pairAs(env: Env, machine: string, facts: MachineFacts, sandbox?: string): Promise<string> {
  const edge = makeEdge(Layer.empty);

  try {
    return await edge.runPromise(pairing(env, machine, facts, sandbox));
  } finally {
    await edge.dispose();
  }
}
