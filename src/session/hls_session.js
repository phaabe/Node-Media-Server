// @ts-check
//
//  Created by Chen Mingliang on 25/04/24.
//  illuspas@msn.com
//  Copyright (c) 2025 Nodemedia. All rights reserved.
//

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const EventEmitter = require("node:events");
const logger = require("../core/logger.js");

/**
 * @typedef {import("../core/context.js").HlsConfig} HlsConfig
 */

/**
 * Owns one ffmpeg process that pulls a single published stream back in over
 * a loopback RTMP connection and remuxes it into a live HLS playlist +
 * segments on disk. Not a BaseSession: it has no data-plane role, ffmpeg is
 * its own RTMP client and writes straight to disk.
 * @class
 * @augments EventEmitter
 */
class HlsSession extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.streamPath - Stream path like "/live/test"
   * @param {string} options.streamApp
   * @param {string} options.streamName
   * @param {string} options.ffmpegPath - Path to the ffmpeg binary, or a bare command name
   * @param {string} options.rtmpUrl - Loopback RTMP URL ffmpeg pulls from
   * @param {string} options.outDir - Directory the playlist/segments are written to
   * @param {HlsConfig} options.hlsConfig
   */
  constructor({ streamPath, streamApp, streamName, ffmpegPath, rtmpUrl, outDir, hlsConfig }) {
    super();
    this.id = crypto.randomUUID();
    this.streamPath = streamPath;
    this.streamApp = streamApp;
    this.streamName = streamName;
    this.ffmpegPath = ffmpegPath;
    this.rtmpUrl = rtmpUrl;
    this.outDir = outDir;
    this.hlsConfig = hlsConfig;
    this.playlistPath = path.join(outDir, "index.m3u8");
    this.createTime = Date.now();
    this._stopped = false;
    this.child = null;
  }

  /**
   * Build the ffmpeg argv for a passthrough (or transcoding, if vc/ac are set)
   * remux from the loopback RTMP input into a live HLS playlist.
   * @returns {Array<string>}
   */
  buildArgs() {
    const c = this.hlsConfig;
    return [
      "-y",
      "-i", this.rtmpUrl,
      "-c:v", c.vc || "copy", ...(c.vcParam || []),
      "-c:a", c.ac || "copy", ...(c.acParam || []),
      "-f", "hls",
      "-hls_time", String(c.hlsTime ?? 2),
      "-hls_list_size", String(c.hlsListSize ?? 3),
      "-hls_flags", c.hlsFlags || "delete_segments",
      "-hls_segment_filename", path.join(this.outDir, "%d.ts"),
      this.playlistPath
    ];
  }

  /**
   * Spawn ffmpeg and start writing the playlist/segments to outDir.
   * @returns {void}
   */
  run() {
    fs.mkdirSync(this.outDir, { recursive: true });
    const argv = this.buildArgs();
    logger.info(`Hls session ${this.id} ${this.streamPath} spawning ${this.ffmpegPath} ${argv.join(" ")}`);
    this.child = childProcess.spawn(this.ffmpegPath, argv, { stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout.on("data", (data) => logger.debug(`Hls session ${this.id} stdout: ${data}`));
    this.child.stderr.on("data", (data) => logger.debug(`Hls session ${this.id} stderr: ${data}`));
    this.child.on("error", (error) => {
      logger.error(`Hls session ${this.id} ${this.streamPath} ffmpeg error: ${error.message}`);
    });
    this.child.on("close", (code) => {
      logger.info(`Hls session ${this.id} ${this.streamPath} ffmpeg exited with code ${code}`);
      this._cleanup();
      this.emit("exit", this);
    });
  }

  /**
   * Terminate the ffmpeg process. Idempotent: repeated calls are no-ops.
   * Cleanup and the "exit" event happen asynchronously once ffmpeg's own
   * "close" event fires.
   * @returns {void}
   */
  stop() {
    if (this._stopped) {
      return;
    }
    this._stopped = true;
    this.child?.kill("SIGTERM");
  }

  /**
   * Remove the per-stream output directory unless hlsKeep is set.
   * @returns {void}
   */
  _cleanup() {
    if (this.hlsConfig.hlsKeep) {
      return;
    }
    fs.rm(this.outDir, { recursive: true, force: true }, (error) => {
      if (error) {
        logger.warn(`Hls session ${this.id} ${this.streamPath} failed to remove ${this.outDir}: ${error.message}`);
      }
    });
  }
}

module.exports = HlsSession;
