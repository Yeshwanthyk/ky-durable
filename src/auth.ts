/**
 * One user, one secret. The browser signs in once with `KY_TOKEN` and keeps
 * it in an HttpOnly cookie; a runner sends it as a bearer token.
 */

// The Workers runtime has this; the DOM typings, which win for `crypto`, do not.
declare global {
  interface SubtleCrypto {
    timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
  }
}

const COOKIE = "ky_token";

const YEAR_SECONDS = 365 * 24 * 60 * 60;

const encoder = new TextEncoder();

function same(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);

  if (left.byteLength !== right.byteLength) return false;

  return crypto.subtle.timingSafeEqual(left, right);
}

function presented(request: Request): string | undefined {
  const header = request.headers.get("Authorization");

  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  const cookies = request.headers.get("Cookie") ?? "";

  for (const part of cookies.split(";")) {
    const [name, ...value] = part.trim().split("=");

    if (name === COOKIE) return decodeURIComponent(value.join("="));
  }

  return undefined;
}

export async function authenticate(request: Request, env: Env): Promise<boolean> {
  const token = presented(request);

  if (!env.KY_TOKEN || !token) return false;

  return same(token, env.KY_TOKEN);
}

export async function login(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const token = String(form.get("token") ?? "");

  if (!env.KY_TOKEN || !same(token, env.KY_TOKEN)) {
    return loginPage("That token is not right.", 401);
  }

  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${YEAR_SECONDS}; HttpOnly; Secure; SameSite=Lax`
    }
  });
}

export function loginPage(error?: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ky</title>
<style>
  body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#0d0d0d;color:#eee;font:16px system-ui,sans-serif}
  form{display:grid;gap:12px;width:min(320px,90vw)}
  input,button{font:inherit;padding:12px 14px;border-radius:10px;border:1px solid #333;background:#171717;color:inherit}
  button{background:#eee;color:#111;border:0;font-weight:600}
  p{margin:0;color:#f87171;font-size:14px}
</style></head>
<body><form method="post" action="/login">
  <h1 style="margin:0 0 8px">ky</h1>
  <input name="token" type="password" placeholder="Token" autocomplete="current-password" autofocus required>
  <button>Sign in</button>
  ${error ? `<p>${error}</p>` : ""}
</form></body></html>`;

  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
