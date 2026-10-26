import * as Schema from "effect/Schema";
import type { Refusable } from "../core/edge";

export const BYPASS = ["/runner/*", "/api/runners/pair", "/api/files", "/peer/*", "/manifest.webmanifest", "/icons/*", "/p/*", "/hooks/*"];

export const ASSERTION = "Cf-Access-Jwt-Assertion";

export function bypassed(pathname: string): boolean {
  return BYPASS.some((path) =>
    path.endsWith("/*") ? pathname.startsWith(path.slice(0, -1)) : pathname === path || pathname.startsWith(`${path}/`)
  );
}

export type AccessVars = Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD" | "ACCESS_EMAILS" | "KY_DEV" | "KY_DEV_EMAIL">;

const SIGN_IN = "Sign in to ky through Cloudflare Access.";

const NOT_SET_UP =
  "ky's Access isn't set up: it needs ACCESS_TEAM_DOMAIN, ACCESS_AUD and ACCESS_EMAILS. `ky init` sets them up: https://github.com/Yeshwanthyk/ky-durable#quickstart";

const TRY_AGAIN = "ky couldn't check the sign-in with Cloudflare Access; try again.";

export const JwtHeader = Schema.Struct({ alg: Schema.Literal("RS256"), kid: Schema.String });

export const JwtClaims = Schema.Struct({
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  iss: Schema.String,
  email: Schema.String,
  exp: Schema.Finite,
  nbf: Schema.optionalKey(Schema.Finite)
});

export type JwtClaims = typeof JwtClaims.Type;

export const Certs = Schema.Struct({
  keys: Schema.Array(Schema.Struct({ kid: Schema.String, kty: Schema.Literal("RSA"), n: Schema.String, e: Schema.String }))
});

export class SignInRefused extends Schema.TaggedError<SignInRefused>()("SignInRefused", {}) implements Refusable {
  get refusal(): string {
    return SIGN_IN;
  }
}

export class NotSetUp extends Schema.TaggedError<NotSetUp>()("NotSetUp", {}) implements Refusable {
  get refusal(): string {
    return NOT_SET_UP;
  }
}

export class KeysUnavailable extends Schema.TaggedError<KeysUnavailable>()("KeysUnavailable", { cause: Schema.Defect() }) implements Refusable {
  get refusal(): string {
    return TRY_AGAIN;
  }
}
