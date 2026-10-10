import Type, { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

/**
 * ChatGPT's OAuth, as the Codex CLI signs in with a device code: ported from
 * Scotty's src/creds/oauth.ts, plus the refresh grant. Only the Vault calls
 * it, with its own `fetch`, so tests answer for OpenAI.
 *
 * Every error names the step and OpenAI's status and code, never a token or
 * a device code: the Vault shows refresh errors in Settings.
 */

const OPENAI_ISSUER = "https://auth.openai.com";

/** The Codex CLI's public client. */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Where the user types the code. */
export const VERIFICATION_URL = `${OPENAI_ISSUER}/codex/device`;

/** How long a device code lasts. */
export const DEVICE_CODE_TTL_MS = 15 * 60_000;

/** The ChatGPT login the Vault keeps. Only the Vault ever reads `refreshToken`. */
export type ChatGptLogin = {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  /** Epoch milliseconds, from the access token's `exp`. */
  expiresAt: number;
};

const DeviceSchema = Type.Object({ device_auth_id: Type.String(), user_code: Type.String(), interval: Type.String() });

const AuthorizationSchema = Type.Object({ authorization_code: Type.String(), code_verifier: Type.String() });

const TokensSchema = Type.Object({ id_token: Type.String(), access_token: Type.String(), refresh_token: Type.String() });

/** A refresh may keep the refresh token, and the id token, it was given. */
const RefreshedSchema = Type.Object({
  access_token: Type.String(),
  id_token: Type.Optional(Type.String()),
  refresh_token: Type.Optional(Type.String())
});

const ClaimsSchema = Type.Object({
  exp: Type.Optional(Type.Number()),
  chatgpt_account_id: Type.Optional(Type.String()),
  "https://api.openai.com/auth": Type.Optional(Type.Object({ chatgpt_account_id: Type.Optional(Type.String()) }))
});

const CodedSchema = Type.Object({ code: Type.Optional(Type.String()) });

const ErrorSchema = Type.Object({ code: Type.Optional(Type.String()), error: Type.Optional(Type.Union([Type.String(), CodedSchema])) });

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export type Device = { deviceAuthId: string; userCode: string; intervalMs: number };

/** OpenAI's error code in a failed response, if it says one; leaves the response unread. */
async function errorCode(response: Response): Promise<string | undefined> {
  const body: unknown = await response.clone().json().catch(() => null);

  if (!Value.Check(ErrorSchema, body)) return undefined;
  const { code, error } = body;

  return code ?? (Value.Check(CodedSchema, error) ? error.code : error);
}

async function failure(step: string, response: Response): Promise<Error> {
  const code = await errorCode(response);

  return new Error(`ChatGPT ${step} failed: ${response.status}${code ? ` ${code}` : ""}.`);
}

async function decoded<S extends TSchema>(step: string, response: Response, schema: S): Promise<Static<S>> {
  if (!response.ok) throw await failure(step, response);
  const body: unknown = await response.json().catch(() => null);

  if (!Value.Check(schema, body)) throw new Error(`ChatGPT ${step} failed: an answer ky can't read.`);

  return body;
}

/** A JWT's claims; ky reads them but doesn't verify them, as the Codex CLI doesn't. */
function claims(step: string, jwt: string): Static<typeof ClaimsSchema> {
  try {
    const segment = jwt.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/");
    const parsed: unknown = JSON.parse(atob(segment));

    if (Value.Check(ClaimsSchema, parsed)) return parsed;
  } catch {
    // Not a JWT: refused below.
  }

  throw new Error(`ChatGPT ${step} failed: a token ky can't read.`);
}

/** The login a set of tokens makes. */
function login(step: string, tokens: { access_token: string; id_token: string; refresh_token: string }): ChatGptLogin {
  const identity = claims(step, tokens.id_token);
  const accountId = identity["https://api.openai.com/auth"]?.chatgpt_account_id ?? identity.chatgpt_account_id;
  const exp = claims(step, tokens.access_token).exp;

  if (!accountId || exp === undefined) throw new Error(`ChatGPT ${step} failed: the tokens name no account or expiry.`);

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    accountId,
    expiresAt: exp * 1000
  };
}

const json = (body: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

const form = (body: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString()
});

export async function startDevice(fetch: Fetch): Promise<Device> {
  const response = await fetch(`${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`, json({ client_id: CLIENT_ID }));
  const body = await decoded("sign-in", response, DeviceSchema);
  const interval = Number(body.interval);

  if (!Number.isFinite(interval) || interval < 1) throw new Error("ChatGPT sign-in failed: an answer ky can't read.");

  return { deviceAuthId: body.device_auth_id, userCode: body.user_code, intervalMs: interval * 1000 };
}

/** Whether the user has entered the code yet: once they have, the login. */
export async function pollDevice(fetch: Fetch, device: Device): Promise<ChatGptLogin | "pending"> {
  const response = await fetch(
    `${OPENAI_ISSUER}/api/accounts/deviceauth/token`,
    json({ device_auth_id: device.deviceAuthId, user_code: device.userCode })
  );

  if (response.status === 403 || response.status === 404) {
    const code = await errorCode(response);

    if (code === "deviceauth_authorization_pending") return "pending";
  }

  const authorization = await decoded("sign-in", response, AuthorizationSchema);

  const tokens = await fetch(
    `${OPENAI_ISSUER}/oauth/token`,
    form({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: authorization.authorization_code,
      redirect_uri: `${OPENAI_ISSUER}/deviceauth/callback`,
      code_verifier: authorization.code_verifier
    })
  );

  return login("sign-in", await decoded("sign-in", tokens, TokensSchema));
}

/** A fresh access token for `current`, keeping what OpenAI doesn't send again. */
export async function refreshLogin(fetch: Fetch, current: ChatGptLogin): Promise<ChatGptLogin> {
  const response = await fetch(
    `${OPENAI_ISSUER}/oauth/token`,
    form({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: current.refreshToken, scope: "openid profile email" })
  );

  const tokens = await decoded("refresh", response, RefreshedSchema);

  return login("refresh", {
    access_token: tokens.access_token,
    id_token: tokens.id_token ?? current.idToken,
    refresh_token: tokens.refresh_token ?? current.refreshToken
  });
}
