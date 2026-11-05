import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, baseUrl, forceDemo, livekitCloud, livekitConfig, maxTokens, metaKey, modelId, sttEngine, sttModel, voiceAgentEnabled, voiceTtsKind } from "./env.js";
import { extractPdfText, fetchUrlText, loadContext } from "./context.js";
import { SAMPLE, SAMPLE_CONTEXT } from "./demo.js";
import { takeTurn } from "./interview.js";
import { handleMcp } from "./mcp.js";
import { transcribeWav } from "./muse.js";
import { createSession, executeTool, pushLog, sessions, slugify, toMarkdown, view } from "./prd.js";

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
      engine: sttEngine(),
      model: sttModel(),
      endpoint: "/asr/transcribe",
      audioEncoding: "WAV",
      sampleRateHertz: 16000,
      browserFallback: sttEngine() === "browser",
      note:
        sttEngine() === "muse"
          ? "The mic records a push-to-talk clip and sends 16 kHz mono WAV to muse-voice-transcribe-1.0. META_STT=browser switches the mic to the Web Speech API."
          : "The mic is the browser Web Speech API because META_STT=browser or no API key is set. With META_API_KEY, the mic uses muse-voice-transcribe-1.0.",
    },
    mcp: "/mcp",
    voice: "Push-to-talk uses Muse Voice Transcribe and speechSynthesis. Voice agent is a LiveKit Agents pipeline when LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are set.",
    livekit: livekitHealth(),
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
    sendJson(res, 200, { turns: SAMPLE, context: SAMPLE_CONTEXT });
    return;
  }
  if (req.method === "POST" && pathname === "/api/session") {
    sendJson(res, 200, view(createSession()));
    return;
  }

  const sessionContext = pathname.match(/^\/api\/session\/([^/]+)\/context$/);
  if (req.method === "POST" && sessionContext) {
    const session = sessions.get(decodeURIComponent(sessionContext[1]));
    if (!session) return sendJson(res, 404, { error: "No such session.", code: "not_found" });
    const body = await readJson(req, 12_000_000);
    let text = body.text || "";
    let label = body.label || "notes";
    let source = body.source || "paste";
    if (body.url) {
      text = await fetchUrlText(body.url);
      label = body.label || body.url;
      source = "url";
    } else if (body.pdfBase64) {
      text = extractPdfText(Buffer.from(body.pdfBase64, "base64"));
      label = body.label || "notes.pdf";
      source = "file";
    }
    if (body.text && (body.url || body.pdfBase64)) {
      text = `${body.text.trim()}\n\n${text}`;
      source = "mixed";
    }
    loadContext(session, { text, source, label });
    sendJson(res, 200, view(session));
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

  if (req.method === "POST" && pathname === "/api/livekit/token") {
    if (!livekitConfig().configured) {
      return sendJson(res, 503, {
        error: "LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.",
        code: "livekit_unconfigured",
      });
    }
    const body = await readJson(req);
    const session = sessions.get(body.sessionId);
    if (!session) return sendJson(res, 404, { error: "No such session.", code: "not_found" });
    const { issueParticipantToken } = await import("./livekit.js");
    const issued = await issueParticipantToken(session, { live: Boolean(body.live) });
    sendJson(res, 200, issued);
    return;
  }

  if (req.method === "POST" && pathname === "/api/livekit/stop") {
    if (!livekitConfig().configured) {
      return sendJson(res, 503, {
        error: "LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.",
        code: "livekit_unconfigured",
      });
    }
    const body = await readJson(req);
    if (!body.sessionId) return sendJson(res, 400, { error: "Missing session.", code: "bad_session" });
    if (!voiceAgentEnabled()) return sendJson(res, 200, { stopped: false });
    const { deleteShapeRoom } = await import("./livekit-worker.js");
    const stopped = await deleteShapeRoom(body.sessionId);
    sendJson(res, 200, { stopped });
    return;
  }

  if (req.method === "POST" && pathname === "/api/transcribe") {
    const body = await readJson(req, 20_000_000);
    const wav = Buffer.from(body.wavBase64 || "", "base64");
    if (wav.length < 44) return sendJson(res, 400, { error: "Audio was empty.", code: "empty_audio" });
    const session = body.sessionId ? sessions.get(body.sessionId) : null;
    try {
      const out = await transcribeWav(wav);
      if (session) {
        pushLog(session, {
          name: "asr/transcribe",
          via: "model",
          transport: "none",
          source: out.model,
          args: { model: out.model, audioEncoding: "WAV", sampleRateHertz: 16000 },
          summary: `${out.model} · ${out.latencyMs}ms · ${out.text}`,
          result: { live: true, latencyMs: out.latencyMs, audioDurationMs: out.audioDurationMs },
        });
      }
      sendJson(res, 200, { ...out, toolLog: session ? session.toolLog : undefined });
    } catch (error) {
      if (session) {
        pushLog(session, {
          name: "asr/transcribe",
          via: "model",
          transport: "none",
          source: sttModel(),
          ok: false,
          args: { model: sttModel(), audioEncoding: "WAV", sampleRateHertz: 16000 },
          summary: error.message,
        });
      }
      error.toolLog = session ? session.toolLog : undefined;
      throw error;
    }
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

let livekitRuntime = "off";

function livekitHealth() {
  const configured = livekitConfig().configured;
  return {
    configured,
    runtime: configured ? livekitRuntime : "off",
    agent: "livekit-agents",
    active: 0,
    join: configured && voiceAgentEnabled() ? "on" : "off",
    stt: sttModel(),
    sttFallback: configured && livekitCloud() ? "livekit-inference" : "none",
    tts: voiceTtsKind(),
  };
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = error.status || 500;
    if (status >= 500) console.error("[shape]", error);
    else console.error("[shape]", error.code || status, error.message);
    if (!res.headersSent) {
      const body = { error: error.message || "Internal error.", code: error.code || "error" };
      if (error.toolLog) body.toolLog = error.toolLog;
      sendJson(res, status, body);
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
      sttEngine() === "muse"
        ? `stt    ${sttModel()}  POST /v1/asr/transcribe  16 kHz mono WAV`
        : `stt    browser Web Speech API  (set a META_API_KEY for ${sttModel()}; META_STT=browser keeps this fallback)`,
    );
    if (!metaKey() || forceDemo()) console.log("demo   ready — the UI runs with no API key");
    if (livekitConfig().configured) {
      const agent = voiceAgentEnabled() ? "livekit-agents worker" : "tokens only";
      console.log(`livekit configured · ${agent} · tts ${voiceTtsKind()}`);
      if (voiceAgentEnabled()) {
        livekitRuntime = "starting";
        import("./livekit-worker.js")
          .then((mod) => {
            mod.startShapeWorker();
            const mark = () => {
              if (mod.workerState() === "ready") livekitRuntime = "ready";
            };
            const timer = setInterval(mark, 500);
            setTimeout(() => {
              clearInterval(timer);
              mark();
              if (livekitRuntime !== "ready") {
                livekitRuntime = "error";
                console.error("[shape] livekit worker has not registered yet. Push-to-talk still works.");
              }
            }, 12000);
          })
          .catch((error) => {
            livekitRuntime = "error";
            console.error("[shape] livekit worker", error.message);
          });
      } else {
        livekitRuntime = "off";
      }
    } else {
      livekitRuntime = "off";
      console.log("livekit off — push-to-talk only (set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)");
    }
  });
}
