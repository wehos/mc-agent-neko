// ../neko-mc-trial/mc-agent-viewer-upstream-20261013/src/agent/vision/viewer_self_skin.js
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
async function loadViewerSelfSkin(filename, model = "slim") {
  if (!filename) return null;
  if (!["slim", "classic"].includes(model)) throw new Error("Invalid viewer self skin model");
  if ((await stat(filename)).size > 128 * 1024) throw new Error("Viewer self skin exceeds 128 KiB");
  const bytes = await readFile(filename);
  if (bytes.length < 33 || bytes.length > 128 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(16) !== 64 || bytes.readUInt32BE(20) !== 64) throw new Error("Viewer self skin must be a 64\xD764 PNG");
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { bytes, entity: { skinUrl: `/head-texture/${hash}.png`, skinModel: model } };
}

// ../mc-visual-console/packages/modern-viewer/renderer-src/host/viewer-agent.mjs
import { randomUUID } from "node:crypto";

// ../mc-visual-console/packages/modern-viewer/renderer-src/src/modern-viewer/agent-visual-protocol.js
var AGENT_VISUAL_COLORS = Object.freeze({
  path: "#4ee6b1",
  trail: "#63b8ff",
  candidate: "#a6b7d4",
  attack: "#ff697b",
  gather: "#ffbe55",
  interact: "#c59aff",
  info: "#b7e7ff"
});
var AGENT_VISUAL_LIMITS = Object.freeze({
  markers: 48,
  vertices: 1024,
  route: 128,
  candidates: 4,
  imageBytes: 512 * 1024,
  sceneNodes: 64,
  drawingBytes: 64 * 1024
});
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var finite = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
var visualText = (v, limit = 240) => typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, limit) : "";
var visualTtl = (v, fallback = 15e3, max = 12e4) => finite(v, 500, max) ? Math.round(v) : fallback;
function visualSubject(v) {
  return v && UUID.test(v.playerUuid ?? "") && /^[\w.]{1,32}$/.test(v.playerName ?? "") && Number.isSafeInteger(v.entityId) ? { playerUuid: v.playerUuid.toLowerCase(), playerName: v.playerName, entityId: v.entityId } : null;
}
var sameVisualSubject = (a, b) => !!a && !!b && a.playerUuid.toLowerCase() === b.playerUuid.toLowerCase() && a.entityId === b.entityId;
function visualPoint(v, space = "world") {
  if (space === "screen") return v && finite(v.x, 0, 1) && finite(v.y, 0, 1) ? { x: v.x, y: v.y } : null;
  return v && finite(v.x, -3e7, 3e7) && finite(v.y, -4096, 4096) && finite(v.z, -3e7, 3e7) ? { x: v.x, y: v.y, z: v.z } : null;
}
function visualPoints(values, max = 128, space = "world") {
  if (!Array.isArray(values) || !values.length) return [];
  const count = Math.min(max, values.length), result = [];
  for (let i = 0; i < count; i++) {
    const p = visualPoint(values[Math.floor(i * (values.length - 1) / Math.max(1, count - 1))], space);
    if (!p) return null;
    result.push(p);
  }
  return result;
}
function normalizeVisualIntent(v) {
  if (!v || typeof v !== "object") return null;
  const status = ["planning", "acting", "waiting", "blocked", "done"].includes(v.status) ? v.status : "acting";
  const goal = visualText(v.goal), step = visualText(v.step), summary = visualText(v.summary, 700);
  if (!goal && !step && !summary) return null;
  return { status, goal, step, summary, ...finite(v.progress, 0, 1) ? { progress: v.progress } : {}, ttlMs: visualTtl(v.ttlMs) };
}
function normalizeVisualRoute(v) {
  if (!v || typeof v !== "object") return null;
  const points = visualPoints(v.points ?? []);
  if (!points) return null;
  return {
    points,
    goal: visualPoint(v.goal),
    status: ["planning", "moving", "reached", "blocked", "stopped"].includes(v.status) ? v.status : "moving",
    source: v.source === "pathfinder" ? "pathfinder" : "agent",
    ttlMs: visualTtl(v.ttlMs, 1e4, 3e4)
  };
}
function normalizeVisualCandidates(v) {
  if (!Array.isArray(v) || v.length > AGENT_VISUAL_LIMITS.candidates) return null;
  const result = v.map((row, i) => {
    const route = normalizeVisualRoute(row);
    return route && route.points.length > 1 ? { id: visualText(row.id, 48) || `candidate-${i}`, label: visualText(row.label, 80), points: route.points } : null;
  });
  return result.every(Boolean) ? result : null;
}
var color = (v, fallback) => /^#[a-f0-9]{6}$/i.test(v ?? "") ? v : fallback;
function normalizeVisualMarkers(values) {
  if (!Array.isArray(values) || values.length > AGENT_VISUAL_LIMITS.markers) return null;
  let vertices = 0;
  const ids = /* @__PURE__ */ new Set(), result = [];
  for (const v of values) {
    if (!v || !["point", "line", "area", "label"].includes(v.kind)) return null;
    const id = visualText(v.id, 48), space = v.space === "screen" ? "screen" : "world";
    if (!id || ids.has(id)) return null;
    ids.add(id);
    const role = Object.hasOwn(AGENT_VISUAL_COLORS, v.role) ? v.role : "info";
    const points = ["line", "area"].includes(v.kind) ? visualPoints(v.points, v.kind === "area" ? 64 : 128, space) : [visualPoint(v.position ?? v.points?.[0], space)];
    if (!points || points.some((p) => !p) || points.length < (v.kind === "area" ? 3 : v.kind === "line" ? 2 : 1)) return null;
    vertices += points.length;
    if (vertices > AGENT_VISUAL_LIMITS.vertices) return null;
    result.push({
      id,
      kind: v.kind,
      space,
      role,
      points,
      label: visualText(v.label, 100),
      color: color(v.color, AGENT_VISUAL_COLORS[role]),
      width: finite(v.width, 1, 10) ? v.width : 3,
      radius: finite(v.radius, 2, 24) ? v.radius : 6,
      dashed: v.dashed === true || role === "candidate",
      flow: v.flow === true && v.kind === "line",
      ttlMs: visualTtl(v.ttlMs, 1e4, 3e4)
    });
  }
  return result;
}
function normalizeVisualPointer(v) {
  const p = visualPoint(v, "screen");
  return p ? { ...p, ttlMs: visualTtl(v.ttlMs, 1500, 3e3) } : null;
}
function normalizeVisualCamera(v) {
  return v && finite(v.verticalFov, 5, 170) ? { verticalFov: v.verticalFov, ttlMs: visualTtl(v.ttlMs, 1e3, 3e3) } : null;
}
function normalizeVisualPresentation(v) {
  if (!v || typeof v !== "object") return null;
  const base = { id: visualText(v.id, 48), title: visualText(v.title, 100), caption: visualText(v.caption, 300), ttlMs: visualTtl(v.ttlMs, 3e4) };
  if (!base.id) return null;
  if (v.kind === "image") {
    if (typeof v.src !== "string" || v.src.length > Math.ceil(AGENT_VISUAL_LIMITS.imageBytes * 4 / 3) + 100 || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(v.src)) return null;
    const encoded = v.src.slice(v.src.indexOf(",") + 1);
    if (encoded.length % 4 || encoded.length * 3 / 4 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0) > AGENT_VISUAL_LIMITS.imageBytes) return null;
    return { ...base, kind: "image", src: v.src };
  }
  if (v.kind === "card") {
    const text = visualText(v.text, 1500);
    if (!text) return null;
    return { ...base, kind: "card", text };
  }
  if (v.kind !== "scene" || !finite(v.width, 64, 1920) || !finite(v.height, 64, 1080) || !Array.isArray(v.nodes) || v.nodes.length > AGENT_VISUAL_LIMITS.sceneNodes) return null;
  const nodes = [];
  for (const node of v.nodes) {
    if (!node || !["rect", "circle", "line", "text"].includes(node.kind) || !finite(node.x, -4096, 4096) || !finite(node.y, -4096, 4096)) return null;
    const row = { kind: node.kind, x: node.x, y: node.y, color: color(node.color, "#b7e7ff") };
    if (node.kind === "rect") {
      if (!finite(node.width, 1, 4096) || !finite(node.height, 1, 4096)) return null;
      row.width = node.width;
      row.height = node.height;
    } else if (node.kind === "circle") {
      if (!finite(node.radius, 1, 1024)) return null;
      row.radius = node.radius;
    } else if (node.kind === "line") {
      if (!finite(node.x2, -4096, 4096) || !finite(node.y2, -4096, 4096)) return null;
      row.x2 = node.x2;
      row.y2 = node.y2;
      row.width = finite(node.width, 1, 10) ? node.width : 2;
    } else {
      row.text = visualText(node.text, 180);
      row.size = finite(node.size, 8, 96) ? node.size : 20;
    }
    if (node.motion) {
      if (!finite(node.motion.dx, -4096, 4096) || !finite(node.motion.dy, -4096, 4096) || !finite(node.motion.periodMs, 500, 2e4)) return null;
      row.motion = { dx: node.motion.dx, dy: node.motion.dy, periodMs: node.motion.periodMs };
    }
    nodes.push(row);
  }
  return { ...base, kind: "scene", width: v.width, height: v.height, background: color(v.background, "#142431"), nodes };
}
function normalizeAgentVisualUpdate(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, code: "AGENT_VISUAL_INVALID_UPDATE" };
  const validators = {
    intent: normalizeVisualIntent,
    route: normalizeVisualRoute,
    candidates: normalizeVisualCandidates,
    markers: normalizeVisualMarkers,
    presentation: normalizeVisualPresentation,
    pointer: normalizeVisualPointer,
    camera: normalizeVisualCamera
  };
  const value = {};
  for (const [key, validate] of Object.entries(validators)) if (Object.hasOwn(v, key)) {
    if (v[key] === null && !["candidates", "markers"].includes(key)) value[key] = null;
    else {
      value[key] = validate(v[key]);
      if (value[key] === null) return { ok: false, code: `AGENT_VISUAL_INVALID_${key.toUpperCase()}` };
    }
  }
  if (!Object.keys(value).length) return { ok: false, code: "AGENT_VISUAL_EMPTY_UPDATE" };
  const drawing = { ...value };
  delete drawing.presentation;
  if (JSON.stringify(drawing).length > AGENT_VISUAL_LIMITS.drawingBytes) return { ok: false, code: "AGENT_VISUAL_DRAWING_BUDGET" };
  return { ok: true, value };
}

// ../mc-visual-console/packages/modern-viewer/renderer-src/host/viewer-agent.mjs
function createViewerAgentHub({ maximum = 64 } = {}) {
  const records = /* @__PURE__ */ new Map();
  return {
    put(owner, record3) {
      const key = record3.subject.playerUuid, old = records.get(key);
      if (old && old.owner !== owner) return false;
      if (!old && records.size >= maximum) return false;
      records.set(key, { owner, record: record3 });
      return true;
    },
    get(subject) {
      const record3 = records.get(subject?.playerUuid)?.record;
      return sameVisualSubject(subject, record3?.subject) ? record3 : null;
    },
    remove(owner) {
      for (const [key, row] of records) if (row.owner === owner) records.delete(key);
    },
    get size() {
      return records.size;
    }
  };
}
var viewerAgentHub = createViewerAgentHub();
var publishers = /* @__PURE__ */ new WeakMap();
var dispatchers = /* @__PURE__ */ new WeakMap();
function observeSentPackets(client, callback) {
  if (typeof client?.write !== "function") return () => {
  };
  let row = dispatchers.get(client);
  if (!row) {
    let write = function(...args) {
      const result = original.apply(this, args);
      for (const listener of listeners) {
        try {
          listener(...args);
        } catch {
        }
      }
      return result;
    };
    const original = client.write, listeners = /* @__PURE__ */ new Set();
    row = { original, write, listeners };
    dispatchers.set(client, row);
    client.write = write;
  }
  row.listeners.add(callback);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    row.listeners.delete(callback);
    if (!row.listeners.size) {
      if (client.write === row.write) client.write = row.original;
      dispatchers.delete(client);
    }
  };
}
var ownSubject = (bot) => visualSubject({
  playerUuid: bot.player?.uuid ?? bot.entity?.uuid ?? bot.uuid,
  playerName: bot.username,
  entityId: bot.entity?.id
});
var controls = ["forward", "back", "left", "right", "jump", "sprint", "sneak"];
function createViewerAgentBridge(bot, {
  hub = viewerAgentHub,
  getViewerSession = () => null,
  authorizePublish = null,
  now = Date.now,
  intervalMs = 100,
  timers = true
} = {}) {
  if (publishers.has(bot)) throw Error("AGENT_VISUAL_HOST_ALREADY_ATTACHED");
  const owner = {}, sockets = /* @__PURE__ */ new Map(), hooks = [];
  let record3 = null, closed = false, ended = false, sequence = 0, operationId = 0;
  const on = (event, handler) => {
    bot.on(event, handler);
    hooks.push([event, handler]);
  };
  const isBody = () => !ended && bot.entity && bot.game?.gameMode !== "spectator" && bot._client?.state === "play";
  function refreshRecord() {
    const subject = isBody() ? ownSubject(bot) : null;
    if (!subject) {
      hub.remove(owner);
      record3 = null;
      return null;
    }
    if (!sameVisualSubject(record3?.subject, subject)) {
      hub.remove(owner);
      record3 = {
        subject,
        epoch: randomUUID(),
        dimension: bot.game?.dimension ?? null,
        intent: null,
        route: null,
        candidates: [],
        markers: [],
        pointer: null,
        camera: null,
        presentation: null,
        presentationRevision: 0,
        trail: [],
        operations: [],
        input: {}
      };
      if (!hub.put(owner, record3)) {
        record3 = null;
        return null;
      }
    }
    return record3;
  }
  function viewerSubject() {
    const session = getViewerSession();
    if (session) return session.attached ? visualSubject(session) : null;
    return isBody() ? ownSubject(bot) : null;
  }
  function expire(r, time) {
    for (const key of ["intent", "route", "pointer", "camera", "presentation"]) if (r[key]?.until <= time) r[key] = null;
    r.candidates = r.candidates.filter((v) => v.until > time);
    r.markers = r.markers.filter((v) => v.until > time);
    r.operations = r.operations.filter((v) => v.until > time);
    r.trail = r.trail.filter((v) => time - v.at <= 3e4);
  }
  function publish(update) {
    if (closed) return { ok: false, code: "AGENT_VISUAL_HOST_CLOSED" };
    const parsed = normalizeAgentVisualUpdate(update);
    if (!parsed.ok) return parsed;
    const r = refreshRecord();
    if (!r) return { ok: false, code: "AGENT_VISUAL_ACTION_PLAYER_UNAVAILABLE" };
    const time = now();
    for (const [key, value] of Object.entries(parsed.value)) {
      if (key === "candidates" || key === "markers") r[key] = value.map((v) => ({ ...v, until: time + (v.ttlMs ?? 1e4) }));
      else r[key] = value ? { ...value, until: time + value.ttlMs } : null;
      if (key === "presentation") r.presentationRevision++;
    }
    return { ok: true, code: "AGENT_VISUAL_ACCEPTED", subject: { ...r.subject }, accepted: Object.keys(parsed.value) };
  }
  publishers.set(bot, publish);
  on("viewer:agent", (update, acknowledge) => {
    const result = publish(update);
    if (typeof acknowledge === "function") acknowledge(result);
  });
  on("spawn", () => {
    ended = false;
    hub.remove(owner);
    record3 = null;
    refreshRecord();
    flush(true);
  });
  on("respawn", () => {
    hub.remove(owner);
    record3 = null;
    flush(true);
  });
  on("end", () => {
    ended = true;
    hub.remove(owner);
    record3 = null;
    flush(true);
  });
  on("path_update", (result) => {
    const r = refreshRecord();
    if (!r) return;
    const status = ["noPath", "timeout"].includes(result?.status) ? "blocked" : result?.status === "partial" ? "planning" : "moving";
    const route = normalizeVisualRoute({ points: result?.path ?? [], goal: bot.pathfinder?.goal, status, source: "pathfinder" });
    if (route) r.route = { ...route, until: now() + route.ttlMs };
  });
  for (const [event, status] of [["path_reset", "planning"], ["path_stop", "stopped"], ["goal_reached", "reached"]]) on(event, () => {
    const r = refreshRecord();
    if (!r?.route) return;
    r.route = { ...r.route, status, points: [], until: now() + 3e3 };
  });
  const stopPackets = observeSentPackets(bot._client, (name2, data) => {
    const r = refreshRecord();
    if (!r || !data) return;
    let kind, target = null, detail = "";
    if (name2 === "use_entity") {
      kind = data.mouse === 1 ? "attack" : "interact";
      target = visualPoint(bot.entities?.[data.target]?.position);
      detail = `\u5B9E\u4F53 ${data.target}`;
    } else if (name2 === "block_dig" && [0, 1, 2].includes(data.status)) {
      kind = "gather";
      target = visualPoint(data.location);
      detail = data.status === 0 ? "\u5F00\u59CB\u91C7\u96C6" : data.status === 1 ? "\u53D6\u6D88\u91C7\u96C6" : "\u63D0\u4EA4\u91C7\u96C6";
    } else if (name2 === "block_place" || name2 === "use_item") {
      kind = "interact";
      target = visualPoint(data.location);
      detail = "\u4F7F\u7528\u7269\u54C1 / \u65B9\u5757";
    } else if (name2 === "window_click") {
      kind = "inventory";
      detail = `\u69FD\u4F4D ${Number.isSafeInteger(data.slot) ? data.slot : "?"} \xB7 ${data.mouseButton === 1 ? "\u53F3\u952E" : "\u5DE6\u952E"}`;
    } else return;
    r.operations.push({
      id: ++operationId,
      kind,
      button: kind === "attack" || kind === "gather" ? "left" : kind === "inventory" && data.mouseButton !== 1 ? "left" : "right",
      detail,
      target,
      from: visualPoint(bot.entity.position),
      until: now() + 1800
    });
    r.operations = r.operations.slice(-6);
  });
  function sample() {
    const r = refreshRecord();
    if (!r) return;
    const time = now(), position2 = visualPoint(bot.entity.position);
    if (r.dimension !== (bot.game?.dimension ?? null)) {
      r.dimension = bot.game?.dimension ?? null;
      r.epoch = randomUUID();
      r.trail = [];
      r.intent = null;
      r.route = null;
      r.candidates = [];
      r.markers = [];
      r.operations = [];
      r.pointer = null;
      r.camera = null;
      r.presentation = null;
    }
    const previous = r.trail.at(-1);
    if (position2 && (!previous || Math.hypot(previous.x - position2.x, previous.y - position2.y, previous.z - position2.z) >= 0.3)) {
      if (previous && Math.hypot(previous.x - position2.x, previous.y - position2.y, previous.z - position2.z) > 16) r.trail = [];
      r.trail.push({ ...position2, at: time });
      r.trail = r.trail.slice(-64);
    }
    if (r.route?.source === "pathfinder" && r.route.status === "moving" && bot.pathfinder?.isMoving?.() === true) r.route.until = time + 1e4;
    r.input = {
      controls: controls.filter((key) => bot.controlState?.[key] === true),
      position: position2,
      yaw: Number.isFinite(bot.entity.yaw) ? bot.entity.yaw : null,
      pitch: Number.isFinite(bot.entity.pitch) ? bot.entity.pitch : null
    };
    expire(r, time);
  }
  const remaining = (value, time) => value ? { ...value, remainingMs: Math.max(0, value.until - time), until: void 0 } : null;
  function flush(force = false) {
    if (closed) return;
    sample();
    const subject = viewerSubject(), r = subject ? hub.get(subject) : null, time = now();
    if (r) expire(r, time);
    const presentation = r?.presentation, presentationKey = presentation ? `${r.epoch}:${r.presentationRevision}` : "";
    const frame = {
      schemaVersion: 1,
      subject,
      available: !!r,
      reason: r ? null : subject ? "AGENT_VISUAL_SOURCE_UNAVAILABLE" : "AGENT_VISUAL_SUBJECT_UNATTACHED",
      epoch: r?.epoch ?? null,
      ttlMs: 3500
    };
    if (r) Object.assign(frame, {
      intent: remaining(r.intent, time),
      route: remaining(r.route, time),
      camera: remaining(r.camera, time),
      candidates: r.candidates.map((v) => remaining(v, time)),
      markers: r.markers.map((v) => remaining(v, time)),
      trail: r.trail.map(({ at, ...p }) => p),
      input: { ...r.input, operations: r.operations.map((v) => remaining(v, time)), pointer: remaining(r.pointer, time) },
      presentation: presentation ? {
        id: presentation.id,
        revision: r.presentationRevision,
        kind: presentation.kind,
        title: presentation.title,
        caption: presentation.caption,
        remainingMs: Math.max(0, presentation.until - time)
      } : null
    });
    const signature = JSON.stringify(frame);
    for (const [socket, sent] of sockets) {
      if (socket.connected === false) continue;
      if (force || sent.signature !== signature || time - sent.at >= 1e3) {
        socket.emit("agentVisualization", { ...frame, sequence: ++sequence });
        sent.signature = signature;
        sent.at = time;
      }
      if (presentationKey && sent.presentation !== presentationKey) socket.emit("agentPresentation", {
        schemaVersion: 1,
        subject,
        epoch: r.epoch,
        revision: r.presentationRevision,
        presentation: remaining(presentation, time)
      });
      sent.presentation = presentationKey;
    }
  }
  const timer = timers ? setInterval(flush, Math.max(100, intervalMs)) : null;
  timer?.unref?.();
  refreshRecord();
  return {
    publish,
    flush,
    subscribeSocket(socket) {
      if (closed) throw Error("AGENT_VISUAL_HOST_CLOSED");
      let lastPublish = -Infinity;
      const incoming = async (update, acknowledge) => {
        if (typeof acknowledge !== "function") return;
        const finish = (result) => {
          if (sockets.has(socket) && !closed) acknowledge(result);
        };
        if (now() - lastPublish < 200) {
          finish({ ok: false, code: "AGENT_VISUAL_RATE_LIMIT" });
          return;
        }
        lastPublish = now();
        let authorized = false;
        try {
          authorized = typeof authorizePublish === "function" && await authorizePublish({ socket, subject: ownSubject(bot) }) === true;
        } catch {
        }
        if (!authorized) {
          finish({ ok: false, code: "AGENT_VISUAL_PUBLISH_FORBIDDEN" });
          return;
        }
        if (closed || !sockets.has(socket)) return;
        finish(publish(update));
      };
      const off = () => {
        sockets.delete(socket);
        socket.off?.("disconnect", off);
        socket.off?.("agentVisualUpdate", incoming);
      };
      sockets.set(socket, { signature: "", at: -Infinity, presentation: "", off });
      socket.on("disconnect", off);
      socket.on("agentVisualUpdate", incoming);
      flush(true);
      return off;
    },
    dispose() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      stopPackets();
      for (const [event, handler] of hooks) bot.off(event, handler);
      publishers.delete(bot);
      hub.remove(owner);
      record3 = null;
      for (const [socket, row] of sockets) {
        socket.emit("agentVisualization", { schemaVersion: 1, subject: null, available: false, reason: "AGENT_VISUAL_HOST_CLOSED", sequence: ++sequence, ttlMs: 3500 });
        row.off();
      }
      sockets.clear();
    }
  };
}

// ../mc-visual-console/packages/modern-viewer/renderer-src/host/viewer-observer.mjs
var CHANNELS = /* @__PURE__ */ new Set(["mcviewer:state", "corti:viewer_state"]);
var UUID2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function createViewerObserverBridge(bot, { now = Date.now, staleMs = 12e3, serializeWindow } = {}) {
  const subscribers = /* @__PURE__ */ new Set();
  let nativeWindow = null;
  const windowChanged = () => {
    if (nativeWindow && current?.viewerSession?.attached && current.viewerSession.windowOpen && serializeWindow)
      emit("containerState", serializeWindow(nativeWindow));
  };
  function openWindow(window) {
    nativeWindow?.off?.("updateSlot", windowChanged);
    nativeWindow = window;
    nativeWindow?.on?.("updateSlot", windowChanged);
    windowChanged();
  }
  let current = null, pending = null, cameraId = null, at = 0, closed = false;
  const key = (state) => state?.viewerSession?.attached ? [
    state.viewerSession.playerUuid,
    state.viewerSession.entityId,
    state.viewerSession.worldUuid
  ].join(":") : "";
  const emit = (event, value) => {
    for (const socket of subscribers) socket.emit(event, value);
  };
  function reset(reason) {
    openWindow(null);
    current = null;
    pending = null;
    at = 0;
    emit("viewerSession", { mode: "observer", attached: false, reason });
    emit("containerState", null);
    emit("skillsState", { schemaVersion: 1, mana: null, skills: [], abilities: [] });
    emit("observerState", { attached: false, reason });
  }
  function accept(state) {
    const session = state.viewerSession;
    if (session.mode === "observer" && session.attached && session.entityId !== cameraId) {
      pending = state;
      return;
    }
    if (key(current) !== key(state)) emit("containerState", null);
    current = state;
    pending = null;
    at = now();
    emit("viewerSession", session);
    if (!session.attached || !session.windowOpen) emit("containerState", null);
    emit("skillsState", state);
    emit("observerState", { ...session, vitals: state.vitals ?? null });
    windowChanged();
  }
  function payload(packet) {
    if (!CHANNELS.has(packet.channel) || !Buffer.isBuffer(packet.data) || packet.data.length > 16384) return;
    let state;
    try {
      state = JSON.parse(packet.data.toString("utf8"));
    } catch {
      return;
    }
    const session = state?.viewerSession;
    if (state?.schemaVersion !== 1 || !session || !UUID2.test(session.recipientUuid ?? "") || session.recipientUuid.toLowerCase() !== String(bot.player?.uuid ?? bot.entity?.uuid ?? bot.uuid).toLowerCase() || !["self", "observer"].includes(session.mode) || typeof session.attached !== "boolean") return;
    if (session.attached && (!UUID2.test(session.playerUuid ?? "") || !UUID2.test(session.worldUuid ?? "") || !Number.isSafeInteger(session.entityId) || !/^[A-Za-z0-9_.]{1,32}$/.test(session.playerName ?? "") || typeof session.windowOpen !== "boolean")) return;
    accept(state);
  }
  function camera(packet) {
    const previous = cameraId, candidate = pending;
    cameraId = packet.cameraId;
    if (current?.viewerSession?.mode === "observer" && current.viewerSession.entityId !== cameraId) reset("camera_changed");
    if (previous !== cameraId && candidate?.viewerSession?.entityId === cameraId) accept(candidate);
  }
  const respawn = () => {
    cameraId = null;
    reset("respawn");
  };
  const closeWindow = () => {
    openWindow(null);
    emit("containerState", null);
  };
  const outgoing = (name2) => {
    if (name2 === "close_window") closeWindow();
  };
  const register = () => {
    if (bot._client?.state === "play") bot._client.write("custom_payload", {
      channel: "minecraft:register",
      data: Buffer.from("mcviewer:state")
    });
  };
  bot._client.on("custom_payload", payload);
  bot._client.on("camera", camera);
  bot._client.on("respawn", respawn);
  bot._client.on("close_window", closeWindow);
  bot._client.on("writePacket", outgoing);
  bot.on("windowClose", closeWindow);
  bot.on("spawn", register);
  if (serializeWindow) bot.on("windowOpen", openWindow);
  const onEnd = () => reset("disconnected");
  bot.on("end", onEnd);
  register();
  const timer = setInterval(() => {
    if (current && now() - at > staleMs) reset("state_stale");
  }, 1e3);
  timer.unref?.();
  return {
    subscribeSocket(socket) {
      if (closed) throw Error("observer_bridge_closed");
      subscribers.add(socket);
      if (current) {
        socket.emit("viewerSession", current.viewerSession);
        socket.emit("skillsState", current);
        socket.emit("observerState", { ...current.viewerSession, vitals: current.vitals ?? null });
        if (nativeWindow && current.viewerSession.attached && current.viewerSession.windowOpen && serializeWindow)
          socket.emit("containerState", serializeWindow(nativeWindow));
      }
      const off = () => {
        subscribers.delete(socket);
        socket.off?.("disconnect", off);
      };
      socket.on("disconnect", off);
      return off;
    },
    snapshot: () => current,
    dispose() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      reset("disposed");
      subscribers.clear();
      bot._client.off("custom_payload", payload);
      bot._client.off("camera", camera);
      bot._client.off("respawn", respawn);
      bot._client.off("close_window", closeWindow);
      bot._client.off("writePacket", outgoing);
      bot.off("windowClose", closeWindow);
      bot.off("spawn", register);
      bot.off("end", onEnd);
      bot.off("windowOpen", openWindow);
    }
  };
}

// ../mc-visual-console/packages/modern-viewer/renderer-src/host/viewer-ysm-assets.mjs
import { createHash as createHash2, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
var YSM_ASSET_CHANNEL = "mcagent:ysm_asset";
var MAX_BYTES = 2 * 1024 * 1024;
var MAX_RAW = 8 * 1024 * 1024;
var sha = (bytes) => createHash2("sha256").update(bytes).digest("hex");
function decodeYsmBundle(compressed, hash) {
  if (compressed.length > MAX_BYTES || sha(compressed) !== hash) throw Error("YSM_ASSET_HASH_MISMATCH");
  const raw = gunzipSync(compressed, { maxOutputLength: MAX_RAW });
  const bundle = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (bundle.schemaVersion !== 1 || bundle.ysmVersion !== "2.4.1" || bundle.format !== "ysm-bedrock-original" || typeof bundle.modelId !== "string" || bundle.modelId.length > 96 || !bundle.files || Object.keys(bundle.files).length > 32) throw Error("YSM_ASSET_FORMAT_UNSUPPORTED");
  let total = 0;
  for (const [path5, file] of Object.entries(bundle.files)) {
    if (path5.startsWith("/") || path5.includes("\\") || path5.includes(":") || path5.split("/").includes("..") || typeof file.base64 !== "string") throw Error("YSM_ASSET_PATH_INVALID");
    const bytes = Buffer.from(file.base64, "base64");
    total += bytes.length;
    if (total > MAX_RAW || bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw Error("YSM_SOURCE_HASH_MISMATCH");
  }
  if (!bundle.files[bundle.model] || !bundle.files[bundle.animation] || !bundle.files["ysm.json"] || Object.values(bundle.textures ?? {}).some((path5) => !bundle.files[path5]) || Object.values(bundle.animations ?? {}).some((path5) => typeof path5 !== "string" || !bundle.files[path5]) || !Array.isArray(bundle.controllers ?? []) || (bundle.controllers?.length ?? 0) > 8 || (bundle.controllers ?? []).some((path5) => typeof path5 !== "string" || !bundle.files[path5])) throw Error("YSM_SOURCE_MISSING");
  return { ...bundle, assetSha256: hash };
}
function createYsmAssetReceiver(bot, { onAsset = () => {
}, onError = () => {
} } = {}) {
  const cache = /* @__PURE__ */ new Map(), queue = /* @__PURE__ */ new Map(), attempts = /* @__PURE__ */ new Map();
  let active = null, disposed = false, bytes = 0, lastStarted = 0;
  const start = () => {
    if (disposed || active || !queue.size || bot._client.state !== "play" || Date.now() - lastStarted < 600) return;
    const [hash, row] = queue.entries().next().value;
    queue.delete(hash);
    const requestId = randomBytes(16).toString("hex");
    active = { row, hash, requestId, parts: [], size: 0, count: null, started: Date.now() };
    lastStarted = Date.now();
    attempts.set(hash, (attempts.get(hash) ?? 0) + 1);
    bot._client.write("custom_payload", { channel: YSM_ASSET_CHANNEL, data: Buffer.from(JSON.stringify({ type: "get", modelId: row.modelId, sha256: hash, requestId })) });
  };
  const fail = (reason) => {
    const prior = active;
    active = null;
    if (prior) onError(prior.row, reason);
    start();
  };
  const payload = (packet) => {
    if (packet.channel !== YSM_ASSET_CHANNEL || !active || packet.data.length > 18e3) return;
    try {
      const p = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packet.data));
      if (p.schemaVersion !== 1 || p.type !== "chunk" || p.requestId !== active.requestId || p.sha256 !== active.hash) return;
      if (!Number.isInteger(p.count) || p.count < 1 || p.count > 171 || !Number.isInteger(p.index) || p.index < 0 || p.index >= p.count || !Number.isInteger(p.bytes) || p.bytes < 1 || p.bytes > MAX_BYTES || typeof p.data !== "string" || p.data.length > 16384 || active.count !== null && (active.count !== p.count || active.bytes !== p.bytes)) throw Error("YSM_TRANSFER_INVALID");
      active.count = p.count;
      active.bytes = p.bytes;
      if (active.parts[p.index]) return;
      const part = Buffer.from(p.data, "base64");
      if (part.length !== Math.min(12288, p.bytes - p.index * 12288)) throw Error("YSM_TRANSFER_SIZE_INVALID");
      active.parts[p.index] = part;
      active.size += part.length;
      if (active.parts.filter(Boolean).length === p.count) {
        if (active.size !== p.bytes) throw Error("YSM_TRANSFER_SIZE_INVALID");
        const bundle = decodeYsmBundle(Buffer.concat(active.parts), active.hash);
        if (bundle.modelId !== active.row.modelId) throw Error("YSM_MODEL_BINDING_MISMATCH");
        const size = Buffer.byteLength(JSON.stringify(bundle));
        while (cache.size >= 32 || bytes + size > 32 * 1024 * 1024) {
          const key = cache.keys().next().value;
          bytes -= cache.get(key).size;
          cache.delete(key);
        }
        const hash = active.hash;
        cache.set(hash, { bundle, size });
        bytes += size;
        active = null;
        onAsset(bundle);
        setTimeout(start, 600).unref?.();
      }
    } catch (error) {
      fail(error.message?.startsWith("YSM_") ? error.message : "YSM_TRANSFER_INVALID");
    }
  };
  const timer = setInterval(() => {
    if (active && Date.now() - active.started > 2e4) fail("YSM_TRANSFER_TIMEOUT");
    else start();
  }, 1e3);
  timer.unref?.();
  bot._client.on("custom_payload", payload);
  return { get: (hash) => cache.get(hash)?.bundle, request(row) {
    if (disposed || row.webAvailable !== true || cache.has(row.assetSha256) || active?.hash === row.assetSha256 || (attempts.get(row.assetSha256) ?? 0) >= 3 || queue.size >= 40) return;
    queue.set(row.assetSha256, row);
    start();
  }, reset() {
    active = null;
    queue.clear();
    attempts.clear();
  }, dispose() {
    disposed = true;
    clearInterval(timer);
    bot._client.off("custom_payload", payload);
    cache.clear();
    queue.clear();
    active = null;
  } };
}

