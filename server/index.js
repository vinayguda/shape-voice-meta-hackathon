import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, baseUrl, forceDemo, maxTokens, metaKey, modelId, sttEnabled } from "./env.js";
import { SAMPLE } from "./demo.js";
import { takeTurn } from "./interview.js";
import { handleMcp } from "./mcp.js";
import { transcribeWav } from "./muse.js";
import { createSession, executeTool, sessions, slugify, toMarkdown, view } from "./prd.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(path.join(root, ".env"));

const web = path.join(root, "web");
const port = Number(process.env.PORT || 3000);
const TOOL_NAMES = new Set(["create_prd", "update_prd_section", "export_prd"]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, body, extra = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
    ...extra,
  });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("too large"), { status: 413, code: "too_large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, limit = 1_000_000) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    const error = new Error("Request body was not JSON.");
    error.status = 400;
    error.code = "bad_json";
    throw error;
  }
}

function health() {
  return {
    ok: true,
    product: "Shape",
    theme: "Build for Your World",
    track: "Indie Developer",
    museConfigured: Boolean(metaKey()),
    forceDemo: forceDemo(),
    model: modelId(),
    baseUrl: baseUrl(),
    maxTokens: maxTokens(),
    reasoningEffort: process.env.META_REASONING_EFFORT || "low",
    stt: {
      provider: "browser-web-speech",
      museOptional: sttEnabled(),
      museModel: process.env.META_STT_MODEL || "muse-voice-transcribe-1.0",
      museEndpoint: "/asr/transcribe",
      note: "The browser Web Speech API is the microphone. META_STT=1 tries Muse Voice Transcribe at POST /v1/asr/transcribe. POST /v1/audio/transcriptions returns 404. Meta has no TTS model; the browser speaks.",
    },
    mcp: "/mcp",
    voice: "Browser Web Speech API in, speechSynthesis out. One Node process.",
  };
}

function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(web, rel || "index.html");
  if (file !== web && !file.startsWith(`${web}${path.sep}`)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  const target = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, "index.html") : file;
  if (!target.startsWith(`${web}${path.sep}`) && target !== path.join(web, "index.html")) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const type = TYPES[path.extname(target)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(data);
  });
}

async function handle(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = url.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, health());
    return;
  }
  if (req.method === "GET" && pathname === "/api/sample") {
    sendJson(res, 200, { turns: SAMPLE });
    return;
  }
  if (req.method === "POST" && pathname === "/api/session") {
    sendJson(res, 200, view(createSession()));
    return;
  }

  const sessionGet = pathname.match(/^\/api\/session\/([^/]+)$/);
  if (req.method === "GET" && sessionGet) {
    const session = sessions.get(decodeURIComponent(sessionGet[1]));
    if (!session) return sendJson(res, 404, { error: "No such session.", code: "not_found" });
    return sendJson(res, 200, view(session));
  }

  const sessionExport = pathname.match(/^\/api\/session\/([^/]+)\/export\.md$/);
  if (req.method === "GET" && sessionExport) {
    const session = sessions.get(decodeURIComponent(sessionExport[1]));
    if (!session) return sendJson(res, 404, { error: "No such session.", code: "not_found" });
    const markdown = toMarkdown(session.prd);
    const filename = slugify(session.prd.title);
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    });
    res.end(markdown);
    return;
  }

  if (req.method === "POST" && pathname === "/api/turn") {
    const body = await readJson(req);
    const session = sessions.get(body.sessionId);
    if (!session) return sendJson(res, 404, { error: "No such session.", code: "not_found" });
    const result = await takeTurn(session, body.text, { live: Boolean(body.live) });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && pathname === "/api/tool") {
    const body = await readJson(req);
    const session = sessions.get(body.sessionId);
    if (!session) return sendJson(res, 404, { error: "No such session.", code: "not_found" });
    if (!TOOL_NAMES.has(body.name)) return sendJson(res, 400, { error: "Unknown tool.", code: "bad_tool" });
    const { result, entry } = executeTool(session, body.name, body.arguments || {}, { source: "ui", transport: "in-process" });
    if (!result.ok) return sendJson(res, 400, { error: result.error, code: "tool_failed", toolCall: entry });
    sendJson(res, 200, { ...view(session), result, toolCall: entry, changedSections: [] });
    return;
  }

  if (req.method === "POST" && pathname === "/api/transcribe") {
    const body = await readJson(req, 20_000_000);
    const wav = Buffer.from(body.wavBase64 || "", "base64");
    if (wav.length < 44) return sendJson(res, 400, { error: "Audio was empty.", code: "empty_audio" });
    const out = await transcribeWav(wav);
    sendJson(res, 200, out);
    return;
  }

  if (pathname === "/mcp") {
    if (req.method === "GET") return sendJson(res, 405, { error: "Shape MCP accepts POST.", code: "method" });
    if (req.method === "DELETE") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      res.end();
      return;
    }
    if (req.method === "POST") {
      const raw = await readBody(req, 1_000_000);
      let message;
      try {
        message = JSON.parse(raw.toString("utf8") || "null");
      } catch {
        return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      const headerSession = req.headers["mcp-session-id"];
      const out = handleMcp(message, headerSession);
      if (out.status === 202) {
        res.writeHead(202, { "Access-Control-Allow-Origin": "*", "Mcp-Session-Id": out.sessionId || headerSession || "" });
        res.end();
        return;
      }
      const extra = {};
      if (out.sessionId) extra["Mcp-Session-Id"] = out.sessionId;
      extra["MCP-Protocol-Version"] = "2025-03-26";
      sendJson(res, out.status, out.body, extra);
      return;
    }
  }

  if (pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Not found.", code: "not_found" });
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }
  serveStatic(req, res, pathname === "/" ? "/index.html" : pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = error.status || 500;
    if (status >= 500) console.error("[shape]", error);
    else console.error("[shape]", error.code || status, error.message);
    if (!res.headersSent) {
      sendJson(res, status, { error: error.message || "Internal error.", code: error.code || "error" });
    } else {
      res.end();
    }
  });
});

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.on("error", (error) => {
    console.error("[shape]", error.message);
    process.exit(1);
  });
  server.listen(port, "0.0.0.0", () => {
    const key = metaKey() ? "yes" : "no";
    console.log(`Shape  http://localhost:${port}`);
    console.log(`MCP    http://localhost:${port}/mcp`);
    console.log(`model  ${modelId()}  key ${key}  max_tokens ${maxTokens()}`);
    console.log(
      `stt    browser Web Speech API${sttEnabled() ? " + muse-voice-transcribe-1.0 at /asr/transcribe" : "  (META_STT=1 tries Muse Voice Transcribe)"}`,
    );
    if (!metaKey() || forceDemo()) console.log("demo   ready — the UI runs with no API key");
  });
}
