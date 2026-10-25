/**
 * The Cloudflare API, with the user's own login: CLOUDFLARE_API_TOKEN, else the
 * token `ky login` saved (cli/login.ts), else `cf auth login`'s, else `wrangler auth token`. The CLI
 * writes a token only when the user runs `ky login`; it never deploys one.
 *
 * Every call is a @distilled.cloud/cloudflare operation, run here so the rest
 * of the CLI is plain async code. CLOUDFLARE_API_BASE_URL points it at another
 * API, as it does wrangler; the tests point it at test/fakes/cloudflare.ts.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import { CloudflareError as ApiError, CloudflareRateLimited } from "@distilled.cloud/cloudflare/Errors";
import { CloudflareProtocol } from "@distilled.cloud/cloudflare/Protocol";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import * as T from "@distilled.cloud/cloudflare/Traits";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as API from "@distilled.cloud/core/api";
import * as Cause from "effect/Cause";
import * as Accounts from "@distilled.cloud/cloudflare/accounts";
import * as EmailRouting from "@distilled.cloud/cloudflare/email-routing";
import * as R2 from "@distilled.cloud/cloudflare/r2";
import * as Zones from "@distilled.cloud/cloudflare/zones";
import * as ZeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parseOr } from "../src/core/decode.ts";

/** Where the token came from, so a refusal can say which login to fix. */
export type Login = "CLOUDFLARE_API_TOKEN" | "ky login" | "cf login" | "wrangler login" | "a pasted token";

/** A failed call: Cloudflare's own error, with its tag (`NoSuchBucket`, `Forbidden`, …). */
class CloudflareError extends Error {
  readonly tag: string;

  constructor(tag: string, message: string) {
    super(message);
    this.tag = tag;
  }
}

const REFUSALS = new Set(["Forbidden", "Unauthorized"]);

/** Whether Cloudflare refused the login: it's signed in, but its token can't do this. */
export function refused(error: unknown): error is CloudflareError {
  return error instanceof CloudflareError && REFUSALS.has(error.tag);
}

/** Whether Cloudflare answered the call with an error, rather than the call failing to reach it. */
export function answeredWithError(error: unknown): error is CloudflareError {
  return error instanceof CloudflareError;
}

/** What @distilled.cloud/cloudflare fails with: Cloudflare's error, tagged by its code. */
const Tagged = Type.Object({ _tag: Type.String() });

type Layered = ReturnType<typeof layer>;

type Services = Layer.Success<Layered>;

/**
 * How a permission check retries: Cloudflare answers a token without a permission "Authentication
 * error", which distilled retries for some 20 seconds as the blip it can be. Twice is enough for a blip.
 */
const BRIEFLY: Retry.Options = { schedule: Schedule.spaced("200 millis").pipe(Schedule.upTo({ times: 2 })) };

function layer(token: string, retry?: Retry.Options) {
  const login = Layer.merge(
    fromApiToken({ apiToken: token, apiBaseUrl: process.env.CLOUDFLARE_API_BASE_URL || undefined }),
    FetchHttpClient.layer
  );

  return retry ? Layer.merge(login, Layer.succeed(Retry.Retry, retry)) : login;
}

export class Cloudflare {
  readonly #token: string;
  readonly #layer: Layered;
  readonly login: Login;

  constructor(token: string, login: Login, retry?: Retry.Options) {
    this.#token = token;
    this.#layer = layer(token, retry);
    this.login = login;
  }

