import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fetchModels, checkApiKey, KNOWN_MODELS } from "../dist/models.js";

function mockApi(handler) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => handler({ method: req.method, url: req.url, body }, res));
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () =>
      r({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((x) => server.close(x)) })
    )
  );
}

test("fetchModels returns the live list from GET /models", async () => {
  const api = await mockApi((ctx, res) => {
    assert.equal(ctx.method, "GET");
    assert.equal(ctx.url, "/models");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] }));
  });
  const models = await fetchModels(api.url, "k");
  await api.close();
  assert.deepEqual(models.map((m) => m.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(models[0].description, "fast & cheap (default)");
});

test("fetchModels falls back to the known lineup on failure", async () => {
  const api = await mockApi((ctx, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  const models = await fetchModels(api.url, "k");
  await api.close();
  assert.deepEqual(models.map((m) => m.id), KNOWN_MODELS.map((m) => m.id));
});

test("checkApiKey reports ok / invalid / unverified", async () => {
  let mode = "ok";
  const api = await mockApi((ctx, res) => {
    if (mode === "ok") { res.writeHead(200); res.end("{}"); }
    else if (mode === "invalid") { res.writeHead(401); res.end("{}"); }
    else { res.writeHead(503); res.end("{}"); }
  });
  assert.equal(await checkApiKey(api.url, "k"), "ok");
  mode = "invalid";
  assert.equal(await checkApiKey(api.url, "k"), "invalid");
  mode = "server-error";
  assert.equal(await checkApiKey(api.url, "k"), "unverified");
  await api.close();
});
