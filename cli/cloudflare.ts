/**
 * The Cloudflare API, with the user's own login, for this run only. ky keeps
 * no Cloudflare token: `ky` asks for one each run (CLOUDFLARE_API_TOKEN, or
 * `wrangler auth token`), holds it in memory, and never writes it anywhere.
 *
 * Every call is a @distilled.cloud/cloudflare operation, run here so the rest
 * of the CLI is plain async code. CLOUDFLARE_API_BASE_URL points it at another
 * API, as it does wrangler; the tests point it at test/fakes/cloudflare.ts.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** Where the token came from, so a refusal can say which login to fix. */
export type Login = "CLOUDFLARE_API_TOKEN" | "wrangler login" | "a pasted token";

/** A failed call: Cloudflare's own error, with its tag (`NoSuchBucket`, `Forbidden`, …). */
export class CloudflareError extends Error {
  readonly tag: string;

  constructor(tag: string, message: string) {
    super(message);
    this.tag = tag;
  }
}

/** What @distilled.cloud/cloudflare fails with: Cloudflare's error, tagged by its code. */
const Tagged = Type.Object({ _tag: Type.String() });

type Layered = ReturnType<typeof layer>;

type Services = Layer.Success<Layered>;

function layer(token: string) {
  return Layer.merge(
    fromApiToken({ apiToken: token, apiBaseUrl: process.env.CLOUDFLARE_API_BASE_URL || undefined }),
    FetchHttpClient.layer
  );
}

export class Cloudflare {
  readonly #layer: Layered;
  readonly login: Login;

  constructor(token: string, login: Login) {
    this.#layer = layer(token);
    this.login = login;
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
      tag === "Forbidden" || tag === "Unauthorized"
        ? `${message} (signed in with ${this.login}). A token from ${tokenPage()} can do everything ky needs: set CLOUDFLARE_API_TOKEN to it.`
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

/** The user's Cloudflare login for this run: CLOUDFLARE_API_TOKEN, or else wrangler's. */
export async function login(): Promise<Cloudflare> {
  const token = process.env.CLOUDFLARE_API_TOKEN;

  if (token) return new Cloudflare(token, "CLOUDFLARE_API_TOKEN");
  const wrangler = await wranglerToken();

  if (wrangler) return new Cloudflare(wrangler, "wrangler login");
  throw new Error(`Not signed in to Cloudflare: run \`wrangler login\`, or set CLOUDFLARE_API_TOKEN to a token from ${tokenPage()}`);
}

/** wrangler's own login, refreshed by wrangler; undefined when wrangler is missing or signed out. */
async function wranglerToken(): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)("wrangler", ["auth", "token"], { timeout: 30_000 });

    return stdout.trim().split("\n").at(-1)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The dashboard page that creates an API token with what a deploy needs, for
 * a user without wrangler (or whose wrangler login can't manage Access).
 */
export function tokenPage(): string {
  const permissions = [
    ["account_settings", "read"],
    ["workers_scripts", "edit"],
    ["workers_r2", "edit"],
    ["access", "edit"]
  ].map(([key, type]) => ({ key, type }));

  const url = new URL("https://dash.cloudflare.com/profile/api-tokens");

  url.searchParams.set("permissionGroupKeys", JSON.stringify(permissions));
  url.searchParams.set("accountId", "*");
  url.searchParams.set("name", "ky");

  return url.toString();
}
