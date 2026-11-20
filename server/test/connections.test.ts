import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.ts";
import { createConnections } from "../src/connections.ts";

const person = () => {
  const store = openStore(mkdtempSync(join(tmpdir(), "sidebots-test-")));
  return { store, person: store.addPerson({ name: "Alex", provider: "claude", configDir: "/config/alex" }) };
};

test("a turn is handed the server of each connection the person has made, with a token from its maker, and none for one that can't be renewed", async () => {
  const { store, person: alex } = person();
  store.setConnection(alex.id, "gmail", { account: "alex@example.com", token: "lasting" });
  store.setConnection(alex.id, "notion", { account: "Notion", token: "lasting" });
  let notion: () => Response = () => Response.json({ access_token: "notion-access", expires_in: 3600 });
  const connections = createConnections(store, { google: "sidebots-test.apps.googleusercontent.com", notion: "https://sidebots.example/oauth-client.json" }, async (url) =>
    String(url) === "https://oauth2.googleapis.com/token" ? Response.json({ access_token: "google-access", expires_in: 3600 }) : notion(),
  );
  // Calendar isn't connected, so its server isn't there.
  assert.deepEqual(await connections.servers(alex.id), {
    gmail: { url: "https://gmailmcp.googleapis.com/mcp/v1", token: "google-access" },
    notion: { url: "https://mcp.notion.com/mcp", token: "notion-access" },
  });

  // A maker that won't renew a sign-in for now leaves its server out and the connection be. One that has ended it has the connection forgotten.
  connections.remove(alex.id, "notion");
  store.setConnection(alex.id, "notion", { account: "Notion", token: "lasting" });
  notion = () => Response.json({ error: "temporarily_unavailable" }, { status: 503 });
  assert.deepEqual(Object.keys(await connections.servers(alex.id)), ["gmail"]);
  assert.equal(connections.account(alex.id, "notion"), "Notion");
  notion = () => Response.json({ error: "invalid_grant" }, { status: 400 });
  assert.deepEqual(Object.keys(await connections.servers(alex.id)), ["gmail"]);
  assert.equal(connections.account(alex.id, "notion"), null);
});

test("a token asked for under a sign-in the person has since replaced is not used, and its refusal leaves the new connection be", async () => {
  const { store, person: alex } = person();
  store.setConnection(alex.id, "gmail", { account: "old@example.com", token: "old" });
  const connections = createConnections(store, { google: "sidebots-test.apps.googleusercontent.com" }, async (_url, init) => {
    const lasting = new URLSearchParams(String(init?.body)).get("refresh_token");
    if (lasting === "new") return Response.json({ access_token: "access-new", expires_in: 3600 });
    // The person connects another account while Google is asked about the one before.
    store.setConnection(alex.id, "gmail", { account: "new@example.com", token: "new" });
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  });
  assert.deepEqual([(await connections.servers(alex.id)).gmail?.token, connections.account(alex.id, "gmail")], ["access-new", "new@example.com"]);
});

test("a person signs in to Notion with the file that says what Sidebots is, and each new token that lasts is kept in place of the one it ends", async () => {
  const { store, person: alex } = person();
  const swaps: URLSearchParams[] = [];
  let lasting = 0;
  let time = 0;
  // Notion ends the token that lasts as it answers with the next.
  const connections = createConnections(
    store,
    { notion: "https://sidebots.example/oauth-client.json" },
    async (url, init) => {
      assert.equal(String(url), "https://mcp.notion.com/token");
      const swap = new URLSearchParams(String(init?.body));
      swaps.push(swap);
      if (swap.get("grant_type") === "refresh_token" && swap.get("refresh_token") !== `lasting-${lasting}`) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: `access-${++lasting}`, expires_in: 3600, refresh_token: `lasting-${lasting}` });
    },
    () => time,
  );

  // Notion's page is asked for tokens for its tool server, and comes back to the address the file lists.
  const signIn = connections.signIn(alex.id, "notion");
  const page = new URL(signIn.url);
  assert.equal(`${page.origin}${page.pathname}`, "https://mcp.notion.com/authorize");
  assert.deepEqual(
    [signIn.redirect, ...["client_id", "redirect_uri", "scope", "resource", "code_challenge_method"].map((name) => page.searchParams.get(name))],
    ["app.sidebots:/oauth2redirect", "https://sidebots.example/oauth-client.json", "app.sidebots:/oauth2redirect", "default", "https://mcp.notion.com/mcp", "S256"],
  );
  // Notion doesn't say who signed in, so the connection is listed under its name.
  const connected = await connections.finish(alex.id, "notion", `${signIn.redirect}?state=${page.searchParams.get("state")}&code=one-time`);
  assert.deepEqual([connected.account, store.connection(alex.id, "notion")], ["Notion", { account: "Notion", token: "lasting-1" }]);
  assert.deepEqual(["code", "client_id", "resource"].map((name) => swaps[0].get(name)), ["one-time", "https://sidebots.example/oauth-client.json", "https://mcp.notion.com/mcp"]);
  assert.deepEqual(await connections.servers(alex.id), { notion: { url: "https://mcp.notion.com/mcp", token: "access-1" } });

  // Turns that start at once ask for one new token between them, and the new token that lasts is kept.
  time = 1_800_000;
  const [one, other] = await Promise.all([connections.servers(alex.id), connections.servers(alex.id)]);
  assert.deepEqual([one.notion?.token, other.notion?.token], ["access-2", "access-2"]);
  assert.deepEqual([swaps.length, swaps[1].get("refresh_token"), store.connection(alex.id, "notion")?.token], [2, "lasting-1", "lasting-2"]);
});