// ../mc-visual-console/packages/modern-viewer/renderer-src/host/viewer-ysm-motion.mjs
var angle = (value) => Math.atan2(Math.sin(value), Math.cos(value));
var compactItem = (item) => {
  if (item === null) return null;
  if (!item || !/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]{1,128}$/.test(item.name ?? "")) return null;
  const result = { name: item.name, count: Math.min(99, Math.max(1, item.count ?? 1)) };
  for (const key of ["type", "metadata", "enchants", "components", "nbt"]) {
    if (item[key] === void 0) continue;
    try {
      const value = JSON.stringify(item[key], (_k, v) => typeof v === "bigint" ? v.toString() : v);
      if (value.length <= 8192) result[key] = JSON.parse(value);
      else result.visualDataUnavailable = true;
    } catch {
      result.visualDataUnavailable = true;
    }
  }
  return result;
};
function createViewerYsmMotion(bot, { binding, emit, now = Date.now } = {}) {
  const states = /* @__PURE__ */ new Map(), ground = /* @__PURE__ */ new Map();
  let sequence = 0;
  const listeners = [];
  const on = (target, name2, fn) => {
    target.on(name2, fn);
    listeners.push(() => target.off(name2, fn));
  };
  function actual(row) {
    const own = (bot._client.uuid ?? bot.player?.uuid)?.toLowerCase() === row.playerUuid;
    const entity = own ? bot.entity : bot.entities?.[row.entityId];
    return entity && entity.id === row.entityId && (own || entity.uuid?.toLowerCase() === row.playerUuid) ? entity : null;
  }
  function sample(row) {
    if (!row?.available) return null;
    const entity = actual(row);
    if (!entity) return null;
    const position2 = entity.position;
    if (!position2 || ![position2.x, position2.y, position2.z].every(Number.isFinite)) return null;
    let prior = states.get(row.playerUuid);
    const time = now();
    if (!prior || prior.entityId !== entity.id || prior.epoch !== row.epoch) {
      prior = { entityId: entity.id, epoch: row.epoch, position: { ...position2 }, at: time, movedAt: time, speed: 0, sentAt: 0 };
      states.set(row.playerUuid, prior);
    }
    const distance2 = Math.hypot(position2.x - prior.position.x, position2.z - prior.position.z), elapsed = (time - prior.at) / 1e3;
    if (distance2 > 0 && elapsed > 0) {
      prior.speed = distance2 < 4 && elapsed < 2 ? Math.min(30, distance2 / elapsed) : 0;
      prior.movedAt = time;
    } else if (time - prior.movedAt > 250) prior.speed = 0;
    prior.position = { x: position2.x, y: position2.y, z: position2.z };
    prior.at = time;
    const metadata = entity.metadata ?? [], flags = Number(metadata[0]) || 0, living = Number(metadata[8]) || 0;
    const yaw = entity.yaw ?? 0, headYaw = entity.headYaw ?? yaw, pitch = entity.pitch ?? 0;
    const mainArm = metadata[18] === 0 ? "left" : "right";
    const equipment = entity === bot.entity ? [bot.heldItem ?? entity.equipment?.[0] ?? null, bot.inventory?.slots?.[45] ?? entity.equipment?.[1] ?? null] : entity.equipment?.slice(0, 2);
    const result = {
      schemaVersion: 1,
      source: "same_connection_java_protocol",
      epoch: row.epoch,
      playerUuid: row.playerUuid,
      entityId: entity.id,
      sequence: ++sequence,
      horizontalSpeed: prior.speed,
      bodyYaw: yaw,
      headYawDegrees: angle(headYaw - yaw) * 180 / Math.PI,
      headPitchDegrees: -pitch * 180 / Math.PI,
      crouching: !!(flags & 2),
      sprinting: !!(flags & 8),
      usingItem: !!(living & 1),
      activeHand: living & 2 ? "offhand" : "mainhand",
      mainArm,
      pose: typeof metadata[6] === "number" ? ["standing", "fall_flying", "sleeping", "swimming", "spin_attack", "crouching", "long_jumping", "dying"][metadata[6]] : metadata[6],
      equipment: Array.isArray(equipment) ? equipment.map(compactItem) : null
    };
    const knownGround = entity === bot.entity ? entity.onGround : ground.get(entity.id);
    if (typeof knownGround === "boolean") result.onGround = knownGround;
    const flying = entity === bot.entity ? bot.game?.gameMode === "creative" && bot.entity?.isFlying : void 0;
    if (typeof flying === "boolean") result.flying = flying;
    if (prior.swing && time - prior.swing.at < 2500) result.swing = { hand: prior.swing.hand, sequence: prior.swing.sequence, ageSeconds: (time - prior.swing.at) / 1e3 };
    if (prior.hurt && time - prior.hurt.at < 700) result.hurt = { sequence: prior.hurt.sequence, ageSeconds: (time - prior.hurt.at) / 1e3 };
    return result;
  }
  function send(row, force = false) {
    const prior = states.get(row?.playerUuid);
    if (!force && prior && now() - prior.sentAt < 100) return;
    const value = sample(row);
    if (!value) return;
    const current = states.get(row.playerUuid), signature = JSON.stringify({ ...value, sequence: 0, swing: value.swing ? { ...value.swing, ageSeconds: 0 } : null, hurt: value.hurt ? { ...value.hurt, ageSeconds: 0 } : null });
    if (!force && current.signature === signature && now() - current.sentAt < 1e3) return;
    current.signature = signature;
    current.sentAt = now();
    emit("appearanceMotion", value);
  }
  const update = (entity) => {
    const row = binding(entity?.id);
    if (row) send(row);
  };
  for (const event of ["entityMoved", "entityEquip", "entityUpdate", "entitySpawn"]) on(bot, event, update);
  on(bot, "move", () => update(bot.entity));
  on(bot, "heldItemChanged", () => update(bot.entity));
  on(bot._client, "packet", (packet, meta) => {
    if (["rel_entity_move", "entity_move_look", "entity_teleport", "entity_position_sync"].includes(meta?.name) && typeof packet.onGround === "boolean") {
      if (ground.size < 128 || ground.has(packet.entityId)) ground.set(packet.entityId, packet.onGround);
    }
  });
  on(bot._client, "animation", (packet) => {
    if (![0, 3].includes(packet.animation)) return;
    const row = binding(packet.entityId);
    if (!row || !sample(row)) return;
    states.get(row.playerUuid).swing = { at: now(), hand: packet.animation === 3 ? "offhand" : "mainhand", sequence: ++sequence };
    send(row, true);
  });
  let serializer = null, outgoing = null;
  const attachOutgoing = () => {
    if (serializer && outgoing) serializer.off("data", outgoing);
    serializer = bot._client.serializer;
    outgoing = null;
    if (bot.version !== "1.20.6" || !serializer?.createPacketBuffer || !serializer.proto?.parsePacketBuffer) return;
    try {
      const armBytes = serializer.createPacketBuffer({ name: "arm_animation", params: { hand: 0 } }), prefix = armBytes.subarray(0, armBytes.length - 1);
      outgoing = (bytes) => {
        if (bot._client.state !== "play" || bytes.length !== armBytes.length || !bytes.subarray(0, prefix.length).equals(prefix)) return;
        try {
          const decoded = serializer.proto.parsePacketBuffer(serializer.mainType, bytes).data;
          if (decoded.name !== "arm_animation" || ![0, 1].includes(decoded.params.hand)) return;
          const row = binding(bot.entity?.id);
          if (!row || !sample(row)) return;
          states.get(row.playerUuid).swing = { at: now(), hand: decoded.params.hand ? "offhand" : "mainhand", sequence: ++sequence };
          send(row, true);
        } catch {
        }
      };
      serializer.on("data", outgoing);
    } catch {
    }
  };
  on(bot._client, "state", attachOutgoing);
  attachOutgoing();
  on(bot, "entityHurt", (entity) => {
    const row = binding(entity?.id);
    if (!row || !sample(row)) return;
    states.get(row.playerUuid).hurt = { at: now(), sequence: ++sequence };
    send(row, true);
  });
  on(bot, "entityGone", (entity) => {
    ground.delete(entity?.id);
    for (const [uuid, row] of states) if (row.entityId === entity?.id) states.delete(uuid);
  });
  const timer = setInterval(() => {
    for (const [uuid, prior] of states) {
      const row = binding(prior.entityId);
      if (!row || row.playerUuid !== uuid || row.epoch !== prior.epoch) states.delete(uuid);
      else send(row);
    }
  }, 100);
  timer.unref?.();
  return {
    send: (row) => send(row, true),
    snapshot: (rows) => rows.map(sample).filter(Boolean),
    reset() {
      states.clear();
      ground.clear();
    },
    dispose() {
      clearInterval(timer);
      if (serializer && outgoing) serializer.off("data", outgoing);
      for (const off of listeners) off();
      states.clear();
      ground.clear();
    }
  };
}

// ../mc-visual-console/packages/modern-viewer/renderer-src/host/viewer-appearance.mjs
var UUID3 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var APPEARANCE_CHANNEL = "mcagent:appearance";
var PAPER_YSM_JAR_SHA256 = "ec51cfae84d219a45fac5098a31bfe980bcb7c2d8b413e8fffbd05a411a85680";
function parseAppearancePacket(packet) {
  if (packet?.channel !== APPEARANCE_CHANNEL || !(packet.data instanceof Uint8Array) || packet.data.length > 2048) return null;
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packet.data));
  } catch {
    return null;
  }
  if (!value || value.schemaVersion !== 1 || value.source !== "freesia_worker" || !UUID3.test(value.epoch ?? "") || !UUID3.test(value.playerUuid ?? "")) return null;
  const base = { schemaVersion: 1, source: value.source, epoch: value.epoch, playerUuid: value.playerUuid.toLowerCase(), type: value.type };
  if (value.type === "remove") return base;
  if (value.type !== "state" || typeof value.available !== "boolean" || value.ysmVersion !== "2.4.1" || value.protocolVersion !== "2.4.0" || value.jarSha256 !== PAPER_YSM_JAR_SHA256) return null;
  Object.assign(base, { available: value.available, ysmVersion: value.ysmVersion, protocolVersion: value.protocolVersion, jarSha256: value.jarSha256 });
  if (typeof value.workerConnected === "boolean") base.workerConnected = value.workerConnected;
  if (["confirmed", "unsupported", "awaiting_model_state", "worker_offline", "awaiting_initial_poll"].includes(value.stateStatus)) base.stateStatus = value.stateStatus;
  if (typeof value.message === "string" && value.message.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value.message)) base.message = value.message;
  if (!value.available) return { ...base, reason: value.reason === "YSM_WORKER_STATE_UNSUPPORTED" ? "YSM_WORKER_STATE_UNSUPPORTED" : "YSM_WORKER_STATE_UNAVAILABLE" };
  if (!Number.isSafeInteger(value.entityId) || value.entityId < 0 || value.entityId > 2147483647 || typeof value.mandatory !== "boolean" || !/^[\p{L}\p{N}_./-]{1,96}$/u.test(value.modelId ?? "") || value.modelId.includes("..") || value.modelId.startsWith("/") || !/^[\p{L}\p{N}_.-]{1,96}$/u.test(value.texture ?? "") || typeof value.animation !== "string" || value.animation.length > 96) return null;
  const web = value.webAvailable === true && /^[a-f0-9]{64}$/.test(value.assetSha256 ?? "") && Number.isInteger(value.assetBytes) && value.assetBytes > 0 && value.assetBytes <= 2 * 1024 * 1024;
  return {
    ...base,
    entityId: value.entityId,
    modelId: value.modelId,
    texture: value.texture,
    mandatory: value.mandatory,
    animation: value.animation,
    webAvailable: web,
    ...web ? { assetSha256: value.assetSha256, assetBytes: value.assetBytes } : { webReason: typeof value.webReason === "string" ? value.webReason.slice(0, 96) : "YSM_SOURCE_NOT_REGISTERED" }
  };
}
function createViewerAppearanceBridge(bot, { now = Date.now } = {}) {
  const records = /* @__PURE__ */ new Map(), listeners = /* @__PURE__ */ new Set();
  let epoch = null, disposed = false;
  const errors = /* @__PURE__ */ new Map();
  const assets = createYsmAssetReceiver(bot, { onAsset: (bundle) => {
    emit("appearanceAsset", bundle);
    for (const row of records.values()) if (row.assetSha256 === bundle.assetSha256) {
      const bound = binding(row);
      if (bound) emit("appearanceState", bound);
    }
  }, onError: (row, reason) => {
    errors.set(row.assetSha256, reason);
    const bound = binding(row);
    if (bound) emit("appearanceState", bound);
  } });
  const emit = (name2, row) => {
    for (const fn of listeners) try {
      fn(name2, row);
    } catch {
      listeners.delete(fn);
    }
  };
  const motion = createViewerYsmMotion(bot, { now, emit, binding: (id) => {
    for (const row of records.values()) if (row.entityId === id && now() - row.receivedAt <= 15e3) return binding(row);
    return null;
  } });
  const reset = () => {
    records.clear();
    errors.clear();
    assets.reset();
    motion.reset();
    epoch = null;
    emit("appearanceReset", { schemaVersion: 1 });
  };
  function binding(row) {
    const ownUuid = bot._client.uuid ?? bot.player?.uuid;
    const own = ownUuid?.toLowerCase() === row.playerUuid;
    const entity = own ? bot.entity : bot.entities?.[row.entityId];
    const actualUuid = own ? ownUuid : entity?.uuid;
    if (!entity || typeof actualUuid !== "string" || actualUuid.toLowerCase() !== row.playerUuid || row.available && entity.id !== row.entityId) return null;
    const { receivedAt, ...publicRow } = row;
    const asset = assets.get(row.assetSha256), renderAvailable = row.available === true && asset?.modelId === row.modelId && Object.hasOwn(asset.textures, row.texture);
    return { ...publicRow, entityId: entity.id, renderAvailable, renderReason: renderAvailable ? null : errors.get(row.assetSha256) ?? row.webReason ?? row.reason ?? "YSM_ASSET_PENDING", completeEntityParityVerified: false };
  }
  function payload(packet) {
    const row = parseAppearancePacket(packet);
    if (!row) return;
    if (epoch !== row.epoch) {
      reset();
      epoch = row.epoch;
    }
    if (row.type === "remove") {
      records.delete(row.playerUuid);
      emit("appearanceRemove", { schemaVersion: 1, playerUuid: row.playerUuid });
      return;
    }
    if (records.size >= 40 && !records.has(row.playerUuid)) return;
    if (!row.available) row.entityId = records.get(row.playerUuid)?.entityId;
    records.set(row.playerUuid, { ...row, receivedAt: now() });
    const bound = binding(row);
    if (bound) {
      const bundle = assets.get(row.assetSha256);
      if (bundle) emit("appearanceAsset", bundle);
      emit("appearanceState", bound);
      motion.send(bound);
      if (listeners.size) assets.request(row);
    }
  }
  const tracked = (entity) => {
    const uuid = entity?.uuid?.toLowerCase();
    const row = uuid && records.get(uuid);
    const bound = row && binding(row);
    if (bound) emit("appearanceState", bound);
  };
  const gone = (entity) => {
    if (entity?.uuid) emit("appearanceRemove", { schemaVersion: 1, playerUuid: entity.uuid.toLowerCase() });
  };
  bot._client.on("custom_payload", payload);
  bot.on("entitySpawn", tracked);
  bot.on("entityGone", gone);
  bot.on("login", reset);
  bot.on("respawn", reset);
  bot.on("end", reset);
  const expire = () => {
    for (const [uuid, row] of records) if (now() - row.receivedAt > 15e3) {
      records.delete(uuid);
      emit("appearanceRemove", { schemaVersion: 1, playerUuid: uuid });
    }
  };
  const timer = setInterval(expire, 1e3);
  timer.unref?.();
  const snapshot = () => {
    expire();
    return Array.from(records.values()).map(binding).filter(Boolean);
  };
  return { snapshot, subscribeSocket(socket) {
    if (disposed) throw Error("viewer_appearance_disposed");
    const fn = (name2, row) => socket.emit(name2, row);
    listeners.add(fn);
    socket.emit("appearanceReset", { schemaVersion: 1 });
    for (const row of snapshot()) {
      const bundle = assets.get(row.assetSha256);
      if (bundle) socket.emit("appearanceAsset", bundle);
      socket.emit("appearanceState", row);
      motion.send(row);
      assets.request(row);
    }
    return () => listeners.delete(fn);
  }, dispose() {
    if (disposed) return;
    disposed = true;
    assets.dispose();
    motion.dispose();
    clearInterval(timer);
    bot._client.off("custom_payload", payload);
    bot.off("entitySpawn", tracked);
    bot.off("entityGone", gone);
    bot.off("login", reset);
    bot.off("respawn", reset);
    bot.off("end", reset);
    records.clear();
    listeners.clear();
  } };
}

