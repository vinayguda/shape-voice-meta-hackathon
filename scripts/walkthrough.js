import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublicHttpUrl, extractPdfText, loadContext, stripHtml } from "../server/context.js";
import { cleanProse, demoTurn, looksBloated, SAMPLE, SAMPLE_CONTEXT, synthesize } from "../server/demo.js";
import { sttEngine } from "../server/env.js";
import { brief, decideAdvance, questionFitsStage, routeFor } from "../server/interview.js";
import { shouldDropReasoningEffort, transcribeRequest, wavIs16kMono } from "../server/muse.js";
import { createSession, formatScope, titleFrom, toMarkdown } from "../server/prd.js";

function wavHeader(rate, channels, bits) {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE((rate * channels * bits) / 8, 28);
  bytes.writeUInt16LE((channels * bits) / 8, 32);
  bytes.writeUInt16LE(bits, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(0, 40);
  return bytes;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 3099;
const base = `http://127.0.0.1:${port}`;

function unit() {
  assert.equal(shouldDropReasoningEffort(400, "Unsupported parameter: reasoning_effort"), true);
  assert.equal(shouldDropReasoningEffort(400, "bad model"), false);
  assert.equal(shouldDropReasoningEffort(401, "reasoning_effort"), false);

  const saved = { DEMO: process.env.DEMO, META_API_KEY: process.env.META_API_KEY, MODEL_API_KEY: process.env.MODEL_API_KEY };
  delete process.env.DEMO;
  delete process.env.META_API_KEY;
  delete process.env.MODEL_API_KEY;
  assert.equal(routeFor(false), "demo");
  assert.equal(routeFor(true), "no_key");
  process.env.META_API_KEY = "LLM_test";
  process.env.DEMO = "1";
  assert.equal(routeFor(true), "demo");
  delete process.env.DEMO;
  assert.equal(routeFor(true), "live");
  delete process.env.META_STT;
  assert.equal(sttEngine(), "muse");
  process.env.META_STT = "browser";
  assert.equal(sttEngine(), "browser");
  delete process.env.META_STT;
  delete process.env.META_API_KEY;
  assert.equal(sttEngine(), "browser");
  const request = transcribeRequest();
  assert.deepEqual(request, { model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", sampleRateHertz: 16000 });
  assert.equal(wavIs16kMono(wavHeader(16000, 1, 16)), true);
  assert.equal(wavIs16kMono(wavHeader(44100, 1, 16)), false);
  assert.equal(wavIs16kMono(wavHeader(16000, 2, 16)), false);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const title = titleFrom(SAMPLE[0]);
  assert.match(title, /^Parents to understand/);
  assert.equal(title.includes("Not just"), false);
  assert.equal(cleanProse("i want to build build an app."), "I want to build an app.");
  assert.equal(questionFitsStage("What hurts most?", "target_user"), false);
  assert.equal(questionFitsStage("Who is the primary user here?", "target_user"), true);
  assert.deepEqual(decideAdvance({ stageIndex: 4, written: true }), { stageIndex: 5, complete: false, stayed: false });
  assert.deepEqual(decideAdvance({ stageIndex: 4, written: false }), { stageIndex: 4, complete: false, stayed: true });
  assert.equal(decideAdvance({ stageIndex: 6, written: true }).complete, true);
  const scoped = createSession();
  scoped.answers.problem = "i want to build build an app for parents.";
  scoped.answers.mvp_scope = "weekly summary only";
  scoped.prd.sections.mvp_scope = "In:\n- weekly summary\n\nOut:\n- content filtering";
  const shaped = synthesize(scoped);
  assert.match(shaped.problem, /^I want to build an app/);
  assert.equal(shaped.problem.includes("build build"), false);
  assert.equal(shaped.user_stories.includes("help with this problem"), false);
  assert.equal(/explicitly out/i.test(shaped.open_questions), false);
  assert.equal(stripHtml("<script>alert(1)</script><style>p{}</style><p>Hello &amp; notes</p>"), "Hello & notes");
  assert.throws(() => extractPdfText(Buffer.from("not a pdf")), /PDF/);
  const pdf = Buffer.from("%PDF-1.1\n1 0 obj<</Length 52>>stream\n(Parents check screen time before dinner tonight) Tj\nendstream\nendobj\n");
  assert.match(extractPdfText(pdf), /Parents check screen time/);
  const noted = createSession();
  loadContext(noted, { text: SAMPLE_CONTEXT, source: "sample", label: "sample notes" });
  assert.ok(noted.toolLog.some((entry) => entry.name === "load_context"));
  assert.match(brief(noted), /Your notes say/);
  assert.match(brief(noted), /YouTube/);
  assert.throws(() => assertPublicHttpUrl("http://127.0.0.1/secret"), /public/);
  assert.equal(looksBloated(SAMPLE[4]), false);
  assert.equal(looksBloated("We should ship chat, payments, social profiles, an admin console, analytics, notifications, a marketplace, and a native client."), true);
  assert.match(formatScope(SAMPLE[4]), /In:\n- weekly pattern summary/);
  assert.match(formatScope(SAMPLE[4]), /school admin dashboards/);

  const thin = createSession();
  const thinTurn = demoTurn(thin, "hi");
  assert.equal(thinTurn.pushback, true);
  assert.equal(thin.stageIndex, 0);
  assert.equal(thin.prd.sections.problem, "");
  assert.equal(thin.createdPrd, false);

  const unsure = createSession();
  demoTurn(unsure, "I don't know");
  assert.equal(unsure.stageIndex, 0);
  demoTurn(unsure, "I don't know");
  assert.equal(unsure.stageIndex, 1);
  assert.match(unsure.prd.sections.problem, /screen-time|check-in/);

  const broad = createSession();
  demoTurn(broad, SAMPLE[0]);
  const everyone = demoTurn(broad, "everyone");
  assert.equal(everyone.pushback, true);
  assert.equal(broad.stageIndex, 1);
  assert.equal(broad.prd.sections.target_user, "");

  const scope = createSession();
  for (const line of SAMPLE.slice(0, 4)) demoTurn(scope, line);
  assert.equal(scope.stageIndex, 4);
  const bloated = demoTurn(scope, "We should ship chat, payments, social profiles, an admin console, analytics, notifications, a marketplace, and a native client.");
  assert.equal(bloated.pushback, true);
  assert.equal(scope.stageIndex, 4);
  assert.equal(scope.prd.sections.mvp_scope, "");

  const metrics = createSession();
  for (const line of SAMPLE.slice(0, 5)) demoTurn(metrics, line);
  const vagueMetric = demoTurn(metrics, "it should feel better overall");
  assert.equal(vagueMetric.pushback, true);
  assert.equal(metrics.stageIndex, 5);

  const full = createSession();
  let last;
  for (const line of SAMPLE) last = demoTurn(full, line);
  assert.equal(full.complete, true);
  assert.equal(full.stageIndex, 7);
  assert.equal(full.prd.status, "ready");
  for (const id of ["problem", "target_user", "user_stories", "mvp_scope", "success_metrics", "risks", "open_questions"]) {
    assert.ok(full.prd.sections[id].trim(), `empty section ${id}`);
  }
  assert.match(full.prd.sections.problem, /screen-time/);
  assert.match(full.prd.sections.problem, /Current workaround/);
  assert.match(full.prd.sections.user_stories, /As /);
  assert.match(full.prd.sections.mvp_scope, /In:/);
  assert.match(full.prd.sections.mvp_scope, /Out:/);
  assert.match(full.prd.sections.success_metrics, /60/);
  assert.match(full.prd.sections.open_questions, /consent/);
  const names = full.toolLog.map((entry) => entry.name);
  assert.ok(names.includes("chat.completions"));
  assert.ok(names.includes("create_prd"));
  assert.ok(names.includes("update_prd_section"));
  assert.ok(names.includes("export_prd"));
  assert.ok(names.indexOf("create_prd") < names.indexOf("export_prd"));
  assert.equal(last.modelCall.live, false);
  const markdown = toMarkdown(full.prd);
  for (const heading of ["## Problem", "## Target user / personas", "## User stories", "## MVP scope", "## Success metrics", "## Risks", "## Open questions"]) {
    assert.ok(markdown.includes(heading), heading);
  }
  const revised = demoTurn(full, "Please change the success metric to 40 percent of families completing a weekly check-in.");
  assert.match(revised.prd.sections.success_metrics, /40 percent/);
  assert.match(revised.question, /Updated success metrics/);
}

async function startServer() {
  const env = { ...process.env, PORT: String(port) };
  delete env.META_API_KEY;
  delete env.MODEL_API_KEY;
  delete env.DEMO;
  delete env.META_STT;
  env.META_MODEL = "muse-spark-1.3";
  env.META_BASE_URL = "https://api.meta.ai/v1";
  const child = spawn(process.execPath, ["server/index.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  let up = false;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server start timeout\n${buf}`)), 8000);
    const onData = (chunk) => {
      buf += chunk.toString();
      if (!up && buf.includes("Shape  http")) {
        up = true;
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (!up) {
        clearTimeout(timer);
        reject(new Error(`server exited ${code}\n${buf}`));
      }
    });
  });
  return child;
}

async function post(pathname, body) {
  const response = await fetch(base + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: response.status, json, text, headers: response.headers };
}

async function http() {
  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.model, "muse-spark-1.3");
  assert.equal(health.baseUrl, "https://api.meta.ai/v1");
  assert.equal(health.museConfigured, false);
  assert.equal(health.theme, "Build for Your World");
  assert.equal(health.track, "Indie Developer");
  assert.equal(health.stt.engine, "browser");
  assert.equal(health.stt.model, "muse-voice-transcribe-1.0");
  assert.equal(health.stt.audioEncoding, "WAV");
  assert.equal(health.stt.sampleRateHertz, 16000);
  assert.equal(health.stt.browserFallback, true);

  const html = await fetch(`${base}/`).then((response) => response.text());
  assert.match(html, /Build for Your World/);
  assert.match(html, /Talk your idea/);
  assert.equal((await fetch(`${base}/styles.css`)).status, 200);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);

  const escaped = await fetch(`${base}/../package.json`);
  const escapedBody = await escaped.text();
  assert.ok(escaped.status === 403 || escaped.status === 404 || !escapedBody.includes('"name"'));

  const sample = await fetch(`${base}/api/sample`).then((response) => response.json());
  assert.deepEqual(sample.turns, SAMPLE);
  assert.match(sample.context, /YouTube/);
  const withNotes = await post("/api/session", {});
  const loaded = await post(`/api/session/${withNotes.json.sessionId}/context`, {
    text: SAMPLE_CONTEXT,
    source: "paste",
    label: "sample notes",
  });
  assert.equal(loaded.status, 200, loaded.text);
  assert.equal(loaded.json.context.loaded, true);
  assert.ok(loaded.json.toolLog.some((entry) => entry.name === "load_context"));

  const created = await post("/api/session", {});
  assert.equal(created.status, 200);
  assert.equal(created.json.stageIndex, 0);
  assert.match(created.json.question, /pain/);
  let current = created.json;
  for (const line of SAMPLE) {
    const turn = await post("/api/turn", { sessionId: current.sessionId, text: line, live: false });
    assert.equal(turn.status, 200, turn.text);
    current = turn.json;
  }
  assert.equal(current.complete, true);
  assert.match(current.prd.sections.problem, /screen-time/);
  const exported = await fetch(`${base}/api/session/${current.sessionId}/export.md`);
  assert.equal(exported.status, 200);
  const markdown = await exported.text();
  assert.match(markdown, /## Success metrics/);
  assert.match(markdown, /60/);

  const live = await post("/api/turn", { sessionId: created.json.sessionId, text: "A second session answer that should not be recorded.", live: true });
  assert.equal(live.status, 400);
  assert.equal(live.json.code, "no_key");
  const after = await fetch(`${base}/api/session/${current.sessionId}`).then((response) => response.json());
  assert.equal(after.complete, true);
  assert.equal(after.transcript.length, current.transcript.length);

  const fresh = await post("/api/session", {});
  const denied = await post("/api/turn", { sessionId: fresh.json.sessionId, text: SAMPLE[0], live: true });
  assert.equal(denied.status, 400);
  const freshAfter = await fetch(`${base}/api/session/${fresh.json.sessionId}`).then((response) => response.json());
  assert.equal(freshAfter.stageIndex, 0);
  assert.equal(freshAfter.prd.sections.problem, "");
  assert.equal(freshAfter.transcript.length, 1);

  const wav = Buffer.alloc(64).toString("base64");
  const stt = await post("/api/transcribe", { wavBase64: wav });
  assert.equal(stt.status, 400);
  assert.equal(stt.json.code, "no_key");

  const init = await post("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "walkthrough", version: "0" } },
  });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.serverInfo.name, "shape-prd");
  assert.ok(init.headers.get("mcp-session-id"));

  const listed = await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const toolNames = listed.json.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, ["create_prd", "export_prd", "update_prd_section"]);

  const made = await post("/mcp", {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "create_prd", arguments: { sessionId: "mcp-test", title: "Widget", problem: "Widgets break in the rain." } },
  });
  assert.equal(made.json.result.isError, false);
  const updated = await post("/mcp", {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "update_prd_section", arguments: { sessionId: "mcp-test", section: "risks", content: "Plastic cracks." } },
  });
  assert.equal(updated.json.result.isError, false);
  const dumped = await post("/mcp", {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "export_prd", arguments: { sessionId: "mcp-test" } },
  });
  assert.match(dumped.json.result.content[0].text, /Widget/);
  assert.match(dumped.json.result.content[0].text, /Plastic cracks/);

  const ping = await post("/mcp", { jsonrpc: "2.0", id: 6, method: "ping" });
  assert.deepEqual(ping.json.result, {});
  const missing = await post("/mcp", { jsonrpc: "2.0", id: 7, method: "nope" });
  assert.equal(missing.json.error.code, -32601);
  const note = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(note.status, 202);
  assert.equal(await note.text(), "");
}

const child = await startServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
try {
  unit();
  await http();
  console.log("walkthrough ok");
} finally {
  child.kill("SIGTERM");
}
