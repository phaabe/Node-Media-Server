// @ts-check
//
//  Created by Chen Mingliang on 26/09/12.
//  illuspas@msn.com
//  Copyright (c) 2026 NodeMedia. All rights reserved.
//
//  HTTP-layer tests for the HLS playlist/segment routes: MIME types,
//  cache-control headers, and 404s for missing files.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Context = require("../src/core/context.js");
const NodeHttpServer = require("../src/server/http_server.js");

/**
 * @returns {Promise<number>} an unused port on 127.0.0.1
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * @param {string} hlsPath
 * @returns {Promise<{server: NodeHttpServer, baseUrl: string}>}
 */
async function startHttpServer(hlsPath) {
  Context.config = {
    bind: "127.0.0.1",
    http: { port: await getFreePort() },
    hls: { path: hlsPath }
  };
  const server = new NodeHttpServer();
  const listening = new Promise(resolve => server.httpServer.once("listening", resolve));
  server.run();
  await listening;
  return { server, baseUrl: `http://127.0.0.1:${server.httpServer.address().port}` };
}

test.describe("HLS HTTP routes", () => {
  /** @type {NodeHttpServer[]} */
  const servers = [];
  const hlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "nms-hls-http-"));
  const streamDir = path.join(hlsDir, "live", "test");
  fs.mkdirSync(streamDir, { recursive: true });
  fs.writeFileSync(path.join(streamDir, "index.m3u8"), "#EXTM3U\n#EXT-X-VERSION:3\n");
  fs.writeFileSync(path.join(streamDir, "0.ts"), Buffer.from([0x47, 0x00, 0x00]));

  test.after(() => {
    for (const server of servers) {
      server.stop();
    }
    fs.rmSync(hlsDir, { recursive: true, force: true });
  });

  test.it("serves the playlist with the correct MIME type and no-cache header", async () => {
    const { server, baseUrl } = await startHttpServer(hlsDir);
    servers.push(server);
    const res = await fetch(`${baseUrl}/live/test/index.m3u8`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/vnd.apple.mpegurl");
    assert.match(res.headers.get("cache-control"), /no-cache/);
    const body = await res.text();
    assert.match(body, /#EXTM3U/);
  });

  test.it("serves a segment with the correct MIME type and immutable cache header", async () => {
    const { server, baseUrl } = await startHttpServer(hlsDir);
    servers.push(server);
    const res = await fetch(`${baseUrl}/live/test/0.ts`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp2t");
    assert.match(res.headers.get("cache-control"), /immutable/);
  });

  test.it("404s for a missing playlist", async () => {
    const { server, baseUrl } = await startHttpServer(hlsDir);
    servers.push(server);
    const res = await fetch(`${baseUrl}/live/nope/index.m3u8`);
    assert.equal(res.status, 404);
  });

  test.it("404s for a missing segment", async () => {
    const { server, baseUrl } = await startHttpServer(hlsDir);
    servers.push(server);
    const res = await fetch(`${baseUrl}/live/test/99.ts`);
    assert.equal(res.status, 404);
  });

  test.it("routes are not registered when hls.path is not configured", async () => {
    Context.config = { bind: "127.0.0.1", http: { port: await getFreePort() } };
    const server = new NodeHttpServer();
    const listening = new Promise(resolve => server.httpServer.once("listening", resolve));
    server.run();
    await listening;
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${server.httpServer.address().port}/live/test/index.m3u8`);
    assert.equal(res.status, 404);
  });
});
