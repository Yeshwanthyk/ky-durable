import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ClaudeCodeApiOptions } from "@tembo-io/pi-durable-cc";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CLAUDE_BILLING } from "../../src/providers/claude/wire.ts";

type SpawnOptions = Parameters<NonNullable<NonNullable<ClaudeCodeApiOptions["queryOptions"]>["spawnClaudeCodeProcess"]>>[0];

const KILL_MS = 5_000;

const HOLD_MS = 60 * 60_000;

const KEEP_ALIVE = '{"type":"keep_alive"';

export const CLAUDE_CONVERSATION = "KY_CONVERSATION";

export const CHARGED = `${CLAUDE_BILLING} Anthropic charged a request to Claude usage credits instead of the plan, so ky stopped Claude Code until the plan limit resets.`;

const limitOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("rate_limit_event"),
      rate_limit_info: Schema.Struct({
        resetsAt: Schema.optionalKey(Schema.Number),
        isUsingOverage: Schema.optionalKey(Schema.Boolean),
        overageInUse: Schema.optionalKey(Schema.Boolean)
      })
    })
  )
);

export const overage = (line: string) =>
  line.includes('"rate_limit_event"')
    ? limitOf(line).pipe(
        Option.map((event) => event.rate_limit_info),
        Option.filter((info) => info.isUsingOverage === true || info.overageInUse === true)
      )
    : Option.none();

const tapped = (onOverage: (resetsAt: number | undefined) => void, onOutput: () => void) => {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  let tripped = false;

  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (tripped) {
        done();

        return;
      }

      const parts = (rest + decoder.write(chunk)).split("\n");

      rest = parts.pop() ?? "";

      if (parts.some((part) => !part.startsWith(KEEP_ALIVE))) onOutput();

      for (const part of parts) {
        const used = overage(part);

        if (Option.isSome(used)) {
          tripped = true;
          onOverage(used.value.resetsAt);
          done();

          return;
        }
      }

      done(null, chunk);
    }
  });
};

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export const openGuard = () => {
  const held = new Map<string, number>();
  const output = new EventEmitter();

  const start = (options: SpawnOptions) => {
    const { [CLAUDE_CONVERSATION]: conversation = "", ...env } = options.env;
    const token = env["CLAUDE_CODE_OAUTH_TOKEN"] ?? "";

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "ignore"]
    });

    const tap = tapped(
      (resetsAt) => {
        held.set(digest(token), resetsAt === undefined ? Date.now() + HOLD_MS : resetsAt * 1000);
        child.kill("SIGTERM");
      },
      () => {
        output.emit(`from ${conversation}`);
      }
    );

    const forceKill = () => {
      const timer = setTimeout(() => child.kill("SIGKILL"), KILL_MS);

      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    };

    options.signal.addEventListener("abort", forceKill, { once: true });
    child.on("error", () => undefined);
    child.stdin.on("error", () => undefined);
    child.once("exit", () => {
      options.signal.removeEventListener("abort", forceKill);

      if (options.cwd !== undefined) rm(dirname(options.cwd), { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    });

    return Object.assign(child, { stdout: child.stdout.pipe(tap) });
  };

  const onOutput = (conversation: string, listener: () => void) => {
    const name = `from ${conversation}`;

    output.on(name, listener);

    return () => {
      output.off(name, listener);
    };
  };

  return {
    onOutput,
    charging: (token: string) => (held.get(digest(token)) ?? 0) > Date.now(),
    start
  };
};
