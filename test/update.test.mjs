import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { isNewer, fetchLatestVersion } from "../dist/update.js";

function mockRegistry(handler) {
  const server = createServer((req, res) => handler({ method: req.method, url: req.url }, res));
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () =>
      r({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((x) => server.close(x)) })
    )
  );
}

test("isNewer compares releases and ignores pre-release tags", () => {
  assert.equal(isNewer("0.2.0", "0.1.0"), true);
  assert.equal(isNewer("0.1.1", "0.1.0"), true);
  assert.equal(isNewer("1.0.0", "0.9.9"), true);
  assert.equal(isNewer("0.1.0", "0.1.0"), false);
  assert.equal(isNewer("0.1.0", "0.2.0"), false);
  assert.equal(isNewer("0.1.0-beta.1", "0.1.0"), false);
});

test("fetchLatestVersion returns the version from the registry", async () => {
  const reg = await mockRegistry((ctx, res) => {
    assert.equal(ctx.method, "GET");
    assert.equal(ctx.url, "/dsk/latest");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: "dsk", version: "9.9.9" }));
  });
  const v = await fetchLatestVersion(reg.url);
  await reg.close();
  assert.equal(v, "9.9.9");
});

test("fetchLatestVersion returns null on a registry error", async () => {
  const reg = await mockRegistry((ctx, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  const v = await fetchLatestVersion(reg.url);
  await reg.close();
  assert.equal(v, null);
});
