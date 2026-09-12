// @ts-check
//
//  Created by Chen Mingliang on 26/09/12.
//  illuspas@msn.com
//  Copyright (c) 2026 NodeMedia. All rights reserved.
//
//  Lifecycle tests for NodeHlsServer/HlsSession: postPublish/donePublish wiring,
//  app allow-listing, manual start/stop, and cleanup-on-exit. child_process.spawn
//  is mocked so these tests don't need a real ffmpeg binary.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { mock } = require("node:test");
const EventEmitter = require("node:events");
const childProcess = require("node:child_process");

const NodeHlsServer = require("../src/server/hls_server.js");
const Context = require("../src/core/context.js");

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fake ffmpeg child process: an EventEmitter with stdio streams and a kill() stub. */
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.killSignal = null;
  }

  kill(signal) {
    this.killed = true;
    this.killSignal = signal;
    // Simulate ffmpeg actually exiting once asked to.
    process.nextTick(() => this.emit("close", 0));
  }
}

function resetContext() {
  Context.eventEmitter.removeAllListeners();
  Context.broadcasts.clear();
  Context.sessions.clear();
  Context.config = {};
}

/**
 * @param {object} [hlsOverrides]
 * @returns {{hlsDir: string, spawnCalls: Array<{command: string, args: Array<string>}>, fakeChildren: FakeChild[]}}
 */
function setup(hlsOverrides = {}) {
  resetContext();
  const hlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "nms-hls-"));
  Context.config = {
    bind: "0.0.0.0",
    rtmp: { port: 1935 },
    hls: { ffmpeg: "ffmpeg", path: hlsDir, ...hlsOverrides }
  };

  const spawnCalls = [];
  /** @type {FakeChild[]} */
  const fakeChildren = [];
  mock.method(childProcess, "spawn", (command, args) => {
    spawnCalls.push({ command, args });
    const child = new FakeChild();
    fakeChildren.push(child);
    return child;
  });

  return { hlsDir, spawnCalls, fakeChildren };
}

test.afterEach(() => {
  mock.reset();
});

test("postPublish for an allow-listed app spawns ffmpeg with expected argv", () => {
  const { hlsDir, spawnCalls } = setup({ apps: ["live"] });
  const hlsServer = new NodeHlsServer();
  hlsServer.run();

  const publisher = { streamPath: "/live/test", streamApp: "live", streamName: "test" };
  Context.eventEmitter.emit("postPublish", publisher);

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "ffmpeg");
  const args = spawnCalls[0].args;
  assert.ok(args.includes("rtmp://127.0.0.1:1935/live/test"));
  assert.ok(args.includes("-hls_time"));
  assert.equal(args[args.indexOf("-hls_time") + 1], "2");
  assert.ok(args.includes("-hls_list_size"));
  assert.equal(args[args.indexOf("-hls_list_size") + 1], "3");
  assert.ok(args.includes("-hls_flags"));
  assert.equal(args[args.indexOf("-hls_flags") + 1], "delete_segments");
  assert.equal(args[args.length - 1], path.join(hlsDir, "live", "test", "index.m3u8"));
  assert.ok(hlsServer.isTransmuxing("/live/test"));

  hlsServer.stop();
});

test("postPublish for a non-allow-listed app does not spawn", () => {
  const { spawnCalls } = setup({ apps: ["live"] });
  const hlsServer = new NodeHlsServer();
  hlsServer.run();

  Context.eventEmitter.emit("postPublish", { streamPath: "/other/test", streamApp: "other", streamName: "test" });
  assert.equal(spawnCalls.length, 0);

  hlsServer.stop();
});

test("hls.auto=false suppresses auto-start but manual startHls still works", () => {
  const { spawnCalls } = setup({ auto: false });
  const hlsServer = new NodeHlsServer();
  hlsServer.run();

  const publisher = { streamPath: "/live/test", streamApp: "live", streamName: "test" };
  Context.eventEmitter.emit("postPublish", publisher);
  assert.equal(spawnCalls.length, 0);

  Context.broadcasts.set("/live/test", { publisher });
  const result = hlsServer.startHls("/live/test");
  assert.equal(result.ok, true);
  assert.equal(spawnCalls.length, 1);

  hlsServer.stop();
});

test("donePublish stops the ffmpeg process and cleans up its output directory", async () => {
  const { hlsDir } = setup({ apps: ["live"] });
  const hlsServer = new NodeHlsServer();
  hlsServer.run();

  const publisher = { streamPath: "/live/test", streamApp: "live", streamName: "test" };
  Context.eventEmitter.emit("postPublish", publisher);

  const outDir = path.join(hlsDir, "live", "test");
  fs.writeFileSync(path.join(outDir, "index.m3u8"), "#EXTM3U\n");
  assert.ok(fs.existsSync(outDir));

  Context.eventEmitter.emit("donePublish", publisher);
  await sleep(50);

  assert.ok(!fs.existsSync(outDir), "output directory removed after donePublish");
  assert.ok(!hlsServer.isTransmuxing("/live/test"));

  hlsServer.stop();
});

test("hlsKeep=true keeps the output directory after donePublish", async () => {
  const { hlsDir } = setup({ apps: ["live"], hlsKeep: true });
  const hlsServer = new NodeHlsServer();
  hlsServer.run();

  const publisher = { streamPath: "/live/test", streamApp: "live", streamName: "test" };
  Context.eventEmitter.emit("postPublish", publisher);

  const outDir = path.join(hlsDir, "live", "test");
  fs.writeFileSync(path.join(outDir, "index.m3u8"), "#EXTM3U\n");

  Context.eventEmitter.emit("donePublish", publisher);
  await sleep(50);

  assert.ok(fs.existsSync(outDir), "output directory kept when hlsKeep is true");

  hlsServer.stop();
});

test("a resumed publish for the same streamPath does not spawn a second process", () => {
  const { spawnCalls } = setup({ apps: ["live"] });
  const hlsServer = new NodeHlsServer();
  hlsServer.run();

  const publisher = { streamPath: "/live/test", streamApp: "live", streamName: "test" };
  Context.eventEmitter.emit("postPublish", publisher);
  Context.eventEmitter.emit("postPublish", publisher);
  assert.equal(spawnCalls.length, 1);

  hlsServer.stop();
});

test("run() disables HLS when rtmp.port is not configured", () => {
  const { spawnCalls } = setup();
  Context.config.rtmp = {};
  const hlsServer = new NodeHlsServer();
  hlsServer.run();

  Context.eventEmitter.emit("postPublish", { streamPath: "/live/test", streamApp: "live", streamName: "test" });
  assert.equal(spawnCalls.length, 0);

  hlsServer.stop();
});
