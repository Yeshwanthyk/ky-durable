import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { uploadedType } from "../files/files";
import { upload } from "../files/wiring";
import { isMachineFacts, isMachineName, type MachineFacts, PAIRING_HEADER, RUNNER_PATH, runnerPathMachine, WIRE } from "../machines/contract";
import {
  BadFacts,
  BadPairRequest,
  bearer,
  CODE_TTL_MS,
  CodeRefused,
  machineSubject,
  NoMachine,
  NotAllowed,
  NotFound,
  type RouteRefused,
  SandboxName,
  SandboxNotRemovable,
  TooManyPairings,
  Unauthorized,
  UpgradeRequired
} from "./contract";

type Route = Effect.Effect<Response, RouteRefused>;

const vault = (env: Env) => env.Vault.getByName("owner");

const agent = (env: Env) => env.PiAgent.getByName("me");

const asPairRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(WIRE.pair));

const runnerSocket = (request: Request, env: Env, url: URL): Route =>
  Effect.gen(function* () {
    const machine = runnerPathMachine(url.pathname);

    if (!machine) return yield* new NotFound();
    const token = bearer(request);
    const subject = token ? yield* Effect.promise(() => vault(env).check("machine", token)) : null;
    const [owner, pairing] = subject?.split(":") ?? [];

    if (owner !== machine || pairing === undefined) return yield* new Unauthorized();

    if (request.headers.get("Upgrade") !== "websocket") return yield* new UpgradeRequired();
    const headers = new Headers(request.headers);
    headers.delete("Authorization");
    headers.set(PAIRING_HEADER, pairing);

    return yield* Effect.promise(() => agent(env).fetch(new Request(request, { headers })));
  });

const taskUpload = (request: Request, env: Env, url: URL): Route =>
  Effect.gen(function* () {
    const task = url.searchParams.get("task");
    const token = bearer(request);

    if (!task || !token || (yield* Effect.promise(() => vault(env).check("task", token))) !== task) return yield* new Unauthorized();

    return yield* Effect.promise(() => upload(request, env.FILES, (file) => agent(env).attachFile(file), uploadedType));
  });

export const pairing = (env: Env, machine: string, facts: MachineFacts, sandbox?: string) =>
  Effect.gen(function* () {
    const id = crypto.randomUUID();
    const subject = machineSubject(machine, id);
    const token = yield* Effect.promise(() => vault(env).mint("machine", subject));

    const previous = yield* Effect.promise(() => agent(env).pairMachine(machine, facts, id, sandbox)).pipe(
      Effect.onError(() => Effect.promise(() => vault(env).revoke("machine", subject)))
    );

    if (previous !== null) yield* Effect.promise(() => vault(env).revoke("machine", machineSubject(machine, previous)));

    return token;
  });

const pair = (request: Request, env: Env): Route =>
  Effect.gen(function* () {
    if (request.method !== "POST") return yield* new NotAllowed();
    const address = request.headers.get("CF-Connecting-IP") ?? "unknown";

    if (!(yield* Effect.promise(() => env.PAIR_LIMIT.limit({ key: address }))).success) return yield* new TooManyPairings();

    const body = yield* Effect.tryPromise({ try: () => request.text(), catch: () => new BadPairRequest() }).pipe(
      Effect.flatMap((text) => Effect.mapError(asPairRequest(text), () => new BadPairRequest()))
    );

    if (!isMachineFacts(body.facts)) return yield* new BadFacts();

    if (yield* Effect.promise(() => agent(env).isSandbox(body.name))) return yield* new SandboxName({ name: body.name });

    if ((yield* Effect.promise(() => vault(env).consume("pair", body.code))) === null) return yield* new CodeRefused();
    const token = yield* pairing(env, body.name, body.facts);

    return Response.json({ machine: body.name, token });
  });

const newCode = (env: Env): Route =>
  Effect.gen(function* () {
    const expiresAt = (yield* Clock.currentTimeMillis) + CODE_TTL_MS;
    const code = yield* Effect.promise(() => vault(env).mint("pair", crypto.randomUUID(), CODE_TTL_MS));

    return Response.json({ code, expiresAt });
  });

const remove = (env: Env, machine: string): Route =>
  Effect.gen(function* () {
    if (!isMachineName(machine)) return yield* new NotFound();

    if (yield* Effect.promise(() => agent(env).isSandbox(machine))) return yield* new SandboxNotRemovable({ machine });
    const removed = yield* Effect.promise(() => agent(env).removeMachine(machine));

    if (!removed) return yield* new NoMachine({ machine });
    const last = removed.pairing;

    if (last !== null) yield* Effect.promise(() => vault(env).revoke("machine", machineSubject(machine, last)));

    return new Response(null, { status: 204 });
  });

export function tokenRoute(request: Request, env: Env, url: URL): Route | undefined {
  if (url.pathname.startsWith(RUNNER_PATH)) return runnerSocket(request, env, url);

  if (url.pathname === "/api/runners/pair") return pair(request, env);

  if (url.pathname === "/api/files") return taskUpload(request, env, url);

  return undefined;
}

export function ownerRoute(request: Request, env: Env, url: URL): Route | undefined {
  if (url.pathname === "/api/runners/codes") return request.method === "POST" ? newCode(env) : new NotAllowed();

  const machine = /^\/api\/runners\/([^/]+)$/.exec(url.pathname)?.[1];

  if (machine !== undefined && request.method === "DELETE") return remove(env, machine);

  return undefined;
}
