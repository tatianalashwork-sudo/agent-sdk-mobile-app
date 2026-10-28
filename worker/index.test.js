import { afterEach, expect, mock, test } from "bun:test";
import worker from "./index.js";

const env = {
  ACCESS_CODE: "test-only-access-code",
  LETTA_API_KEY: "test-only-letta-key",
  ASSETS: { fetch: async () => new Response("<html>app shell</html>", { headers: { "Content-Type": "text/html" } }) },
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

test("no cookie gets only the login page; API calls are rejected locally", async () => {
  const page = await worker.fetch(new Request("https://bloop.example/"), env);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("private access code");

  const api = await worker.fetch(new Request("https://bloop.example/api/v1/agents"), env);
  expect(api.status).toBe(401);
  expect(await api.json()).toMatchObject({ error: "Sign in to use this private app." });
});

test("correct access code creates a signed HttpOnly cookie and unlocks assets", async () => {
  const body = new URLSearchParams({ code: env.ACCESS_CODE });
  const response = await worker.fetch(new Request("https://bloop.example/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }), env);
  expect(response.status).toBe(303);
  const cookie = response.headers.get("Set-Cookie");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("SameSite=Lax");

  const app = await worker.fetch(new Request("https://bloop.example/", {
    headers: { Cookie: cookie.split(";")[0] },
  }), env);
  expect(await app.text()).toContain("app shell");
});

test("API proxy strips browser headers, injects server key, and preserves SDK path", async () => {
  let observed;
  globalThis.fetch = async (request) => {
    observed = request;
    return new Response("upstream", { status: 200 });
  };
  const body = new URLSearchParams({ code: env.ACCESS_CODE });
  const login = await worker.fetch(new Request("https://bloop.example/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }), env);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];

  const response = await worker.fetch(new Request("https://bloop.example/api/v1/agents?limit=2", {
    headers: { Cookie: cookie, Origin: "https://bloop.example", Authorization: "Bearer proxy" },
  }), env);
  expect(response.status).toBe(200);
  expect(observed.url).toBe("https://api.letta.com/v1/agents?limit=2");
  expect(observed.headers.get("Authorization")).toBe(`Bearer ${env.LETTA_API_KEY}`);
  expect(observed.headers.get("Origin")).toBeNull();
  expect(observed.headers.get("Cookie")).toBeNull();
});

test("SDK root WebSocket route is proxied without its placeholder token", async () => {
  let observed;
  globalThis.fetch = async (request) => {
    observed = request;
    return new Response("upstream", { status: 200 });
  };
  const body = new URLSearchParams({ code: env.ACCESS_CODE });
  const login = await worker.fetch(new Request("https://bloop.example/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }), env);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];

  await worker.fetch(new Request("https://bloop.example/v1/environments/env-1/status/ws?token=proxy&agentId=a", {
    headers: { Cookie: cookie, Upgrade: "websocket", Origin: "https://bloop.example" },
  }), env);
  const target = new URL(observed.url);
  expect(target.origin).toBe("https://api.letta.com");
  expect(target.pathname).toBe("/v1/environments/env-1/status/ws");
  expect(target.searchParams.get("token")).toBe(env.LETTA_API_KEY);
  expect(observed.headers.get("Origin")).toBeNull();
});
