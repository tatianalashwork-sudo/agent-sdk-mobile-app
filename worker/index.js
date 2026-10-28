const UPSTREAM = "https://api.letta.com";
const COOKIE = "bloop_auth";
const MAX_AGE = 60 * 60 * 24 * 30;
const encoder = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/login") return login(request, env, url);
    if (url.pathname === "/logout") return logout(url);

    const apiRoute = url.pathname === "/api" || url.pathname.startsWith("/api/");
    const sdkRootRoute = url.pathname === "/v1" || url.pathname.startsWith("/v1/");

    if (!(await authenticated(request, env))) {
      return apiRoute || sdkRootRoute
        ? json(401, { error: "Sign in to use this private app." })
        : loginPage(url.searchParams.get("error") === "1");
    }

    if (apiRoute) {
      const path = url.pathname.slice("/api".length) || "/";
      return proxy(request, new URL(`${path}${url.search}`, UPSTREAM), env);
    }
    // The SDK intentionally resets the path to /v1 for its status WebSocket.
    if (sdkRootRoute) return proxy(request, new URL(`${url.pathname}${url.search}`, UPSTREAM), env);

    if (!env.ASSETS) return new Response("Static assets are not configured.", { status: 500 });
    return env.ASSETS.fetch(request);
  },
};

async function login(request, env, url) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!env.ACCESS_CODE || !env.LETTA_API_KEY) {
    return new Response("The private app has not been configured yet.", { status: 503 });
  }
  let code = "";
  try {
    code = String((await request.formData()).get("code") ?? "");
  } catch {
    // A non-form request cannot authenticate.
  }
  if (!(await equal(code, env.ACCESS_CODE))) return new Response(null, {
    status: 303,
    headers: { Location: "/?error=1", "Cache-Control": "no-store" },
  });

  const expiry = String(Date.now() + MAX_AGE * 1000);
  const signature = await sign(env.ACCESS_CODE, expiry);
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `${COOKIE}=${expiry}.${signature}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
      "Cache-Control": "no-store",
    },
  });
}

function logout(url) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      "Cache-Control": "no-store",
    },
  });
}

async function authenticated(request, env) {
  if (!env.ACCESS_CODE) return false;
  const cookie = request.headers.get("Cookie")?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!cookie) return false;
  const dot = cookie.indexOf(".");
  if (dot < 1) return false;
  const expiry = cookie.slice(0, dot);
  if (!/^\d+$/.test(expiry) || Number(expiry) <= Date.now()) return false;
  return equal(cookie.slice(dot + 1), await sign(env.ACCESS_CODE, expiry));
}

async function proxy(request, target, env) {
  if (!env.LETTA_API_KEY) return json(503, { error: "The Letta connection is not configured." });
  // Browser WebSockets use a query token; the SDK only ever sends the harmless
  // placeholder. Replace it before the request leaves this Worker.
  if (target.searchParams.has("token")) target.searchParams.set("token", env.LETTA_API_KEY);
  const upstream = new Request(target, request);
  upstream.headers.delete("Origin");
  upstream.headers.delete("Referer");
  upstream.headers.delete("Host");
  upstream.headers.delete("Cookie");
  upstream.headers.set("Authorization", `Bearer ${env.LETTA_API_KEY}`);
  // Do not read the response body: SSE and WebSocket streams pass through.
  return fetch(upstream);
}

async function sign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function equal(left, right) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}

function loginPage(error = false) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#161618"><title>Bloop</title>
    <style>
      *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;
      background:#161618;color:#fbfbfa;font:16px system-ui,-apple-system,sans-serif}
      form{width:min(90vw,340px);padding:30px;background:#202023;border:1px solid #333;
      border-radius:18px}h1{font-size:24px;margin:0 0 8px}p{color:#aaa;margin:0 0 22px}
      .error{display:${error ? "block" : "none"};color:#f08080;margin:-10px 0 12px}
      input,button{width:100%;font:inherit;border-radius:10px;padding:12px}
      input{color:inherit;background:#161618;border:1px solid #444;margin-bottom:12px}
      button{border:0;background:#e8823c;color:#161618;font-weight:650}
    </style></head><body><form method="post" action="/login"><h1>Bloop</h1>
    <p>Enter your private access code.</p><p class="error">That code did not work. Try again.</p>
    <input type="password" name="code" autocomplete="current-password" required autofocus>
    <button>Continue</button></form></body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
