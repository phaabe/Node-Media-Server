// @ts-check
//
//  Created by Chen Mingliang on 25/04/24.
//  illuspas@msn.com
//  Copyright (c) 2025 Nodemedia. All rights reserved.
//

const fs = require("node:fs");
const path = require("node:path");
const logger = require("../core/logger.js");
const Context = require("../core/context.js");
const HlsSession = require("../session/hls_session.js");

class NodeHlsServer {
  constructor() {
    /** @type {Map<string, HlsSession>} streamPath -> active HLS session */
    this._activeSessions = new Map();
    this._running = false;

    this._onPostPublish = (session) => {
      if (!this._running || Context.config.hls?.auto === false) {
        return;
      }
      const apps = Context.config.hls?.apps;
      if (Array.isArray(apps) && apps.length > 0 && !apps.includes(session.streamApp)) {
        return;
      }
      if (this._activeSessions.has(session.streamPath)) {
        // the same client resumed within the publish grace window: ffmpeg's
        // own RTMP pull just idles through the gap, nothing to do here
        return;
      }
      this._start(session.streamPath, session.streamApp, session.streamName);
    };

    this._onDonePublish = (session) => {
      this._activeSessions.get(session.streamPath)?.stop();
    };
  }

  /**
   * Resolve the loopback RTMP URL ffmpeg pulls the stream back in from.
   * @param {string} streamPath
   * @returns {string}
   */
  _buildRtmpUrl(streamPath) {
    const bind = Context.config.bind;
    const host = (!bind || bind === "0.0.0.0") ? "127.0.0.1" : bind;
    return `rtmp://${host}:${Context.config.rtmp.port}${streamPath}`;
  }

  /**
   * @param {string} streamPath
   * @param {string} streamApp
   * @param {string} streamName
   * @returns {HlsSession}
   */
  _start(streamPath, streamApp, streamName) {
    const outDir = path.join(Context.config.hls.path, streamApp, streamName);
    const sess = new HlsSession({
      streamPath,
      streamApp,
      streamName,
      ffmpegPath: Context.config.hls.ffmpeg || "ffmpeg",
      rtmpUrl: this._buildRtmpUrl(streamPath),
      outDir,
      hlsConfig: Context.config.hls
    });
    sess.on("exit", () => {
      if (this._activeSessions.get(streamPath) === sess) {
        this._activeSessions.delete(streamPath);
      }
    });
    sess.run();
    this._activeSessions.set(streamPath, sess);
    logger.info(`Hls server ${streamPath} start transmux to ${outDir}`);
    return sess;
  }

  /**
   * Validate config and ffmpeg availability, then start listening for publishes.
   * @returns {void}
   */
  run() {
    const hls = Context.config.hls;
    if (!hls?.path) {
      return;
    }
    if (!Context.config.rtmp?.port) {
      logger.error("HLS requires rtmp.port to be configured (ffmpeg pulls the stream back in over loopback RTMP); HLS disabled.");
      return;
    }
    try {
      fs.mkdirSync(hls.path, { recursive: true });
      fs.accessSync(hls.path, fs.constants.W_OK);
    } catch (error) {
      logger.error(`HLS path ${hls.path} has no write permission. ${error}`);
      return;
    }
    const ffmpegPath = hls.ffmpeg || "ffmpeg";
    if (ffmpegPath.includes(path.sep) || ffmpegPath.includes("/")) {
      try {
        fs.accessSync(ffmpegPath, fs.constants.X_OK);
      } catch (error) {
        logger.error(`HLS ffmpeg binary ${ffmpegPath} is not executable. ${error}`);
        return;
      }
    }
    // Don't serve stale segments left over from a previous unclean shutdown.
    if (!hls.hlsKeep) {
      fs.rmSync(hls.path, { recursive: true, force: true });
      fs.mkdirSync(hls.path, { recursive: true });
    }
    logger.info(`Hls server start on the path ${hls.path}`);
    this._running = true;
    if (hls.auto === false) {
      logger.info("Auto HLS disabled, transmuxing only via the manual HLS API");
    }
    Context.eventEmitter.on("postPublish", this._onPostPublish);
    Context.eventEmitter.on("donePublish", this._onDonePublish);
  }

  /**
   * Whether the given stream currently has an active HLS session.
   * @param {string} streamPath
   * @returns {boolean}
   */
  isTransmuxing(streamPath) {
    return this._activeSessions.has(streamPath);
  }

  /**
   * Get the active HLS session of the given stream, if any.
   * @param {string} streamPath
   * @returns {HlsSession|undefined}
   */
  getActiveSession(streamPath) {
    return this._activeSessions.get(streamPath);
  }

  /**
   * Manually start HLS transmuxing for a publishing stream (webadmin button).
   * @param {string} streamPath
   * @returns {{ok: boolean, error?: string, hlsId?: string, playlistPath?: string}}
   */
  startHls(streamPath) {
    if (!this._running) {
      return { ok: false, error: "HLS path is not configured or not writable" };
    }
    if (this._activeSessions.has(streamPath)) {
      return { ok: false, error: "Stream is already transmuxing to HLS" };
    }
    const broadcast = Context.broadcasts.get(streamPath);
    if (!broadcast?.publisher) {
      return { ok: false, error: "Stream is not publishing" };
    }
    const { streamApp, streamName } = broadcast.publisher;
    const sess = this._start(streamPath, streamApp, streamName);
    return { ok: true, hlsId: sess.id, playlistPath: sess.playlistPath };
  }

  /**
   * Manually stop the active HLS session of the given stream.
   * @param {string} streamPath
   * @returns {{ok: boolean, error?: string}}
   */
  stopHls(streamPath) {
    const sess = this._activeSessions.get(streamPath);
    if (!sess) {
      return { ok: false, error: "Stream is not transmuxing to HLS" };
    }
    sess.stop();
    return { ok: true };
  }

  /**
   * Stop accepting new publishes and terminate all active HLS sessions.
   * @returns {void}
   */
  stop() {
    this._running = false;
    Context.eventEmitter.off("postPublish", this._onPostPublish);
    Context.eventEmitter.off("donePublish", this._onDonePublish);
    for (const session of this._activeSessions.values()) {
      session.stop();
    }
    this._activeSessions.clear();
    logger.info("Hls server stopped");
  }
}

module.exports = NodeHlsServer;
