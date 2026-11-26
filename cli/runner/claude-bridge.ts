import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { claudeCodeApi, type ClaudeCodeApiOptions } from "@tembo-io/pi-durable-cc";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  CLAUDE_MODELS,
  CLAUDE_SILENCE_MS,
  type ClaudeLine,
  ClaudeRequest,
  failedAnswer,
  silent,
  wireOf
} from "../../src/providers/claude/wire.ts";
import { CHARGED, CLAUDE_CONVERSATION, openGuard } from "./claude-guard.ts";

const IDLE_MS = 10 * 60_000;

const BEATS = 9;

const STREAM_TOOL_INPUT = { CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: "1" };

const requestOf = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeRequest));

const refuse = (res: ServerResponse, status: number, reason: string) => {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(reason);
};

export const openClaudeBridge = (settings: Pick<ClaudeCodeApiOptions, "executable" | "env">, silenceMs = CLAUDE_SILENCE_MS) => {
  const guard = openGuard();

  const api = claudeCodeApi({
    ...settings,
    env: { ...settings.env, ...STREAM_TOOL_INPUT },
    idleTimeoutMs: IDLE_MS,
    clientApp: "ky/1.0",
    inheritEnv: false,
    queryOptions: { spawnClaudeCodeProcess: guard.start }
  });

  const stream = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const abort = new AbortController();

    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    const request = requestOf(await text(req));

    if (Option.isNone(request)) {
      refuse(res, 400, "The Claude bridge could not read the request.");

      return;
    }

    const { context, options } = request.value;
    const model = CLAUDE_MODELS.find((each) => each.id === request.value.model.id);

    if (model === undefined) {
      refuse(res, 400, "The Claude bridge has no such model.");

      return;
    }

    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.flushHeaders();

    const write = (line: ClaudeLine) => res.write(`${JSON.stringify(line)}\n`);

    const send = async (line: ClaudeLine) => {
      if (!write(line)) await once(res, "drain", { signal: abort.signal });
    };

    if (guard.charging(options.apiKey)) {
      await send(failedAnswer(model, "error", CHARGED));
      res.end();

      return;
    }

    const conversation = options.sessionId ?? randomUUID();
    let heardAt = Date.now();

    const unlisten = guard.onOutput(conversation, () => {
      heardAt = Date.now();
    });

    const beat = setInterval(() => {
      if (Date.now() - heardAt < silenceMs) {
        write({ type: "alive" });

        return;
      }

      clearInterval(beat);
      abort.abort();
      write(failedAnswer(model, "error", silent("Claude", silenceMs)));
      res.end();
    }, silenceMs / BEATS);

    try {
      const answer = api.streamSimple(model, normalizeContext(context), {
        ...options,
        env: { [CLAUDE_CONVERSATION]: conversation },
        signal: abort.signal
      } satisfies SimpleStreamOptions);

      for await (const event of answer) {
        if (abort.signal.aborted) return;

        await send(event.type === "error" && guard.charging(options.apiKey) ? failedAnswer(model, "error", CHARGED) : wireOf(event));
      }

      res.end();
    } finally {
      clearInterval(beat);
      unlisten();
    }
  };

  return {
    stream,
    close: async () => {
      await api.close();
    }
  };
};