// ../mc-visual-console/packages/modern-viewer/renderer-src/host/text-display.mjs
var integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
var vector = (v, fallback) => v === void 0 ? fallback : v && ["x", "y", "z"].every((k) => Number.isFinite(v[k]) && Math.abs(v[k]) <= 64) ? { x: v.x, y: v.y, z: v.z } : null;
var colors = Object.freeze({ black: "#000000", dark_blue: "#0000aa", dark_green: "#00aa00", dark_aqua: "#00aaaa", dark_red: "#aa0000", dark_purple: "#aa00aa", gold: "#ffaa00", gray: "#aaaaaa", dark_gray: "#555555", blue: "#5555ff", green: "#55ff55", aqua: "#55ffff", red: "#ff5555", light_purple: "#ff55ff", yellow: "#ffff55", white: "#ffffff" });
function textDisplayRuns(input) {
  let nodes = 0, length = 0;
  function nbt(value, depth = 0) {
    if (++nodes > 512 || depth > 16) throw Error("component_budget");
    if (!value || typeof value !== "object") return value;
    if (value.type === "compound") return Object.fromEntries(Object.entries(value.value).map(([k, v]) => [k, nbt(v, depth + 1)]));
    if (value.type === "list") return value.value.value.map((v) => nbt({ type: value.value.type, value: v }, depth + 1));
    if (["string", "byte", "int", "float", "double"].includes(value.type)) return value.value;
    if (Array.isArray(value)) return value.map((v) => nbt(v, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, nbt(v, depth + 1)]));
  }
  const runs = [];
  function visit(value, color2 = "#ffffff", depth = 0) {
    if (++nodes > 512 || depth > 16) throw Error("component_budget");
    if (typeof value === "string") {
      length += [...value].length;
      if (length > 512) throw Error("text_budget");
      if (value) runs.push({ text: value, color: color2 });
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) visit(v, color2, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") throw Error("component_type");
    if (["translate", "selector", "score", "nbt", "keybind"].some((k) => Object.hasOwn(value, k)) || value.obfuscated || value.bold || value.italic || value.underlined || value.strikethrough || value.font && value.font !== "minecraft:default") throw Error("component_unsupported");
    if (value.color !== void 0) {
      color2 = colors[value.color] ?? (/^#[0-9a-f]{6}$/i.test(value.color) ? value.color : null);
      if (!color2) throw Error("component_color");
    }
    if (Object.hasOwn(value, "text")) visit(value.text, color2, depth + 1);
    if (value.extra !== void 0) {
      if (!Array.isArray(value.extra)) throw Error("component_extra");
      for (const v of value.extra) visit(v, color2, depth + 1);
    }
  }
  try {
    let value = nbt(input);
    if (typeof value === "string" && value.length > 16384) return null;
    if (typeof value === "string" && /^[\[{]/.test(value.trim())) {
      try {
        value = JSON.parse(value);
      } catch {
      }
    }
    visit(value);
    if (runs.some((r) => /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(r.text))) return null;
    return runs;
  } catch {
    return null;
  }
}
function textDisplayMetadataKeys(registry) {
  const keys = registry?.entitiesByName?.text_display?.metadataKeys;
  return Array.isArray(keys) && keys[23] === "text" && keys[27] === "style_flags" ? keys : null;
}
function decodeTextDisplay(entity, registry) {
  const keys = textDisplayMetadataKeys(registry);
  if (!keys || entity?.name !== "text_display" || !integer(entity.id, 0, 2147483647)) return null;
  const position2 = entity.position;
  if (!position2 || !["x", "y", "z"].every((k) => Number.isFinite(position2[k]))) return null;
  const values = entity.metadata ?? {};
  const get = (key, fallback) => values[keys.indexOf(key)] ?? fallback;
  const runs = textDisplayRuns(get("text", ""));
  const translation = vector(get("translation"), { x: 0, y: 0, z: 0 }), scale = vector(get("scale"), { x: 1, y: 1, z: 1 });
  const identity = (v) => !v || v.x === 0 && v.y === 0 && v.z === 0 && (v.w === 1 || v.w === -1);
  const flags = get("style_flags", 0), billboard = get("billboard_render_constraints", 0);
  const lineWidth = get("line_width", 200), opacity = get("text_opacity", -1), background = get("background_color", 1073741824);
  const viewRange = get("view_range", 1), teleportTicks = get("pos_rot_interpolation_duration", 0);
  const reason = !runs ? "text-component" : !identity(get("left_rotation")) || !identity(get("right_rotation")) ? "rotation" : get("transformation_interpolation_duration", 0) !== 0 ? "transform-interpolation" : flags & ~31 ? "style-flags" : null;
  if (!integer(flags, -128, 255) || !integer(billboard, 0, 3) || !integer(lineWidth, 1, 2048) || !integer(opacity, -128, 255) || !integer(background, -2147483648, 4294967295) || !translation || !scale || !Number.isFinite(viewRange) || viewRange < 0 || viewRange > 4 || !integer(teleportTicks, 0, 59)) return null;
  return {
    schemaVersion: 1,
    id: entity.id,
    uuid: entity.uuid,
    name: "text_display",
    position: { ...position2 },
    yaw: Number.isFinite(entity.yaw) ? entity.yaw : Math.PI,
    pitch: Number.isFinite(entity.pitch) ? entity.pitch : 0,
    runs: runs ?? [],
    translation,
    scale,
    billboard,
    flags: flags & 255,
    lineWidth,
    opacity: opacity & 255,
    background: background >>> 0,
    viewRange,
    teleportTicks,
    invisible: (get("shared_flags", 0) & 32) !== 0,
    unavailable: reason
  };
}

// ../mc-visual-console/packages/modern-viewer/renderer-src/host/viewer-content.mjs
var finite2 = (n) => typeof n === "number" && Number.isFinite(n);
var integer2 = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
var pos = (p) => p && [p.x, p.y, p.z].every(finite2) ? { x: p.x, y: p.y, z: p.z } : null;
var rgb = (p) => Array.isArray(p) && p.length === 3 && p.every((n) => finite2(n) && n >= 0 && n <= 1) ? p : null;
var VIEWER_CONTENT_LIMITS = Object.freeze({ maps: 64, frames: 128, textDisplays: 64, particleBatch: 256, flushMs: 50, range: 80, longDistanceRange: 512 });
function transitionFieldOrder(protocol) {
  const fields = protocol?.types?.Particle?.[1]?.find((f) => f.name === "data")?.type?.[1]?.fields?.dust_color_transition?.[1];
  return Array.isArray(fields) ? fields.map((f) => f.name).join(",") : null;
}
function viewerParticlePacket(packet, { version = "1.20.6", protocol } = {}) {
  const position2 = pos(packet);
  const name2 = packet?.particle?.type;
  if (!position2 || typeof name2 !== "string" || !/^[a-z_]{1,64}$/.test(name2) || !integer2(packet.amount, 0, 4096) || ![packet.offsetX, packet.offsetY, packet.offsetZ, packet.velocityOffset].every(finite2)) return null;
  const data = packet.particle.data;
  const result = {
    kind: "particle",
    name: name2,
    position: position2,
    longDistance: packet.longDistance === true,
    spread: {
      x: Math.max(-8, Math.min(8, packet.offsetX)),
      y: Math.max(-8, Math.min(8, packet.offsetY)),
      z: Math.max(-8, Math.min(8, packet.offsetZ))
    },
    count: Math.min(48, packet.amount),
    speed: Math.max(0, Math.min(4, packet.velocityOffset)),
    exact: packet.amount === 1 && packet.offsetX === 0 && packet.offsetY === 0 && packet.offsetZ === 0 && packet.velocityOffset === 0
  };
  if (name2 === "dust" || name2 === "dust_color_transition") {
    if (!data) return null;
    let color2, colorEnd, scale;
    if (name2 === "dust") {
      color2 = [data.red, data.green, data.blue];
      scale = data.scale;
    } else {
      color2 = [data.fromRed, data.fromGreen, data.fromBlue];
      const order = transitionFieldOrder(protocol);
      if (version === "1.20.6" && order === "fromRed,fromGreen,fromBlue,scale,toRed,toGreen,toBlue") {
        colorEnd = [data.scale, data.toRed, data.toGreen];
        scale = data.toBlue;
      } else if (order === "fromRed,fromGreen,fromBlue,toRed,toGreen,toBlue,scale") {
        colorEnd = [data.toRed, data.toGreen, data.toBlue];
        scale = data.scale;
      } else return null;
    }
    if (!rgb(color2) || colorEnd && !rgb(colorEnd) || !finite2(scale) || scale < 0.01 || scale > 4) return null;
    result.color = color2;
    result.size = scale;
    if (colorEnd) result.colorEnd = colorEnd;
  }
  return result;
}
function viewerMapPacket(packet) {
  if (!packet || !integer2(packet.itemDamage, 0, 2147483647) || !integer2(packet.scale, 0, 4) || !integer2(packet.columns, 0, 128)) return null;
  const row = { schemaVersion: 1, mapId: packet.itemDamage, scale: packet.scale, locked: packet.locked === true };
  if (Array.isArray(packet.icons)) row.icons = packet.icons.slice(0, 256).filter((i) => integer2(i.type, 0, 255) && integer2(i.x, -128, 127) && integer2(i.z, -128, 127) && integer2(i.direction, 0, 255)).map((i) => ({ type: i.type, x: i.x, z: i.z, direction: i.direction }));
  if (packet.columns === 0) return { ...row, columns: 0 };
  if (!integer2(packet.rows, 1, 128) || !integer2(packet.x, 0, 127) || !integer2(packet.y, 0, 127) || packet.x + packet.columns > 128 || packet.y + packet.rows > 128 || !(packet.data instanceof Uint8Array) || packet.data.length !== packet.columns * packet.rows) return null;
  return { ...row, x: packet.x, y: packet.y, columns: packet.columns, rows: packet.rows, data: Uint8Array.from(packet.data) };
}
function frameMapId(slot, registry) {
  if (!slot || registry?.items?.[slot.itemId ?? slot.type]?.name !== "filled_map") return null;
  const component = slot.components?.find((c) => c.type === "map_id" || c.type === "minecraft:map_id");
  return integer2(component?.data, 0, 2147483647) ? component.data : null;
}
var normals = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
function frameTileCenter(tile, normal) {
  if (!pos(tile) || ![tile.x, tile.y, tile.z].every(Number.isInteger)) return null;
  return Object.fromEntries(["x", "y", "z"].map((axis, i) => [axis, tile[axis] + 0.5 - normal[i] * 0.46875]));
}
function nativeFrameCenter(position2, normal) {
  const tileCenter = frameTileCenter(position2, normal);
  if (tileCenter) return tileCenter;
  return pos(position2) && ["x", "y", "z"].every((axis, i) => Number.isInteger(position2[axis] + normal[i] * 0.46875 - 0.5)) ? pos(position2) : null;
}
function cachedMapFrame(entity, registry) {
  if (!["item_frame", "glow_item_frame"].includes(entity?.name) || !integer2(entity.id, 0, 2147483647) || !pos(entity.position) || !finite2(entity.yaw) || !finite2(entity.pitch)) return null;
  let normal;
  if (Math.abs(Math.abs(entity.pitch) - Math.PI / 2) < 1e-5) normal = [0, Math.sign(entity.pitch), 0];
  else if (Math.abs(entity.pitch) < 1e-5) {
    const notchYaw = Math.PI - entity.yaw, quarter = Math.round(notchYaw / (Math.PI / 2));
    if (Math.abs(notchYaw - quarter * Math.PI / 2) > 1e-5) return null;
    normal = [[0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0]][(quarter % 4 + 4) % 4];
  } else return null;
  const rotation = entity.metadata?.[9] ?? 0;
  if (!integer2(rotation, 0, 7)) return null;
  const position2 = nativeFrameCenter(entity.position, normal);
  if (!position2) return null;
  return {
    id: entity.id,
    uuid: entity.uuid,
    name: entity.name,
    position: position2,
    normal,
    rotation,
    mapId: frameMapId(entity.metadata?.[8], registry),
    invisible: ((entity.metadata?.[0] ?? 0) & 32) !== 0
  };
}
function createViewerContentBridge(bot, { now = Date.now, schedule = setInterval, unschedule = clearInterval } = {}) {
  if (bot.version !== "1.20.6") throw Error("viewer_content_requires_1.20.6");
  const protocol = bot._client, maps = /* @__PURE__ */ new Map(), frames = /* @__PURE__ */ new Map(), textEntities = /* @__PURE__ */ new Map(), textDisplays = /* @__PURE__ */ new Map(), listeners = /* @__PURE__ */ new Set(), hooks = [], socketDrainers = /* @__PURE__ */ new Set(), socketDisposers = /* @__PURE__ */ new Set();
  let epoch = 0, queue = [], disposed = false;
  const diagnostics = { particles: 0, droppedParticles: 0, mapPatches: 0, rejected: 0, subscriberErrors: 0, cachedFrames: 0, cachedTextDisplays: 0, rejectedTextDisplays: 0 };
  const nearby = (p, range = VIEWER_CONTENT_LIMITS.range) => !bot.entity?.position || Math.hypot(p.x - bot.entity.position.x, p.y - bot.entity.position.y, p.z - bot.entity.position.z) <= range;
  const deliver = (publish, name2, value) => {
    try {
      publish(name2, value);
    } catch {
      diagnostics.subscriberErrors++;
    }
  };
  const send = (name2, value) => {
    for (const publish of listeners) deliver(publish, name2, { ...value, epoch });
  };
  const on = (emitter, name2, fn) => {
    emitter.on(name2, fn);
    hooks.push(() => emitter.off(name2, fn));
  };
  function textSnapshot(display) {
    return { ...display, position: { ...display.position }, translation: { ...display.translation }, scale: { ...display.scale }, runs: display.runs.map((r) => ({ ...r })) };
  }
  function publishText(entity) {
    const display = decodeTextDisplay(entity, bot.registry);
    if (!display) {
      diagnostics.rejectedTextDisplays++;
      if (textDisplays.delete(entity.id)) send("textDisplay", { schemaVersion: 1, id: entity.id, delete: true });
      return;
    }
    textDisplays.set(display.id, display);
    send("textDisplay", textSnapshot(display));
  }
  function removeText(id) {
    textEntities.delete(id);
    if (textDisplays.delete(id)) send("textDisplay", { schemaVersion: 1, id, delete: true });
  }
  on(protocol, "spawn_entity", (packet) => {
    removeText(packet.entityId);
    if (bot.registry?.entities?.[packet.type]?.name !== "text_display" || !textDisplayMetadataKeys(bot.registry) || !integer2(packet.entityId, 0, 2147483647) || !pos(packet)) return;
    if (textEntities.size >= VIEWER_CONTENT_LIMITS.textDisplays) {
      diagnostics.rejectedTextDisplays++;
      return;
    }
    const entity = {
      id: packet.entityId,
      uuid: packet.objectUUID,
      name: "text_display",
      position: pos(packet),
      metadata: {},
      yaw: Math.PI - (packet.yaw ?? 0) * Math.PI / 128,
      pitch: -(packet.pitch ?? 0) * Math.PI / 128
    };
    textEntities.set(entity.id, entity);
    publishText(entity);
  });
  on(protocol, "entity_metadata", (packet) => {
    const entity = textEntities.get(packet.entityId);
    if (!entity || !Array.isArray(packet.metadata)) return;
    for (const field of packet.metadata.slice(0, 64)) if (integer2(field.key, 0, 27)) entity.metadata[field.key] = field.value;
    publishText(entity);
  });
  on(protocol, "entity_teleport", (packet) => {
    const entity = textEntities.get(packet.entityId), position2 = pos(packet);
    if (!entity || !position2) return;
    const yaw = integer2(packet.yaw, -128, 255) ? Math.PI - packet.yaw * Math.PI / 128 : entity.yaw;
    const pitch = integer2(packet.pitch, -128, 255) ? -packet.pitch * Math.PI / 128 : entity.pitch;
    if (["x", "y", "z"].every((k) => entity.position[k] === position2[k]) && entity.yaw === yaw && entity.pitch === pitch) return;
    entity.position = position2;
    entity.yaw = yaw;
    entity.pitch = pitch;
    publishText(entity);
  });
  on(bot, "entityMoved", (moved) => {
    const entity = textEntities.get(moved.id);
    if (!entity || !pos(moved.position)) return;
    if (JSON.stringify(entity.position) === JSON.stringify(pos(moved.position)) && entity.yaw === moved.yaw && entity.pitch === moved.pitch) return;
    entity.position = pos(moved.position);
    entity.yaw = moved.yaw;
    entity.pitch = moved.pitch;
    publishText(entity);
  });
  on(protocol, "entity_destroy", (packet) => {
    for (const id of packet.entityIds ?? []) removeText(id);
  });
  on(protocol, "world_particles", (packet) => {
    const event = viewerParticlePacket(packet, { version: bot.version, protocol: bot.registry?.protocol });
    if (!event) {
      diagnostics.rejected++;
      return;
    }
    if (!nearby(event.position, event.longDistance ? VIEWER_CONTENT_LIMITS.longDistanceRange : VIEWER_CONTENT_LIMITS.range) || !listeners.size) return;
    if (queue.length >= VIEWER_CONTENT_LIMITS.particleBatch) {
      diagnostics.droppedParticles++;
      return;
    }
    queue.push(event);
    diagnostics.particles++;
  });
  function flush() {
    if (disposed) return;
    for (const drain of socketDrainers) try {
      drain();
    } catch {
      diagnostics.subscriberErrors++;
    }
    if (!queue.length) return;
    const events = queue;
    queue = [];
    send("particleBatch", { schemaVersion: 1, atMs: now(), events });
  }
  const timer = schedule(flush, VIEWER_CONTENT_LIMITS.flushMs);
  timer?.unref?.();
  on(protocol, "map", (packet) => {
    const patch = viewerMapPacket(packet);
    if (!patch) {
      diagnostics.rejected++;
      return;
    }
    let map = maps.get(patch.mapId);
    if (!map) {
      if (maps.size >= VIEWER_CONTENT_LIMITS.maps) maps.delete(maps.keys().next().value);
      map = { mapId: patch.mapId, scale: patch.scale, locked: patch.locked, data: new Uint8Array(16384), coverage: new Uint8Array(2048), icons: [] };
      maps.set(patch.mapId, map);
    }
    map.scale = patch.scale;
    map.locked = patch.locked;
    if (patch.icons) map.icons = patch.icons;
    for (let y = 0; y < (patch.rows ?? 0); y++) for (let x = 0; x < patch.columns; x++) {
      const index = (patch.y + y) * 128 + patch.x + x;
      map.data[index] = patch.data[y * patch.columns + x];
      map.coverage[index >> 3] |= 1 << (index & 7);
    }
    diagnostics.mapPatches++;
    send("mapPixels", patch);
  });
  on(protocol, "spawn_entity", (packet) => {
    const name2 = bot.registry?.entities?.[packet.type]?.name;
    if (!["item_frame", "glow_item_frame"].includes(name2) || !integer2(packet.entityId, 0, 2147483647) || !pos(packet) || !integer2(packet.objectData, 0, 5)) return;
    if (frames.size >= VIEWER_CONTENT_LIMITS.frames) return;
    const normal = normals[packet.objectData], position2 = frameTileCenter(packet, normal);
    if (!position2) return;
    frames.set(packet.entityId, { id: packet.entityId, uuid: packet.objectUUID, name: name2, position: position2, normal, rotation: 0, mapId: null, invisible: false });
  });
  on(protocol, "entity_metadata", (packet) => {
    const frame = frames.get(packet.entityId);
    if (!frame || !Array.isArray(packet.metadata)) return;
    for (const field of packet.metadata) {
      if (field.key === 0 && integer2(field.value, -128, 255)) frame.invisible = (field.value & 32) !== 0;
      if (field.key === 8) frame.mapId = frameMapId(field.value, bot.registry);
      if (field.key === 9 && integer2(field.value, 0, 7)) frame.rotation = field.value;
    }
    if (nearby(frame.position)) send("mapFrame", { schemaVersion: 1, ...frame });
  });
  on(protocol, "entity_teleport", (packet) => {
    const frame = frames.get(packet.entityId);
    if (!frame) return;
    const position2 = nativeFrameCenter(packet, frame.normal);
    if (!position2) {
      diagnostics.rejected++;
      return;
    }
    frame.position = position2;
    if (nearby(position2)) send("mapFrame", { schemaVersion: 1, ...frame });
  });
  on(protocol, "entity_destroy", (packet) => {
    for (const id of packet.entityIds ?? []) if (frames.delete(id)) send("mapFrame", { schemaVersion: 1, id, delete: true });
  });
  for (const entity of Object.values(bot.entities ?? {})) {
    if (frames.size >= VIEWER_CONTENT_LIMITS.frames) break;
    const frame = cachedMapFrame(entity, bot.registry);
    if (frame) {
      frames.set(frame.id, frame);
      diagnostics.cachedFrames++;
    }
  }
  for (const entity of Object.values(bot.entities ?? {})) {
    if (textEntities.size >= VIEWER_CONTENT_LIMITS.textDisplays) break;
    if (entity.name !== "text_display") continue;
    const display = decodeTextDisplay(entity, bot.registry);
    if (!display) continue;
    textEntities.set(entity.id, { ...entity, position: pos(entity.position), metadata: { ...entity.metadata } });
    textDisplays.set(entity.id, display);
    diagnostics.cachedTextDisplays++;
  }
  function reset() {
    epoch++;
    maps.clear();
    frames.clear();
    textEntities.clear();
    textDisplays.clear();
    queue = [];
    send("contentReset", { schemaVersion: 1 });
  }
  on(bot, "respawn", reset);
  on(bot, "end", reset);
  function snapshot(map) {
    return { schemaVersion: 1, epoch, ...map, data: Uint8Array.from(map.data), coverage: Uint8Array.from(map.coverage), snapshot: true, x: 0, y: 0, columns: 128, rows: 128 };
  }
  function subscribe(publish) {
    if (disposed) throw Error("viewer_content_disposed");
    if (typeof publish !== "function") throw TypeError("viewer_content_publish_required");
    listeners.add(publish);
    deliver(publish, "contentReset", { schemaVersion: 1, epoch });
    for (const map of maps.values()) deliver(publish, "mapPixels", snapshot(map));
    for (const frame of frames.values()) if (nearby(frame.position)) deliver(publish, "mapFrame", { schemaVersion: 1, epoch, ...frame });
    for (const display of textDisplays.values()) deliver(publish, "textDisplay", { ...textSnapshot(display), epoch });
    return () => listeners.delete(publish);
  }
  function subscribeSocket(socket, { writable = () => socket.connected && socket.conn?.transport?.writable !== false && (socket.conn?.writeBuffer?.length ?? 0) <= 4 } = {}) {
    let closed = false, resetPending = false;
    const mapIds = /* @__PURE__ */ new Set(), frameIds = /* @__PURE__ */ new Set(), textIds = /* @__PURE__ */ new Set();
    const fullReplay = () => {
      resetPending = true;
      mapIds.clear();
      frameIds.clear();
      textIds.clear();
      for (const id of maps.keys()) mapIds.add(id);
      for (const id of frames.keys()) frameIds.add(id);
      for (const id of textDisplays.keys()) textIds.add(id);
    };
    function drain() {
      if (closed || !writable()) return;
      if (resetPending) {
        socket.emit("contentReset", { schemaVersion: 1, epoch });
        resetPending = false;
      }
      let sent = 0;
      for (const id of textIds) {
        if (!writable() || sent >= 4) break;
        textIds.delete(id);
        const display = textDisplays.get(id);
        socket.emit("textDisplay", display ? { ...textSnapshot(display), epoch } : { schemaVersion: 1, epoch, id, delete: true });
        sent++;
      }
      for (const id of mapIds) {
        if (!writable() || sent >= 4) break;
        mapIds.delete(id);
        const map = maps.get(id);
        if (map) {
          socket.emit("mapPixels", snapshot(map));
          sent++;
        }
      }
      for (const id of frameIds) {
        if (!writable() || sent >= 4) break;
        frameIds.delete(id);
        const frame = frames.get(id);
        socket.emit("mapFrame", frame ? { schemaVersion: 1, epoch, ...frame } : { schemaVersion: 1, epoch, id, delete: true });
        sent++;
      }
    }
    const off = subscribe((name2, value) => {
      if (name2 === "contentReset") {
        resetPending = true;
        mapIds.clear();
        frameIds.clear();
        textIds.clear();
      }
      if (writable() && !resetPending && !mapIds.size && !frameIds.size && !textIds.size) {
        socket.emit(name2, value);
        return;
      }
      if (name2 === "mapPixels") mapIds.add(value.mapId);
      if (name2 === "mapFrame") frameIds.add(value.id);
      if (name2 === "textDisplay") textIds.add(value.id);
      if (mapIds.size > VIEWER_CONTENT_LIMITS.maps || frameIds.size > VIEWER_CONTENT_LIMITS.frames || textIds.size > VIEWER_CONTENT_LIMITS.textDisplays) fullReplay();
      drain();
    });
    function close() {
      if (closed) return;
      closed = true;
      off();
      mapIds.clear();
      frameIds.clear();
      textIds.clear();
      socketDrainers.delete(drain);
      socketDisposers.delete(close);
      socket.off("disconnect", close);
    }
    socketDrainers.add(drain);
    socketDisposers.add(close);
    socket.on("disconnect", close);
    return close;
  }
  return {
    subscribe,
    subscribeSocket,
    flush,
    stats: () => ({ ...diagnostics, epoch, maps: maps.size, frames: frames.size, textDisplays: textDisplays.size, viewers: listeners.size, pendingParticles: queue.length }),
    dispose() {
      if (disposed) return;
      disposed = true;
      unschedule(timer);
      for (const close of [...socketDisposers]) close();
      for (const off of hooks) off();
      maps.clear();
      frames.clear();
      textEntities.clear();
      textDisplays.clear();
      listeners.clear();
      queue = [];
    }
  };
}

// src/worlds/minecraft/modern-viewer.ts
import { createRequire } from "node:module";
import { createHash as createHash3 } from "node:crypto";
import { createServer } from "node:http";
import { readFile as readFile4, stat as stat4 } from "node:fs/promises";
import path4 from "node:path";
import { Server as SocketServer } from "socket.io";
import { Vec3 as Vec33 } from "vec3";
import { gameOnline } from "../game_health.js";

// src/worlds/minecraft/viewer-biome.ts
function nearestVanillaBiome(name2) {
  const value = name2.replace(/^.*:/, "").toLowerCase();
  if (/cherry|sakura/.test(value)) return "cherry_grove";
  if (/mushroom|fungal/.test(value)) return "mushroom_fields";
  if (/mangrove|swamp|marsh|bog/.test(value)) return "swamp";
  if (/badlands|mesa|canyon/.test(value)) return "badlands";
  if (/snow|frozen|ice|glacier|tundra|alpine/.test(value)) return "snowy_plains";
  if (/jungle|rainforest|tropical|bamboo/.test(value)) return "jungle";
  if (/desert|dune/.test(value)) return "desert";
  if (/savanna|shrub|steppe|prairie|dry_grass/.test(value)) return "savanna";
  if (/ocean|river|lake|coast/.test(value)) return "river";
  if (/taiga|spruce|pine/.test(value)) return "taiga";
  if (/forest|woods|grove/.test(value)) return "forest";
  if (/nether|crimson|warped|basalt|soul_sand/.test(value)) return "nether_wastes";
  if (/end|void/.test(value)) return "the_end";
  return "plains";
}
function biomeIdMap(server, vanilla) {
  const targetByName = new Map(vanilla.map((biome) => [biome.name.replace(/^minecraft:/, ""), biome.id]));
  const fallback = targetByName.get("plains");
  if (fallback === void 0) throw Error("Minecraft 1.20.6 \u7FA4\u7CFB\u5217\u8868\u7F3A\u5C11 plains");
  const result = /* @__PURE__ */ new Map();
  const add = (key, biome) => {
    const id = Number.isInteger(biome.id) ? biome.id : Number(key);
    if (!Number.isInteger(id) || id < 0) return;
    const name2 = String(biome.name || "").replace(/^minecraft:/, "");
    result.set(id, targetByName.get(name2) ?? targetByName.get(nearestVanillaBiome(name2)) ?? fallback);
  };
  for (const [key, biome] of Object.entries(server.biomes || {})) add(key, biome);
  for (const biome of server.biomesArray || []) add(String(biome.id), biome);
  return result;
}
function remapViewerChunkBiomes(serialized, ids, fallback) {
  if (ids.size === 0 || typeof serialized !== "string") return serialized;
  try {
    const chunk = JSON.parse(serialized);
    if (!Array.isArray(chunk.biomes)) return serialized;
    let changed = false;
    chunk.biomes = chunk.biomes.map((section) => {
      if (typeof section !== "string") return section;
      const data = JSON.parse(section);
      if (data.type === "single" && Number.isInteger(data.value)) {
        const next = ids.get(data.value) ?? fallback;
        if (next !== data.value) {
          data.value = next;
          changed = true;
          return JSON.stringify(data);
        }
      } else if (data.type === "indirect" && Array.isArray(data.palette)) {
        const palette = data.palette.map((id) => ids.get(id) ?? fallback);
        if (palette.some((id, index) => id !== data.palette[index])) {
          data.palette = palette;
          changed = true;
          return JSON.stringify(data);
        }
      }
      return section;
    });
    return changed ? JSON.stringify(chunk) : serialized;
  } catch {
    return serialized;
  }
}

// src/worlds/minecraft/viewer-light.ts
function viewerLight(bot) {
  if (!bot.entity?.position) return null;
  const world = bot.world;
  if (typeof world.getSkyLight !== "function" || typeof world.getBlockLight !== "function") return null;
  const feet = bot.entity.position.floored();
  for (const position2 of [feet.offset(0, 1, 0), feet]) {
    try {
      const block = bot.blockAt(position2, false);
      if (!block || block.boundingBox === "block") continue;
      const sky = world.getSkyLight(position2);
      const emitted = world.getBlockLight(position2);
      if (Number.isInteger(sky) && sky >= 0 && sky <= 15 && Number.isInteger(emitted) && emitted >= 0 && emitted <= 15) {
        return { sky, block: emitted };
      }
    } catch {
    }
  }
  return null;
}

// src/worlds/minecraft/viewer-minimap.ts
var RADIUS = 12;
var MAX_Y_ABOVE = 9;
var MAX_Y_BELOW = 18;
function terrainKind(name2) {
  if (!name2 || name2 === "air" || name2.endsWith("_air")) return " ";
  if (name2.includes("water") || name2 === "bubble_column") return "W";
  if (name2.includes("lava")) return "L";
  if (name2.includes("leaves") || name2.includes("vine")) return "F";
  if (name2.includes("log") || name2.includes("stem") || name2.includes("wood")) return "T";
  if (name2.includes("grass") || name2.includes("moss") || name2.includes("azalea")) return "G";
  if (name2.includes("path") || name2.includes("farmland")) return "P";
  if (name2.includes("sand") || name2.includes("terracotta")) return "S";
  if (name2.includes("snow") || name2.includes("ice")) return "N";
  if (name2.includes("flower") || name2.includes("crop") || name2.includes("wheat")) return "C";
  if (name2.includes("stone") || name2.includes("ore") || name2.includes("tuff")) return "R";
  if (name2.includes("dirt") || name2.includes("mud") || name2.includes("clay")) return "B";
  if (name2.includes("planks") || name2.includes("brick") || name2.includes("cobble") || name2.includes("glass")) return "H";
  return "X";
}
function minimapSnapshot(source) {
  const position2 = source.entity.position;
  const centerX = Math.floor(position2.x);
  const centerZ = Math.floor(position2.z);
  const playerY = Math.floor(position2.y);
  const blocks = source.registry.blocksByStateId ?? {};
  const columns = /* @__PURE__ */ new Map();
  const cells = [];
  for (let dz = -RADIUS; dz <= RADIUS; dz++) {
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      const worldX = centerX + dx;
      const worldZ = centerZ + dz;
      const chunkX = Math.floor(worldX / 16);
      const chunkZ = Math.floor(worldZ / 16);
      const key = `${chunkX},${chunkZ}`;
      if (!columns.has(key)) columns.set(key, source.world.getColumn(chunkX, chunkZ) ?? null);
      const column = columns.get(key);
      if (!column) {
        cells.push("?");
        continue;
      }
      const localX = worldX - chunkX * 16;
      const localZ = worldZ - chunkZ * 16;
      const top = Math.min(playerY + MAX_Y_ABOVE, (column.minY ?? -64) + (column.worldHeight ?? 384) - 1);
      const bottom = Math.max(playerY - MAX_Y_BELOW, column.minY ?? -64);
      let kind = " ";
      for (let y = top; y >= bottom; y--) {
        const stateId = column.getBlockStateId({ x: localX, y, z: localZ });
        const name2 = blocks[stateId]?.name ?? "";
        kind = terrainKind(name2);
        if (kind !== " ") break;
      }
      cells.push(kind);
    }
  }
  return {
    centerX,
    centerZ,
    radius: RADIUS,
    sampleY: playerY,
    dimension: String(source.game.dimension || "minecraft:overworld"),
    cells: cells.join("")
  };
}

// src/worlds/minecraft/item-display.ts
function itemCustomName(item) {
  const nbt = item.nbt;
  const value = item.customName ?? componentData(item, "custom_name") ?? componentData(item, "item_name") ?? nbt?.value?.display?.value?.Name?.value;
  return chatText(unwrapNbt(value))?.slice(0, 80) ?? null;
}
function componentData(item, type) {
  return item.componentMap?.get(type)?.data ?? item.componentMap?.get(`minecraft:${type}`)?.data ?? item.components?.find((entry) => entry.type === type || entry.type === `minecraft:${type}`)?.data;
}
function unwrapNbt(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 16) return value;
  const tag = value;
  if (tag.type === "compound" && tag.value && typeof tag.value === "object") {
    return Object.fromEntries(Object.entries(tag.value).map(([key, entry]) => [key, unwrapNbt(entry, depth + 1)]));
  }
  if (tag.type === "list" && tag.value && typeof tag.value === "object") {
    const list = tag.value;
    return Array.isArray(list.value) ? list.value.slice(0, 64).map((entry) => unwrapNbt({ type: list.type, value: entry }, depth + 1)) : [];
  }
  if (typeof tag.type === "string" && "value" in tag) return unwrapNbt(tag.value, depth + 1);
  return value;
}
function chatText(value, depth = 0) {
  if (depth > 16) return null;
  if (typeof value === "string") {
    if (value.length > 4096) return null;
    try {
      return chatText(JSON.parse(value), depth + 1) ?? value;
    } catch {
      return value.trim() || null;
    }
  }
  if (Array.isArray(value)) {
    const text = value.map((part) => chatText(part, depth + 1)).filter((part) => Boolean(part)).join("");
    return text || null;
  }
  if (value && typeof value === "object") {
    const part = value;
    const text = `${typeof part.text === "string" ? part.text : ""}${chatText(part.extra, depth + 1) ?? ""}`.trim();
    return text || null;
  }
  return null;
}
function itemProfileSkinHash(item) {
  const profile = componentData(item, "profile");
  const properties = Array.isArray(profile?.properties) ? profile.properties : [];
  const texture = properties.find((entry) => entry && typeof entry === "object" && entry.name === "textures");
  if (typeof texture?.value !== "string" || texture.value.length > 8192) return null;
  try {
    const decoded = JSON.parse(Buffer.from(texture.value, "base64").toString("utf8"));
    if (typeof decoded.textures?.SKIN?.url !== "string") return null;
    const url = new URL(decoded.textures.SKIN.url);
    if (!["http:", "https:"].includes(url.protocol) || url.hostname !== "textures.minecraft.net" || url.port || url.username || url.password || url.search || url.hash) return null;
    return /^\/texture\/([0-9a-f]{40,64})$/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

// src/worlds/minecraft/item-facts.ts
var TOOL_MAX = {
  wooden: 59,
  stone: 131,
  iron: 250,
  golden: 32,
  diamond: 1561,
  netherite: 2031
};
var TOOL_KIND = /* @__PURE__ */ new Set(["pickaxe", "axe", "shovel", "hoe", "sword"]);
var ARMOR_BASE = {
  leather: 5,
  chainmail: 15,
  iron: 15,
  golden: 7,
  diamond: 33,
  netherite: 37
};
var ARMOR_SLOT = {
  helmet: 11,
  chestplate: 16,
  leggings: 15,
  boots: 13
};
var WHOLE_MAX = {
  shield: 336,
  bow: 384,
  crossbow: 465,
  trident: 250,
  elytra: 432,
  fishing_rod: 64,
  flint_and_steel: 64,
  shears: 238,
  brush: 64,
  carrot_on_a_stick: 25,
  warped_fungus_on_a_stick: 100,
  turtle_helmet: 275
};
function maxDurabilityOf(id) {
  const name2 = id.replace(/^minecraft:/, "");
  const whole = WHOLE_MAX[name2];
  if (whole !== void 0) return whole;
  const cut = name2.lastIndexOf("_");
  if (cut < 0) return null;
  const head = name2.slice(0, cut);
  const tail = name2.slice(cut + 1);
  if (TOOL_KIND.has(tail) && TOOL_MAX[head] !== void 0) return TOOL_MAX[head];
  const slot = ARMOR_SLOT[tail];
  const base = ARMOR_BASE[head];
  if (slot !== void 0 && base !== void 0) return base * slot;
  return null;
}
function componentData2(item, type) {
  return item.componentMap?.get(type)?.data;
}
function nbtValue(node, key) {
  const v = node?.value;
  return v?.[key]?.value;
}
function readDamage(item) {
  const comp = componentData2(item, "damage");
  if (typeof comp === "number") return comp;
  const raw = nbtValue(item.nbt, "Damage");
  return typeof raw === "number" ? raw : null;
}
function readDurability(item) {
  const max = maxDurabilityOf(item.name);
  if (max === null) return null;
  return { left: Math.max(0, max - (readDamage(item) ?? 0)), max };
}
function readEnchants(item, registry) {
  const out = [];
  for (const type of ["enchantments", "stored_enchantments"]) {
    const data = componentData2(item, type);
    for (const e of data?.enchantments ?? []) {
      const name2 = enchantName(e.id, registry);
      if (name2 !== null && typeof e.level === "number") out.push({ name: name2, level: e.level });
    }
  }
  if (out.length > 0) return out;
  for (const key of ["Enchantments", "StoredEnchantments"]) {
    const list = nbtValue(item.nbt, key);
    for (const e of list?.value ?? []) {
      const name2 = enchantName(e.id?.value, registry);
      const lvl = e.lvl?.value;
      if (name2 !== null && typeof lvl === "number") out.push({ name: name2, level: lvl });
    }
  }
  return out;
}
function enchantName(id, registry) {
  if (typeof id === "string") return id.replace(/^minecraft:/, "");
  if (typeof id !== "number") return null;
  return registry?.enchantments?.[id]?.name ?? null;
}

// src/worlds/minecraft/text-component.ts
function minecraftTextComponent(value) {
  const unwrapNbt2 = (input2, depth) => {
    if (depth > 16 || !input2 || typeof input2 !== "object") return input2;
    if (Array.isArray(input2)) return input2.map((part) => unwrapNbt2(part, depth + 1));
    const tag = input2;
    if (typeof tag.type === "string" && "value" in tag) return unwrapNbt2(tag.value, depth + 1);
    return Object.fromEntries(Object.entries(tag).map(([key, part]) => [key, unwrapNbt2(part, depth + 1)]));
  };
  const render = (input2, depth) => {
    if (depth > 8 || input2 === null || input2 === void 0) return "";
    if (typeof input2 === "number") return String(input2);
    if (typeof input2 === "string") {
      const text2 = input2.trim();
      if (/^[\[{\"]/.test(text2)) {
        try {
          return render(JSON.parse(text2), depth + 1);
        } catch {
        }
      }
      return input2;
    }
    if (Array.isArray(input2)) return input2.map((part) => render(part, depth + 1)).join("");
    if (typeof input2 !== "object") return "";
    const component = input2;
    if (typeof component.toString === "function" && component.toString !== Object.prototype.toString) {
      const text2 = component.toString();
      if (text2 && text2 !== "[object Object]") return text2;
    }
    if (component.value !== void 0 && component.text === void 0 && component.extra === void 0) {
      return render(component.value, depth + 1);
    }
    let text = component.text === void 0 ? "" : render(component.text, depth + 1);
    if (!text && typeof component.translate === "string") {
      const args = Array.isArray(component.with) ? component.with.map((part) => render(part, depth + 1)) : [];
      let nextArg = 0;
      const template = typeof component.fallback === "string" ? component.fallback : component.translate;
      text = template.replace(/%(?:(\d+)\$)?s/g, (_match, slot) => args[slot ? Number(slot) - 1 : nextArg++] ?? "");
      if (text === template && args.length) text += ` ${args.join(" ")}`;
    }
    if (!text && typeof component.keybind === "string") text = component.keybind;
    if (!text && typeof component.selector === "string") text = component.selector;
    if (!text && component.score && typeof component.score === "object") {
      const score = component.score;
      if (typeof score.value === "string" || typeof score.value === "number") text = String(score.value);
    }
    return text + (component.extra === void 0 ? "" : render(component.extra, depth + 1));
  };
  const input = value && typeof value === "object" && "type" in value && "value" in value ? unwrapNbt2(value, 0) : value;
  return render(input, 0).trim().slice(0, 500);
}

// src/worlds/minecraft/viewer-state.ts
var finite3 = (value) => typeof value === "number" && Number.isFinite(value);
var bounded = (value, min, max) => finite3(value) && value >= min && value <= max ? value : null;
function viewerItemData(value, depth = 0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
  if (typeof value === "string") return value.slice(0, 4096);
  if (!value || typeof value !== "object" || depth >= 8) return void 0;
  if (Array.isArray(value)) return value.slice(0, 64).map((part) => viewerItemData(part, depth + 1) ?? null);
  const result = {};
  for (const [key, part] of Object.entries(value).slice(0, 64)) {
    const safe = viewerItemData(part, depth + 1);
    if (safe !== void 0) result[key.slice(0, 128)] = safe;
  }
  return result;
}
function viewerItem(value) {
  if (!value || typeof value !== "object") return null;
  const item = value;
  if (typeof item.name !== "string" || !finite3(item.type)) return null;
  const customName = itemCustomName(item);
  const headTextureHash = item.name.replace(/^minecraft:/, "") === "player_head" ? itemProfileSkinHash(item) : null;
  const componentMap = item.componentMap instanceof Map ? item.componentMap : null;
  const enchantComponent = componentMap?.get("enchantments")?.data ?? (Array.isArray(item.components) ? item.components.find((component) => component.type === "enchantments")?.data : void 0);
  const enchanted = Array.isArray(enchantComponent?.enchantments) && enchantComponent.enchantments.length > 0 || readEnchants(item).length > 0;
  const vanillaDurability = readDurability(item);
  const customMax = componentMap?.get("max_damage")?.data;
  const max = finite3(customMax) && customMax > 0 && customMax <= 1e6 ? customMax : vanillaDurability?.max;
  const damage = readDamage(item) ?? 0;
  const durability = max && !componentMap?.has("unbreakable") ? { left: Math.max(0, max - damage), max } : null;
  return {
    name: item.name.slice(0, 96),
    type: item.type,
    itemId: item.type,
    displayName: customName ?? (typeof item.displayName === "string" ? item.displayName.slice(0, 80) : item.name.slice(0, 80)),
    count: bounded(item.count, 1, 127) ?? 1,
    metadata: bounded(item.metadata, 0, 65535) ?? 0,
    ...customName ? { customName } : {},
    ...headTextureHash ? { headTextureHash } : {},
    ...enchanted ? { enchanted: true } : {},
    ...durability ? { durability } : {},
    ...item.components ? { components: viewerItemData(item.components) } : {},
    ...item.nbt ? { nbt: viewerItemData(item.nbt) } : {}
  };
}
function viewerTradeList(packet, decodeItem) {
  if (!packet || typeof packet !== "object") return null;
  const source = packet;
  if (!Number.isInteger(source.windowId) || !Array.isArray(source.trades)) return null;
  const offers = [];
  for (const entry of source.trades.slice(0, 128)) {
    if (!entry || typeof entry !== "object") continue;
    const trade = entry;
    const input = decodeItem(trade.inputItem1);
    const output = decodeItem(trade.outputItem);
    if (!input || !output) continue;
    const secondInput = decodeItem(trade.inputItem2);
    const uses = bounded(trade.nbTradeUses, 0, 65535) ?? 0;
    const maxUses = bounded(trade.maximumNbTradeUses, 0, 65535) ?? 0;
    const demand = finite3(trade.demand) ? trade.demand : 0;
    const multiplier = finite3(trade.priceMultiplier) ? trade.priceMultiplier : 0;
    const special = finite3(trade.specialPrice) ? trade.specialPrice : 0;
    const calculatedPrice = Math.max(1, Math.min(
      64,
      input.count + special + Math.max(0, Math.floor(input.count * demand * multiplier))
    ));
    const compact = (item) => {
      const display = { ...item };
      delete display.components;
      delete display.nbt;
      return display;
    };
    offers.push({
      input: compact(input),
      secondInput: secondInput ? compact(secondInput) : null,
      output: compact(output),
      uses,
      maxUses,
      disabled: trade.tradeDisabled === true || maxUses > 0 && uses >= maxUses,
      realPrice: bounded(trade.realPrice, 1, 64) ?? calculatedPrice,
      xp: bounded(trade.xp, 0, 9999)
    });
  }
  return {
    windowId: source.windowId,
    offers,
    level: bounded(source.villagerLevel, 0, 5),
    experience: bounded(source.experience, 0, 1e6),
    regularVillager: source.isRegularVillager === true
  };
}
function windowSnapshot(window, properties = /* @__PURE__ */ new Map(), serializeItem = viewerItem, trades = null) {
  if (!window) return null;
  const type = String(window.type || "minecraft:generic_9x3").slice(0, 80);
  const inventoryStart = Math.max(0, Math.min(90, Number(window.inventoryStart) || 0));
  const hotbarStart = Math.max(inventoryStart, Math.min(90, Number(window.hotbarStart) || 0));
  const furnace = /(?:^|:)(?:furnace|blast_furnace|smoker)$/.test(type);
  const currentBurn = properties.get(0);
  const totalBurn = properties.get(1);
  const currentCook = properties.get(2);
  const totalCook = properties.get(3);
  const ratio = (current, total) => finite3(current) && finite3(total) && total > 0 ? Math.max(0, Math.min(1, current / total)) : null;
  return {
    id: window.id,
    type,
    title: minecraftTextComponent(window.title).slice(0, 100) || type.replace(/^minecraft:/, "").replaceAll("_", " "),
    slots: window.slots.slice(0, 90).map(serializeItem),
    inventoryStart,
    hotbarStart,
    containerCount: inventoryStart,
    furnace: furnace ? { burn: ratio(currentBurn, totalBurn), cook: ratio(currentCook, totalCook) } : null,
    properties: Object.fromEntries([...properties].filter(([key, value]) => Number.isInteger(key) && key >= 0 && key < 16 && finite3(value))),
    trades: /(?:^|:)(?:merchant|villager)$/.test(type) && trades?.windowId === window.id ? trades : null
  };
}
var VIEWER_STATE_CHANNEL = "mcagent:state";
function manaSnapshotFromText(text) {
  if (typeof text !== "string" || text.length > 512) return null;
  const label = /(?:魔力|法力|\b(?:mana|mp)\b)/iu.exec(text);
  if (!label) return null;
  const part = text.slice(label.index + label[0].length, label.index + label[0].length + 60);
  const pair = /(?:当前|current)?[^\d\n]{0,24}(\d{1,6})\s*\/\s*(\d{1,6})/iu.exec(part);
  if (!pair) return null;
  const current = Number(pair[1]);
  const max = Number(pair[2]);
  return max > 0 && current <= max ? { current, max } : null;
}
function spellCatalogueFromText(text) {
  if (typeof text !== "string" || text.length > 16384 || !/(?:战斗咏唱|探索咏唱)[：:]/u.test(text)) return null;
  const abilities = [];
  for (const match of text.matchAll(/([^、，；：:()（）\s]{1,32})[（(]([a-z][a-z0-9_:-]{0,63})[，,]([^）)]{0,160})[）)]/giu)) {
    const id = match[2].toLowerCase();
    const cost = /(\d{1,4})\s*魔力/u.exec(match[3]);
    const cooldown = /(?:\/|冷却\s*)(\d{1,5})\s*秒/u.exec(match[3]);
    abilities.push({
      id,
      name: match[1],
      level: null,
      cooldownMs: cooldown ? Number(cooldown[1]) * 1e3 : null,
      manaCost: cost ? Number(cost[1]) : null
    });
  }
  return abilities.length ? abilities : null;
}
function viewerBossBars(value) {
  if (!Array.isArray(value)) return [];
  const colors2 = /* @__PURE__ */ new Set(["pink", "blue", "red", "green", "yellow", "purple", "white"]);
  return value.slice(0, 8).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const bar = entry;
    const title = minecraftTextComponent(bar.title).slice(0, 100);
    if (!title) return [];
    const health = finite3(bar.health) ? Math.max(0, Math.min(1, bar.health)) : 0;
    const color2 = typeof bar.color === "string" && colors2.has(bar.color) ? bar.color : "purple";
    return [{ title, progress: health, color: color2 }];
  });
}
function viewerPlayerAbsorption(metadata, metadataKeys) {
  if (!metadata || typeof metadata !== "object") return 0;
  const index = metadataKeys?.indexOf("player_absorption") ?? 15;
  const value = metadata[index >= 0 ? index : 15];
  return finite3(value) ? Math.max(0, Math.min(80, value)) : 0;
}
function parseSkillsPayload(channel, data) {
  if (channel !== VIEWER_STATE_CHANNEL && channel !== "mcviewer:state" && channel !== "corti:viewer_state" || !Buffer.isBuffer(data) || data.length > 65536) return null;
  let raw;
  try {
    raw = JSON.parse(data.toString("utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const input = raw;
  if (channel === VIEWER_STATE_CHANNEL) {
    if (input.schemaVersion !== 1 || !Object.hasOwn(input, "mana")) return null;
    if (input.mana !== null) {
      if (!input.mana || typeof input.mana !== "object" || Array.isArray(input.mana)) return null;
      const mana2 = input.mana;
      const current2 = bounded(mana2.current, 0, 1e6);
      const max2 = bounded(mana2.max, 0, 1e6);
      if (current2 === null || max2 === null || max2 <= 0 || current2 > max2) return null;
    }
  }
  if (input.schemaVersion !== 1 || !("mana" in input || "skills" in input || "abilities" in input) || input.skills !== void 0 && !Array.isArray(input.skills) || input.abilities !== void 0 && !Array.isArray(input.abilities)) return null;
  const mana = input.mana;
  const current = bounded(mana?.current, 0, 1e6);
  const max = bounded(mana?.max, 0, 1e6);
  const readName = (value, maxLength) => typeof value === "string" && value.length <= maxLength ? value : null;
  const skillsInput = Array.isArray(input.skills) ? input.skills : [];
  const skills = skillsInput.map((value) => {
    if (!value || typeof value !== "object") return null;
    const row = value;
    const id = readName(row.id, 64);
    const name2 = readName(row.name, 80);
    const level = bounded(row.level, 0, 1e5);
    if (!id || !/^[a-z0-9_:.-]+$/.test(id) || !name2 || level === null) return null;
    return {
      id,
      name: name2,
      level,
      xp: bounded(row.xp, 0, 1e9),
      requiredXp: bounded(row.requiredXp, 0, 1e9)
    };
  });
  if (skills.some((entry) => !entry)) return null;
  const abilitiesInput = Array.isArray(input.abilities) ? input.abilities : [];
  const abilities = abilitiesInput.map((value) => {
    if (!value || typeof value !== "object") return null;
    const row = value;
    const id = readName(row.id, 64);
    const name2 = readName(row.name, 80);
    if (!id || !/^[a-z0-9_:.-]+$/.test(id) || !name2) return null;
    const icon = readName(row.icon, 64);
    const cooldownMs = bounded(row.cooldownMs, 0, 864e5);
    return {
      id,
      name: name2,
      level: bounded(row.level, 0, 1e5),
      cooldownMs: channel === "mcviewer:state" ? null : cooldownMs,
      ...channel === "mcviewer:state" ? { cooldownRemainingMs: cooldownMs } : row.cooldownRemainingMs !== void 0 ? { cooldownRemainingMs: bounded(row.cooldownRemainingMs, 0, 864e5) } : {},
      manaCost: bounded(row.manaCost, 0, 1e6),
      ...icon && /^(?:minecraft:)?[a-z0-9_]+$/.test(icon) ? { icon: icon.replace(/^minecraft:/, "") } : {}
    };
  });
  if (abilities.some((entry) => !entry)) return null;
  return {
    schemaVersion: 1,
    mana: current !== null && max !== null && max > 0 && current <= max ? { current, max } : null,
    skills,
    abilities
  };
}
function matchingAbility(abilities, id) {
  const exact = abilities.find((entry) => entry.id === id);
  if (exact) return exact;
  const suffix = id.split(":").at(-1);
  const matches = abilities.filter((entry) => entry.id.split(":").at(-1) === suffix);
  return matches.length === 1 ? matches[0] : void 0;
}
function mergeViewerSkillState(previous, next, channel, agentStateSeen) {
  const authoritative = channel === VIEWER_STATE_CHANNEL;
  const oldAbilities = previous?.abilities ?? [];
  const abilities = authoritative ? next.abilities.map((ability) => ({
    ...ability,
    manaCost: ability.manaCost ?? matchingAbility(oldAbilities, ability.id)?.manaCost ?? null
  })) : agentStateSeen ? oldAbilities : next.abilities.length ? next.abilities : oldAbilities;
  return {
    ...next,
    mana: authoritative || !agentStateSeen ? next.mana : previous?.mana ?? null,
    skills: next.skills.length ? next.skills : previous?.skills ?? [],
    abilities,
    source: "plugin",
    observedAt: Date.now()
  };
}
function mergeViewerSpellCatalogue(previous, catalogue, agentStateSeen) {
  const oldAbilities = previous?.abilities ?? [];
  const abilities = agentStateSeen ? oldAbilities.map((ability) => ({
    ...ability,
    manaCost: ability.manaCost ?? matchingAbility(catalogue, ability.id)?.manaCost ?? null
  })) : (() => {
    const merged = new Map(oldAbilities.map((ability) => [ability.id, ability]));
    for (const entry of catalogue) {
      const old = matchingAbility(oldAbilities, entry.id);
      merged.set(old?.id ?? entry.id, old ? {
        ...entry,
        ...old,
        cooldownMs: old.cooldownMs ?? entry.cooldownMs,
        manaCost: old.manaCost ?? entry.manaCost
      } : entry);
    }
    return [...merged.values()];
  })();
  return {
    ...previous ?? { schemaVersion: 1, mana: null, skills: [] },
    abilities,
    observedAt: previous?.observedAt ?? Date.now()
  };
}

// src/worlds/minecraft/viewer-entity-state.ts
function viewerMovementState(speed, sprinting, sneaking) {
  const moving = speed > 0.08;
  if (sneaking) return moving ? "crouchWalking" : "crouch";
  if (!moving) return "idle";
  return sprinting ? "running" : "walking";
}
function viewerSheepAppearance(metadata, metadataKeys) {
  const index = metadataKeys?.indexOf("wool") ?? -1;
  const packed = index >= 0 && metadata && typeof metadata === "object" ? metadata[index] : void 0;
  const value = typeof packed === "number" && Number.isInteger(packed) ? packed : 0;
  return { colorId: value & 15, sheared: (value & 16) !== 0 };
}
function observeViewerArmAnimation(protocol, publish) {
  const originalWrite = protocol.write;
  const viewerWrite = (name2, params) => {
    originalWrite.call(protocol, name2, params);
    if (name2 === "arm_animation") publish(params?.hand === 1 ? "left" : "right");
  };
  protocol.write = viewerWrite;
  return () => {
    if (protocol.write === viewerWrite) protocol.write = originalWrite;
  };
}
function observeViewerAttack(protocol, publish) {
  const originalWrite = protocol.write;
  const viewerWrite = (name2, params) => {
    originalWrite.call(protocol, name2, params);
    if (name2 === "use_entity" && params?.mouse === true && Number.isSafeInteger(params.target) && Number(params.target) >= 0) {
      publish(Number(params.target));
    }
  };
  protocol.write = viewerWrite;
  return () => {
    if (protocol.write === viewerWrite) protocol.write = originalWrite;
  };
}
function observeViewerRangedUse(protocol, heldItemName, publish) {
  const originalWrite = protocol.write;
  let active = null;
  const viewerWrite = (name2, params) => {
    originalWrite.call(protocol, name2, params);
    if (name2 === "use_item") {
      const item = String(heldItemName() || "").replace(/^minecraft:/, "");
      if (item === "bow" || item === "crossbow" || item === "trident") {
        active = { kind: item, hand: params?.hand === 1 ? "left" : "right" };
        publish({ ...active, phase: "draw" });
      }
    } else if (name2 === "block_dig" && params?.status === 5 && active) {
      publish({ ...active, phase: "release" });
      active = null;
    } else if (name2 === "held_item_slot" && active) {
      publish({ ...active, phase: "cancel" });
      active = null;
    }
  };
  protocol.write = viewerWrite;
  return () => {
    if (protocol.write === viewerWrite) protocol.write = originalWrite;
  };
}
function observeViewerShieldUse(protocol, offhandItemName, publish) {
  const originalWrite = protocol.write;
  let raised = false;
  const setRaised = (next) => {
    if (next === raised) return;
    raised = next;
    publish(next);
  };
  const viewerWrite = (name2, params) => {
    originalWrite.call(protocol, name2, params);
    if (name2 === "use_item" && params?.hand === 1 && String(offhandItemName() || "").replace(/^minecraft:/, "") === "shield") setRaised(true);
    else if (name2 === "block_dig" && params?.status === 5 || name2 === "held_item_slot") setRaised(false);
  };
  protocol.write = viewerWrite;
  return () => {
    if (protocol.write === viewerWrite) protocol.write = originalWrite;
  };
}

// src/worlds/minecraft/viewer-tactics.ts
function point(value) {
  if (!value || typeof value !== "object") return null;
  const p = value;
  if (!["x", "y", "z"].every((axis) => typeof p[axis] === "number" && Number.isFinite(p[axis]) && Math.abs(p[axis]) <= 3e7)) return null;
  return { x: p.x, y: p.y, z: p.z };
}
function viewerGoal(value) {
  if (!value || typeof value !== "object") return null;
  const goal = value;
  return point(goal.entity?.position) ?? point(value);
}
function viewerRoute(result, origin, goal) {
  const data = result && typeof result === "object" ? result : {};
  const start = point(origin);
  const points = start ? [start] : [];
  for (const raw of Array.isArray(data.path) ? data.path.slice(0, 72) : []) {
    const next = point(raw);
    if (!next) continue;
    const last = points.at(-1);
    if (last && Math.hypot(next.x - last.x, next.z - last.z) < 0.15 && Math.abs(next.y - last.y) < 0.15) continue;
    points.push(next);
    if (points.length >= 64) break;
  }
  return {
    points,
    goal: viewerGoal(goal),
    status: typeof data.status === "string" ? data.status.slice(0, 24) : "active"
  };
}

// src/worlds/minecraft/viewer-cast.ts
var commandListeners = /* @__PURE__ */ new WeakMap();
function observeViewerCastCommands(bot, listener) {
  let listeners = commandListeners.get(bot);
  if (!listeners) {
    listeners = /* @__PURE__ */ new Set();
    commandListeners.set(bot, listeners);
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}
var SPELL_NAMES = {
  home: "\u5F52\u4E61",
  blink: "\u95EA\u73B0",
  selfheal: "\u5723\u6108\u672F",
  heal: "\u6CBB\u7597\u961F\u53CB",
  food: "\u9971\u98DF",
  give: "\u9020\u7269\u672F",
  fireworks: "\u70DF\u82B1\u672F",
  starlight: "\u661F\u5C18\u672F",
  starbolt: "\u661F\u8292\u7BAD",
  frostnova: "\u971C\u73AF",
  flamewave: "\u7130\u6D6A",
  golem: "\u5B88\u62A4\u5080\u5121",
  prospect: "\u63A2\u77FF\u672F",
  sense: "\u63A2\u654C",
  leap: "\u8DC3\u7A7A",
  flight: "\u98DE\u884C",
  blood_mana: "\u71C3\u8840\u672F",
  feather: "\u7FBD\u843D\u4E4B\u9774",
  night: "\u591C\u89C6"
};
function viewerCastCommand(text) {
  if (typeof text !== "string") return null;
  const match = /^\s*\/mycli\s+cast\s+([a-z0-9_:-]{1,64})(?=\s|$)/i.exec(text);
  if (!match) return null;
  const id = match[1].toLowerCase();
  return { id, name: SPELL_NAMES[id] ?? id.replaceAll("_", " ") };
}
function viewerCastResult(text, spellId) {
  if (typeof text !== "string" || text.length > 1024) return null;
  if (/(?:not|don't have) enough (?:mana|magic)|insufficient (?:mana|magic)|(?:on |in )?cooldown|you cannot (?:blink|cast|use)|cannot cast|failed to cast|\bno permission\b|魔力不足|灵力不足|冷却中|无法施放|施法失败|未学会|不能在此施法|不可在此施法|没有看得见的怪物|没有可用目标/i.test(text)) {
    return { phase: "failed", detail: "\u65BD\u6CD5\u53D7\u963B" };
  }
  if (spellId === "home" && /传送到|teleported to|you have been teleported/i.test(text)) {
    return { phase: "succeeded", detail: "\u4F20\u9001\u5B8C\u6210" };
  }
  if ((spellId === "selfheal" || spellId === "heal") && /sacred healing restores|治疗成功|恢复了生命/i.test(text)) {
    return { phase: "succeeded", detail: "\u6CBB\u7597\u751F\u6548" };
  }
  if (spellId === "food" && /feel less hungry|饥饿值已恢复|饱食生效/i.test(text)) {
    return { phase: "succeeded", detail: "\u9971\u98DF\u751F\u6548" };
  }
  const successBySpell = {
    golem: /守护傀儡.*(?:帮你|召唤|出现)/u,
    frostnova: /霜环.*(?:命中|冻结|冻住)/u,
    flamewave: /焰浪.*(?:命中|灼烧)/u,
    starbolt: /星芒箭.*命中/u,
    prospect: /探矿术.*(?:发现|找到|探查完成)/u,
    sense: /探敌.*(?:发现|探查|感知)/u,
    leap: /跃空.*(?:生效|腾空|跳跃)/u,
    flight: /飞行.*(?:生效|起飞|持续)/u
  };
  if (successBySpell[spellId]?.test(text)) return { phase: "succeeded", detail: "\u65BD\u6CD5\u751F\u6548" };
  if (/咏唱成功|施法成功|成功施放|successfully cast/i.test(text)) {
    return { phase: "succeeded", detail: "\u65BD\u6CD5\u751F\u6548" };
  }
  return null;
}

// src/worlds/minecraft/viewer-combat.ts
var VIEWER_COMBAT_CHANNEL = "mcviewer:combat";
function parseViewerCombatHit(channel, data, ownEntityId) {
  if (channel !== VIEWER_COMBAT_CHANNEL || !Buffer.isBuffer(data) || data.length > 2048) return null;
  let value;
  try {
    value = JSON.parse(data.toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const packet = value;
  if (packet.schemaVersion !== 1 || packet.attackerEntityId !== ownEntityId || !Number.isSafeInteger(packet.targetEntityId) || packet.targetEntityId < 0 || typeof packet.damage !== "number" || !Number.isFinite(packet.damage) || packet.damage <= 0 || packet.damage > 2048 || typeof packet.critical !== "boolean") return null;
  return { id: packet.targetEntityId, amount: packet.damage, critical: packet.critical };
}

// src/worlds/minecraft/viewer-block-entities.ts
function viewerChunkBlockEntities(origin, entities) {
  const result = {};
  for (const [key, value] of Object.entries(entities ?? {})) {
    const parts = key.split(",").map(Number);
    if (parts.length !== 3 || !parts.every(Number.isInteger) || parts[0] < 0 || parts[0] > 15 || parts[2] < 0 || parts[2] > 15) continue;
    result[`${origin.x + parts[0]},${parts[1]},${origin.z + parts[2]}`] = value;
  }
  return result;
}
function viewerBlockEntities(chunks) {
  const result = {};
  for (const chunk of chunks) Object.assign(result, chunk);
  return result;
}

// src/worlds/minecraft/viewer-boss-bars.ts
function observeViewerBossBars(bot, publish) {
  const afterDelete = () => queueMicrotask(publish);
  bot.on("bossBarCreated", publish);
  bot.on("bossBarUpdated", publish);
  bot.on("bossBarDeleted", afterDelete);
  return () => {
    bot.off("bossBarCreated", publish);
    bot.off("bossBarUpdated", publish);
    bot.off("bossBarDeleted", afterDelete);
  };
}

// src/worlds/minecraft/viewer-presentation.ts
function viewerBiomeClimate(value) {
  if (!value || typeof value !== "object") return {};
  const biome = value;
  const precipitation = biome.precipitation;
  const hasPrecipitation = biome.has_precipitation ?? biome.hasPrecipitation;
  return {
    ...typeof hasPrecipitation === "boolean" ? { hasPrecipitation } : {},
    ...typeof biome.temperature === "number" && Number.isFinite(biome.temperature) ? { temperature: biome.temperature } : {},
    ...precipitation === "rain" || precipitation === "snow" || precipitation === "none" ? { precipitation } : {}
  };
}
var finite4 = (value) => typeof value === "number" && Number.isFinite(value);
var point2 = (x, y, z) => finite4(x) && finite4(y) && finite4(z) && [x, y, z].every((value) => Math.abs(value) <= 3e7) ? { x, y, z } : null;
function viewerParticle(packet) {
  if (!packet || typeof packet !== "object") return null;
  const row = packet;
  const position2 = point2(row.x, row.y, row.z);
  const spread = point2(row.offsetX, row.offsetY, row.offsetZ);
  const particle = row.particle;
  const name2 = typeof particle?.type === "string" ? particle.type.replace(/^minecraft:/, "") : "";
  if (!position2 || !spread || !/^[a-z0-9_]{1,64}$/.test(name2) || !finite4(row.amount) || !finite4(row.velocityOffset)) return null;
  const data = particle?.data;
  const color2 = data && [data.red, data.green, data.blue].every(finite4) ? [data.red, data.green, data.blue].map((value) => Math.max(0, Math.min(1, value))) : void 0;
  return {
    kind: "particle",
    name: name2,
    position: position2,
    spread: { x: Math.min(Math.abs(spread.x), 8), y: Math.min(Math.abs(spread.y), 8), z: Math.min(Math.abs(spread.z), 8) },
    speed: Math.min(Math.abs(row.velocityOffset), 3),
    count: Math.min(48, Math.max(1, Math.trunc(row.amount))),
    ...color2 ? { color: color2 } : {}
  };
}
function viewerExplosion(packet) {
  if (!packet || typeof packet !== "object") return null;
  const row = packet;
  const position2 = point2(row.x, row.y, row.z);
  return position2 && finite4(row.radius) ? { kind: "explosion", position: position2, radius: Math.min(12, Math.max(0.5, Math.abs(row.radius))) } : null;
}
function viewerWorldEvent(packet, registry) {
  if (!packet || typeof packet !== "object") return null;
  const row = packet;
  const location = row.location;
  const position2 = location && point2(location.x, location.y, location.z);
  if (!position2 || !Number.isInteger(row.effectId) || !Number.isInteger(row.data)) return null;
  const blockName = row.effectId === 2001 ? registry?.blocksByStateId?.[Number(row.data)]?.name : void 0;
  const itemName = row.effectId === 1010 && Number(row.data) > 0 ? registry?.items?.[Number(row.data)]?.name : void 0;
  const resourceName = (value) => typeof value === "string" && /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]{1,96}$/.test(value);
  return {
    kind: "world_event",
    position: position2,
    effectId: row.effectId,
    data: row.data,
    ...resourceName(blockName) ? { blockName } : {},
    ...resourceName(itemName) ? { itemName } : {}
  };
}
var VIEWER_EVENT_CHANNEL = "mcagent:event";
function viewerPacketLane(name2) {
  if (name2 === "custom_payload") return "plugin";
  if ([
    "world_particles",
    "explosion",
    "world_event",
    "collect",
    "entity_effect",
    "remove_entity_effect",
    "set_cooldown",
    "advancements",
    "sound_effect",
    "named_sound_effect",
    "entity_sound_effect",
    "stop_sound"
  ].includes(name2))
    return "presentation";
  if ([
    "map_chunk",
    "unload_chunk",
    "block_change",
    "multi_block_change",
    "update_light",
    "tile_entity_data",
    "block_action",
    "chunk_biomes"
  ].includes(name2)) return "world";
  if (/^(?:spawn_|entity_|rel_entity_move$|named_entity_spawn$|player_info$)/.test(name2) || ["damage_event", "animation", "teams"].includes(name2)) return "entity";
  if ([
    "update_health",
    "set_slot",
    "window_items",
    "open_window",
    "close_window",
    "craft_progress_bar",
    "game_state_change",
    "update_time",
    "experience",
    "boss_bar",
    "action_bar",
    "title",
    "title_times",
    "clear_titles",
    "scoreboard_objective",
    "scoreboard_score",
    "scoreboard_display_objective"
  ].includes(name2)) return "hud";
  if (["system_chat", "player_chat", "disguised_chat", "chat"].includes(name2)) return "message";
  if ([
    "keep_alive",
    "bundle_delimiter",
    "declare_commands",
    "acknowledge_player_digging",
    "ping",
    "abilities",
    "login",
    "respawn",
    "declare_recipes",
    "tags",
    "update_enabled_features",
    "position",
    "update_view_position",
    "update_view_distance",
    "simulation_distance",
    "initialize_world_border",
    "set_ticking_state",
    "step_tick"
  ].includes(name2))
    return "control";
  return "unmapped";
}
function parseViewerCustomEvent(channel, data) {
  if (channel !== VIEWER_EVENT_CHANNEL && channel !== "mcviewer:event" || !Buffer.isBuffer(data) || data.length > 16384) return null;
  let raw;
  try {
    raw = JSON.parse(data.toString("utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const row = raw;
  const kinds = /* @__PURE__ */ new Set(["skill", "quest", "notice", "combat", "environment", "achievement"]);
  const tones = /* @__PURE__ */ new Set(["positive", "neutral", "warning", "danger", "arcane", "healing", "frost", "fire", "movement"]);
  if (row.schemaVersion !== 1 || !kinds.has(String(row.kind)) || typeof row.id !== "string" || !/^[a-z0-9_:.-]{1,80}$/.test(row.id) || typeof row.title !== "string" || row.title.length < 1 || row.title.length > 80 || typeof row.body !== "string" || row.body.length > 240) return null;
  const sourcePosition = row.position;
  const position2 = sourcePosition && point2(sourcePosition.x, sourcePosition.y, sourcePosition.z);
  if (sourcePosition && !position2) return null;
  return {
    kind: row.kind,
    id: row.id,
    title: row.title,
    body: row.body,
    tone: tones.has(String(row.tone)) ? row.tone : "arcane",
    ...position2 ? { position: position2 } : {}
  };
}

// src/worlds/minecraft/viewer-advancements.ts
var ViewerAdvancementTracker = class {
  definitions = /* @__PURE__ */ new Map();
  completed = /* @__PURE__ */ new Set();
  initialized = false;
  ingest(packet, text) {
    if (!packet || typeof packet !== "object") return [];
    const row = packet;
    if (row.reset === true) {
      this.definitions.clear();
      this.completed.clear();
      this.initialized = false;
    }
    for (const key of Array.isArray(row.identifiers) ? row.identifiers.slice(0, 256) : []) {
      if (typeof key === "string") {
        this.definitions.delete(key);
        this.completed.delete(key);
      }
    }
    for (const entry of Array.isArray(row.advancementMapping) ? row.advancementMapping.slice(0, 256) : []) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry;
      const value = item.value;
      const display = value?.displayData;
      if (typeof item.key !== "string" || item.key.length > 160 || !display) continue;
      const requirements = Array.isArray(value?.requirements) ? value.requirements.filter((group) => Array.isArray(group) && group.every((part) => typeof part === "string")).slice(0, 64) : [];
      const flags = display.flags;
      const frame = display.frameType === 2 ? "challenge" : display.frameType === 1 ? "goal" : "task";
      this.definitions.set(item.key, {
        key: item.key,
        title: text(display.title).slice(0, 80),
        description: text(display.description).slice(0, 160),
        frame,
        requirements,
        showToast: flags?.show_toast === 1 || flags?.show_toast === true
      });
    }
    const notices = [];
    for (const entry of Array.isArray(row.progressMapping) ? row.progressMapping.slice(0, 256) : []) {
      if (!entry || typeof entry !== "object") continue;
      const progress = entry;
      if (typeof progress.key !== "string" || !Array.isArray(progress.value)) continue;
      const definition = this.definitions.get(progress.key);
      if (!definition || !definition.requirements.length) continue;
      const granted = new Set(progress.value.filter((item) => item && typeof item === "object" && item.criterionProgress != null).map((item) => item.criterionIdentifier));
      const done = definition.requirements.every((group) => group.some((criterion) => granted.has(criterion)));
      if (!done) {
        this.completed.delete(progress.key);
        continue;
      }
      if (!this.completed.has(progress.key) && this.initialized && definition.showToast && definition.title)
        notices.push({
          key: definition.key,
          title: definition.title,
          description: definition.description,
          frame: definition.frame
        });
      this.completed.add(progress.key);
    }
    this.initialized = true;
    return notices.slice(0, 8);
  }
};

// src/worlds/minecraft/viewer-render-metadata.ts
function viewerRenderableMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return metadata;
  const normalize = (value) => {
    if (!value || typeof value !== "object") return value;
    const slot = value;
    if (!("itemCount" in slot)) return value;
    const id = Number.isInteger(slot.itemId) ? slot.itemId : Number.isInteger(slot.type) ? slot.type : null;
    if (typeof id === "number" && id >= 0) return { ...slot, itemId: id };
    if (typeof slot.name === "string" && /^[a-z0-9_:]+$/.test(slot.name)) return slot;
    return null;
  };
  if (Array.isArray(metadata)) return metadata.map(normalize);
  const source = metadata;
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, /^\d+$/.test(key) ? normalize(value) : value]));
}

// src/worlds/minecraft/viewer-session-slots.ts
var ViewerSessionSlots = class {
  constructor(maxViewers, maxCaptures) {
    this.maxViewers = maxViewers;
    this.maxCaptures = maxCaptures;
  }
  maxViewers;
  maxCaptures;
  viewers = 0;
  captures = 0;
  reserve(capture) {
    if (capture ? this.captures >= this.maxCaptures : this.viewers >= this.maxViewers) return null;
    if (capture) this.captures++;
    else this.viewers++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (capture) this.captures--;
      else this.viewers--;
    };
  }
  status() {
    return {
      viewers: this.viewers,
      maxSessions: this.maxViewers,
      captureSessions: this.captures,
      maxCaptureSessions: this.maxCaptures
    };
  }
};

// src/worlds/minecraft/viewer-capture-lease.ts
var ViewerCaptureLease = class {
  constructor(expired, idleMs = 6e4) {
    this.expired = expired;
    this.idleMs = idleMs;
    this.renew();
  }
  expired;
  idleMs;
  timer;
  active = true;
  renew() {
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.release(), this.idleMs);
    this.timer.unref();
  }
  stop() {
    this.active = false;
    clearTimeout(this.timer);
    this.timer = void 0;
  }
  release() {
    if (!this.active) return;
    this.stop();
    this.expired();
  }
};

// src/worlds/minecraft/viewer-sound-packets.ts
var categories = ["master", "music", "records", "weather", "blocks", "hostile", "neutral", "players", "ambient", "voice"];
var categoryAliases = { record: "records", block: "blocks", player: "players" };
var category = (value) => {
  if (typeof value === "number" && Number.isInteger(value)) return categories[value];
  if (typeof value === "string") {
    const name2 = categoryAliases[value] ?? value;
    if (categories.includes(name2)) return name2;
  }
  return void 0;
};
var name = (value) => {
  if (typeof value !== "string" || !/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]{1,160}$/.test(value)) return void 0;
  if (value.split("/").some((part) => part === "." || part === "..")) return void 0;
  return value.replace(/^minecraft:/, "");
};
var record = (value) => value && typeof value === "object" ? value : null;
var finite5 = (value) => typeof value === "number" && Number.isFinite(value);
var position = (value, scale = 1) => {
  const p = record(value);
  return p && [p.x, p.y, p.z].every(finite5) ? { x: Number(p.x) / scale, y: Number(p.y) / scale, z: Number(p.z) / scale } : null;
};
var seed = (value) => {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d{1,20}$/.test(value)) return value;
  if (Array.isArray(value) && value.length === 2 && value.every((part) => Number.isInteger(part)))
    return BigInt.asIntN(64, BigInt(value[0]) << 32n | BigInt(Number(value[1]) >>> 0)).toString();
  return void 0;
};
function viewerSoundPacket(kind, value, registry, entityPosition) {
  const packet = record(value);
  if (!packet || !finite5(packet.volume) || !finite5(packet.pitch)) return null;
  const holder = record(packet.sound);
  const inline = record(holder?.data);
  const id = holder?.soundId ?? packet.soundId;
  const soundName = name(packet.soundName ?? inline?.soundName ?? (Number.isSafeInteger(id) ? registry.sounds?.[Number(id)]?.name : void 0));
  if (!soundName) return null;
  let pos3;
  let entityId;
  if (kind === "entity_sound_effect") {
    if (!Number.isSafeInteger(packet.entityId) || Number(packet.entityId) < 0) return null;
    entityId = Number(packet.entityId);
    pos3 = position(entityPosition(entityId));
    if (!pos3) return null;
  } else if (kind === "sound_effect" || kind === "named_sound_effect") {
    pos3 = position(packet, 8);
    if (!pos3) return null;
  } else return null;
  const source = category(packet.soundCategory);
  const randomSeed = seed(packet.seed);
  return {
    name: soundName,
    position: pos3,
    volume: Math.max(0, Math.min(16, packet.volume)),
    pitch: Math.max(0.01, Math.min(4, packet.pitch)),
    ...source ? { category: source } : {},
    ...entityId !== void 0 ? { entityId } : {},
    ...randomSeed !== void 0 ? { seed: randomSeed } : {},
    ...finite5(inline?.fixedRange) && inline.fixedRange > 0 && inline.fixedRange <= 1024 ? { fixedRange: inline.fixedRange } : {}
  };
}
function viewerSoundStopPacket(value) {
  const packet = record(value);
  if (!packet || !Number.isInteger(packet.flags) || Number(packet.flags) < 0 || Number(packet.flags) > 3) return null;
  const flags = Number(packet.flags);
  const source = flags & 1 ? category(packet.source) : void 0;
  const soundName = flags & 2 ? name(packet.sound) : void 0;
  if (flags & 1 && !source || flags & 2 && !soundName) return null;
  return { ...source ? { category: source } : {}, ...soundName ? { name: soundName } : {} };
}
function observeViewerSounds(protocol, registry, entityPosition, publish, stop, now = Date.now) {
  let windowAt = now();
  let count = 0;
  const listeners = ["sound_effect", "named_sound_effect", "entity_sound_effect"].map((kind) => {
    const listener = (packet) => {
      const event = viewerSoundPacket(kind, packet, registry, entityPosition);
      if (!event) return;
      const at = now();
      if (at - windowAt >= 1e3) {
        windowAt = at;
        count = 0;
      }
      if (++count <= 128) publish(event);
    };
    protocol.on(kind, listener);
    return { kind, listener };
  });
  const stopped = (packet) => {
    const event = viewerSoundStopPacket(packet);
    if (event) stop(event);
  };
  protocol.on("stop_sound", stopped);
  return () => {
    for (const { kind, listener } of listeners) protocol.off(kind, listener);
    protocol.off("stop_sound", stopped);
  };
}

// src/worlds/minecraft/viewer-sound-registry.ts
import { readFile as readFile2 } from "node:fs/promises";
import path from "node:path";
var CLIENT_1206_SHA256 = "02dfd345ac1ad55692d5dbc8486ac7e4fea72cd54ac494a79cd48963048e56b2";
var SOUND_1206_COUNT = 1607;
function validateViewerSoundRegistry(value, expectedVersion) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value;
  if (expectedVersion !== "1.20.6" || row.schemaVersion !== 1 || row.minecraftVersion !== expectedVersion || row.clientJarSha256 !== CLIENT_1206_SHA256 || !row.events || typeof row.events !== "object" || Array.isArray(row.events)) return null;
  const events = row.events;
  if (Object.keys(events).length !== SOUND_1206_COUNT) return null;
  const sounds = {};
  const names = /* @__PURE__ */ new Set();
  for (let id = 0; id < SOUND_1206_COUNT; id++) {
    if (!Object.hasOwn(events, String(id))) return null;
    const event = events[String(id)];
    const name2 = event && typeof event === "object" ? event.name : void 0;
    if (typeof name2 !== "string" || !/^minecraft:[a-z0-9_][a-z0-9_.-]{0,159}$/.test(name2) || names.has(name2)) return null;
    names.add(name2);
    sounds[id] = { name: name2 };
  }
  return { sounds };
}
async function loadViewerSoundRegistry(assetsDir, minecraftVersion, fallbackRegistry) {
  if (minecraftVersion !== "1.20.6") return { registry: fallbackRegistry, source: "minecraft-data", diagnostic: null };
  try {
    const source = await readFile2(path.join(assetsDir, "public", "sounds", "registry.json"), "utf8");
    if (source.length > 1024 * 1024) throw new Error("Sound registry metadata too large");
    const value = JSON.parse(source);
    const registry = validateViewerSoundRegistry(value, minecraftVersion);
    if (registry) return { registry, source: "exact-assets", diagnostic: null };
  } catch {
  }
  return {
    registry: { sounds: {} },
    source: "unavailable",
    diagnostic: "1.20.6 \u58F0\u97F3\u7F16\u53F7\u8868\u7F3A\u5931\u6216\u4E0D\u5339\u914D\uFF1A\u7F16\u53F7\u97F3\u6548\u5DF2\u505C\u7528\uFF0C\u8BF7\u4ECE\u5339\u914D\u7684\u539F\u7248\u5BA2\u6237\u7AEF\u5BFC\u51FA\u58F0\u97F3\u6CE8\u518C\u8868\u3002"
  };
}

// src/worlds/minecraft/viewer-fishing.ts
var writeDispatchers = /* @__PURE__ */ new WeakMap();
function observeWrite(protocol, onWrite) {
  let dispatch = writeDispatchers.get(protocol);
  if (!dispatch) {
    const originalWrite = protocol.write;
    const observers = /* @__PURE__ */ new Set();
    const viewerWrite = (name2, params) => {
      for (const observer of observers) observer(name2, params);
      return originalWrite.call(protocol, name2, params);
    };
    dispatch = { originalWrite, viewerWrite, observers };
    writeDispatchers.set(protocol, dispatch);
    protocol.write = viewerWrite;
  }
  const shared = dispatch;
  shared.observers.add(onWrite);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    shared.observers.delete(onWrite);
    if (shared.observers.size) return;
    if (protocol.write === shared.viewerWrite) protocol.write = shared.originalWrite;
    writeDispatchers.delete(protocol);
  };
}
var pos2 = (value) => {
  const p = value;
  return p && [p.x, p.y, p.z].every((part) => typeof part === "number" && Number.isFinite(part)) ? { x: p.x, y: p.y, z: p.z } : null;
};
var distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
var canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, part]) => [key, canonical(part)]));
  return value;
};
var itemKey = (item) => JSON.stringify(canonical({
  type: item.type,
  metadata: item.metadata,
  customName: item.customName,
  components: item.components,
  nbt: item.nbt
}));
function viewerDroppedItem(entity, serializeItem) {
  if (!entity || typeof entity !== "object") return null;
  const source = entity;
  if (!["item", "Item", "item_stack"].includes(source.name ?? "") || !source.getDroppedItem) return null;
  try {
    return serializeItem(source.getDroppedItem());
  } catch {
    return null;
  }
}
function observeViewerFishingCatch(bot, publish, serializeItem, now = Date.now) {
  const protocol = bot._client;
  const hooks = /* @__PURE__ */ new Map();
  const loot = /* @__PURE__ */ new Map();
  let seq = 0;
  const inventory = () => {
    const result = /* @__PURE__ */ new Map();
    for (const raw of bot.inventory.slots.slice(bot.inventory.inventoryStart ?? 9)) {
      const item = serializeItem(raw);
      if (item) {
        const key = itemKey(item);
        result.set(key, (result.get(key) ?? 0) + item.count);
      }
    }
    return result;
  };
  const trim = () => {
    const at = now();
    for (const [id, entry] of loot) if (at - entry.spawnedAt > 8e3) loot.delete(id);
    for (const [id, hook] of hooks) if (hook.reelAt && at - hook.reelAt > 8e3) hooks.delete(id);
    while (loot.size > 32) loot.delete(loot.keys().next().value);
    while (hooks.size > 4) hooks.delete(hooks.keys().next().value);
  };
  const confirmed = () => {
    trim();
    const counts = inventory();
    for (const [id, entry] of loot) {
      if (!entry.collectedAt || !entry.item) continue;
      const key = itemKey(entry.item);
      const gained = (counts.get(key) ?? 0) - (entry.hook.before.get(key) ?? 0);
      if (gained < entry.count) continue;
      loot.delete(id);
      publish({
        seq: ++seq,
        atMs: now(),
        item: { ...entry.item, count: entry.count },
        count: entry.count,
        position: entry.position
      });
    }
  };
  const onSpawn = (packet) => {
    trim();
    if (!Number.isSafeInteger(packet.entityId)) return;
    const id = packet.entityId;
    loot.delete(id);
    hooks.delete(id);
    const entities = bot.registry.entitiesByName;
    const position2 = pos2(packet);
    if (!position2) return;
    if (packet.type === entities.fishing_bobber?.internalId && packet.objectData === bot.entity?.id) {
      hooks.set(id, { id, position: position2, biteAt: 0, reelAt: 0, before: /* @__PURE__ */ new Map() });
      return;
    }
    if (packet.type !== entities.item?.internalId) return;
    const at = now();
    const hook = [...hooks.values()].reverse().find((entry) => entry.reelAt && entry.biteAt && at - entry.reelAt <= 1500 && at - entry.reelAt >= 0 && Math.abs(entry.reelAt - entry.biteAt) <= 2e3 && distance(position2, entry.position) <= 2);
    if (!hook) return;
    const entity = bot.entities[id];
    const caster = pos2(bot.entity?.position);
    const rawVelocity = pos2(packet.velocity);
    const velocity = rawVelocity ? {
      x: rawVelocity.x / 8e3,
      y: rawVelocity.y / 8e3,
      z: rawVelocity.z / 8e3
    } : pos2(entity?.velocity);
    if (!caster || !velocity) return;
    const dx = caster.x - position2.x, dz = caster.z - position2.z;
    if (Math.hypot(dx, dz) > 1 && (velocity.x * dx + velocity.z * dz <= 0.01 || velocity.y <= 0.02)) return;
    loot.set(id, { hook, position: position2, spawnedAt: at, item: viewerDroppedItem(entity, serializeItem), collectedAt: 0, count: 0 });
  };
  const onEntity = (entity) => {
    const hook = hooks.get(entity.id);
    if (hook) {
      const position2 = pos2(entity.position);
      if (position2) hook.position = position2;
      const keys = bot.registry.entitiesByName.fishing_bobber?.metadataKeys;
      const biting = keys?.indexOf("biting") ?? -1;
      if (biting >= 0 && entity.metadata[biting] === true) hook.biteAt = now();
    }
    const entry = loot.get(entity.id);
    if (entry) {
      entry.item = viewerDroppedItem(entity, serializeItem) ?? entry.item;
      confirmed();
    }
  };
  const onParticle = (packet) => {
    const particle = packet.particle?.type;
    const ids = bot.registry.particlesByName;
    if ((packet.amount ?? packet.particles) !== 6 || !(["fishing", "bubble"].includes(particle ?? "") || Number.isSafeInteger(packet.particleId) && (packet.particleId === ids.fishing?.id || packet.particleId === ids.bubble?.id))) return;
    const position2 = pos2(packet);
    if (!position2) return;
    for (const hook of hooks.values()) if (Math.hypot(
      position2.x - hook.position.x,
      position2.z - hook.position.z
    ) <= 1.23 && Math.abs(position2.y - hook.position.y) <= 2) hook.biteAt = now();
  };
  const onCollect = (packet) => {
    if (packet.collectorEntityId !== bot.entity?.id || !Number.isSafeInteger(packet.collectedEntityId)) return;
    const entry = loot.get(packet.collectedEntityId);
    if (!entry) return;
    entry.item = viewerDroppedItem(bot.entities[packet.collectedEntityId], serializeItem) ?? entry.item;
    if (!entry.item) {
      loot.delete(packet.collectedEntityId);
      return;
    }
    const count = packet.pickupItemCount ?? entry.item.count;
    if (!Number.isSafeInteger(count) || count < 1 || count > entry.item.count) return;
    entry.count = count;
    entry.collectedAt = now();
    confirmed();
  };
  const onDestroy = (packet) => {
    for (const id of packet.entityIds ?? []) {
      const hook = hooks.get(id);
      if (hook && !hook.reelAt) hooks.delete(id);
    }
    trim();
  };
  const reset = () => {
    hooks.clear();
    loot.clear();
  };
  const disposeWrite = observeWrite(protocol, (kind, params) => {
    if (kind === "use_item") {
      const item = params?.hand === 1 ? bot.inventory.slots[45] : bot.heldItem;
      if (item?.name?.replace(/^minecraft:/, "") === "fishing_rod") {
        trim();
        for (const hook of hooks.values()) if (!hook.reelAt) {
          hook.reelAt = now();
          hook.before = inventory();
        }
      }
    }
  });
  protocol.on("spawn_entity", onSpawn);
  protocol.on("world_particles", onParticle);
  protocol.on("collect", onCollect);
  protocol.on("entity_destroy", onDestroy);
  bot.on("entityUpdate", onEntity);
  bot.on("entityMoved", onEntity);
  bot.on("itemDrop", onEntity);
  bot.inventory.on("updateSlot", confirmed);
  bot.on("respawn", reset);
  bot.on("end", reset);
  return () => {
    disposeWrite();
    protocol.off("spawn_entity", onSpawn);
    protocol.off("world_particles", onParticle);
    protocol.off("collect", onCollect);
    protocol.off("entity_destroy", onDestroy);
    bot.off("entityUpdate", onEntity);
    bot.off("entityMoved", onEntity);
    bot.off("itemDrop", onEntity);
    bot.inventory.off("updateSlot", confirmed);
    bot.off("respawn", reset);
    bot.off("end", reset);
    reset();
  };
}

