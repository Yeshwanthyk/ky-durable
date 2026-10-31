/**
 * A fake of OpenAI's auth server for ChatGPT's sign-in, as the Vault calls
 * it (src/chatgpt.ts): the device code, its poll, the code exchange and the
 * refresh grant. It runs in the Worker, so the Vault's `openai` is its
 * `fetch`; it makes no network call.
 *
 * A device code asks to wait once, then is approved. Every token is a JWT of
 * its own: access tokens expire ACCESS_TTL_MS after they are made, by the
 * clock given (the Vault's, which a test can move ahead), and each refresh
 * rotates the refresh token, as OpenAI does.
 */

/** How long an access token lasts. */
const ACCESS_TTL_MS = 2 * 60 * 60_000;

/** The account every token names. */
export const ACCOUNT_ID = "acct-fake";

export type OpenAiCall = { path: string; grant?: string };

export type FakeOpenAi = {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  calls: OpenAiCall[];
  /** Refuse every refresh from now on, as OpenAI does a revoked login. */
  revoke: () => void;
};

type Claims = { readonly [claim: string]: string | number | Claims };

const encode = (value: Claims) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** An unsigned JWT with `claims`; ky reads claims and never checks signatures. */
const jwt = (claims: Claims) => `${encode({ alg: "none" })}.${encode(claims)}.fake`;

const error = (status: number, code: string) => Response.json({ error: { code } }, { status });

export function fakeOpenAi(now: () => number): FakeOpenAi {
  const calls: OpenAiCall[] = [];
  const polls = new Map<string, number>();
  let issued = 0;
  let revoked = false;

  const tokens = () => {
    issued++;

    return Response.json({
      id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID }, n: issued }),
      // As OpenAI's do, the access token names the account too: Codex's backend wants it as chatgpt-account-id.
      access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID }, exp: Math.floor((now() + ACCESS_TTL_MS) / 1000), n: issued }),
      refresh_token: `refresh-${issued}`
    });
  };

  const usercode = () => {
    const id = `device-${polls.size + 1}`;
    polls.set(id, 0);

    return Response.json({ device_auth_id: id, user_code: `FAKE-${polls.size}`, interval: "1" });
  };

  const deviceToken = (body: string) => {
    const { device_auth_id: id } = JSON.parse(body);
    const count = polls.get(id);

    if (count === undefined) return error(404, "deviceauth_not_found");
    polls.set(id, count + 1);

    return count === 0 ? error(403, "deviceauth_authorization_pending") : Response.json({ authorization_code: `code-${id}`, code_verifier: `verifier-${id}` });
  };

  const oauthToken = (body: string) => {
    const grant = new URLSearchParams(body).get("grant_type") ?? "";
    calls.push({ path: "/oauth/token", grant });

    return grant === "refresh_token" && revoked ? error(401, "refresh_token_invalidated") : tokens();
  };

  const routes = new Map<string, (body: string) => Response>([
    ["/api/accounts/deviceauth/usercode", usercode],
    ["/api/accounts/deviceauth/token", deviceToken],
    ["/oauth/token", oauthToken]
  ]);

  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const { pathname } = new URL(input);
    const route = routes.get(pathname);

    if (!route) return new Response("Not found", { status: 404 });

    if (pathname !== "/oauth/token") calls.push({ path: pathname });

    return route(String(init.body ?? ""));
  };

  return {
    fetch,
    calls,
    revoke: () => {
      revoked = true;
    }
  };
}
