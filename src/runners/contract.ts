import * as Schema from "effect/Schema";
import type { Refusable } from "../core/edge";
import { CLOUD } from "../machines/contract";

export const RUNNER_TABLES = Object.freeze({ sandboxes: "ky_sandboxes", seeded: "ky_sandboxes_seeded" } as const);

export const SANDBOX_CAP = 8;

export const IDLE_MAX = 24 * 60;

export const CODE_TTL_MS = 10 * 60_000;

export function saveKey(id: string): string {
  return id === CLOUD ? "cloud-machine/save.tar.gz" : `cloud-machine/${id}/save.tar.gz`;
}

export const machineSubject = (machine: string, pairing: string) => `${machine}:${pairing}`;

export function bearer(request: Request): string | undefined {
  const header = request.headers.get("Authorization");

  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

const Sandbox = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  repos: Schema.Array(Schema.String),
  idleMinutes: Schema.NullOr(Schema.Number),
  isDefault: Schema.Boolean,
  createdAt: Schema.Number,
  deletedAt: Schema.NullOr(Schema.Number)
});

export type Sandbox = typeof Sandbox.Type;

const SandboxDraft = Schema.Struct({
  name: Schema.String,
  repos: Schema.optional(Schema.Array(Schema.String)),
  from: Schema.optional(Schema.String),
  /** false: never the default, though it is the first live one (a specialist's own). */
  isDefault: Schema.optional(Schema.Literal(false))
});

export type SandboxDraft = typeof SandboxDraft.Type;

const SandboxChange = Schema.Struct({
  repos: Schema.optional(Schema.Array(Schema.String)),
  idleMinutes: Schema.optional(Schema.NullOr(Schema.Number)),
  isDefault: Schema.optional(Schema.Literal(true))
});

export type SandboxChange = typeof SandboxChange.Type;

export class NotAName extends Schema.TaggedError<NotAName>()("NotAName", {}) implements Refusable {
  get refusal(): string {
    return "A name is lowercase letters, digits and dashes, up to 32.";
  }
}

export class NameTaken extends Schema.TaggedError<NameTaken>()("NameTaken", { name: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.name} is taken; pick another name.`;
  }
}

export class AtCap extends Schema.TaggedError<AtCap>()("AtCap", {}) implements Refusable {
  get refusal(): string {
    return `ky runs at most ${SANDBOX_CAP} sandboxes; delete one first.`;
  }
}

export class NotASandboxRepo extends Schema.TaggedError<NotASandboxRepo>()("NotASandboxRepo", { repo: Schema.String }) implements Refusable {
  get refusal(): string {
    return `A repo is owner/name, not ${JSON.stringify(this.repo)}.`;
  }
}

export class RepoOwned extends Schema.TaggedError<RepoOwned>()("RepoOwned", { repo: Schema.String, owner: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.repo} is already ${this.owner}'s; a repo belongs to one sandbox.`;
  }
}

export class NoKeptDisk extends Schema.TaggedError<NoKeptDisk>()("NoKeptDisk", { id: Schema.String }) implements Refusable {
  get refusal(): string {
    return `No kept disk ${this.id}.`;
  }
}

export class NoSandbox extends Schema.TaggedError<NoSandbox>()("NoSandbox", { id: Schema.String }) implements Refusable {
  get refusal(): string {
    return `No sandbox ${this.id}.`;
  }
}

export class BadIdle extends Schema.TaggedError<BadIdle>()("BadIdle", {}) implements Refusable {
  get refusal(): string {
    return `Idle minutes are a whole number from 1 to ${IDLE_MAX}.`;
  }
}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {}) implements Refusable {
  get status(): number {
    return 404;
  }

  get refusal(): string {
    return "Not found";
  }
}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) implements Refusable {
  get status(): number {
    return 401;
  }

  get refusal(): string {
    return "Unauthorized";
  }
}

export class UpgradeRequired extends Schema.TaggedError<UpgradeRequired>()("UpgradeRequired", {}) implements Refusable {
  get status(): number {
    return 426;
  }

  get refusal(): string {
    return "Upgrade Required";
  }
}

export class RunnerMethodNotAllowed extends Schema.TaggedError<RunnerMethodNotAllowed>()("RunnerMethodNotAllowed", {}) implements Refusable {
  get status(): number {
    return 405;
  }

  get refusal(): string {
    return "Method not allowed";
  }
}

export class TooManyPairings extends Schema.TaggedError<TooManyPairings>()("TooManyPairings", {}) implements Refusable {
  get status(): number {
    return 429;
  }

  get refusal(): string {
    return "Too many pairing attempts; wait a minute.";
  }
}

export class BadPairRequest extends Schema.TaggedError<BadPairRequest>()("BadPairRequest", {}) implements Refusable {
  get status(): number {
    return 400;
  }

  get refusal(): string {
    return "Send { code, name, facts }; a name is lowercase letters, digits and dashes, up to 32.";
  }
}

export class BadFacts extends Schema.TaggedError<BadFacts>()("BadFacts", {}) implements Refusable {
  get status(): number {
    return 400;
  }

  get refusal(): string {
    return "facts is not what a runner says about its machine.";
  }
}

export class SandboxName extends Schema.TaggedError<SandboxName>()("SandboxName", { name: Schema.String }) implements Refusable {
  get status(): number {
    return 409;
  }

  get refusal(): string {
    return `${this.name} is one of ky's sandboxes; pick another name.`;
  }
}

export class CodeRefused extends Schema.TaggedError<CodeRefused>()("CodeRefused", {}) implements Refusable {
  get status(): number {
    return 401;
  }

  get refusal(): string {
    return "That code is wrong, used or expired. Make a new one in ky.";
  }
}

export class SandboxNotRemovable extends Schema.TaggedError<SandboxNotRemovable>()("SandboxNotRemovable", { machine: Schema.String }) implements Refusable {
  get status(): number {
    return 409;
  }

  get refusal(): string {
    return `${this.machine} is one of ky's sandboxes: delete it in Settings, under Machines.`;
  }
}

export class NoRunnerMachine extends Schema.TaggedError<NoRunnerMachine>()("NoRunnerMachine", { machine: Schema.String }) implements Refusable {
  get status(): number {
    return 404;
  }

  get refusal(): string {
    return `No machine ${this.machine}.`;
  }
}

export type RouteRefused =
  | NotFound
  | Unauthorized
  | UpgradeRequired
  | RunnerMethodNotAllowed
  | TooManyPairings
  | BadPairRequest
  | BadFacts
  | SandboxName
  | CodeRefused
  | SandboxNotRemovable
  | NoRunnerMachine;
