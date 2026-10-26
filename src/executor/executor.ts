import type { JsonValue } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
  StreamableHTTPError
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type Attempt,
  type CallResult,
  ExecutorConnection,
  type ExecutorConfig,
  type ExecutorVault,
  NoToken,
  NotAUrl,
  NotConnected,
  NotHttps,
  OtherOrigin,
  TokenRefused,
  Unreachable
} from "./contract";

const REQUEST_TIMEOUT_MS = 6 * 60_000;

const PROBE_TIMEOUT_MS = 30_000;

class Unanswered extends Schema.TaggedError<Unanswered>()("Unanswered", { message: Schema.String, neverRan: Schema.Boolean }) {}

function answered(error: Error, ...codes: number[]): boolean {
  return error instanceof StreamableHTTPError && error.code !== undefined && codes.includes(error.code);
}

const unanswered = (error: Error, neverRan: boolean) => new Unanswered({ message: error.message, neverRan });

const failed = (message: string): CallResult => ({ output: [{ type: "text", text: `Executor call failed: ${message}` }], isError: true });

const partsOf = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));

const textOf = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }));

function toResult(answer: Awaited<ReturnType<Client["callTool"]>>): CallResult {
  const output = Option.getOrElse(partsOf(answer.content), () => []).map((part) => ({
    type: "text" as const,
    text: Option.match(textOf(part), { onSome: (said) => said.text, onNone: () => JSON.stringify(part) })
  }));

  if (answer.structuredContent !== undefined && output.length === 0) output.push({ type: "text", text: JSON.stringify(answer.structuredContent) });

  return { output, isError: answer.isError === true };
}

function modelMode(url: string): URL {
  const parsed = new URL(url);

  parsed.searchParams.delete("elicitation_mode");

  return parsed;
}