  /** The same login, with a permission check's brief retries. */
  briefly(): Cloudflare {
    return new Cloudflare(this.#token, this.login, BRIEFLY);
  }

  /** Runs one operation; a failure throws a CloudflareError. */
  async run<A, E>(operation: Effect.Effect<A, E, Services>): Promise<A> {
    const exit = await Effect.runPromiseExit(operation.pipe(Effect.provide(this.#layer)));

    if (Exit.isSuccess(exit)) return exit.value;
    const error = Cause.squash(exit.cause);
    const tag = Value.Check(Tagged, error) ? error._tag : "UnknownError";
    const message = error instanceof Error ? error.message : String(error);

    throw new CloudflareError(
      tag,
      REFUSALS.has(tag)
        ? `${message} (signed in with ${this.login}). ky needs a token with ${SCOPES}: create one at ${tokenPage()}, then run \`ky login\`.`
        : message
    );
  }

  /** Every item of a paginated operation. */
  list<A, E>(items: Stream.Stream<A, E, Services>): Promise<A[]> {
    return this.run(Stream.runCollect(items).pipe(Effect.map((all) => [...all])));
  }

  /** The operation's result, or undefined when it fails with one of `missing` (say `NoSuchBucket`). */
  async find<A, E>(operation: Effect.Effect<A, E, Services>, ...missing: string[]): Promise<A | undefined> {
    try {
      return await this.run(operation);
    } catch (error) {
      if (error instanceof CloudflareError && missing.includes(error.tag)) return undefined;
      throw error;
    }
  }
}

/**
 * The user's Cloudflare login for this run: CLOUDFLARE_API_TOKEN, else the token `ky login` saved,
 * else cf's, else wrangler's. A blank one, such as `$(cat missing)`'s, is unset.
 */
export async function login(saved: () => Promise<string | undefined>): Promise<Cloudflare> {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();

  if (token) return new Cloudflare(token, "CLOUDFLARE_API_TOKEN");
  const kept = await saved();

  if (kept) return new Cloudflare(kept, "ky login");
  const cf = await cfToken();

  if (cf) return new Cloudflare(cf, "cf login");
  const wrangler = await wranglerToken();

  if (wrangler) return new Cloudflare(wrangler, "wrangler login");
  throw new Error("Not signed in to Cloudflare: run `cf auth login` or `ky login`");
}

/** What `cf auth whoami` prints when it isn't a terminal; the rest is ignored. */
const CfWhoami = Type.Object({ authenticated: Type.Boolean(), authSource: Type.Optional(Type.String()) });

/** Where cf's OAuth login says it keeps its token, and the token's shape there. */
const CF_SOURCE = /^OAuth token from (.+\.json)$/;

const CfConfig = Type.Object({ oauth_token: Type.String({ minLength: 1 }) });

/**
 * cf's OAuth login: `cf auth whoami` refreshes its token when it's expired and names the file it read,
 * which holds the fresh one. Undefined when cf is missing, signed out, or keeps its token elsewhere.
 */
async function cfToken(): Promise<string | undefined> {
  try {
    // Without a blank CLOUDFLARE_API_TOKEN, which cf would take as its login.
    const { CLOUDFLARE_API_TOKEN: _blank, ...env } = process.env;
    const { stdout } = await promisify(execFile)("cf", ["auth", "whoami"], { timeout: 30_000, env });
    const whoami = parseOr(CfWhoami, stdout, undefined);
    const file = whoami?.authenticated ? CF_SOURCE.exec(whoami.authSource ?? "")?.[1] : undefined;

    if (!file) return undefined;

    return parseOr(CfConfig, await readFile(file, "utf8"), undefined)?.oauth_token;
  } catch {
    return undefined;
  }
}

/** wrangler's own login, refreshed by wrangler; undefined when wrangler is missing or signed out. */
async function wranglerToken(): Promise<string | undefined> {
  try {
    // Without a blank CLOUDFLARE_API_TOKEN, which wrangler would take as its login.
    const { CLOUDFLARE_API_TOKEN: _blank, ...env } = process.env;
    const { stdout } = await promisify(execFile)("wrangler", ["auth", "token"], { timeout: 30_000, env });

    return stdout.trim().split("\n").at(-1)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** What a deploy needs, by the dashboard's name and its template key; `wrangler login` has neither Access one. */
const PERMISSIONS = [
  ["Account Settings: Read", "account_settings", "read"],
  ["Workers Scripts: Edit", "workers_scripts", "edit"],
  ["Workers R2 Storage: Edit", "workers_r2", "edit"],
  ["Access: Apps and Policies: Edit", "access", "edit"],
  ["Access: Organizations, Identity Providers, and Groups: Read", "access_acct", "read"]
];

export const SCOPES = PERMISSIONS.map(([scope]) => scope).join(", ");

/** What routing ky's mail needs too, when it has an address: finding its domain's zone, reading Email Routing, making the rule. */
const MAIL_PERMISSIONS = [
  ["Zone: Read", "zone", "read"],
  ["Zone Settings: Read", "zone_settings", "read"],
  ["Email Routing Rules: Edit", "email_routing_rule", "edit"]
];

export const MAIL_SCOPES = MAIL_PERMISSIONS.map(([scope]) => scope).join(", ");

/** Where the user edits a token they have, to add what it lacks. */
const TOKENS_PAGE = "https://dash.cloudflare.com/profile/api-tokens";

/** Each permission past Account Settings, with a read only it allows: reading tells, and changes nothing. */
const PROBES: Array<[string, (cloudflare: Cloudflare, accountId: string) => Promise<void>]> = [
  [
    "Workers Scripts: Edit",
    async (cloudflare, accountId) => {
      await cloudflare.list(Workers.listScripts.items({ accountId }));
    }
  ],
  [
    "Workers R2 Storage: Edit",
    async (cloudflare, accountId) => {
      await cloudflare.run(R2.listBuckets({ accountId }));
    }
  ],
  [
    "Access: Apps and Policies: Edit",
    async (cloudflare, accountId) => {
      await cloudflare.list(ZeroTrust.listAccessApplicationsForAccount.items({ accountId }));
    }
  ],
  [
    "Access: Organizations, Identity Providers, and Groups: Read",
    async (cloudflare, accountId) => {
      await cloudflare.find(ZeroTrust.listOrganizationsForAccount({ accountId }), "OrganizationNotFound");
    }
  ]
];

/** `scope` when Cloudflare refuses `read`, else nothing. */
async function refusedFor(scope: string, read: () => Promise<void>): Promise<string[]> {
  try {
    await read();

    return [];
  } catch (error) {
    if (refused(error)) return [scope];
    throw error;
  }
}

/** What of MAIL_PERMISSIONS the login lacks for `mail`'s domain, read by reads alone. A domain not on the account is the deploy's to report. */
async function missingForMail(cloudflare: Cloudflare, accountId: string, mail: string): Promise<string[]> {
  const domain = mail.split("@")[1] ?? "";
  let zone: { id: string } | undefined;

  const zoneRead = await refusedFor("Zone: Read", async () => {
    [zone] = await cloudflare.list(Zones.listZones.items({ name: domain, account: { id: accountId } }));
  });

  if (!zone) return zoneRead;
  const zoneId = zone.id;

  const rest = await Promise.all([
    refusedFor("Zone Settings: Read", async () => {
      await cloudflare.run(EmailRouting.getEmailRouting({ zoneId }));
    }),
    refusedFor("Email Routing Rules: Edit", async () => {
      await cloudflare.list(EmailRouting.listRules.items({ zoneId }));
    })
  ]);

  return rest.flat();
}

/**
 * The permissions a deploy needs that the login lacks on the account, by the dashboard's names; none when it has them all.
 * With `mail`, ky's address, routing its mail is part of the deploy.
 */
export async function missingPermissions(login: Cloudflare, accountId: string, mail?: string): Promise<string[]> {
  const cloudflare = login.briefly();
  const accounts = await cloudflare.list(Accounts.listAccounts.items({}));

  if (!accounts.some((account) => account.id === accountId)) return [`Account Settings: Read, on account ${accountId}`];

  const refusedBy = await Promise.all(PROBES.map(([scope, probe]) => refusedFor(scope, () => probe(cloudflare, accountId))));

  return [...refusedBy.flat(), ...(mail ? await missingForMail(cloudflare, accountId, mail) : [])];
}

/** Why the login can't deploy, and what fixes it: a token with all a deploy needs, saved with `ky login`. */
export function lacks(login: Login, missing: string[]): string {
  const fix = `create a token with all a deploy needs at ${tokenPage()}, then run \`ky login\``;

  if (login === "wrangler login") return `wrangler's login can't manage Access (it lacks ${missing.join(", ")}): ${fix}`;

  if (login === "cf login") return `cf's login lacks ${missing.join(", ")}: run \`cf auth login\` again, or ${fix}`;

  return `The token from ${login} lacks ${missing.join(", ")}. Add ${missing.length > 1 ? "them" : "it"} to the token at ${TOKENS_PAGE}, or ${fix}`;
}

/** Throws, naming what's missing, unless the login has every permission a deploy needs on the account. */
export async function ready(cloudflare: Cloudflare, accountId: string, mail?: string): Promise<void> {
  const missing = await missingPermissions(cloudflare, accountId, mail);

  if (missing.length > 0) throw new Error(lacks(cloudflare.login, missing));
}

/**
 * The dashboard page that creates an API token with what a deploy needs, mail's routing
 * included, for a user without wrangler (or whose wrangler login can't manage Access).
 */
export function tokenPage(): string {
  const permissions = [...PERMISSIONS, ...MAIL_PERMISSIONS].map(([, key, type]) => ({ key, type }));

  const url = new URL("https://dash.cloudflare.com/profile/api-tokens");

  url.searchParams.set("permissionGroupKeys", JSON.stringify(permissions));
  url.searchParams.set("accountId", "*");
  url.searchParams.set("zoneId", "all");
  url.searchParams.set("name", "ky");

  return url.toString();
}

/**
 * GET /workers/services/{name}, which @distilled.cloud/cloudflare doesn't have: where wrangler
 * reads a Worker's migration tag, `default_environment.script.migration_tag`.
 */
export const getService = API.make(() => ({
  input: S.Struct({
    accountId: S.String.pipe(T.Label("account_id")),
    serviceName: S.String.pipe(T.Label("service_name"))
  }).pipe(T.Http({ method: "GET", uri: "/accounts/{account_id}/workers/services/{service_name}", code: 200 })),
  output: S.Struct({
    defaultEnvironment: S.Struct({
      script: S.Struct({ migrationTag: S.optional(S.NullOr(S.String).pipe(T.Body("migration_tag"))) })
    }).pipe(T.Body("default_environment"))
  }),
  errors: [Workers.WorkerNotFound, Workers.Forbidden, CloudflareRateLimited, ApiError],
  protocol: CloudflareProtocol,
  retry: Retry.Retry
}));