// src/worlds/minecraft/viewer-page-assets.ts
import { readFile as readFile3, stat as stat2 } from "node:fs/promises";
import path2 from "node:path";
var MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
async function document(root, relative) {
  const filename = path2.join(root, "public", relative);
  const info = await stat2(filename).catch((error) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (!info?.isFile() || info.size > MAX_DOCUMENT_BYTES) return null;
  const bytes = await readFile3(filename);
  if (bytes.length > MAX_DOCUMENT_BYTES) return null;
  return bytes.toString("utf8");
}
async function viewerPageHtml(root, mode, fallback, speechFrame = "", speechScript = "") {
  const generated = await document(root, mode === "first" ? "index.html" : `${mode}/index.html`) ?? (mode === "first" ? null : await document(root, "index.html"));
  let html = (generated ?? fallback).replaceAll("__VIEW_MODE__", mode);
  const bodyMode = /(<body\b[^>]*\bdata-view-mode\s*=\s*)(["'])[^"']*\2/i;
  if (bodyMode.test(html)) html = html.replace(bodyMode, `$1"${mode}"`);
  else html = html.replace(/<body\b/i, `<body data-view-mode="${mode}"`);
  const additions = [
    speechFrame && !/\bid\s*=\s*["']corti-speech-bubble["']/i.test(html) ? speechFrame : "",
    speechScript && !/\bsrc\s*=\s*["']\/speech-bubble\.js["']/i.test(html) ? speechScript : ""
  ].join("");
  return additions ? html.replace(/<\/body\s*>/i, `${additions}</body>`) : html;
}
async function viewerPageCss(root, fallback, speechCss = "") {
  const generated = await document(root, "viewer.css");
  return generated === null ? fallback : generated + speechCss;
}

// ../mc-visual-console/packages/modern-viewer/renderer-src/host/viewer-asset-server.mjs
import { createReadStream } from "node:fs";
import { stat as stat3 } from "node:fs/promises";
import path3 from "node:path";
var MAX_ASSET_BYTES = 32 * 1024 * 1024;
var MIME = {
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ogg": "audio/ogg",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".vrm": "model/gltf-binary",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".zip": "application/zip"
};
function viewerByteRange(range, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || !match[1] && !match[2] || size <= 0)
    return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
      return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start)
    return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}
async function serveViewerAsset(res, root, relative, cacheControl = "public, max-age=3600", range) {
  const file = path3.resolve(root, relative);
  const extension = path3.extname(file).toLowerCase();
  if (!file.startsWith(path3.resolve(root) + path3.sep) || !MIME[extension])
    return false;
  const info = await stat3(file).catch(() => null);
  if (!info?.isFile() || info.size > MAX_ASSET_BYTES)
    return false;
  const ranged = extension === ".ogg";
  const headers = {
    "content-type": MIME[extension],
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    ...ranged ? { "accept-ranges": "bytes" } : {}
  };
  if (ranged && range !== void 0) {
    const selected = viewerByteRange(range, info.size);
    if (!selected) {
      res.writeHead(416, { ...headers, "content-range": `bytes */${info.size}`, "content-length": 0 });
      res.end();
      return true;
    }
    res.writeHead(206, {
      ...headers,
      "content-length": selected.end - selected.start + 1,
      "content-range": `bytes ${selected.start}-${selected.end}/${info.size}`
    });
    createReadStream(file, selected).on("error", (error) => res.destroy(error)).pipe(res);
    return true;
  }
  res.writeHead(200, { ...headers, "content-length": info.size });
  createReadStream(file).on("error", (error) => res.destroy(error)).pipe(res);
  return true;
}

// src/worlds/minecraft/terrain.ts
import { Vec3 as Vec32 } from "vec3";

// src/core/log-context.ts
import { AsyncLocalStorage } from "node:async_hooks";
var storage = new AsyncLocalStorage();

// src/core/util.ts
var ROTATE_BYTES = 64 * 1024 * 1024;

// src/worlds/minecraft/chests.ts
var FURNACE_BLOCKS = ["furnace", "smoker", "blast_furnace"];
var CHEST_BLOCKS = ["chest", "trapped_chest", "barrel", "ender_chest"];
var CHEST_KINDS = new Set(CHEST_BLOCKS);
var FURNACE_KINDS = new Set(FURNACE_BLOCKS);

// src/worlds/minecraft/names.ts
var MODIFIER = {
  oak: "\u6A61\u6728",
  spruce: "\u4E91\u6749",
  birch: "\u767D\u6866",
  jungle: "\u4E1B\u6797",
  acacia: "\u91D1\u5408\u6B22",
  dark_oak: "\u6DF1\u8272\u6A61\u6728",
  mangrove: "\u7EA2\u6811",
  cherry: "\u6A31\u82B1",
  bamboo: "\u7AF9",
  pale_oak: "\u82CD\u767D\u6A61\u6728",
  crimson: "\u7EEF\u7EA2",
  warped: "\u8BE1\u5F02",
  nether: "\u4E0B\u754C",
  end: "\u672B\u5730",
  stone: "\u77F3",
  cobblestone: "\u5706\u77F3",
  deepslate: "\u6DF1\u677F\u5CA9",
  cobbled_deepslate: "\u6DF1\u677F\u5CA9\u5706\u77F3",
  granite: "\u82B1\u5C97\u5CA9",
  diorite: "\u95EA\u957F\u5CA9",
  andesite: "\u5B89\u5C71\u5CA9",
  sandstone: "\u7802\u5CA9",
  red_sandstone: "\u7EA2\u7802\u5CA9",
  blackstone: "\u9ED1\u77F3",
  basalt: "\u7384\u6B66\u5CA9",
  quartz: "\u77F3\u82F1",
  purpur: "\u7D2B\u73C0",
  prismarine: "\u6D77\u6676\u77F3",
  obsidian: "\u9ED1\u66DC\u77F3",
  mud: "\u6CE5",
  iron: "\u94C1",
  gold: "\u91D1",
  golden: "\u91D1",
  diamond: "\u94BB\u77F3",
  netherite: "\u4E0B\u754C\u5408\u91D1",
  copper: "\u94DC",
  coal: "\u7164\u70AD",
  lapis: "\u9752\u91D1\u77F3",
  lapis_lazuli: "\u9752\u91D1\u77F3",
  redstone: "\u7EA2\u77F3",
  emerald: "\u7EFF\u5B9D\u77F3",
  amethyst: "\u7D2B\u6C34\u6676",
  wooden: "\u6728",
  leather: "\u76AE\u9769",
  chainmail: "\u9501\u94FE",
  turtle: "\u6D77\u9F9F",
  raw_iron: "\u7C97\u94C1",
  raw_gold: "\u7C97\u91D1",
  raw_copper: "\u7C97\u94DC",
  white: "\u767D\u8272",
  orange: "\u6A59\u8272",
  magenta: "\u54C1\u7EA2\u8272",
  light_blue: "\u6DE1\u84DD\u8272",
  yellow: "\u9EC4\u8272",
  lime: "\u9EC4\u7EFF\u8272",
  pink: "\u7C89\u7EA2\u8272",
  gray: "\u7070\u8272",
  light_gray: "\u6DE1\u7070\u8272",
  cyan: "\u9752\u8272",
  purple: "\u7D2B\u8272",
  blue: "\u84DD\u8272",
  brown: "\u68D5\u8272",
  green: "\u7EFF\u8272",
  red: "\u7EA2\u8272",
  black: "\u9ED1\u8272",
  mossy: "\u82D4\u77F3",
  cracked: "\u88C2\u7EB9",
  chiseled: "\u933E\u5236",
  polished: "\u78E8\u5236",
  smooth: "\u5E73\u6ED1",
  cut: "\u5207\u5236",
  waxed: "\u6D82\u8721",
  exposed: "\u6591\u9A73",
  weathered: "\u9508\u8680",
  oxidized: "\u6C27\u5316",
  infested: "\u88AB\u866B\u8680\u7684",
  dead: "\u5931\u6D3B\u7684",
  stripped: "\u53BB\u76AE",
  muddy: "\u6CE5\u6CDE",
  suspicious: "\u53EF\u7591\u7684",
  flowering: "\u5F00\u82B1\u7684",
  budding: "\u7D2B\u6676\u7C07\u751F",
  wet: "\u6E7F",
  powered: "\u5145\u80FD",
  detector: "\u63A2\u6D4B",
  heavy: "\u91CD\u578B",
  large: "\u5927\u578B",
  small: "\u5C0F\u578B",
  tinted: "\u906E\u5149",
  reinforced: "\u5F3A\u5316",
  ominous: "\u4E0D\u7965",
  azalea: "\u675C\u9E43",
  dripstone: "\u6EF4\u6C34\u77F3",
  pointed: "\u5C16",
  sculk: "\u5E7D\u533F",
  potted: "\u76C6\u683D",
  tube: "\u7BA1",
  brain: "\u8111",
  bubble: "\u6C14\u6CE1",
  horn: "\u9E7F\u89D2",
  fire: "\u706B",
  activator: "\u6FC0\u6D3B",
  trapped: "\u9677\u9631",
  chipped: "\u5F00\u88C2",
  damaged: "\u7834\u635F",
  petrified: "\u77F3\u5316",
  decorated: "\u9970\u7EB9",
  calibrated: "\u6821\u9891",
  repeating: "\u5FAA\u73AF",
  chain: "\u9501\u94FE",
  soul: "\u7075\u9B42",
  attached: "\u9644\u7740",
  carved: "\u96D5\u523B",
  packed: "\u538B\u5B9E"
};
var BASE = {
  armor_trim_smithing_template: "\u76D4\u7532\u7EB9\u9970\u953B\u9020\u6A21\u677F",
  concrete_powder: "\u6DF7\u51DD\u571F\u7C89\u672B",
  glazed_terracotta: "\u5E26\u91C9\u9676\u74E6",
  stained_glass_pane: "\u67D3\u8272\u73BB\u7483\u677F",
  stained_glass: "\u67D3\u8272\u73BB\u7483",
  glass_pane: "\u73BB\u7483\u677F",
  pressure_plate: "\u538B\u529B\u677F",
  hanging_sign: "\u60AC\u6302\u5F0F\u544A\u793A\u724C",
  fence_gate: "\u6805\u680F\u95E8",
  horse_armor: "\u9A6C\u94E0",
  shulker_box: "\u6F5C\u5F71\u76D2",
  chest_boat: "\u8FD0\u8F93\u8239",
  spawn_egg: "\u5237\u602A\u86CB",
  pottery_sherd: "\u9676\u7247",
  banner_pattern: "\u65D7\u5E1C\u56FE\u6848",
  music_disc: "\u5531\u7247",
  brick_slab: "\u7816\u53F0\u9636",
  brick_stairs: "\u7816\u697C\u68AF",
  brick_wall: "\u7816\u5899",
  log: "\u539F\u6728",
  wood: "\u6728\u5934",
  planks: "\u6728\u677F",
  leaves: "\u6811\u53F6",
  sapling: "\u6811\u82D7",
  stairs: "\u697C\u68AF",
  slab: "\u53F0\u9636",
  fence: "\u6805\u680F",
  door: "\u95E8",
  trapdoor: "\u6D3B\u677F\u95E8",
  button: "\u6309\u94AE",
  sign: "\u544A\u793A\u724C",
  wall: "\u5899",
  ore: "\u77FF\u77F3",
  block: "\u5757",
  ingot: "\u952D",
  nugget: "\u7C92",
  bricks: "\u7816\u5757",
  brick: "\u7816",
  dust: "\u7C89",
  shard: "\u788E\u7247",
  seeds: "\u79CD\u5B50",
  bucket: "\u6876",
  boat: "\u8239",
  bed: "\u5E8A",
  wool: "\u7F8A\u6BDB",
  carpet: "\u5730\u6BEF",
  concrete: "\u6DF7\u51DD\u571F",
  terracotta: "\u9676\u74E6",
  glass: "\u73BB\u7483",
  banner: "\u65D7\u5E1C",
  candle: "\u8721\u70DB",
  dye: "\u67D3\u6599",
  minecart: "\u77FF\u8F66",
  pickaxe: "\u9550",
  sword: "\u5251",
  axe: "\u65A7",
  shovel: "\u9539",
  hoe: "\u9504",
  helmet: "\u5934\u76D4",
  chestplate: "\u80F8\u7532",
  leggings: "\u62A4\u817F",
  boots: "\u9774\u5B50",
  pillar: "\u67F1",
  tiles: "\u74E6\u7247",
  stem: "\u83CC\u67C4",
  hyphae: "\u83CC\u6838",
  roots: "\u6839",
  fungus: "\u83CC",
  mushroom: "\u8611\u83C7",
  berries: "\u6D46\u679C",
  sprouts: "\u82BD",
  vines: "\u85E4",
  coral: "\u73CA\u745A",
  coral_block: "\u73CA\u745A\u5757",
  crystals: "\u6676\u7C07",
  cluster: "\u7C07",
  shulker: "\u6F5C\u5F71\u8D1D",
  golem: "\u5080\u5121",
  froglight: "\u86D9\u660E\u706F",
  wall_hanging_sign: "\u5899\u4E0A\u60AC\u6302\u544A\u793A\u724C",
  wall_sign: "\u5899\u4E0A\u544A\u793A\u724C",
  wall_torch: "\u5899\u4E0A\u706B\u628A",
  torch: "\u706B\u628A",
  rail: "\u94C1\u8F68",
  wire: "\u7EBF",
  nylium: "\u83CC\u5CA9",
  propagule: "\u80CE\u751F\u82D7",
  mosaic: "\u7AF9\u9A6C\u8D5B\u514B",
  sponge: "\u6D77\u7EF5",
  copper: "\u94DC\u5757",
  tuff: "\u51DD\u7070\u5CA9",
  granite: "\u82B1\u5C97\u5CA9",
  diorite: "\u95EA\u957F\u5CA9",
  andesite: "\u5B89\u5C71\u5CA9",
  deepslate: "\u6DF1\u677F\u5CA9",
  sand: "\u6C99\u5B50",
  gravel: "\u6C99\u783E",
  core: "\u6838",
  bricks_slab: "\u7816\u5757\u53F0\u9636",
  coral_fan: "\u73CA\u745A\u6247",
  tile: "\u74E6",
  wall_skull: "\u5899\u4E0A\u5934\u9885",
  wall_head: "\u5899\u4E0A\u7684\u5934",
  skull: "\u5934\u9885",
  head: "\u5934",
  bars: "\u680F\u6746",
  rod: "\u68D2",
  vein: "\u8109\u7EDC",
  catalyst: "\u50AC\u53D1\u4F53",
  shrieker: "\u5C16\u5578\u4F53",
  sensor: "\u611F\u6D4B\u4F53",
  dripleaf: "\u5782\u6EF4\u53F6",
  pickle: "\u6D77\u6CE1\u83DC",
  lantern: "\u706F\u7B3C",
  detector: "\u63A2\u6D4B\u5668",
  pot: "\u7F50",
  plant: "\u690D\u682A",
  flower: "\u82B1",
  fruit: "\u679C",
  egg: "\u86CB",
  bush: "\u4E1B",
  cauldron: "\u70BC\u836F\u9505",
  portal: "\u4F20\u9001\u95E8",
  command_block: "\u547D\u4EE4\u65B9\u5757",
  wart_block: "\u75A3\u5757",
  bricks_stairs: "\u7816\u5757\u697C\u68AF"
};
var BASE_KEYS = Object.keys(BASE).sort((a, b) => b.length - a.length);
var MODIFIER_KEYS = Object.keys(MODIFIER).sort((a, b) => b.length - a.length);

// src/worlds/minecraft/hazard-geometry.ts
var HAZARD_BODY_REACH = 0.3 + 0.1;
var HAZARD_HEAD_OFFSET = 1.8 - 0.1;

// src/worlds/minecraft/status-effects.ts
var received = /* @__PURE__ */ new WeakMap();
var observed = /* @__PURE__ */ new WeakSet();
function record2(effect, receivedAtMs = Date.now()) {
  received.set(effect, { duration: effect.duration, receivedAtMs });
}
function remainingEffectTicks(effect, nowMs = Date.now()) {
  let timing = received.get(effect);
  if (!timing || timing.duration !== effect.duration) {
    record2(effect, nowMs);
    timing = received.get(effect);
  }
  if (effect.duration < 0) return effect.duration;
  const elapsedTicks = Math.floor(Math.max(0, nowMs - timing.receivedAtMs) / 50);
  return Math.max(0, effect.duration - elapsedTicks);
}
function observeStatusEffects(bot) {
  if (observed.has(bot)) return;
  observed.add(bot);
  for (const entity of [bot.entity, ...Object.values(bot.entities ?? {})]) {
    for (const effect of Object.values(entity?.effects ?? {})) {
      if (!received.has(effect)) record2(effect);
    }
  }
  bot.on("entityEffect", (_entity, effect) => record2(effect));
}

// src/worlds/minecraft/flight.ts
import { Vec3 } from "vec3";

// src/worlds/minecraft/skill-context.ts
import pathfinderPkg from "mineflayer-pathfinder";
var { goals } = pathfinderPkg;

// src/worlds/minecraft/terrain.ts
var SEE_THROUGH_BLOCKS = /* @__PURE__ */ new Set([
  "glass",
  "glass_pane",
  "iron_bars",
  ...[
    "white",
    "orange",
    "magenta",
    "light_blue",
    "yellow",
    "lime",
    "pink",
    "gray",
    "light_gray",
    "cyan",
    "purple",
    "blue",
    "brown",
    "green",
    "red",
    "black"
  ].flatMap((c) => [`${c}_stained_glass`, `${c}_stained_glass_pane`])
]);
function isRaining(bot) {
  const level = bot.rainState;
  if (typeof level !== "number" || !Number.isFinite(level) || level <= 0) return false;
  try {
    const position2 = bot.entity?.position;
    const biome = position2 && bot.blockAt?.(position2.floored?.() ?? position2)?.biome;
    const registryBiome = Number.isInteger(biome?.id) ? bot.registry?.biomes?.[biome.id] : null;
    const value = biome?.has_precipitation ?? biome?.hasPrecipitation ?? registryBiome?.has_precipitation ?? registryBiome?.hasPrecipitation ?? registryBiome?.precipitation;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return value !== "none";
  } catch {
  }
  return true;
}

// src/worlds/minecraft/viewer-player-skin.ts
function viewerPlayerSkin(bot, username, uuid) {
  const player = (username ? bot.players?.[username] : void 0) ?? (uuid ? Object.values(bot.players ?? {}).find((entry) => entry.uuid === uuid) : void 0);
  const skin = player?.skinData;
  if (!skin?.url || typeof skin.url !== "string") return {};
  try {
    const url = new URL(skin.url);
    const hash = /^\/texture\/([0-9a-f]{40,64})$/.exec(url.pathname)?.[1];
    if (!hash || !["http:", "https:"].includes(url.protocol) || url.hostname !== "textures.minecraft.net" || url.port || url.username || url.password || url.search || url.hash) return {};
    return { skinUrl: `/head-texture/${hash}.png`, skinModel: skin.model === "slim" ? "slim" : "classic" };
  } catch {
    return {};
  }
}

// src/worlds/minecraft/modern-viewer.ts
function viewerMessageKind(message, position2) {
  if (position2 !== "chat" && position2 !== "system") return null;
  if (message.translate === "commands.message.display.outgoing") return null;
  if (position2 === "system" && /^(?:MC_[A-Z0-9_]+(?:\s|$)|\{\s*"(?:schemaVersion|action|type)"\s*:)/.test(message.toString().trimStart())) return null;
  return message.translate === "commands.message.display.incoming" ? "whisper" : message.translate === "chat.type.advancement" ? "advancement" : position2;
}
var require2 = createRequire(import.meta.url);
var { WorldView } = require2("prismarine-viewer/viewer/lib/worldView.js");
var TradeItem = createRequire(require2.resolve("mineflayer"))("prismarine-item")("1.20.6");
var vanillaBiomes = require2("minecraft-data")("1.20.6").biomesArray;
var plainsBiomeId = (() => {
  const id = vanillaBiomes.find((biome) => biome.name === "plains")?.id;
  if (id === void 0) throw Error("1.20.6 \u7FA4\u7CFB\u5217\u8868\u7F3A\u5C11 plains");
  return id;
})();
var VIEW_DISTANCE = 5;
var MANA_CSS = `.corti-mana-bar{height:5px;margin-top:7px;background:#294852;border-radius:5px;overflow:hidden}.corti-mana-bar span{display:block;height:100%;width:0;background:linear-gradient(90deg,#447acb,#8de9ff);box-shadow:0 0 9px #87dafa;transition:width .3s ease}`;
var COMBAT_CSS = `.corti-combat-floats{position:fixed;inset:0;z-index:10;pointer-events:none;overflow:hidden}.corti-combat-float{position:absolute;color:#fff7ee;font:800 23px/1.1 system-ui;text-shadow:0 2px 2px #18111b,0 0 8px #161322;white-space:nowrap;transform:translate(-50%,-50%);animation:corti-damage-number 1.15s ease-out both}.corti-combat-float.is-critical{color:#ffdf46;font-size:30px;font-weight:1000;text-shadow:0 2px 2px #422600,0 0 13px #ffb328}@keyframes corti-damage-number{0%{opacity:0;transform:translate(-50%,-50%) scale(.75)}16%{opacity:1;transform:translate(-50%,-67%) scale(1.12)}72%{opacity:1}100%{opacity:0;transform:translate(-50%,-320%) scale(.96)}}@media(prefers-reduced-motion:reduce){.corti-combat-float{animation-duration:.7s}}`;
var TACTICS_CSS = `.corti-tactical-canvas{position:fixed;inset:0;z-index:5;width:100%;height:100%;pointer-events:none}.corti-tactical-legend{position:fixed;z-index:8;top:55px;left:50%;transform:translateX(-50%);display:flex;gap:8px;max-width:calc(100vw - 28px);pointer-events:none}.corti-tactical-legend[hidden]{display:none}.corti-tactical-legend span{padding:5px 10px;border:1px solid currentColor;border-radius:5px;background:#10242be6;box-shadow:0 2px 12px #000a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:700 12px/1.2 system-ui;text-shadow:1px 1px #000}.corti-tactical-move{color:#8affb7}.corti-tactical-attack{color:#ff8888}@media(max-width:700px){.corti-tactical-legend{top:49px;flex-direction:column;gap:3px;max-width:52vw}.corti-tactical-legend span{font-size:10px;padding:3px 6px}}`;
var STATUS_VIGNETTE_CSS = `.corti-status-vignette{position:fixed;inset:0;z-index:2;pointer-events:none;opacity:0;transition:opacity .35s ease;background:radial-gradient(ellipse at center,transparent 40%,#407b2466 77%,#245810aa 100%),radial-gradient(circle at 11% 83%,#98db5b66 0 1.2%,transparent 2.5%),radial-gradient(circle at 85% 19%,#97d85980 0 .8%,transparent 2%);box-shadow:inset 0 0 34px #416b30;mix-blend-mode:screen}.corti-status-vignette.is-poisoned{opacity:1;animation:corti-poison-breathe 2.4s ease-in-out infinite}@keyframes corti-poison-breathe{0%,100%{filter:saturate(.8)}50%{filter:saturate(1.5) brightness(1.12)}}@media(prefers-reduced-motion:reduce){.corti-status-vignette.is-poisoned{animation:none}}`;
var PRESENTATION_CSS = `:root{--mc-viewer-vfx-fire:#ffa05b;--mc-viewer-vfx-arcane:#c5a5ff;--mc-viewer-vfx-life:#a9eeb8;--mc-viewer-vfx-water:#a6e5ff;--mc-viewer-vfx-combat:#fff4af;--mc-viewer-vfx-neutral:#d9e0d7;--mc-viewer-ui-bg:#11242cde;--mc-viewer-ui-border:#b0ccb5a8;--mc-viewer-ui-text:#f3f5f6}body[data-viewer-theme="corti-arcane"]{--mc-viewer-vfx-arcane:#e6a3ff;--mc-viewer-vfx-combat:#ffd580;--mc-viewer-ui-bg:#201a36e8;--mc-viewer-ui-border:#d2a8f0b0;--mc-viewer-ui-text:#fbf1ff}.corti-presentation-toasts{position:fixed;z-index:9;top:14px;left:250px;display:grid;gap:7px;width:min(300px,25vw);pointer-events:none}.corti-presentation-toast{display:grid;gap:2px;padding:9px 12px;border:1px solid var(--mc-viewer-ui-border);border-left:4px solid #b5d8ea;border-radius:7px;background:var(--mc-viewer-ui-bg);box-shadow:0 4px 18px #0008;color:var(--mc-viewer-ui-text);animation:corti-toast-enter .25s ease-out}.corti-presentation-toast strong{font:800 15px/1.3 system-ui}.corti-presentation-toast span{font:12px/1.35 system-ui;overflow-wrap:anywhere}.corti-presentation-toast[data-tone="arcane"]{border-left-color:#d5a6ff}.corti-presentation-toast[data-tone="positive"]{border-left-color:#9be0ac}.corti-presentation-toast[data-tone="warning"]{border-left-color:#f0ce75}.corti-presentation-toast[data-tone="danger"]{border-left-color:#f49a9a}@keyframes corti-toast-enter{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:translateX(0)}}.corti-effects{position:fixed;z-index:7;right:14px;bottom:66px;display:grid;gap:4px;max-width:220px;max-height:25vh;overflow:hidden;pointer-events:none}.corti-effect{display:flex;align-items:center;gap:5px;min-width:125px;padding:3px 6px;border:1px solid var(--mc-viewer-ui-border);border-radius:5px;background:var(--mc-viewer-ui-bg);color:var(--mc-viewer-ui-text);font:12px/1.2 system-ui}.corti-effect[data-type="bad"]{border-color:#e09c9caf}.corti-effect img{position:static;width:19px;height:19px;image-rendering:pixelated}.corti-effect span{flex:1}.corti-effect small{font:11px monospace}.corti-scoreboard{position:fixed;z-index:7;top:252px;left:14px;width:220px;max-height:min(34vh,300px);overflow:hidden;box-sizing:border-box;padding:8px;border:1px solid var(--mc-viewer-ui-border);border-radius:7px;background:var(--mc-viewer-ui-bg);color:var(--mc-viewer-ui-text);pointer-events:none}.corti-scoreboard>strong{display:block;margin-bottom:5px;font:700 13px system-ui}.corti-scoreboard>div{display:flex;justify-content:space-between;gap:8px;font:11px/1.4 system-ui}.corti-scoreboard b{color:#d6efac}.corti-cooldown{position:absolute;z-index:4;left:4px;right:4px;bottom:2px;background:#1119;pointer-events:none}@media(max-width:900px){.corti-presentation-toasts{left:50%;top:72px;transform:translateX(-50%);width:min(280px,42vw)}.corti-scoreboard{top:180px;width:150px;max-height:26vh}}@media(max-width:420px){.corti-minimap{width:116px}.corti-minimap canvas{width:104px;height:104px}.corti-skills{width:116px}.corti-scoreboard{top:155px;width:116px}.corti-presentation-toasts{top:146px;width:min(210px,70vw)}}@media(prefers-reduced-motion:reduce){.corti-presentation-toast{animation:none}}`;
var THEME_SURFACE_CSS = `.corti-minimap,.corti-skills,.corti-menu{background:var(--mc-viewer-ui-bg);border-color:var(--mc-viewer-ui-border);color:var(--mc-viewer-ui-text)}.corti-night-vision-toggle,.corti-sound-toggle,.corti-inventory-toggle{border-color:var(--mc-viewer-ui-border);color:var(--mc-viewer-ui-text)}`;
var SKILL_TONE_CSS = `.corti-cast[data-phase="succeeded"][data-tone="healing"]{border-color:#91efae;background:linear-gradient(125deg,#102a24f0,#24503bee 65%,#142a37ee)}.corti-cast[data-phase="succeeded"][data-tone="healing"] .corti-cast-line{background:#91efae}.corti-cast[data-phase="succeeded"][data-tone="frost"]{border-color:#88e5ff;background:linear-gradient(125deg,#102b3af0,#265068ee 65%,#142a37ee)}.corti-cast[data-phase="succeeded"][data-tone="frost"] .corti-cast-line{background:#88e5ff}.corti-cast[data-phase="succeeded"][data-tone="fire"]{border-color:#ffad6e;background:linear-gradient(125deg,#351b1cf0,#63352aee 65%,#142a37ee)}.corti-cast[data-phase="succeeded"][data-tone="fire"] .corti-cast-line{background:#ffad6e}.corti-cast[data-phase="succeeded"][data-tone="movement"]{border-color:#96e1df;background:linear-gradient(125deg,#102b30f0,#275256ee 65%,#142a37ee)}.corti-cast[data-phase="succeeded"][data-tone="movement"] .corti-cast-line{background:#96e1df}`;
var MAX_CAPTURE_SESSIONS = 1;
var CAPTURE_SESSION_MS = 6e4;
var PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Minecraft \u753B\u9762</title><link rel="stylesheet" href="/viewer.css"></head><body data-view-mode="__VIEW_MODE__">
<div class="boot" aria-live="polite">\u6B63\u5728\u8F7D\u5165\u4E16\u754C\u753B\u9762\u2026</div>
<nav class="corti-view-switch" aria-label="\u5207\u6362\u89C2\u5BDF\u89C6\u89D2"><a href="/" data-view="first">\u7B2C\u4E00\u4EBA\u79F0</a><a href="/third/" data-view="third">\u7B2C\u4E09\u4EBA\u79F0</a><a href="/dungeon/" data-view="dungeon">\u5730\u4E0B\u57CE 2.5D</a></nav>
<div class="viewer-hud"><div class="viewer-help"></div><div class="viewer-motion"></div><div class="viewer-held"></div><div class="viewer-hotbar"></div></div>
<div class="corti-crosshair" aria-hidden="true"></div>
<div class="corti-status-vignette" id="corti-status-vignette" aria-hidden="true"></div>
<div class="corti-survival" id="corti-survival" aria-label="Minecraft \u751F\u5B58\u72B6\u6001">
  <div class="corti-armor" data-corti-armor></div>
  <div class="corti-vitals"><div data-corti-hearts></div><div class="corti-mana-vital" data-corti-mana-vital><span data-corti-mana-label>\u2726 \u9B54\u529B --/--</span><span class="corti-mana-vital-track"><span data-corti-mana-fill></span></span></div><div class="corti-air" data-corti-air></div><div data-corti-food></div></div>
  <div class="corti-level" data-corti-level></div>
  <div class="corti-xp"><div class="corti-xp-fill" data-corti-xp></div></div>
  <div class="corti-hotbar"><div class="corti-offhand corti-slot" data-corti-offhand title="\u526F\u624B"></div><div class="corti-hotbar-selection" data-corti-selection></div><div class="corti-hotbar-slots" data-corti-slots></div></div>
</div>
<div class="camera-follow-status" id="camera-follow-status" hidden><span>\u955C\u5934\u8DDF\u968F <strong id="camera-follow-name"></strong></span><button type="button" id="camera-follow-return">\u8FD4\u56DE</button></div>
<div class="ground-click-ping" id="ground-click-ping" hidden></div>
<section class="corti-cast" id="corti-cast" aria-label="\u65BD\u6CD5\u63D0\u793A" aria-live="polite" hidden><div class="corti-cast-sigil" aria-hidden="true">\u2726</div><div class="corti-cast-copy"><small data-cast-phase></small><strong data-cast-name></strong><span data-cast-detail></span></div><div class="corti-cast-line" aria-hidden="true"></div></section>
<div class="skill-cue" id="skill-cue" hidden><small data-skill-cue-source></small><strong data-skill-cue-title></strong><span data-skill-cue-evidence></span></div>
<div class="corti-event-feed" id="corti-event-feed" aria-label="\u6E38\u620F\u6D88\u606F" aria-live="polite"></div>
<div class="corti-combat-floats" id="corti-combat-floats" aria-hidden="true"></div>
<canvas class="corti-tactical-canvas" id="corti-tactical-canvas" aria-hidden="true"></canvas><div class="corti-tactical-legend" id="corti-tactical-legend" aria-label="\u5F53\u524D\u884C\u52A8" hidden></div>
<div class="corti-presentation-toasts" id="corti-presentation-toasts" aria-live="polite"></div>
<aside class="corti-effects" id="corti-effects" aria-label="\u72B6\u6001\u6548\u679C"></aside>
<aside class="corti-scoreboard" id="corti-scoreboard" aria-label="\u8BA1\u5206\u677F" hidden></aside>
<div class="corti-boss-bars" id="corti-boss-bars" aria-label="Boss \u8840\u6761"></div>
<div class="corti-game-title" id="corti-game-title" aria-live="assertive" hidden><strong data-game-title></strong><span data-game-subtitle></span></div>
<div class="corti-actionbar" id="corti-actionbar" aria-live="polite" hidden></div>
<iframe class="corti-speech-bubble" id="corti-speech-bubble" title="\u4E3B\u64AD\u8BED\u97F3\u6C14\u6CE1" aria-label="\u4E3B\u64AD\u8BED\u97F3\u6C14\u6CE1" hidden></iframe>
<aside class="corti-minimap" id="corti-minimap" aria-label="\u9644\u8FD1\u5730\u5F62"><canvas width="200" height="200"></canvas><div class="corti-map-caption" data-map-caption></div></aside>
<aside class="corti-skills" id="corti-skills" aria-label="\u6280\u80FD\u72B6\u6001"><header><strong>\u6280\u80FD</strong><span data-mana></span></header><div class="corti-mana-bar"><span data-mana-fill></span></div><div data-skill-list></div><div data-ability-list></div><small data-skill-status></small></aside>
<button type="button" class="corti-sound-toggle" id="corti-sound-toggle" aria-label="\u5207\u6362\u6E38\u620F\u97F3\u6548">\u97F3\u6548 \u5F85\u6FC0\u6D3B</button>
<button type="button" class="corti-night-vision-toggle" id="corti-night-vision-toggle" aria-label="\u5207\u6362\u591C\u89C6\u6A21\u5F0F">\u591C\u89C6 \u81EA\u52A8</button>
<button type="button" class="corti-inventory-toggle" id="corti-inventory-toggle" aria-label="\u6253\u5F00\u80CC\u5305">\u80CC\u5305 <kbd>E</kbd></button>
<section class="corti-menu" id="corti-menu" aria-label="\u7269\u54C1\u754C\u9762" hidden><header><strong data-menu-title></strong><span data-menu-source></span><button type="button" data-menu-close aria-label="\u5173\u95ED\u7269\u54C1\u754C\u9762">\xD7</button></header><div data-menu-body></div></section>
<div class="dungeon-hover-card" id="dungeon-hover-card" hidden><span id="dungeon-hover-icon"></span><strong id="dungeon-hover-title"></strong><small id="dungeon-hover-subtitle"></small><em id="dungeon-hover-action"></em></div>
<div class="entity-context-menu" id="entity-context-menu" hidden><header><strong data-context-title></strong><small data-context-subtitle></small></header><div data-context-summary></div><div data-context-actions></div></div>
<aside class="entity-detail-card" id="entity-detail-card" hidden><button type="button" data-detail-close>\u5173\u95ED</button><h2 id="entity-detail-title" data-detail-title></h2><p data-detail-subtitle></p><div data-detail-rows></div></aside>
<script type="module" src="/index.js"></script><script src="/speech-bubble.js" defer></script></body></html>`;
var CSS = `html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#080d12;color:#f3f5f6;font:14px/1.4 system-ui,sans-serif}
canvas{position:absolute;inset:0;width:100%;height:100%;display:block}.boot{position:fixed;inset:0;z-index:5;display:grid;place-items:center;text-align:center;background:#080d12;color:#e6eeee;pointer-events:none}.boot.is-compact{inset:auto 12px 12px auto;display:block;padding:6px 9px;border-radius:6px;background:#101923dd}.boot.is-error{pointer-events:auto;color:#ffbdad}.viewer-hud{display:none}.corti-crosshair{position:fixed;z-index:3;top:50%;left:50%;width:30px;height:30px;transform:translate(-50%,-50%);background:url('/textures/gui/sprites/hud/crosshair.png') center/30px 30px no-repeat;image-rendering:pixelated;pointer-events:none}.corti-survival{position:fixed;z-index:3;bottom:8px;left:50%;width:364px;transform:translateX(-50%);pointer-events:none;image-rendering:pixelated;filter:drop-shadow(0 2px 2px #0009)}.corti-armor,.corti-air{height:18px;display:flex;gap:0}.corti-armor:empty,.corti-air:empty{display:none}.corti-vitals{height:20px;display:flex;justify-content:space-between}.corti-vitals>div{display:flex;flex-direction:row}.corti-vitals>div:last-child{flex-direction:row-reverse}.corti-icon{width:16px;height:18px;flex:none;background-position:left top;background-repeat:no-repeat;background-size:18px 18px}.corti-xp{position:relative;width:364px;height:10px;margin:2px 0 5px;background:url('/textures/gui/sprites/hud/experience_bar_background.png') left top/364px 10px no-repeat}.corti-xp-fill{height:10px;background:url('/textures/gui/sprites/hud/experience_bar_progress.png') left top/364px 10px no-repeat}.corti-level{position:absolute;bottom:59px;left:50%;transform:translateX(-50%);font:bold 20px/20px monospace;color:#80ff20;text-shadow:2px 2px #163500,-2px 2px #163500,2px -2px #163500,-2px -2px #163500;white-space:nowrap}.corti-level:empty{display:none}.corti-hotbar{position:relative;width:364px;height:44px;background:url('/textures/gui/sprites/hud/hotbar.png') center/364px 44px no-repeat}.corti-hotbar-selection{position:absolute;top:-2px;left:4px;width:48px;height:46px;background:url('/textures/gui/sprites/hud/hotbar_selection.png') center/48px 46px no-repeat}.corti-hotbar-slots{position:absolute;top:5px;left:8px;display:flex}.corti-slot{position:relative;width:40px;height:36px}.corti-slot img{position:absolute;top:2px;left:4px;width:32px;height:32px;object-fit:contain;image-rendering:pixelated}.corti-slot-count{position:absolute;right:0;bottom:-2px;color:#fff;font:bold 17px/18px monospace;text-shadow:2px 2px #222,-1px -1px #222}.corti-slot[title]{cursor:default}body>[hidden]{display:none!important}`;
var HUD_CSS = `.corti-item-fallback{position:absolute;inset:5px 2px 2px;display:grid;place-items:center;color:#eee;font:bold 11px/1 sans-serif;text-shadow:1px 1px #111}`;
var DURABILITY_CSS = `.corti-durability{position:absolute;z-index:2;left:5px;bottom:0;width:30px;height:4px;box-sizing:border-box;border:1px solid #111;background:#111;pointer-events:none}.corti-durability>span{display:block;height:2px}.corti-menu-slot .corti-durability{left:4px;bottom:1px;width:28px}`;
var ENCHANT_CSS = `.corti-enchant-glint{position:absolute;top:2px;z-index:1;width:32px;height:32px;pointer-events:none;image-rendering:pixelated;mask-position:center;mask-size:contain;mask-repeat:no-repeat;background:linear-gradient(110deg,#8a63ca66 0%,#8a63ca66 34%,#e2c0ffb8 46%,#a9daffcc 52%,#8254bf70 62%,#8a63ca66 100%);background-size:230% 100%;mix-blend-mode:screen;animation:corti-enchant-shine 2.4s linear infinite}.corti-enchanted-outline{box-shadow:inset 0 0 6px #ad7cffb0}@keyframes corti-enchant-shine{from{background-position:100% 0}to{background-position:-120% 0}}@media(prefers-reduced-motion:reduce){.corti-enchant-glint{animation:none;background-position:50% 0}}`;
var PANELS_CSS = `.corti-minimap,.corti-skills,.corti-inventory-toggle,.corti-menu{position:fixed;z-index:8;box-sizing:border-box}.corti-minimap{top:14px;left:14px;width:220px;padding:9px;background:#11242cdb;border:1px solid #b0ccb5a8;border-radius:9px;box-shadow:0 4px 20px #0007;pointer-events:none}.corti-minimap canvas{position:static;width:200px;height:200px;image-rendering:pixelated;border:1px solid #9eb9ad7a;background:#334746}.corti-map-caption{margin-top:4px;text-align:center;color:#f1f4de;font:12px/1.3 monospace;text-shadow:1px 1px #000}.corti-skills{top:14px;right:14px;width:220px;max-height:min(280px,40vh);overflow:auto;padding:10px;background:#11242cdb;border:1px solid #b0ccb5a8;border-radius:9px;box-shadow:0 4px 20px #0007;pointer-events:none}.corti-skills header{display:flex;justify-content:space-between;gap:8px;font-weight:700}.corti-skills [data-mana]{color:#a8e1ff}.corti-skills [data-skill-list]{display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;margin-top:7px}.corti-skill{font-size:12px}.corti-skill strong{font:700 12px/1.3 monospace;color:#e6f7d4}.corti-skill-bar{height:3px;margin-top:2px;background:#44545d}.corti-skill-bar span{display:block;height:100%;background:#9bd47d}.corti-skills [data-skill-status]{display:block;margin-top:7px;color:#aebfc1;font-size:11px}.corti-inventory-toggle{right:14px;bottom:14px;padding:6px 10px;background:#1a2f36dd;color:#f0f5ed;border:1px solid #aec3b4;border-radius:7px;font:13px system-ui;cursor:pointer}.corti-inventory-toggle kbd{font:11px monospace;opacity:.8}.corti-menu{top:50%;left:50%;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);transform:translate(-50%,-50%);overflow:auto;padding:8px;background:#14242cec;border:1px solid #b8c8bb;border-radius:8px;box-shadow:0 10px 45px #000b;pointer-events:auto}.corti-menu[hidden]{display:none}.corti-menu header{display:flex;align-items:center;gap:10px;min-height:25px;margin-bottom:5px;color:#f8f8ed}.corti-menu header strong{flex:1}.corti-menu header span{font:11px/1.2 sans-serif;color:#a9bfc1}.corti-menu header button{padding:0 5px;background:none;color:#fff;border:0;font:22px/1 sans-serif;cursor:pointer}.corti-menu-body{position:relative;image-rendering:pixelated}.corti-menu-vanilla{width:352px;height:332px;background-position:left top;background-size:512px 512px;background-repeat:no-repeat}.corti-menu-slot{position:absolute;width:36px;height:36px;box-sizing:border-box}.corti-menu-slot img{position:absolute;top:2px;left:2px;width:32px;height:32px;image-rendering:pixelated}.corti-menu-slot small{position:absolute;right:0;bottom:0;color:#fff;font:700 15px/1 monospace;text-shadow:1px 1px #111,-1px -1px #111}.corti-menu-slot .corti-item-fallback{inset:3px;font-size:11px}.corti-menu-progress{position:absolute;overflow:hidden;background-repeat:no-repeat;background-position:left top;image-rendering:pixelated}.corti-menu-progress span{display:block;height:100%;background-repeat:no-repeat;background-position:left top;background-size:100% 100%}.corti-menu-generic{min-width:352px;padding:8px 8px 14px;background:#c6c6c6;color:#333}.corti-menu-generic h3{margin:0 0 6px;font-size:12px}.corti-menu-grid{display:grid;grid-template-columns:repeat(9,36px);gap:0}.corti-menu-grid .corti-menu-slot{position:relative;background:#8b8b8b;box-shadow:inset 2px 2px #383838,inset -2px -2px #eee}.corti-menu-generic .corti-menu-section{margin-top:13px}.corti-menu-note{padding:9px;color:#293835;font-size:12px}@media(max-width:720px){.corti-minimap{width:150px;padding:5px}.corti-minimap canvas{width:138px;height:138px}.corti-skills{width:155px;padding:6px}.corti-skills [data-skill-list]{grid-template-columns:1fr}.corti-menu{zoom:.8}}`;
var ABILITY_CSS = `.corti-skills{max-height:min(600px,75vh);pointer-events:auto}.corti-skills [data-ability-list]{display:grid;gap:3px;margin-top:8px;padding-top:7px;border-top:1px solid #849e9866}.corti-ability{display:flex;justify-content:space-between;gap:6px;color:#e3e8d9;font:11px/1.3 sans-serif}.corti-ability small{color:#b9d5e2;font:11px/1.3 monospace;white-space:nowrap}.corti-night-vision-toggle,.corti-sound-toggle{position:fixed;z-index:8;left:14px;padding:6px 10px;background:#1a2f36dd;color:#f0f5ed;border:1px solid #aec3b4;border-radius:7px;font:13px system-ui;cursor:pointer}.corti-night-vision-toggle{bottom:14px}.corti-night-vision-toggle[data-active="true"],.corti-sound-toggle[data-active="true"]{border-color:#c6e7a9;color:#eaffd6;background:#2a493bdd}.corti-sound-toggle{bottom:55px}`;
var ABILITY_ICON_CSS = `.corti-vitals{position:relative;height:34px}.corti-mana-vital{position:absolute;left:0;top:18px;width:174px;height:16px;display:flex;align-items:center;gap:5px;color:#d3efff;font:700 10px/1 monospace;text-shadow:1px 1px #081824;white-space:nowrap}.corti-mana-vital-track{flex:1;height:7px;border:1px solid #89c5ec;border-radius:4px;background:#102d4b;overflow:hidden}.corti-mana-vital-track>span{display:block;width:0;height:100%;background:linear-gradient(90deg,#3371d2,#91e7ff);box-shadow:0 0 7px #87dafa;transition:width .35s ease}.corti-skills [data-ability-list]{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:8px;padding-top:8px}.corti-ability{position:relative;display:grid;place-items:center;aspect-ratio:1;min-width:0;overflow:hidden;border:2px solid #6185a3;border-radius:7px;background:linear-gradient(150deg,#365069,#162932);box-shadow:inset 0 0 9px #7ec8fd44,0 2px 5px #0009}.corti-ability img{width:80%;height:80%;object-fit:contain;image-rendering:pixelated;filter:drop-shadow(0 1px 2px #000)}.corti-ability[data-state="ready"]{border-color:#b8eaff;box-shadow:0 0 12px #6dd9ff99,inset 0 0 10px #aaeaff55}.corti-ability[data-state="cooldown"] img,.corti-ability[data-state="mana"] img,.corti-ability[data-state="unknown"] img{filter:grayscale(.85) brightness(.65)}.corti-ability[data-state="cooldown"] .corti-ability-mask{position:absolute;inset:0;background:conic-gradient(#07131ed9 var(--corti-cooldown-angle),transparent 0);pointer-events:none}.corti-ability-overlay{position:absolute;inset:0;display:grid;place-items:center;color:#fff;font:900 15px/1 monospace;text-shadow:0 1px 3px #000,0 0 7px #000;pointer-events:none}.corti-ability[data-state="mana"] .corti-ability-overlay{color:#ffb0ad;font-size:25px}.corti-ability-name{position:absolute;left:0;right:0;bottom:0;overflow:hidden;padding:1px 1px;background:#07151bbb;color:#eef8ff;text-align:center;text-overflow:ellipsis;white-space:nowrap;font:700 9px/1.2 system-ui;text-shadow:1px 1px #000}.corti-ability-glyph{color:#d4eaff;font:800 20px/1 system-ui;text-shadow:0 0 8px #91bff7}@media(max-width:720px){.corti-skills [data-ability-list]{grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}.corti-ability-name{font-size:8px}}@media(max-width:420px){.corti-skills [data-ability-list]{grid-template-columns:repeat(2,minmax(0,1fr))}}`;
var ABILITY_LAYOUT_CSS = `
.corti-vitals{display:grid;grid-template-columns:160px 44px 160px;grid-template-rows:minmax(18px,1fr) 18px;min-height:36px}
.corti-vitals.corti-has-air{grid-template-rows:minmax(18px,1fr) 18px 18px}
.corti-vitals>[data-corti-hearts]{grid-column:1;grid-row:1/-1;align-self:end}
.corti-vitals>div.corti-mana-vital{position:static;grid-column:3;grid-row:1;width:160px;height:18px;justify-self:end;align-self:end;flex-direction:row}
.corti-vitals>[data-corti-air],.corti-vitals>[data-corti-food]{grid-column:3;justify-self:end;align-self:end;flex-direction:row-reverse}
.corti-vitals>[data-corti-food]{grid-row:2}
.corti-vitals.corti-has-air>[data-corti-air]{grid-row:2}
.corti-vitals.corti-has-air>[data-corti-food]{grid-row:3}
.corti-level{bottom:61px;z-index:1}
.corti-skills{top:auto;right:14px;bottom:72px;max-height:min(600px,calc(80vh - 144px))}
.corti-effects{top:56px;bottom:auto;max-height:20vh}
.corti-skills header{align-items:center}.corti-skills header strong{flex:none;white-space:nowrap}
@media(max-width:800px){.corti-effects{top:100px}.corti-skills{max-height:min(600px,calc(80vh - 188px))}}
@media(max-width:720px){.corti-skills header{gap:3px;font-size:11px}.corti-skills [data-mana]{font-size:11px}}
`;
var CAST_CSS = `.corti-cast{position:fixed;z-index:9;top:16%;left:50%;width:min(440px,calc(100vw - 28px));min-height:112px;box-sizing:border-box;transform:translateX(-50%);display:flex;align-items:center;gap:18px;padding:16px 22px;color:#f9f5ff;background:linear-gradient(125deg,#14132bf0,#30264aee 65%,#142a37ee);border:2px solid #d3b2ef;border-radius:15px;box-shadow:0 9px 35px #000d,inset 0 0 25px #b69afa26;pointer-events:none;overflow:hidden;animation:corti-cast-enter .32s ease-out}.corti-cast[hidden]{display:none}.corti-cast[data-phase="succeeded"]{border-color:#c8e7bb}.corti-cast[data-phase="failed"]{border-color:#edaaaf}.corti-cast-sigil{display:grid;place-items:center;flex:none;width:66px;height:66px;border:2px solid #d7b9f0;border-radius:50%;box-shadow:0 0 17px #bf8ff688,inset 0 0 15px #bf8ff644;color:#f4d9ff;font-size:29px;text-shadow:0 0 11px #cba6fa;animation:corti-cast-orbit 8s linear infinite}.corti-cast[data-phase="succeeded"] .corti-cast-sigil{border-color:#c4ebc5;box-shadow:0 0 23px #8fe9ad99}.corti-cast[data-phase="failed"] .corti-cast-sigil{border-color:#e5adb1;box-shadow:0 0 17px #f0879088}.corti-cast-copy{display:flex;flex-direction:column;min-width:0;gap:2px}.corti-cast-copy small{font:700 14px/1.3 system-ui;letter-spacing:.14em;color:#e8d2ff}.corti-cast-copy strong{font:800 32px/1.2 system-ui;letter-spacing:.1em;text-shadow:0 0 13px #c9a8e299}.corti-cast-copy span{font:13px/1.4 system-ui;color:#e6e1f0}.corti-cast-line{position:absolute;bottom:0;left:0;width:100%;height:4px;background:linear-gradient(90deg,#b998ed,#f5d4ff,#a5d8ed);transform-origin:left;animation:corti-cast-line 5s linear both}.corti-cast[data-phase="succeeded"] .corti-cast-line{background:#b9ecc0;animation-duration:4s}.corti-cast[data-phase="failed"] .corti-cast-line{background:#e7afb4;animation-duration:4s}@keyframes corti-cast-enter{from{opacity:0;transform:translate(-50%,-12px) scale(.96)}to{opacity:1;transform:translate(-50%,0) scale(1)}}@keyframes corti-cast-orbit{to{transform:rotate(360deg)}}@keyframes corti-cast-line{from{transform:scaleX(1)}to{transform:scaleX(0)}}@media(max-width:720px){.corti-cast{top:12%;width:min(310px,calc(100vw - 20px));min-height:82px;padding:10px 14px;gap:11px}.corti-cast-sigil{width:48px;height:48px;font-size:22px}.corti-cast-copy strong{font-size:24px}}@media(prefers-reduced-motion:reduce){.corti-cast,.corti-cast-sigil,.corti-cast-line{animation:none}}`;
var NOTICE_CSS = `.corti-event-feed{position:fixed;z-index:7;left:14px;bottom:56px;width:min(385px,40vw);display:flex;flex-direction:column;align-items:flex-start;gap:5px;pointer-events:none}.corti-event{max-width:100%;box-sizing:border-box;padding:6px 10px;border-left:3px solid #a5d4e0;border-radius:4px;background:#10242bdc;box-shadow:0 2px 10px #0008;color:#f4f6f3;font:13px/1.45 system-ui;overflow-wrap:anywhere;text-shadow:1px 1px #000b}.corti-event small{margin-right:7px;color:#a9dce7;font-weight:700}.corti-event[data-kind="whisper"]{border-color:#b9a1e8}.corti-event[data-kind="whisper"] small{color:#dcc8ff}.corti-event[data-kind="advancement"]{border-color:#eacb79}.corti-event[data-kind="advancement"] small{color:#f9dfa0}.corti-event[data-kind="death"]{border-color:#e59191}.corti-game-title{position:fixed;z-index:8;top:33%;left:50%;width:min(700px,90vw);transform:translateX(-50%);text-align:center;color:#fff5e9;font:800 clamp(28px,5vw,53px)/1.25 system-ui;text-shadow:0 3px 12px #000,0 0 22px #b8a2ed;pointer-events:none;animation:corti-title-in var(--corti-title-fade-in,.28s) ease-out}.corti-game-title[hidden]{display:none}.corti-game-title[data-kind="death"]{color:#f4a9a9;text-shadow:0 3px 12px #000,0 0 24px #eb6464}body.corti-took-damage:after{content:"";position:fixed;inset:0;z-index:6;pointer-events:none;background:radial-gradient(ellipse at center,transparent 35%,#a92121a0 100%);animation:corti-damage .65s ease-out both}@keyframes corti-title-in{from{opacity:0;transform:translate(-50%,-8px)}to{opacity:1;transform:translate(-50%,0)}}@keyframes corti-damage{from{opacity:.8}to{opacity:0}}@media(max-width:720px){.corti-event-feed{width:min(260px,60vw);bottom:54px}.corti-event{font-size:11px;padding:4px 7px}}@media(prefers-reduced-motion:reduce){.corti-game-title,body.corti-took-damage:after{animation:none}}`;
var EXTRA_FEEDBACK_CSS = `.corti-boss-bars{position:fixed;z-index:7;top:12px;left:50%;transform:translateX(-50%);width:min(360px,36vw);min-width:200px;display:grid;gap:5px;pointer-events:none}.corti-boss-bar{padding:2px 5px 4px;border:1px solid #30243fbd;border-radius:5px;background:#100f22bd;box-shadow:0 2px 8px #0008}.corti-boss-title{display:block;margin-bottom:2px;color:#fff7fa;text-align:center;font:700 12px/1.2 system-ui;text-shadow:1px 1px #000}.corti-boss-track{height:10px;border:1px solid #15101e;border-radius:2px;background:#271e2d;overflow:hidden}.corti-boss-fill{height:100%;background:linear-gradient(#cf8adf,#8d4aa0)}.corti-boss-bar[data-color="pink"] .corti-boss-fill{background:linear-gradient(#f5a5ce,#d76da8)}.corti-boss-bar[data-color="blue"] .corti-boss-fill{background:linear-gradient(#89b7ef,#4e81cb)}.corti-boss-bar[data-color="red"] .corti-boss-fill{background:linear-gradient(#e99496,#b44750)}.corti-boss-bar[data-color="green"] .corti-boss-fill{background:linear-gradient(#a5d893,#5fa45c)}.corti-boss-bar[data-color="yellow"] .corti-boss-fill{background:linear-gradient(#f5df8c,#d6ae47)}.corti-boss-bar[data-color="white"] .corti-boss-fill{background:linear-gradient(#f7f7f5,#bfc8cf)}.corti-game-title strong{display:block;font:inherit}.corti-game-title span{display:block;margin-top:8px;font:600 clamp(16px,2vw,23px)/1.3 system-ui}.corti-actionbar{position:fixed;z-index:7;left:50%;bottom:106px;max-width:min(680px,90vw);transform:translateX(-50%);padding:5px 12px;border-radius:5px;background:#101923ca;color:#fff7dc;text-align:center;font:700 17px/1.3 system-ui;text-shadow:1px 1px #000;pointer-events:none}.corti-actionbar[hidden]{display:none}@media(max-width:720px){.corti-boss-bars{top:8px;min-width:150px}.corti-boss-title{font-size:10px}.corti-actionbar{bottom:101px;font-size:13px}}`;
var ENCHANT_GLOW_CSS = `
.corti-enchanted img{filter:drop-shadow(0 0 2px #b17bff) drop-shadow(0 0 5px #a263e099)}
.corti-enchant-glint{opacity:.85;background-image:url('/textures/1.20.6/misc/enchanted_glint_item.png'),linear-gradient(110deg,#7442bd88 15%,#e4c7ffdd 48%,#8e56d4a8 72%);background-size:64px 64px,230% 100%;background-blend-mode:screen;animation:corti-enchant-pattern 2.8s linear infinite}
@keyframes corti-enchant-pattern{from{background-position:0 0,100% 0}to{background-position:128px -128px,-120% 0}}
@media(prefers-reduced-motion:reduce){.corti-enchant-glint{animation:none}}
`;
var VIEWER_LAYOUT_CSS = `
.corti-view-switch{position:fixed;z-index:9;top:14px;right:14px;display:flex;gap:2px;padding:3px;border:1px solid #b0ccb5a8;border-radius:8px;background:#11242cde;box-shadow:0 4px 20px #0007;opacity:.72;transition:opacity .2s ease}.corti-view-switch:hover,.corti-view-switch:focus-within{opacity:1}.corti-view-switch a{padding:4px 7px;border-radius:5px;color:#dce8e5;font:12px/1.2 system-ui;text-decoration:none;white-space:nowrap}.corti-view-switch a:hover,.corti-view-switch a:focus-visible{background:#ffffff25;outline:none}body[data-view-mode="first"] .corti-view-switch a[data-view="first"],body[data-view-mode="third"] .corti-view-switch a[data-view="third"],body[data-view-mode="dungeon"] .corti-view-switch a[data-view="dungeon"]{background:#8acbb34d;color:#f5fff6;font-weight:700}body[data-view-mode="third"] .corti-crosshair,body[data-view-mode="dungeon"] .corti-crosshair{display:none}.corti-skills{top:56px}
.boot.is-compact:not(.is-error){display:none}
.corti-event-feed{bottom:112px;max-height:min(26vh,170px);overflow:hidden;justify-content:flex-end}
.corti-event{flex:none;max-height:4.4em;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3}
.corti-boss-bars{max-height:min(18vh,110px);overflow:hidden}
.corti-game-title{top:35%;max-height:31vh;overflow:hidden;overflow-wrap:anywhere}
.corti-game-title strong,.corti-game-title span{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.corti-cast:not([hidden]) ~ .corti-game-title,.skill-cue:not([hidden]) ~ .corti-game-title{top:calc(16% + 130px)}
.skill-cue{position:fixed;z-index:8;top:21%;left:50%;width:min(360px,calc(100vw - 32px));box-sizing:border-box;transform:translateX(-50%);display:grid;gap:3px;padding:10px 16px;text-align:center;color:#f8eeff;background:#1b1535ed;border:1px solid #c2a0f1;border-radius:10px;box-shadow:0 8px 28px #000b,0 0 18px #a273df66;pointer-events:none}
.skill-cue[hidden],.corti-cast:not([hidden]) + .skill-cue{display:none}
.skill-cue small{color:#d7bbf5;font:700 12px/1.2 system-ui;letter-spacing:.08em}
.skill-cue strong{font:800 22px/1.2 system-ui;overflow-wrap:anywhere}
.skill-cue span{font:12px/1.35 system-ui;overflow-wrap:anywhere}
.corti-actionbar{bottom:112px;box-sizing:border-box;max-width:min(640px,calc(100vw - 32px));max-height:4.4em;overflow:hidden;overflow-wrap:anywhere}
@media(max-width:720px){.corti-event-feed{width:min(260px,42vw);bottom:120px}.corti-game-title{top:34%;font-size:clamp(25px,6vw,40px)}.corti-cast:not([hidden]) ~ .corti-game-title,.skill-cue:not([hidden]) ~ .corti-game-title{top:calc(12% + 95px)}.corti-actionbar{bottom:108px;width:max-content;max-width:calc(100vw - 24px)}.skill-cue{top:20%}}
@media(max-width:800px){.corti-view-switch{top:58px;right:8px}.corti-skills{top:100px}}
@media(max-height:560px){.corti-event-feed{max-height:22vh}.corti-cast{top:10%;min-height:82px;padding:10px 16px}.corti-cast:not([hidden]) ~ .corti-game-title,.skill-cue:not([hidden]) ~ .corti-game-title{top:calc(10% + 100px)}.corti-game-title{font-size:clamp(26px,4vw,42px)}.corti-game-title span{font-size:16px}.corti-actionbar{font-size:14px}}
`;
var SPEECH_BUBBLE_CSS = `.corti-speech-bubble{position:fixed;z-index:7;left:50%;bottom:150px;width:min(720px,72vw);height:178px;transform:translateX(-50%);border:0;background:transparent;pointer-events:none}@media(max-width:720px){.corti-speech-bubble{bottom:140px;width:calc(100vw - 20px);height:152px}}`;
async function requiredAssetsPresent(root, version) {
  const source = JSON.parse(await readFile4(path4.join(root, "public", "asset-source.json"), "utf8"));
  const client = JSON.parse(await readFile4(path4.join(root, "viewer-client.json"), "utf8"));
  if (source.minecraftVersion !== version || client.minecraftVersion !== version || !source.clientJarSha256 || client.clientJarSha256 !== source.clientJarSha256) return false;
  for (const relative of [
    "dist/modern-viewer.js",
    "public/mesher.js",
    "public/mesherWasm.js",
    "public/threeWorker.js",
    `public/blocksStates/${version}.json`,
    `public/textures/${version}.png`,
    "render-assets/blockStatesModels.json",
    "render-assets/blocksAtlases.json",
    "render-assets/itemsAtlases.json",
    "render-assets/painting-records.json"
  ]) {
    if (!(await stat4(path4.join(root, relative)).catch(() => null))?.isFile()) return false;
  }
  const browserHash = createHash3("sha256").update(await readFile4(path4.join(root, "dist", "modern-viewer.js"))).digest("hex");
  if (browserHash !== client.browserBundleSha256) return false;
  if (client.mesherSha256 && createHash3("sha256").update(await readFile4(path4.join(root, "public", "mesher.js"))).digest("hex") !== client.mesherSha256) return false;
  return true;
}
function ownEntity(bot) {
  const entity = bot.entity;
  const inventory = bot.inventory;
  const slots = inventory?.slots ?? [];
  const selected = Math.max(0, Math.min(8, Number(bot.quickBarSlot) || 0));
  const hotbarStart = Number.isInteger(inventory?.hotbarStart) ? inventory.hotbarStart : 36;
  const equipped = entity.equipment ?? [];
  const equipment = [
    slots[hotbarStart + selected],
    slots[45],
    equipped[2],
    equipped[3],
    equipped[4],
    equipped[5]
  ].map(viewerItem);
  return {
    id: entity.id,
    name: "player",
    type: "player",
    pos: entity.position,
    width: entity.width,
    height: entity.height,
    yaw: entity.yaw,
    pitch: entity.pitch,
    username: bot.username,
    uuid: entity.uuid,
    isSelf: true,
    equipment,
    skinUrl: null,
    skinModel: null,
    ...viewerPlayerSkin(bot, bot.username, entity.uuid),
    burning: Boolean(entity.isOnFire) || (Number(entity.metadata?.[0]) & 1) !== 0
  };
}
var VILLAGER_TYPES = ["desert", "jungle", "plains", "savanna", "snow", "swamp", "taiga"];
var VILLAGER_PROFESSIONS = ["none", "armorer", "butcher", "cartographer", "cleric", "farmer", "fisherman", "fletcher", "leatherworker", "librarian", "mason", "nitwit", "shepherd", "toolsmith", "weaponsmith"];
var VILLAGER_LEVELS = ["none", "stone", "iron", "gold", "emerald", "diamond"];
function villagerAppearance(value) {
  const visited = /* @__PURE__ */ new WeakSet();
  const find = (entry, depth) => {
    if (!entry || typeof entry !== "object" || depth > 5 || ArrayBuffer.isView(entry) || visited.has(entry)) return null;
    visited.add(entry);
    if (Array.isArray(entry)) {
      for (const child of entry.slice(0, 64)) {
        const found = find(child, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const data2 = entry;
    const keys = Object.fromEntries(Object.entries(data2).map(([key, item]) => [key.replaceAll("_", "").toLowerCase(), item]));
    if ("villagertype" in keys && "villagerprofession" in keys && "level" in keys) return keys;
    for (const child of Object.values(data2).slice(0, 48)) {
      const found = find(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const data = find(value, 0);
  if (!data) return null;
  const bounded2 = (item, min, max, fallback) => {
    const n = Number(item);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };
  const typeId = bounded2(data.villagertype, 0, 6, 2);
  const professionId = bounded2(data.villagerprofession, 0, 14, 0);
  const levelId = bounded2(data.level, 1, 5, 1);
  return {
    typeId,
    typeKey: VILLAGER_TYPES[typeId],
    professionId,
    professionKey: VILLAGER_PROFESSIONS[professionId],
    levelId,
    levelKey: VILLAGER_LEVELS[levelId]
  };
}
function recordFishingBobberOwner(owners, packet, bobberTypeId) {
  const id = packet.entityId;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return;
  owners.delete(id);
  const owner = packet.objectData;
  if (typeof bobberTypeId === "number" && Number.isSafeInteger(bobberTypeId) && packet.type === bobberTypeId && typeof owner === "number" && Number.isSafeInteger(owner) && owner > 0 && owner !== id) owners.set(id, owner);
}
function viewerEntity(bot, entity, fishingBobberOwners) {
  const record3 = entity;
  const registry = bot.registry?.entitiesByName;
  const appearance = villagerAppearance(record3.metadata);
  const rawName = typeof record3.name === "string" ? record3.name.replace(/^minecraft:/, "").toLowerCase() : "";
  const name2 = rawName && rawName !== "unknown" ? rawName : appearance ? "villager" : typeof record3.type === "string" && record3.type !== "mob" ? record3.type.toLowerCase() : "unknown";
  const dimensions = registry?.[name2];
  const ownerEntityId = name2 === "fishing_bobber" ? fishingBobberOwners?.get(entity.id) : void 0;
  return {
    id: entity.id,
    name: name2,
    type: record3.type,
    pos: entity.position,
    position: entity.position,
    width: entity.width || dimensions?.width || 0.6,
    height: entity.height || dimensions?.height || 1.8,
    yaw: entity.yaw,
    pitch: entity.pitch,
    headYaw: record3.headYaw,
    velocity: entity.velocity ? { x: entity.velocity.x, y: entity.velocity.y, z: entity.velocity.z } : void 0,
    username: entity.username,
    uuid: entity.uuid,
    age: record3.age,
    ...name2 === "player" ? { skinUrl: null, skinModel: null, ...viewerPlayerSkin(bot, entity.username, entity.uuid) } : {},
    metadata: viewerRenderableMetadata(record3.metadata),
    burning: record3.isOnFire === true || (Number(record3.metadata?.[0]) & 1) !== 0,
    equipment: Array.isArray(record3.equipment) ? record3.equipment.slice(0, 6).map(viewerItem) : void 0,
    ...ownerEntityId !== void 0 ? { ownerEntityId } : {},
    ...name2 === "villager" && appearance ? { villagerAppearance: appearance } : {},
    ...name2 === "sheep" ? { sheepAppearance: viewerSheepAppearance(
      record3.metadata,
      registry?.sheep?.metadataKeys
    ) } : {}
  };
}
function chunkWorldConfig(bot, x, z) {
  const world = bot.world;
  let column;
  try {
    column = world.getColumn?.(x / 16, z / 16);
  } catch {
  }
  const game = bot.game;
  const overworld = !game?.dimension || game.dimension === "minecraft:overworld" || game.dimension === "overworld";
  const minY = Number.isInteger(column?.minY) ? column.minY : Number.isInteger(game?.minY) ? game.minY : overworld ? -64 : 0;
  const worldHeight = Number.isInteger(column?.worldHeight) && column.worldHeight > 0 ? column.worldHeight : Number.isInteger(game?.height) && game.height > 0 ? game.height : overworld ? 384 : 256;
  return { minY, worldHeight };
}
function diggingShape(block) {
  const shapes = Array.isArray(block.shapes) ? block.shapes.filter((shape) => Array.isArray(shape) && shape.length === 6 && shape.every(Number.isFinite)) : [];
  if (!shapes.length) return { position: { x: 0.5, y: 0.5, z: 0.5 }, width: 1, height: 1, depth: 1 };
  const min = [0, 1, 2].map((axis) => Math.min(...shapes.map((shape) => shape[axis])));
  const max = [3, 4, 5].map((axis) => Math.max(...shapes.map((shape) => shape[axis])));
  return { position: {
    x: (min[0] + max[0]) / 2,
    y: (min[1] + max[1]) / 2,
    z: (min[2] + max[2]) / 2
  }, width: max[0] - min[0], height: max[1] - min[1], depth: max[2] - min[2] };
}
function entityAttribute(entity, suffix) {
  const attrs = entity.attributes;
  const match = Object.entries(attrs ?? {}).find(([name2]) => name2 === suffix || name2.endsWith(`.${suffix}`));
  if (!match || !Number.isFinite(match[1].value)) return null;
  const base = match[1].value;
  const modifiers = match[1].modifiers ?? [];
  let value = base;
  for (const modifier of modifiers) if (modifier.operation === 0) value += Number(modifier.amount) || 0;
  for (const modifier of modifiers) if (modifier.operation === 1) value += base * (Number(modifier.amount) || 0);
  for (const modifier of modifiers) if (modifier.operation === 2) value *= 1 + (Number(modifier.amount) || 0);
  return value;
}
function equipmentArmor(equipment) {
  const points = {
    leather: [1, 2, 3, 1],
    golden: [1, 3, 5, 2],
    chainmail: [1, 4, 5, 2],
    iron: [2, 5, 6, 2],
    diamond: [3, 6, 8, 3],
    netherite: [3, 6, 8, 3]
  };
  return equipment.slice(2, 6).reduce((total, item, slot) => {
    const name2 = item?.name ?? "";
    if (name2 === "turtle_helmet") return total + 2;
    const material = Object.keys(points).find((prefix) => name2.startsWith(`${prefix}_`));
    return total + (material ? points[material][slot] : 0);
  }, 0);
}
function avatarState(bot, sequence, shieldRaised = false) {
  const entity = bot.entity;
  const velocity = entity.velocity;
  const speed = Math.hypot(Number(velocity?.x) || 0, Number(velocity?.z) || 0);
  const inventory = bot.inventory ?? {};
  const slots = inventory.slots ?? [];
  const start = Number.isInteger(inventory.hotbarStart) ? inventory.hotbarStart : 36;
  const selected = Math.max(0, Math.min(8, Number(bot.quickBarSlot) || 0));
  const equipment = Array.isArray(entity.equipment) ? entity.equipment : [];
  const experience = bot.experience;
  const playerMetadataKeys = bot.registry?.entitiesByName?.player?.metadataKeys;
  const rawHealth = Number(bot.health);
  const rawFood = Number(bot.food);
  const oxygen = Number(bot.oxygenLevel);
  const sprinting = bot.controlState?.sprint === true;
  const sneaking = bot.controlState?.sneak === true;
  const feet = bot.entity.position;
  const surface = bot.blockAt(new Vec33(Math.floor(feet.x), Math.floor(feet.y - 0.05), Math.floor(feet.z)));
  const foodRegistry = bot.registry.foodsByName;
  const held = bot.heldItem;
  return {
    seq: sequence,
    sequence,
    capturedAt: Date.now(),
    entity: ownEntity(bot),
    movementState: viewerMovementState(speed, sprinting, sneaking),
    horizontalSpeed: speed,
    verticalSpeed: Number(velocity?.y) || 0,
    velocity: { x: Number(velocity?.x) || 0, y: Number(velocity?.y) || 0, z: Number(velocity?.z) || 0 },
    onGround: entity.onGround === true,
    inWater: entity.isInWater === true,
    shieldRaised,
    burning: entity.isOnFire === true || (Number(entity.metadata?.[0]) & 1) !== 0,
    usingHeldItem: bot.usingHeldItem === true || (Number(entity.metadata?.[8]) & 1) !== 0,
    usingOffhand: (Number(entity.metadata?.[8]) & 2) !== 0,
    heldItemEdible: !!(held?.name && foodRegistry?.[held.name.replace(/^minecraft:/, "")]) || (held?.components?.some((component) => component.type?.replace(/^minecraft:/, "") === "food") ?? false),
    surfaceBlock: surface ? { name: surface.name, stateId: surface.stateId } : null,
    inLava: entity.isInLava === true,
    sprinting,
    sneaking,
    quickBarSlot: selected,
    health: Number.isFinite(rawHealth) ? rawHealth : null,
    maxHealth: Math.max(1, entityAttribute(entity, "max_health") ?? 20, Number.isFinite(rawHealth) ? rawHealth : 0),
    absorption: viewerPlayerAbsorption(entity.metadata, playerMetadataKeys),
    food: Number.isFinite(rawFood) ? rawFood : null,
    armor: Math.max(0, Math.min(20, entityAttribute(entity, "armor") ?? equipmentArmor(equipment))),
    oxygen: Number.isFinite(oxygen) ? Math.max(0, Math.min(20, oxygen)) : null,
    experienceLevel: Number.isFinite(experience?.level) ? experience.level : null,
    experienceProgress: Number.isFinite(experience?.progress) ? experience.progress : null,
    offhand: viewerItem(slots[45]),
    equipment: equipment.slice(0, 6).map(viewerItem),
    hotbar: Array.from({ length: 9 }, (_, index) => ({
      index,
      slot: start + index,
      selected: index === selected,
      item: viewerItem(slots[start + index])
    })),
    inventory: slots.slice(0, 64).map(viewerItem)
  };
}
function observeViewerInventoryPreview(bot, publish) {
  let open = false;
  const release = () => {
    if (!open) return;
    open = false;
    publish({ open: false, ttlMs: 2400, source: "idle" });
  };
  const preview = (event) => {
    if (!event || typeof event !== "object" || !("open" in event) || typeof event.open !== "boolean") return;
    if (!event.open || bot.currentWindow) {
      release();
      return;
    }
    open = true;
    publish({ open: true, ttlMs: 2400, source: "idle" });
  };
  bot.on("viewer_inventory_preview", preview);
  for (const event of ["windowOpen", "end", "death", "respawn"]) bot.on(event, release);
  return () => {
    release();
    bot.off("viewer_inventory_preview", preview);
    for (const event of ["windowOpen", "end", "death", "respawn"]) bot.off(event, release);
  };
}
async function startModernViewer(bot, options) {
  const MAX_SESSIONS = options.maxSessions ?? 8;
  if (!Number.isInteger(MAX_SESSIONS) || MAX_SESSIONS < 1 || MAX_SESSIONS > 16) {
    throw new Error("modern viewer: maxSessions must be an integer from 1 to 16");
  }
  observeStatusEffects(bot);
  const root = path4.resolve(options.assetsDir);
  if (!await requiredAssetsPresent(root, bot.version)) throw new Error(`modern viewer: ${bot.version} \u8D44\u6E90\u4E0D\u5B8C\u6574 ${root}`);
  const soundRegistry = await loadViewerSoundRegistry(
    root,
    bot.version,
    bot.registry
  );
  if (soundRegistry.diagnostic) console.warn(`modern viewer: ${soundRegistry.diagnostic}`);
  const speakerScript = "";
  const speechRelay = { handle: async () => false, close() {
  } };
  const origin = `http://127.0.0.1:${options.port}`;
  const sessions = /* @__PURE__ */ new Set();
  const sessionSlots = new ViewerSessionSlots(MAX_SESSIONS, MAX_CAPTURE_SESSIONS);
  const selfSkin = await loadViewerSelfSkin(options.selfSkinPath, options.selfSkinModel ?? "slim");
  const presentOwnEntity = () => ({ ...ownEntity(bot), ...selfSkin?.entity ?? {} });
  const content = createViewerContentBridge(bot);
  const appearance = createViewerAppearanceBridge(bot);
  const observer = options.observerState === true ? createViewerObserverBridge(bot) : null;
  const agentVisuals = createViewerAgentBridge(bot, {
    getViewerSession: () => observer?.snapshot()?.viewerSession ?? null
  });
  const disposeContent = () => {
    agentVisuals.dispose();
    observer?.dispose();
    appearance.dispose();
    content.dispose();
  };
  const viewerSockets = /* @__PURE__ */ new Set();
  let latestRoute = { points: [], goal: viewerGoal(bot.pathfinder?.goal), status: "pending" };
  const publishRoute = (route) => {
    latestRoute = route;
    for (const socket of viewerSockets) if (socket.connected) socket.emit("tacticalRoute", route);
  };
  const onPathUpdate = (result) => publishRoute(viewerRoute(result, bot.entity?.position, bot.pathfinder?.goal));
  const onGoalUpdated = (goal) => publishRoute({ points: [], goal: viewerGoal(goal), status: "pending" });
  const onGoalReached = () => publishRoute({ points: [], goal: null, status: "done" });
  let latestSkills = null;
  let agentManaSeen = false;
  let agentStateSeen = false;
  const initialSkills = options.getInitialSkillsPacket?.() ?? options.initialSkillsPacket;
  if (initialSkills?.channel === VIEWER_STATE_CHANNEL && Number.isFinite(initialSkills.observedAt) && initialSkills.observedAt > 0 && initialSkills.observedAt <= Date.now() + 3e4) {
    const parsed = parseSkillsPayload(initialSkills.channel, initialSkills.data);
    if (parsed) {
      latestSkills = {
        ...mergeViewerSkillState(null, parsed, initialSkills.channel, false),
        observedAt: initialSkills.observedAt,
        stale: true,
        // A login snapshot cannot prove present cooldown readiness.
        abilities: parsed.abilities.map((ability) => ({ ...ability, cooldownRemainingMs: null }))
      };
      agentManaSeen = true;
      agentStateSeen = true;
    }
  }
  let castSequence = 0;
  let pendingCasts = [];
  let recentChatSuccess = null;
  let recentCastCue = null;
  const publishCast = (cue) => {
    recentCastCue = { cue, atMs: Date.now() };
    for (const socket of viewerSockets) if (socket.connected) socket.emit("castCue", cue);
  };
  const onCastCommand = (text) => {
    const spell = viewerCastCommand(text);
    if (!spell) return;
    const cast = { seq: ++castSequence, spell, sentAtMs: Date.now() };
    pendingCasts = pendingCasts.filter((entry) => cast.sentAtMs - entry.sentAtMs <= 7e3).slice(-7);
    pendingCasts.push(cast);
    publishCast({ seq: cast.seq, phase: "sent", spellId: spell.id, spellName: spell.name });
  };
  const onCastMessage = (message, position2) => {
    if (position2 !== "chat" && position2 !== "system") return;
    const now = Date.now();
    pendingCasts = pendingCasts.filter((entry) => now - entry.sentAtMs <= 7e3);
    const text = message.toString();
    const candidates = pendingCasts.filter((entry) => text.includes(entry.spell.name) || text.includes(entry.spell.id));
    const match = [...candidates, ...pendingCasts.filter((entry) => !candidates.includes(entry))].map((cast2) => ({ cast: cast2, result: viewerCastResult(text, cast2.spell.id) })).find((entry) => entry.result);
    if (!match?.result) return;
    const { cast, result } = match;
    publishCast({ seq: cast.seq, spellId: cast.spell.id, spellName: cast.spell.name, ...result });
    if (result.phase === "succeeded") recentChatSuccess = { seq: cast.seq, id: cast.spell.id, atMs: now };
    pendingCasts = pendingCasts.filter((entry) => entry !== cast);
  };
  const publishGameMessage = (kind, value) => {
    const text = minecraftTextComponent(value).slice(0, 160);
    if (!text) return;
    for (const socket of viewerSockets) if (socket.connected) socket.emit("gameMessage", { kind, text });
  };
  const recordManaText = (text) => {
    if (agentManaSeen || latestSkills?.source === "plugin" && latestSkills.mana !== null && Date.now() - (latestSkills.observedAt ?? 0) < 3e5) return;
    const mana = manaSnapshotFromText(text);
    if (!mana) return;
    latestSkills = {
      ...latestSkills ?? { schemaVersion: 1, skills: [], abilities: [] },
      mana,
      source: latestSkills?.source ?? "chat",
      observedAt: Date.now()
    };
    for (const socket of viewerSockets) if (socket.connected) socket.emit("skillsState", latestSkills);
  };
  const recordSpellCatalogueText = (text) => {
    const abilities = spellCatalogueFromText(text);
    if (!abilities) return;
    latestSkills = mergeViewerSpellCatalogue(latestSkills, abilities, agentStateSeen);
    for (const socket of viewerSockets) if (socket.connected) socket.emit("skillsState", latestSkills);
  };
  const onViewerMessage = (message, position2) => {
    const kind = viewerMessageKind(message, position2);
    if (kind) publishGameMessage(kind, message);
    if (position2 === "chat" || position2 === "system") {
      const text = message.toString();
      recordManaText(text);
      recordSpellCatalogueText(text);
    }
  };
  const onViewerTitle = (value, type) => publishGameMessage(type === "subtitle" ? "subtitle" : "title", value);
  const onViewerTitleTimes = (fadeIn, stay, fadeOut) => {
    const ticks = [fadeIn, stay, fadeOut];
    if (!ticks.every((value) => Number.isInteger(value) && value >= 0 && value <= 1200)) return;
    for (const socket of viewerSockets) if (socket.connected) socket.emit("gameTitleTiming", { fadeIn, stay, fadeOut });
  };
  const onViewerTitleClear = () => {
    for (const socket of viewerSockets) if (socket.connected) socket.emit("gameTitleClear");
  };
  const onViewerActionBar = (value) => {
    publishGameMessage("actionbar", value);
    recordManaText(minecraftTextComponent(value));
  };
  const onViewerDeath = () => {
    publishGameMessage("death", "\u89D2\u8272\u9635\u4EA1");
    latestSkills = {
      ...latestSkills ?? { schemaVersion: 1, skills: [], abilities: [] },
      mana: null,
      abilities: [],
      observedAt: Date.now()
    };
    for (const socket of viewerSockets) if (socket.connected) socket.emit("skillsState", latestSkills);
  };
  let cachedMinimap = null;
  let cachedMinimapAtMs = 0;
  const protocol = bot._client;
  const fishingBobberOwners = /* @__PURE__ */ new Map();
  const onSpawnEntity = (packet) => {
    const bobberTypeId = bot.registry?.entitiesByName?.fishing_bobber?.internalId;
    recordFishingBobberOwner(fishingBobberOwners, packet, bobberTypeId);
  };
  const forgetFishingBobberOwner = (entity) => {
    if (Number.isSafeInteger(entity?.id)) fishingBobberOwners.delete(entity.id);
  };
  const advancements = new ViewerAdvancementTracker();
  const observedPackets = /* @__PURE__ */ new Map();
  const observedChannels = /* @__PURE__ */ new Map();
  const onPacketObserved = (_packet, meta) => {
    if (typeof meta?.name !== "string" || !/^[a-z_]{1,64}$/.test(meta.name)) return;
    observedPackets.set(meta.name, (observedPackets.get(meta.name) ?? 0) + 1);
  };
  const publishPresentation = (event) => {
    for (const socket of viewerSockets) if (socket.connected) socket.emit("presentationEvent", event);
  };
  let particleWindowAt = 0;
  let particleCount = 0;
  const onParticle = (packet) => {
    if (closed || !viewerSockets.size) return;
    const now = Date.now();
    if (now - particleWindowAt >= 1e3) {
      particleWindowAt = now;
      particleCount = 0;
    }
    if (++particleCount > 96) return;
    const event = viewerParticle(packet);
    if (event) publishPresentation(event);
  };
  const onExplosion = (packet) => {
    const event = viewerExplosion(packet);
    if (event) publishPresentation(event);
  };
  const onWorldEvent = (packet) => {
    const event = viewerWorldEvent(packet, bot.registry);
    if (event) publishPresentation(event);
  };
  const onCollect = (packet) => {
    if (!Number.isInteger(packet.collectedEntityId) || !Number.isInteger(packet.collectorEntityId)) return;
    const from = Object.values(bot.entities).find((entity) => entity.id === packet.collectedEntityId);
    const to = packet.collectorEntityId === bot.entity?.id ? bot.entity : Object.values(bot.entities).find((entity) => entity.id === packet.collectorEntityId);
    if (!from?.position || !to?.position) return;
    const item = viewerDroppedItem(from, viewerItem);
    publishPresentation({
      kind: "pickup",
      position: { x: from.position.x, y: from.position.y, z: from.position.z },
      to: { x: to.position.x, y: to.position.y + 1, z: to.position.z },
      self: packet.collectorEntityId === bot.entity?.id,
      collectedEntityId: packet.collectedEntityId,
      collectorEntityId: packet.collectorEntityId,
      entityName: from.name,
      ...item ? { item } : {},
      count: Math.max(1, Math.min(64, packet.pickupItemCount || 1))
    });
  };
  const effectDetails = (id) => {
    const registry = bot.registry;
    const effect = registry.effects?.[id];
    const name2 = String(effect?.name || `effect_${id}`).replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    return {
      name: /^[a-z0-9_]+$/.test(name2) ? name2 : `effect_${id}`,
      title: String(effect?.displayName || effect?.name || `\u6548\u679C ${id}`).slice(0, 60),
      type: effect?.type === "bad" ? "bad" : "good"
    };
  };
  const onEntityEffect = (packet) => {
    if (!Number.isInteger(packet.entityId) || !Number.isInteger(packet.effectId)) return;
    const self = packet.entityId === bot.entity?.id;
    const target = self ? bot.entity : Object.values(bot.entities).find((entity) => entity.id === packet.entityId);
    if (!self && !target?.position) return;
    publishPresentation({
      kind: "effect",
      id: packet.effectId,
      self,
      active: true,
      ...effectDetails(packet.effectId),
      amplifier: Math.max(0, Math.min(255, packet.amplifier || 0)),
      durationTicks: Math.max(0, Math.min(72e3, packet.duration || 0)),
      position: target?.position ? {
        x: target.position.x,
        y: target.position.y + 1,
        z: target.position.z
      } : void 0
    });
  };
  const onRemoveEntityEffect = (packet) => {
    if (packet.entityId === bot.entity?.id && Number.isInteger(packet.effectId))
      publishPresentation({
        kind: "effect",
        id: packet.effectId,
        active: false,
        ...effectDetails(packet.effectId)
      });
  };
  const onCooldown = (packet) => {
    if (!Number.isInteger(packet.itemID) || !Number.isInteger(packet.cooldownTicks)) return;
    publishPresentation({
      kind: "cooldown",
      itemId: packet.itemID,
      durationTicks: Math.max(0, Math.min(1200, packet.cooldownTicks))
    });
  };
  const onAdvancements = (packet) => {
    for (const notice of advancements.ingest(packet, minecraftTextComponent))
      publishPresentation({
        kind: "achievement",
        id: notice.key,
        title: notice.title,
        body: notice.description,
        tone: notice.frame === "challenge" ? "arcane" : "positive"
      });
  };
  const onSkillPacket = (packet) => {
    if (typeof packet.channel === "string" && /^[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(packet.channel))
      observedChannels.set(packet.channel, (observedChannels.get(packet.channel) ?? 0) + 1);
    const custom = parseViewerCustomEvent(packet.channel, packet.data);
    if (custom) {
      const dimension = String(bot.game.dimension || "minecraft:overworld");
      if (custom.kind === "skill") {
        const now = Date.now();
        pendingCasts = pendingCasts.filter((entry) => now - entry.sentAtMs <= 7e3);
        const id = custom.id.split(":").at(-1);
        const pending = [...pendingCasts].reverse().find((entry) => entry.spell.id === id);
        const seq = pending?.seq ?? (recentChatSuccess?.id === id && now - recentChatSuccess.atMs < 2e3 ? recentChatSuccess.seq : ++castSequence);
        if (pending) pendingCasts = pendingCasts.filter((entry) => entry !== pending);
        publishCast({
          seq,
          phase: "succeeded",
          spellId: custom.id,
          spellName: custom.title,
          detail: custom.body,
          tone: custom.tone,
          position: custom.position,
          dimension,
          source: "server"
        });
      }
      publishPresentation({ ...custom, dimension });
      return;
    }
    const next = parseSkillsPayload(packet.channel, packet.data);
    if (next) {
      latestSkills = mergeViewerSkillState(latestSkills, next, String(packet.channel), agentStateSeen);
      if (packet.channel === VIEWER_STATE_CHANNEL) {
        agentManaSeen = true;
        agentStateSeen = true;
      }
      for (const socket of viewerSockets) if (socket.connected) socket.emit("skillsState", latestSkills);
      return;
    }
    const hit = bot.entity && parseViewerCombatHit(packet.channel, packet.data, bot.entity.id);
    if (hit) {
      for (const socket of viewerSockets) if (socket.connected) socket.emit("combatFeedback", hit);
    }
  };
  const currentMinimap = () => {
    if (!bot.entity) return null;
    const now = Date.now();
    const x = Math.floor(bot.entity.position.x);
    const z = Math.floor(bot.entity.position.z);
    if (!cachedMinimap || now - cachedMinimapAtMs > 1e3 || cachedMinimap.centerX !== x || cachedMinimap.centerZ !== z || cachedMinimap.dimension !== String(bot.game.dimension || "minecraft:overworld")) {
      cachedMinimap = minimapSnapshot(bot);
      cachedMinimapAtMs = now;
    }
    return cachedMinimap;
  };
  let closed = false;
  const headTextures = /* @__PURE__ */ new Map();
  const captureLeases = /* @__PURE__ */ new Map();
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  async function handleRequest(req, res) {
    try {
      const pathname = new URL(req.url ?? "/", origin).pathname;
      if (req.method !== "GET" && !(req.method === "DELETE" && pathname === "/capture-lease") || req.headers.host !== `127.0.0.1:${options.port}`) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (pathname === "/" || pathname === "/third/" || pathname === "/dungeon/") {
        const viewMode = pathname === "/third/" ? "third" : pathname === "/dungeon/" ? "dungeon" : "first";
        const page = await viewerPageHtml(
          root,
          viewMode,
          PAGE,
          "",
          ""
        );
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self' data: blob:; connect-src 'self' data: blob: ws://127.0.0.1:* http://127.0.0.1:*; frame-src 'self' http://127.0.0.1:*; img-src 'self' data: blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-eval'"
        });
        res.end(page.replace(/<iframe\b[^>]*\bid=["']corti-speech-bubble["'][^>]*>[\s\S]*?<\/iframe>/gi, "").replace(/<script\b[^>]*\bsrc=["']\/speech-bubble\.js["'][^>]*>[\s\S]*?<\/script>/gi, ""));
        return;
      }
      if (pathname === "/viewer.css") {
        const legacyCss = CSS + HUD_CSS + ".corti-offhand{position:absolute;left:-45px;top:4px;width:40px;height:36px;background:#505050bb;border:2px solid #a8a8a8;box-sizing:border-box;box-shadow:inset 2px 2px #272727,inset -2px -2px #ddd}" + DURABILITY_CSS + ENCHANT_CSS + ENCHANT_GLOW_CSS + PANELS_CSS + MANA_CSS + ABILITY_CSS + ABILITY_ICON_CSS + CAST_CSS + SKILL_TONE_CSS + NOTICE_CSS + COMBAT_CSS + TACTICS_CSS + EXTRA_FEEDBACK_CSS + VIEWER_LAYOUT_CSS + SPEECH_BUBBLE_CSS + PRESENTATION_CSS + STATUS_VIGNETTE_CSS + THEME_SURFACE_CSS + ABILITY_LAYOUT_CSS;
        const style = await viewerPageCss(root, legacyCss, SPEECH_BUBBLE_CSS);
        res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
        res.end(style);
        return;
      }
      if (pathname === "/speech-bubble.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        res.end(speakerScript);
        return;
      }
      if (await speechRelay.handle(req, res, pathname)) return;
      if (selfSkin && pathname === selfSkin.entity.skinUrl) {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" });
        res.end(selfSkin.bytes);
        return;
      }
      if (pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: !closed, gameOnline: gameOnline(bot), version: bot.version, ...sessionSlots.status() }));
        return;
      }
      if (pathname === "/capture-lease") {
        const key = req.headers["x-mc-viewer-capture-key"];
        const lease = req.headers["x-mc-viewer-capture"] === "1" && typeof key === "string" ? captureLeases.get(key) : void 0;
        if (!lease) {
          res.writeHead(404);
          res.end();
          return;
        }
        if (req.method === "DELETE") lease.release();
        else lease.renew();
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end('{"ok":true}');
        return;
      }
      if (pathname === "/viewer-coverage") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({
          version: bot.version,
          audio: {
            registrySource: soundRegistry.source,
            registryEntries: Object.keys(soundRegistry.registry.sounds ?? {}).length,
            diagnostic: soundRegistry.diagnostic
          },
          channels: [...observedChannels].map(([name2, count]) => ({ name: name2, count })),
          skills: latestSkills ? {
            source: latestSkills.source,
            observedAt: latestSkills.observedAt,
            hasMana: latestSkills.mana !== null,
            skillCount: latestSkills.skills.length,
            abilityCount: latestSkills.abilities.length
          } : null,
          packets: [...observedPackets].map(([name2, count]) => ({
            name: name2,
            count,
            renderLane: viewerPacketLane(name2)
          })).sort((a, b) => b.count - a.count)
        }));
        return;
      }
      const headHash = /^\/head-texture\/([0-9a-f]{40,64})\.png$/.exec(pathname)?.[1];
      if (headHash) {
        let texture = headTextures.get(headHash);
        if (!texture) {
          const source = await fetch(`https://textures.minecraft.net/texture/${headHash}`, {
            redirect: "error",
            signal: AbortSignal.timeout(5e3)
          });
          if (!source.ok || !source.headers.get("content-type")?.startsWith("image/png") || Number(source.headers.get("content-length") ?? 0) > 1048576) {
            res.writeHead(502);
            res.end();
            return;
          }
          texture = Buffer.from(await source.arrayBuffer());
          if (texture.length > 1048576 || !texture.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
            res.writeHead(502);
            res.end();
            return;
          }
          if (headTextures.size >= 128) headTextures.delete(headTextures.keys().next().value);
          headTextures.set(headHash, texture);
        }
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": texture.length,
          "cache-control": "public, max-age=86400",
          "x-content-type-options": "nosniff"
        });
        res.end(texture);
        return;
      }
      const relative = pathname.replace(/^\/(third|dungeon)\//, "/").slice(1);
      const range = typeof req.headers.range === "string" ? req.headers.range : void 0;
      if (relative === "index.js" && await serveViewerAsset(res, root, "dist/modern-viewer.js", "no-store", range)) return;
      if (await serveViewerAsset(res, path4.join(root, "public"), relative, void 0, range)) return;
      if (relative.startsWith("textures/") && await serveViewerAsset(
        res,
        path4.join(root, "public"),
        `textures/${bot.version}/${relative.slice("textures/".length)}`,
        void 0,
        range
      )) return;
      res.writeHead(404);
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }
  const allowRequest = (req, done) => {
    const allowed = req.headers.host === `127.0.0.1:${options.port}` && (req.headers.origin === void 0 || req.headers.origin === origin);
    done(allowed ? null : "forbidden", allowed);
  };
  const first = new SocketServer(server, { path: "/socket.io", serveClient: false, allowRequest });
  const third = new SocketServer(server, { path: "/third/socket.io", serveClient: false, allowRequest });
  let shieldRaised = false;
  let tradeState = null;
  const decodeTradeItem = (raw) => {
    if (!raw || typeof raw !== "object") return null;
    try {
      const item = raw;
      return viewerItem(typeof item.name === "string" ? raw : TradeItem.fromNotch(raw));
    } catch {
      return null;
    }
  };
  const onWindowOpened = () => {
    tradeState = null;
  };
  const onTradeList = (packet) => {
    tradeState = viewerTradeList(packet, decodeTradeItem);
  };
  function accept(socket, view) {
    const capture = socket.handshake.headers["x-mc-viewer-capture"] === "1";
    const releaseSlot = !closed && bot.entity ? sessionSlots.reserve(capture) : null;
    if (!releaseSlot) {
      socket.emit("viewerBusy", { maximum: capture ? MAX_CAPTURE_SESSIONS : MAX_SESSIONS });
      socket.disconnect(true);
      return;
    }
    const biomeIds = biomeIdMap(bot.registry, vanillaBiomes);
    const chunkEntities = /* @__PURE__ */ new Map();
    const streamedChunks = /* @__PURE__ */ new Set();
    let lastBlockEntities = "";
    const publishBlockEntities = () => {
      const snapshot = viewerBlockEntities(chunkEntities.values());
      const signature = JSON.stringify(snapshot);
      if (signature === lastBlockEntities) return false;
      lastBlockEntities = signature;
      socket.emit("blockEntities", snapshot);
      return true;
    };
    const refreshChunkEntities = (x, z) => {
      const origin2 = { x: Math.floor(x / 16) * 16, z: Math.floor(z / 16) * 16 };
      const key = `${origin2.x},${origin2.z}`;
      if (!chunkEntities.has(key)) return false;
      const column = bot.world.getColumn(origin2.x / 16, origin2.z / 16);
      chunkEntities.set(key, viewerChunkBlockEntities(origin2, column?.blockEntities));
      return publishBlockEntities();
    };
    const worldSocket = { on: socket.on.bind(socket), emit: (event, payload) => {
      if (event === "loadChunk") {
        const chunk = payload;
        streamedChunks.add(`${chunk.x},${chunk.z}`);
        chunkEntities.set(`${chunk.x},${chunk.z}`, {});
        refreshChunkEntities(chunk.x, chunk.z);
        socket.emit(event, {
          ...chunk,
          chunk: remapViewerChunkBiomes(chunk.chunk, biomeIds, plainsBiomeId),
          worldConfig: chunkWorldConfig(bot, chunk.x, chunk.z)
        });
      } else if (event === "unloadChunk") {
        const chunk = payload;
        streamedChunks.delete(`${chunk.x},${chunk.z}`);
        chunkEntities.delete(`${chunk.x},${chunk.z}`);
        publishBlockEntities();
        socket.emit(event, payload);
      } else if (event === "blockUpdate") {
        const update = payload;
        refreshChunkEntities(update.pos.x, update.pos.z);
        socket.emit(event, payload);
      } else if (event !== "entity") socket.emit(event, payload);
      return true;
    } };
    const worldView = new WorldView(bot.world, VIEW_DISTANCE, bot.entity.position, worldSocket);
    socket.removeAllListeners("mouseClick");
    let active = true;
    let captureLease;
    const rawCaptureKey = socket.handshake.headers["x-mc-viewer-capture-key"];
    const captureKey = capture && typeof rawCaptureKey === "string" && /^[a-f0-9-]{36}$/i.test(rawCaptureKey) ? rawCaptureKey : void 0;
    let initialized = false;
    let resetting = false;
    let sequence = 0;
    let digKey = "";
    let digStartedAt = 0;
    let digDuration = 1e3;
    let digStage = -1;
    let trackedWindowId = null;
    let containerSignature = "";
    const windowProperties = /* @__PURE__ */ new Map();
    const onWindowProperty = (packet) => {
      if (packet.windowId !== bot.currentWindow?.id || !Number.isInteger(packet.property) || !Number.isFinite(packet.value)) return;
      if (trackedWindowId !== packet.windowId) {
        trackedWindowId = packet.windowId;
        windowProperties.clear();
      }
      windowProperties.set(packet.property, packet.value);
    };
    protocol.on("craft_progress_bar", onWindowProperty);
    const onBlockEntityData = (packet) => {
      if (!active || !packet.location) return;
      const position3 = packet.location;
      if (!refreshChunkEntities(position3.x, position3.z)) return;
      const stateId = bot.blockAt(new Vec33(position3.x, position3.y, position3.z))?.stateId;
      if (stateId !== void 0) socket.emit("blockUpdate", { pos: position3, stateId });
    };
    protocol.on("tile_entity_data", onBlockEntityData);
    const publishContainer = () => {
      if (!active || !socket.connected) return;
      const window = bot.currentWindow;
      if (window?.id !== trackedWindowId) {
        trackedWindowId = window?.id ?? null;
        windowProperties.clear();
      }
      const windowTrades = window?.trades;
      const trades = tradeState?.windowId === window?.id ? tradeState : Array.isArray(windowTrades) ? viewerTradeList({
        windowId: window.id,
        trades: windowTrades
      }, decodeTradeItem) : null;
      const state = windowSnapshot(
        window,
        windowProperties,
        viewerItem,
        trades
      );
      const signature = JSON.stringify(state);
      if (signature === containerSignature) return;
      containerSignature = signature;
      socket.emit("containerState", state);
    };
    const containerTimer = setInterval(publishContainer, 150);
    let scoreboardSignature = "";
    const publishScoreboard = () => {
      if (!active || !socket.connected) return;
      const board = bot.scoreboard?.sidebar;
      const rows = (board?.items ?? []).filter((item) => item && !item.name.startsWith("#")).slice(0, 15).map((item) => ({
        name: minecraftTextComponent(item.displayName).slice(0, 80),
        value: Number.isFinite(item.value) ? item.value : 0
      }));
      const state = { title: board ? minecraftTextComponent(board.title).slice(0, 80) : "", rows };
      const signature = JSON.stringify(state);
      if (signature === scoreboardSignature) return;
      scoreboardSignature = signature;
      socket.emit("scoreboardState", state);
    };
    const scoreboardTimer = setInterval(publishScoreboard, 500);
    const publishMinimap = () => {
      if (!active || !socket.connected) return;
      const snapshot = currentMinimap();
      if (snapshot) socket.emit("minimap", snapshot);
    };
    const minimapTimer = setInterval(publishMinimap, 500);
    let lastLight = "";
    const publishLight = () => {
      if (!active || !socket.connected) return;
      const state = viewerLight(bot);
      const signature = JSON.stringify(state);
      if (signature === lastLight) return;
      lastLight = signature;
      socket.emit("lightingState", state);
    };
    const lightTimer = setInterval(publishLight, 500);
    const pendingEntities = /* @__PURE__ */ new Map();
    const knownEntities = /* @__PURE__ */ new Set();
    const nearby = (entity) => entity !== bot.entity && entity.position && bot.entity?.position && Math.hypot(entity.position.x - bot.entity.position.x, entity.position.z - bot.entity.position.z) <= VIEW_DISTANCE * 16;
    const removeEntity = (entity) => {
      const id = String(entity.id);
      pendingEntities.delete(id);
      if (knownEntities.delete(id) && socket.connected) socket.emit("entity", { id: entity.id, delete: true });
    };
    const queueEntity = (entity, full = false) => {
      if (!active || !entity || entity.id === void 0) return;
      if (!nearby(entity)) {
        removeEntity(entity);
        return;
      }
      const id = String(entity.id);
      if (pendingEntities.size < 256 || pendingEntities.has(id)) pendingEntities.set(id, {
        entity,
        full: full || pendingEntities.get(id)?.full === true
      });
    };
    const entitySpawn = (entity) => queueEntity(entity, true);
    const entityMoved = (entity) => queueEntity(entity);
    const entityUpdate = (entity) => queueEntity(entity, true);
    const playerUpdated = (player) => {
      if (player.entity) queueEntity(player.entity, true);
    };
    const flushEntities = () => {
      if (!active || !socket.connected || socket.conn?.transport?.writable === false) return;
      for (const id of knownEntities) {
        const entity = bot.entities[id];
        if (!entity || !nearby(entity)) removeEntity(entity ?? { id: Number(id) });
      }
      const rows = [...pendingEntities.values()];
      pendingEntities.clear();
      for (const { entity, full } of rows) {
        if (!nearby(entity)) {
          removeEntity(entity);
          continue;
        }
        const id = String(entity.id);
        if (!knownEntities.has(id) && knownEntities.size >= 128) continue;
        const complete = full || !knownEntities.has(id);
        socket.emit(complete ? "entity" : "entityMoved", complete ? viewerEntity(bot, entity, fishingBobberOwners) : {
          id: entity.id,
          pos: entity.position,
          yaw: entity.yaw,
          pitch: entity.pitch,
          headYaw: entity.headYaw
        });
        knownEntities.add(id);
      }
    };
    const entityTimer = setInterval(flushEntities, 100);
    const publishDigging = () => {
      const block = bot.targetDigBlock;
      const pos3 = block?.position;
      const next = pos3 && [pos3.x, pos3.y, pos3.z].every(Number.isInteger) ? `${pos3.x},${pos3.y},${pos3.z}` : "";
      if (!next) {
        if (digKey) socket.emit("digProgress", { stage: null });
        digKey = "";
        digStage = -1;
        return;
      }
      if (next !== digKey) {
        digKey = next;
        digStartedAt = Date.now();
        digStage = -1;
        try {
          digDuration = Math.max(50, Math.min(3e4, Number(bot.digTime(block)) || 1e3));
        } catch {
          digDuration = 1e3;
        }
      }
      const stage = Math.max(0, Math.min(9, Math.floor((Date.now() - digStartedAt) / digDuration * 10)));
      if (stage !== digStage) {
        digStage = stage;
        socket.emit("digProgress", {
          x: pos3.x,
          y: pos3.y,
          z: pos3.z,
          stage,
          blockName: block.name,
          mergedShape: diggingShape(block)
        });
      }
    };
    const publishAvatar = () => {
      if (active && bot.entity && socket.connected) {
        socket.emit("avatarState", { ...avatarState(bot, ++sequence, shieldRaised), entity: presentOwnEntity() });
        publishDigging();
      }
    };
    const avatarTimer = setInterval(publishAvatar, 100);
    let pendingPosition = null;
    let positionUpdate = null;
    let lastChunkRepairAtMs = 0;
    const updateChunkPosition = () => {
      if (!active || !initialized || !bot.entity) return;
      pendingPosition = bot.entity.position.clone();
      if (positionUpdate) return;
      positionUpdate = (async () => {
        while (active && pendingPosition) {
          const next = pendingPosition;
          pendingPosition = null;
          await worldView.updatePosition(next);
          if (Date.now() - lastChunkRepairAtMs >= 1500) await repairMissingChunks(true);
        }
      })().catch(() => {
        socket.disconnect(true);
      }).finally(() => {
        positionUpdate = null;
        if (active && pendingPosition) updateChunkPosition();
      });
    };
    let repairingChunks = false;
    const repairMissingChunks = async (fromPositionUpdate = false) => {
      if (!active || !initialized || !bot.entity || repairingChunks || !fromPositionUpdate && positionUpdate) return;
      repairingChunks = true;
      try {
        const cx = Math.floor(worldView.lastPos.x / 16);
        const cz = Math.floor(worldView.lastPos.z / 16);
        for (const key of Array.from(streamedChunks)) {
          const [x, z] = key.split(",").map(Number);
          if (Math.abs(x / 16 - cx) >= VIEW_DISTANCE || Math.abs(z / 16 - cz) >= VIEW_DISTANCE) {
            worldView.unloadChunk(new Vec33(x, 0, z));
          }
        }
        const candidates = Array.from({ length: 9 * 9 }, (_, index) => ({
          dx: index % 9 - 4,
          dz: Math.floor(index / 9) - 4
        })).sort((a, b) => a.dx * a.dx + a.dz * a.dz - b.dx * b.dx - b.dz * b.dz);
        let retried = 0;
        for (const { dx, dz } of candidates) {
          const x = (cx + dx) * 16, z = (cz + dz) * 16;
          if (streamedChunks.has(`${x},${z}`) || !bot.world.getColumn(cx + dx, cz + dz)) continue;
          await worldView.loadChunk(new Vec33(x, 0, z));
          if (++retried >= 4) break;
        }
        socket.emit("chunkStreamState", { streamed: streamedChunks.size, expected: 81, retried });
      } finally {
        lastChunkRepairAtMs = Date.now();
        repairingChunks = false;
      }
    };
    const chunkRepairTimer = setInterval(() => {
      void repairMissingChunks().catch(() => {
      });
    }, 1500);
    const position2 = (_position, teleport = false) => {
      if (!active || !bot.entity) return;
      socket.emit("position", {
        pos: bot.entity.position,
        yaw: bot.entity.yaw,
        pitch: bot.entity.pitch,
        addMesh: view === "third",
        teleport: teleport === true
      });
      socket.emit(view === "third" ? "entityMoved" : "playerEntity", presentOwnEntity());
      updateChunkPosition();
    };
    const forcedPosition = () => position2(void 0, true);
    const time = () => {
      socket.emit("time", bot.time.timeOfDay);
    };
    let climate = {};
    const weather = () => {
      const raining = isRaining(bot);
      socket.emit("weather", { raining, thunder: raining ? bot.thunderState : 0, ...climate });
    };
    let lastBossBarSnapshot = null;
    const publishBossBars = () => {
      if (!active || !socket.connected) return;
      const bars = viewerBossBars(bot.bossBars);
      const snapshot = JSON.stringify(bars);
      if (snapshot === lastBossBarSnapshot) return;
      lastBossBarSnapshot = snapshot;
      socket.emit("bossBars", bars);
    };
    const stopBossBars = observeViewerBossBars(bot, publishBossBars);
    const bossBarTimer = setInterval(publishBossBars, 5e3);
    let lastBiome = "";
    const biome = () => {
      if (!active || !bot.entity || !socket.connected) return;
      const position3 = bot.entity.position.floored();
      let name2 = "";
      let id;
      try {
        const blockBiome = bot.blockAt(position3)?.biome;
        name2 = blockBiome?.name || "";
        id = blockBiome?.id;
        if (!name2) {
          const chunkX = Math.floor(position3.x / 16), chunkZ = Math.floor(position3.z / 16);
          const column = bot.world.getColumn(chunkX, chunkZ);
          const value = column?.getBiome?.(position3.offset(-chunkX * 16, 0, -chunkZ * 16));
          if (typeof value === "number") id ??= value;
          else if (value) {
            id ??= value.id;
            name2 ||= value.name || "";
          }
        }
      } catch {
      }
      const biomes = bot.registry;
      if (!name2 && Number.isInteger(id)) name2 = biomes.biomes?.[id]?.name || biomes.biomesArray?.find((entry) => entry.id === id)?.name || "";
      const originalBiome = Number.isInteger(id) ? biomes.biomes?.[id] : void 0;
      climate = viewerBiomeClimate(originalBiome ?? biomes.biomesArray?.find((entry) => Number.isInteger(id) ? entry.id === id : entry.name === name2));
      if (!name2) name2 = "unknown";
      const dimension = String(bot.game.dimension || "minecraft:overworld");
      const key = `${dimension}:${name2}:${id ?? ""}`;
      if (key === lastBiome) return;
      lastBiome = key;
      socket.emit("biome", { name: name2, dimension, id: Number.isInteger(id) ? id : null, ...climate });
      weather();
    };
    const biomeTimer = setInterval(biome, 1200);
    const chunkUnload = (position3) => {
      if (active && position3 && typeof position3 === "object") worldView.unloadChunk(position3);
    };
    const otherSwing = (entity) => {
      if (active && entity && entity !== bot.entity && nearby(entity)) {
        socket.emit("entityAnimation", { id: entity.id, animation: "oneSwing" });
      }
    };
    const entityHurt = (entity) => {
      if (active && entity && (entity === bot.entity || nearby(entity))) {
        socket.emit("entityDamage", { id: entity.id, isSelf: entity === bot.entity });
      }
    };
    const resetWorld = () => {
      if (!active || resetting) return;
      resetting = true;
      socket.emit("viewerReset");
      setTimeout(stop, 50);
    };
    const stop = () => {
      if (!active) return;
      active = false;
      captureLease?.stop();
      if (captureKey && captureLeases.get(captureKey) === captureLease) captureLeases.delete(captureKey);
      releaseSlot();
      viewerSockets.delete(socket);
      bot.off("move", position2);
      bot.off("forcedMove", forcedPosition);
      bot.off("time", time);
      protocol.off("game_state_change", weather);
      bot.off("respawn", resetWorld);
      bot.off("chunkColumnUnload", chunkUnload);
      bot.off("entitySpawn", entitySpawn);
      bot.off("entityMoved", entityMoved);
      bot.off("entityUpdate", entityUpdate);
      bot.off("entityEquip", entityUpdate);
      bot.off("playerUpdated", playerUpdated);
      bot.off("playerJoined", playerUpdated);
      bot.off("entityGone", removeEntity);
      bot.off("entitySwingArm", otherSwing);
      bot.off("entityHurt", entityHurt);
      stopBossBars();
      clearInterval(bossBarTimer);
      protocol.off("craft_progress_bar", onWindowProperty);
      protocol.off("tile_entity_data", onBlockEntityData);
      clearInterval(avatarTimer);
      clearInterval(chunkRepairTimer);
      clearInterval(entityTimer);
      clearInterval(biomeTimer);
      clearInterval(containerTimer);
      clearInterval(scoreboardTimer);
      clearInterval(minimapTimer);
      clearInterval(lightTimer);
      pendingEntities.clear();
      knownEntities.clear();
      worldView.removeListenersFromBot(bot);
      sessions.delete(stop);
      socket.disconnect(true);
    };
    sessions.add(stop);
    if (capture) {
      captureLease = new ViewerCaptureLease(stop, CAPTURE_SESSION_MS);
      if (captureKey) captureLeases.set(captureKey, captureLease);
    }
    viewerSockets.add(socket);
    socket.once("disconnect", stop);
    socket.emit("version", bot.version);
    content.subscribeSocket(socket);
    socket.once("disconnect", appearance.subscribeSocket(socket));
    observer?.subscribeSocket(socket);
    agentVisuals.subscribeSocket(socket);
    socket.emit("tacticalRoute", latestRoute);
    if (latestSkills) socket.emit("skillsState", latestSkills);
    if (recentCastCue && Date.now() - recentCastCue.atMs < 4e3)
      socket.emit("castCue", recentCastCue.cue);
    for (const effect of Object.values(bot.entity.effects ?? {})) {
      socket.emit("presentationEvent", {
        kind: "effect",
        self: true,
        active: true,
        id: effect.id,
        ...effectDetails(effect.id),
        amplifier: effect.amplifier,
        durationTicks: remainingEffectTicks(effect)
      });
    }
    socket.emit("biome", { name: "unknown", dimension: String(bot.game.dimension || "minecraft:overworld"), id: null });
    socket.emit(view === "third" ? "entity" : "playerEntity", presentOwnEntity());
    bot.on("move", position2);
    bot.on("forcedMove", forcedPosition);
    bot.on("time", time);
    protocol.on("game_state_change", weather);
    bot.on("respawn", resetWorld);
    bot.on("chunkColumnUnload", chunkUnload);
    bot.on("entitySpawn", entitySpawn);
    bot.on("entityMoved", entityMoved);
    bot.on("entityUpdate", entityUpdate);
    bot.on("entityEquip", entityUpdate);
    bot.on("playerUpdated", playerUpdated);
    bot.on("playerJoined", playerUpdated);
    bot.on("entityGone", removeEntity);
    bot.on("entitySwingArm", otherSwing);
    bot.on("entityHurt", entityHurt);
    worldView.listenToBot(bot);
    for (const entity of Object.values(bot.entities)) entitySpawn(entity);
    flushEntities();
    time();
    weather();
    publishBossBars();
    position2();
    biome();
    publishAvatar();
    publishContainer();
    publishScoreboard();
    publishMinimap();
    publishLight();
    void worldView.init(bot.entity.position).then(() => {
      initialized = true;
      updateChunkPosition();
      void repairMissingChunks().catch(() => {
      });
    }).catch(() => socket.disconnect(true));
  }
  first.on("connection", (socket) => accept(socket, "first"));
  third.on("connection", (socket) => accept(socket, "third"));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    disposeContent();
    first.close();
    third.close();
    throw error;
  }
  protocol.on("custom_payload", onSkillPacket);
  bot.on("path_update", onPathUpdate);
  bot.on("goal_updated", onGoalUpdated);
  bot.on("goal_reached", onGoalReached);
  protocol.on("open_window", onWindowOpened);
  protocol.on("trade_list", onTradeList);
  const initialMana = options.agentMana?.();
  if (initialMana !== void 0) {
    agentManaSeen = true;
    latestSkills = {
      ...latestSkills ?? { schemaVersion: 1, skills: [], abilities: [] },
      mana: initialMana,
      source: "plugin",
      observedAt: Date.now()
    };
  }
  protocol.on("packet", onPacketObserved);
  protocol.on("spawn_entity", onSpawnEntity);
  bot.on("entityGone", forgetFishingBobberOwner);
  protocol.on("explosion", onExplosion);
  protocol.on("world_event", onWorldEvent);
  protocol.on("collect", onCollect);
  protocol.on("entity_effect", onEntityEffect);
  protocol.on("remove_entity_effect", onRemoveEntityEffect);
  protocol.on("set_cooldown", onCooldown);
  protocol.on("advancements", onAdvancements);
  const stopCastCommands = observeViewerCastCommands(bot, onCastCommand);
  bot.on("message", onCastMessage);
  bot.on("message", onViewerMessage);
  bot.on("title", onViewerTitle);
  bot.on("title_times", onViewerTitleTimes);
  bot.on("title_clear", onViewerTitleClear);
  bot.on("actionBar", onViewerActionBar);
  bot.on("death", onViewerDeath);
  const publishSoundStop = (event) => {
    for (const socket of viewerSockets) if (socket.connected) socket.emit("worldSoundStop", event);
  };
  const resetSound = () => {
    fishingBobberOwners.clear();
    publishSoundStop({});
  };
  const stopSounds = observeViewerSounds(
    protocol,
    soundRegistry.registry,
    (id) => id === bot.entity?.id ? bot.entity.position : bot.entities[id]?.position,
    (event) => {
      if (!closed) {
        for (const socket of viewerSockets) if (socket.connected) socket.emit("worldSound", event);
      }
    },
    publishSoundStop
  );
  bot.on("respawn", resetSound);
  bot.on("end", resetSound);
  const stopArmAnimation = observeViewerArmAnimation(protocol, (hand) => {
    if (closed || !bot.entity) return;
    const event = { id: bot.entity.id, isSelf: true, animation: "oneSwing", hand };
    for (const socket of viewerSockets) if (socket.connected) socket.emit("entityAnimation", event);
  });
  const stopAttack = observeViewerAttack(protocol, (targetId) => {
    if (closed) return;
    const target = bot.entities[targetId];
    if (!target?.position) return;
    const cue = {
      id: targetId,
      name: target.displayName || target.name || "\u76EE\u6807",
      position: { x: target.position.x, y: target.position.y, z: target.position.z }
    };
    for (const socket of viewerSockets) if (socket.connected) socket.emit("tacticalAttack", cue);
  });
  const stopRangedUse = observeViewerRangedUse(protocol, () => bot.heldItem?.name, (event) => {
    if (closed) return;
    for (const socket of viewerSockets) if (socket.connected) socket.emit("rangedUse", event);
  });
  const stopShieldUse = observeViewerShieldUse(
    protocol,
    () => bot.inventory?.slots?.[45]?.name,
    (raised) => {
      shieldRaised = raised;
    }
  );
  const stopFishing = observeViewerFishingCatch(bot, (event) => {
    if (!closed) {
      for (const socket of viewerSockets) if (socket.connected) socket.emit("fishingCatch", event);
    }
  }, viewerItem);
  const stopInventoryPreview = observeViewerInventoryPreview(bot, (event) => {
    for (const socket of viewerSockets) if (socket.connected) socket.emit("inventoryPreview", event);
  });
  return {
    url: origin,
    async close() {
      if (closed) return;
      closed = true;
      speechRelay.close();
      stopInventoryPreview();
      bot.off("path_update", onPathUpdate);
      bot.off("goal_updated", onGoalUpdated);
      bot.off("goal_reached", onGoalReached);
      protocol.off("custom_payload", onSkillPacket);
      protocol.off("open_window", onWindowOpened);
      protocol.off("trade_list", onTradeList);
      protocol.off("packet", onPacketObserved);
      protocol.off("spawn_entity", onSpawnEntity);
      bot.off("entityGone", forgetFishingBobberOwner);
      protocol.off("explosion", onExplosion);
      protocol.off("world_event", onWorldEvent);
      protocol.off("collect", onCollect);
      protocol.off("entity_effect", onEntityEffect);
      protocol.off("remove_entity_effect", onRemoveEntityEffect);
      protocol.off("set_cooldown", onCooldown);
      protocol.off("advancements", onAdvancements);
      stopCastCommands();
      bot.off("message", onCastMessage);
      bot.off("message", onViewerMessage);
      bot.off("title", onViewerTitle);
      bot.off("title_times", onViewerTitleTimes);
      bot.off("title_clear", onViewerTitleClear);
      bot.off("actionBar", onViewerActionBar);
      bot.off("death", onViewerDeath);
      bot.off("respawn", resetSound);
      bot.off("end", resetSound);
      publishSoundStop({});
      stopSounds();
      stopFishing();
      stopShieldUse();
      stopRangedUse();
      stopAttack();
      stopArmAnimation();
      disposeContent();
      for (const stop of [...sessions]) stop();
      await Promise.all([
        new Promise((resolve) => first.close(() => resolve())),
        new Promise((resolve) => third.close(() => resolve()))
      ]);
    }
  };
}
export {
  observeViewerInventoryPreview,
  ownEntity,
  recordFishingBobberOwner,
  startModernViewer,
  viewerEntity,
  viewerItem,
  viewerMessageKind
};