async function open(config: ExecutorConfig): Promise<Client> {
  const client = new Client({ name: "ky", version: "0.1.0" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  const options: StreamableHTTPClientTransportOptions = { requestInit: { headers: { Authorization: `Bearer ${config.token}` } } };

  if (config.fetch) options.fetch = config.fetch;
  await client.connect(new StreamableHTTPClientTransport(modelMode(config.url), options));

  return client;
}

export class ExecutorClient {
  readonly #config: ExecutorConfig;
  #client: Promise<Client> | undefined;

  constructor(config: ExecutorConfig) {
    this.#config = config;
  }

  #connect(): Promise<Client> {
    if (this.#client) return this.#client;
    const connecting = open(this.#config);

    connecting.catch(() => this.#forget(connecting));
    this.#client = connecting;

    return connecting;
  }

  close(): void {
    if (this.#client) this.#forget(this.#client);
  }

  #forget(connection: Promise<Client>): void {
    if (this.#client !== connection) return;
    this.#client = undefined;
    connection.then((client) => client.close()).catch(() => undefined);
  }

  async call(name: string, args: Record<string, JsonValue | undefined>, signal: AbortSignal | undefined): Promise<CallResult> {
    return (await this.attempt(name, args, signal)).result;
  }

  attempt(name: string, args: Record<string, JsonValue | undefined>, signal: AbortSignal | undefined): Promise<Attempt> {
    const retry = signal?.aborted !== true;

    return Effect.runPromise(
      this.#once(name, args, signal).pipe(
        Effect.retry({ times: 1, while: (unanswered) => retry && unanswered.neverRan }),
        Effect.match({
          onSuccess: (result) => ({ result, neverRan: false }),
          onFailure: (unanswered) => ({ result: failed(unanswered.message), neverRan: unanswered.neverRan })
        })
      )
    );
  }

  #once(name: string, args: Record<string, JsonValue | undefined>, signal: AbortSignal | undefined): Effect.Effect<CallResult, Unanswered> {
    return Effect.suspend(() => {
      const connection = this.#connect();
      const options: RequestOptions = signal ? { timeout: REQUEST_TIMEOUT_MS, signal } : { timeout: REQUEST_TIMEOUT_MS };

      return Effect.tryPromise({
        try: () => connection,
        catch: (thrown) => {
          const error = thrown instanceof Error ? thrown : new Error(String(thrown));

          return unanswered(error, !answered(error, 401, 403));
        }
      }).pipe(
        Effect.flatMap((client) =>
          Effect.tryPromise({
            try: () => client.callTool({ name, arguments: args }, undefined, options),
            catch: (thrown) => {
              const error = thrown instanceof Error ? thrown : new Error(String(thrown));

              if (signal?.aborted !== true) this.#forget(connection);

              return unanswered(error, answered(error, 404));
            }
          })
        ),
        Effect.map(toResult)
      );
    });
  }
}

export class Link extends Context.Service<
  Link,
  {
    readonly saved: Effect.Effect<Option.Option<ExecutorConnection>>;
    readonly url: Effect.Effect<string | null>;
    save(connection: ExecutorConnection): Effect.Effect<void>;
    readonly forget: Effect.Effect<void>;
  }
>()("ky/executor/Link") {
  static layer(vault: () => ExecutorVault, id: string) {
    return Layer.succeed(Link)(
      Link.of({
        saved: Effect.map(
          Effect.promise(() => vault().executor(id)),
          (stored) => Schema.decodeUnknownOption(ExecutorConnection)(stored)
        ),
        url: Effect.map(Effect.promise(() => vault().status()), (secrets) => {
          const secret = secrets.find((each) => each.kind === "executor" && each.id === id);

          return Option.getOrNull(Option.filter(Option.map(metaOf(secret?.meta), (meta) => meta.url), (url) => url !== ""));
        }),
        save: (connection) => Effect.asVoid(Effect.promise(() => vault().put("executor", id, connection, { url: connection.url }))),
        forget: Effect.asVoid(Effect.promise(() => vault().remove("executor", id)))
      })
    );
  }
}

const metaOf = Schema.decodeUnknownOption(Schema.Struct({ url: Schema.String }));

const isExecutorUrl = (parsed: URL): boolean =>
  parsed.protocol === "https:" || (parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname));

const checkUrl = (url: string): Effect.Effect<URL, NotAUrl | NotHttps> =>
  Effect.try({ try: () => new URL(url), catch: () => new NotAUrl() }).pipe(Effect.filterOrFail(isExecutorUrl, () => new NotHttps()));

const refusalOf = (origin: string, error: Error) => (answered(error, 401, 403) ? new TokenRefused() : new Unreachable({ origin, message: error.message }));

const probe = (config: ExecutorConfig, origin: string): Effect.Effect<void, TokenRefused | Unreachable> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => open(config), catch: (thrown) => refusalOf(origin, thrown instanceof Error ? thrown : new Error(String(thrown))) }),
    (client) =>
      Effect.asVoid(
        Effect.tryPromise({
          try: () => client.listTools(undefined, { timeout: PROBE_TIMEOUT_MS }),
          catch: (thrown) => refusalOf(origin, thrown instanceof Error ? thrown : new Error(String(thrown)))
        })
      ),
    (client) => Effect.promise(() => client.close().catch(() => undefined))
  );

export const connect = Effect.fnUntraced(function* (url: string, token: string, reach: typeof fetch | undefined) {
  const link = yield* Link;
  const kept = token.trim() === "" ? Option.getOrUndefined(yield* link.saved)?.token : undefined;
  const connection = { url: url.trim(), token: kept ?? token.trim() };

  if (connection.token === "") return yield* new NoToken();
  const parsed = yield* checkUrl(connection.url);

  yield* probe(reach ? { ...connection, fetch: reach } : connection, parsed.origin);
  yield* link.save(connection);

  return {};
});

function originOf(url: string): Option.Option<string> {
  try {
    return Option.some(new URL(url).origin);
  } catch {
    return Option.none();
  }
}

export const retarget = Effect.fnUntraced(function* (url: string, reach: typeof fetch | undefined) {
  const saved = yield* (yield* Link).saved;

  if (Option.isNone(saved)) return yield* new NotConnected();
  const [from, to] = [originOf(saved.value.url), originOf(url.trim())];

  if (Option.isSome(from) && Option.isSome(to) && from.value !== to.value) return yield* new OtherOrigin({ origin: from.value });

  return yield* connect(url, "", reach);
});
