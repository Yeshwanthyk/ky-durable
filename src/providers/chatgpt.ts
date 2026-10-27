import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type ChatGptLogin, ChatGptNoAccount, ChatGptRefused, ChatGptUnreadable, type Device, type Fetch, Unreached } from "./contract";

const OPENAI_ISSUER = "https://auth.openai.com";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const DeviceAnswer = Schema.Struct({ device_auth_id: Schema.String, user_code: Schema.String, interval: Schema.String });

const Authorization = Schema.Struct({ authorization_code: Schema.String, code_verifier: Schema.String });

const Tokens = Schema.Struct({ id_token: Schema.String, access_token: Schema.String, refresh_token: Schema.String });

const Refreshed = Schema.Struct({ access_token: Schema.String, id_token: Schema.optional(Schema.String), refresh_token: Schema.optional(Schema.String) });

const Claims = Schema.Struct({
  exp: Schema.optional(Schema.Number),
  chatgpt_account_id: Schema.optional(Schema.String),
  "https://api.openai.com/auth": Schema.optional(Schema.Struct({ chatgpt_account_id: Schema.optional(Schema.String) }))
});

const Coded = Schema.Struct({ code: Schema.optional(Schema.String) });

const ErrorAnswer = Schema.Struct({ code: Schema.optional(Schema.String), error: Schema.optional(Schema.Union([Schema.String, Coded])) });

const errorOf = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorAnswer));

const claimsOf = Schema.decodeUnknownOption(Schema.fromJsonString(Claims));

const isCoded = Schema.is(Coded);

type Step = "sign-in" | "refresh";

const reach = (fetch: Fetch, input: string, init: RequestInit) =>
  Effect.tryPromise({ try: () => fetch(input, init), catch: (thrown) => new Unreached({ message: thrown instanceof Error ? thrown.message : String(thrown) }) });

const textOf = (response: Response) => Effect.promise(() => response.text().catch(() => ""));

const errorCode = (response: Response) =>
  Effect.map(textOf(response.clone()), (text) =>
    Option.getOrUndefined(Option.map(errorOf(text), ({ code, error }) => code ?? (isCoded(error) ? error.code : error)))
  );

const refusedBy = (step: Step, response: Response) =>
  Effect.flatMap(errorCode(response), (code) => Effect.fail(new ChatGptRefused(code ? { step, status: response.status, code } : { step, status: response.status })));

const decoded = <S extends Schema.Decoder<unknown>>(step: Step, response: Response, schema: S) =>
  Effect.gen(function* () {
    if (!response.ok) return yield* refusedBy(step, response);
    const text = yield* textOf(response);

    return yield* Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text), {
      onNone: () => Effect.fail(new ChatGptUnreadable({ step, what: "an answer" })),
      onSome: (value) => Effect.succeed(value)
    });
  });

function payload(jwt: string): Option.Option<string> {
  try {
    return Option.some(atob((jwt.split(".")[1] ?? "").replaceAll("-", "+").replaceAll("_", "/")));
  } catch {
    return Option.none();
  }
}

const claims = (step: Step, jwt: string) =>
  Option.match(Option.flatMap(payload(jwt), claimsOf), {
    onNone: () => Effect.fail(new ChatGptUnreadable({ step, what: "a token" })),
    onSome: (value) => Effect.succeed(value)
  });

const login = (step: Step, tokens: { access_token: string; id_token: string; refresh_token: string }) =>
  Effect.gen(function* () {
    const identity = yield* claims(step, tokens.id_token);
    const accountId = identity["https://api.openai.com/auth"]?.chatgpt_account_id ?? identity.chatgpt_account_id;
    const { exp } = yield* claims(step, tokens.access_token);

    if (!accountId || exp === undefined) return yield* new ChatGptNoAccount({ step });

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      accountId,
      expiresAt: exp * 1000
    } satisfies ChatGptLogin;
  });

const json = (body: Record<string, string>): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const form = (body: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString()
});

export const startDevice = Effect.fnUntraced(function* (fetch: Fetch) {
  const response = yield* reach(fetch, `${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`, json({ client_id: CLIENT_ID }));
  const body = yield* decoded("sign-in", response, DeviceAnswer);
  const interval = Number(body.interval);

  if (!Number.isFinite(interval) || interval < 1) return yield* new ChatGptUnreadable({ step: "sign-in", what: "an answer" });

  return { deviceAuthId: body.device_auth_id, userCode: body.user_code, intervalMs: interval * 1000 } satisfies Device;
});

export const pollDevice = Effect.fnUntraced(function* (fetch: Fetch, device: Device) {
  const response = yield* reach(fetch, `${OPENAI_ISSUER}/api/accounts/deviceauth/token`, json({ device_auth_id: device.deviceAuthId, user_code: device.userCode }));

  if ((response.status === 403 || response.status === 404) && (yield* errorCode(response)) === "deviceauth_authorization_pending") return "pending" as const;
  const authorization = yield* decoded("sign-in", response, Authorization);

  const tokens = yield* reach(
    fetch,
    `${OPENAI_ISSUER}/oauth/token`,
    form({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: authorization.authorization_code,
      redirect_uri: `${OPENAI_ISSUER}/deviceauth/callback`,
      code_verifier: authorization.code_verifier
    })
  );

  return yield* login("sign-in", yield* decoded("sign-in", tokens, Tokens));
});

export const refreshLogin = Effect.fnUntraced(function* (fetch: Fetch, current: ChatGptLogin) {
  const response = yield* reach(
    fetch,
    `${OPENAI_ISSUER}/oauth/token`,
    form({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: current.refreshToken, scope: "openid profile email" })
  );

  const tokens = yield* decoded("refresh", response, Refreshed);

  return yield* login("refresh", {
    access_token: tokens.access_token,
    id_token: tokens.id_token ?? current.idToken,
    refresh_token: tokens.refresh_token ?? current.refreshToken
  });
});
