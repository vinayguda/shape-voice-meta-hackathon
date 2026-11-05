import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublicHttpUrl, extractPdfText, loadContext, stripHtml } from "../server/context.js";
import { cleanProse, demoTurn, isUnsure, looksBloated, rewriteProblem, SAMPLE, SAMPLE_CONTEXT, synthesize } from "../server/demo.js";
import { createVad, decodeWav, encodeWav, resampleInt16 } from "../server/audio.js";
import { livekitConfig, livekitHttpUrl, sttEngine, voiceAgentEnabled, voiceTtsKind } from "../server/env.js";
import { brief, decideAdvance, questionFitsStage, routeFor, takeTurn } from "../server/interview.js";
import { shouldDropReasoningEffort, transcribeRequest, wavIs16kMono } from "../server/muse.js";
import { createSession, executeTool, formatScope, titleFrom, toMarkdown } from "../server/prd.js";

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

  const saved = {
    DEMO: process.env.DEMO,
    META_API_KEY: process.env.META_API_KEY,
    MODEL_API_KEY: process.env.MODEL_API_KEY,
    LIVEKIT_URL: process.env.LIVEKIT_URL,
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
    LIVEKIT_AGENT: process.env.LIVEKIT_AGENT,
  };
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
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  delete process.env.LIVEKIT_AGENT;
  assert.equal(livekitConfig().configured, false);
  assert.equal(voiceAgentEnabled(), true);
  process.env.LIVEKIT_URL = "wss://shape-test.livekit.cloud";
  process.env.LIVEKIT_API_KEY = "APIshapeTestKey";
  assert.equal(livekitConfig().configured, false);
  process.env.LIVEKIT_API_SECRET = "secretsecretsecretsecretsecretse";
  assert.equal(livekitConfig().configured, true);
  process.env.LIVEKIT_AGENT = "0";
  assert.equal(voiceAgentEnabled(), false);
  delete process.env.LIVEKIT_AGENT;
  assert.equal(voiceAgentEnabled(), true);
  const tone = new Int16Array(320);
  for (let i = 0; i < tone.length; i += 1) tone[i] = Math.round(Math.sin(i / 4) * 8000);
  const quiet = new Int16Array(320);
  const vad = createVad();
  for (let i = 0; i < 10; i += 1) assert.equal(vad.push({ samples: quiet, sampleRate: 16000, channels: 1 }), null);
  for (let i = 0; i < 2; i += 1) vad.push({ samples: tone, sampleRate: 16000, channels: 1 });
  let dropped = null;
  for (let i = 0; i < 40; i += 1) dropped = vad.push({ samples: quiet, sampleRate: 16000, channels: 1 }) || dropped;
  assert.equal(dropped.type, "drop");
  const heard = createVad();
  for (let i = 0; i < 20; i += 1) heard.push({ samples: tone, sampleRate: 16000, channels: 1 });
  let utterance = null;
  for (let i = 0; i < 40; i += 1) utterance = heard.push({ samples: quiet, sampleRate: 16000, channels: 1 }) || utterance;
  assert.equal(utterance.type, "utterance");
  assert.ok(utterance.samples.length > 1000);
  const stereo = new Int16Array([0, 0, 9000, 9000]);
  const stereoVad = createVad({ minSpeechMs: 0, silenceMs: 1, threshold: 500 });
  stereoVad.push({ samples: stereo, sampleRate: 16000, channels: 2 });
  const stereoEnd = stereoVad.push({ samples: new Int16Array(64), sampleRate: 16000, channels: 1 });
  assert.equal(stereoEnd.type, "utterance");
  const wav = encodeWav(tone, 16000);
  assert.equal(wavIs16kMono(wav), true);
  const decoded = decodeWav(wav);
  assert.equal(decoded.sampleRate, 16000);
  assert.equal(decoded.samples.length, tone.length);
  assert.equal(decoded.samples[10], tone[10]);
  const stretched = resampleInt16(new Int16Array([0, 16000]), 8000, 16000);
  assert.equal(stretched.length, 4);
  process.env.LIVEKIT_URL = "ws://127.0.0.1:7880";
  process.env.LIVEKIT_API_KEY = "devkey";
  process.env.LIVEKIT_API_SECRET = "secret";
  assert.equal(livekitConfig().configured, true);
  assert.equal(livekitHttpUrl(), "http://127.0.0.1:7880");
  assert.equal(voiceTtsKind(), "espeak");
  process.env.LIVEKIT_URL = "wss://shape.livekit.cloud";
  assert.equal(livekitHttpUrl(), "https://shape.livekit.cloud");
  assert.equal(voiceTtsKind(), "inference");
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  assert.equal(voiceTtsKind(), "off");
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
  assert.equal(/^i want\b/i.test(shaped.problem), false);
  assert.equal(shaped.problem.includes("build build"), false);
  assert.match(rewriteProblem("I want to build an app that helps parents track screen time."), /Parents/);
  assert.equal(/I want to build/i.test(rewriteProblem("I want to build an app that helps parents track screen time.")), false);
  assert.match(formatScope("In: weekly summary. Out: No content filtering"), /- content filtering/);
  assert.equal(/No content filtering/.test(formatScope("In: weekly summary. Out: No content filtering")), false);
  assert.equal(isUnsure("I'm not sure."), true);
  assert.equal(isUnsure("you decide"), true);
  const once = createSession();
  executeTool(once, "create_prd", { title: "One", problem: "Parents need a check-in." }, { source: "test" });
  const again = executeTool(once, "create_prd", { title: "Two", problem: "Nope." }, { source: "test" });
  assert.equal(again.result.skipped, true);
  assert.equal(once.prd.title, "One");
  assert.equal(once.toolLog.filter((entry) => entry.name === "create_prd").length, 1);
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
  demoTurn(unsure, "I'm not sure");
  assert.equal(unsure.stageIndex, 1);
  assert.match(unsure.prd.sections.problem, /^Suggested:/);
  assert.equal(/not sure/i.test(unsure.prd.sections.problem), false);

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

async function startServer(listenPort = port, extra = {}) {
  const env = { ...process.env, PORT: String(listenPort), ...extra };
  delete env.META_API_KEY;
  delete env.MODEL_API_KEY;
  delete env.DEMO;
  delete env.META_STT;
  if (!Object.prototype.hasOwnProperty.call(extra, "LIVEKIT_URL")) delete env.LIVEKIT_URL;
  if (!Object.prototype.hasOwnProperty.call(extra, "LIVEKIT_API_KEY")) delete env.LIVEKIT_API_KEY;
  if (!Object.prototype.hasOwnProperty.call(extra, "LIVEKIT_API_SECRET")) delete env.LIVEKIT_API_SECRET;
  if (!Object.prototype.hasOwnProperty.call(extra, "LIVEKIT_AGENT")) delete env.LIVEKIT_AGENT;
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
  assert.equal(health.livekit.configured, false);
  assert.equal(health.livekit.runtime, "off");
  assert.equal(health.livekit.join, "off");
  assert.equal(health.livekit.active, 0);
  assert.equal(health.livekit.agent, "livekit-agents");
  assert.equal(health.livekit.tts, "off");
  assert.equal(health.livekit.sttFallback, "none");

  const gated = await post("/api/livekit/token", { sessionId: "missing" });
  assert.equal(gated.status, 503);
  assert.equal(gated.json.code, "livekit_unconfigured");
  const gatedStop = await post("/api/livekit/stop", { sessionId: "missing" });
  assert.equal(gatedStop.status, 503);
  assert.equal(gatedStop.json.code, "livekit_unconfigured");

  const client = await fetch(`${base}/vendor/livekit-client.esm.js`);
  assert.equal(client.status, 200);
  assert.match(client.headers.get("content-type") || "", /javascript/);
  const clientJs = await client.text();
  assert.match(clientJs, /RoomEvent/);
  assert.match(clientJs, /export\{/);

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

async function pushbackTurn() {
  const savedKey = process.env.META_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.META_API_KEY = "LLM_test_key";
  globalThis.fetch = async (url) => {
    if (!String(url).includes("/chat/completions")) throw new Error(`unexpected fetch ${url}`);
    const body = {
      id: "chatcmpl-pushback",
      model: "muse-spark-1.3",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_upd",
              type: "function",
              function: {
                name: "update_prd_section",
                arguments: JSON.stringify({
                  section: "problem",
                  content: "Parents cannot tell which apps eat the evening. They only notice the fight.",
                }),
              },
            },
            {
              id: "call_commit",
              type: "function",
              function: {
                name: "commit_turn",
                arguments: JSON.stringify({
                  say: "That's still broad. Who feels this on a bad Tuesday?",
                  recommended_answer: "The parent who runs the weekly check-in.",
                  stage: "target_user",
                  pushback: true,
                  interview_complete: false,
                }),
              },
            },
          ],
        },
      }],
      usage: { completion_tokens: 80, completion_tokens_details: { reasoning_tokens: 20 } },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const session = createSession();
    const result = await takeTurn(session, "I want an app that helps parents understand screen time.", { live: true });
    assert.ok(result.sessionId);
    assert.match(session.prd.sections.problem, /Parents/);
    assert.equal(/I'm not sure/i.test(session.prd.sections.problem), false);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.META_API_KEY;
    else process.env.META_API_KEY = savedKey;
  }
}

async function livekitHttp() {
  const listenPort = 3107;
  const origin = `http://127.0.0.1:${listenPort}`;
  const apiKey = "APIshapeTestKey";
  const apiSecret = "secretsecretsecretsecretsecretse";
  const child = await startServer(listenPort, {
    LIVEKIT_URL: "wss://shape-test.livekit.cloud",
    LIVEKIT_API_KEY: apiKey,
    LIVEKIT_API_SECRET: apiSecret,
    LIVEKIT_AGENT: "0",
  });
  const call = async (pathname, body) => {
    const response = await fetch(origin + pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: response.status, json, text };
  };
  try {
    const health = await fetch(`${origin}/api/health`).then((response) => response.json());
    assert.equal(health.livekit.configured, true);
    assert.equal(health.livekit.join, "off");
    assert.equal(health.livekit.tts, "inference");
    assert.equal(health.museConfigured, false);
    assert.equal(health.stt.engine, "browser");
    const created = await call("/api/session", {});
    assert.equal(created.status, 200);
    const missing = await call("/api/livekit/token", { sessionId: "nope" });
    assert.equal(missing.status, 404);
    const issued = await call("/api/livekit/token", { sessionId: created.json.sessionId, live: false });
    assert.equal(issued.status, 200, issued.text);
    assert.equal(issued.json.agent, "disabled");
    assert.equal(issued.json.room, `shape-${created.json.sessionId}`);
    assert.equal(issued.json.url, "wss://shape-test.livekit.cloud");
    const { TokenVerifier } = await import("livekit-server-sdk");
    const claims = await new TokenVerifier(apiKey, apiSecret).verify(issued.json.token);
    assert.equal(claims.sub, issued.json.identity);
    assert.equal(claims.video.room, issued.json.room);
    assert.equal(claims.video.roomJoin, true);
    assert.equal(claims.video.roomCreate, true);
    assert.equal(claims.video.canPublish, true);
    assert.equal(claims.video.canSubscribe, true);
    assert.equal(claims.video.canPublishData, true);
    const { mintJoinToken } = await import("../server/livekit.js");
    process.env.LIVEKIT_URL = "wss://shape-test.livekit.cloud";
    process.env.LIVEKIT_API_KEY = apiKey;
    process.env.LIVEKIT_API_SECRET = apiSecret;
    const agentToken = await mintJoinToken({
      identity: "shape-agent",
      name: "Shape",
      room: issued.json.room,
      attributes: { "lk.agent.state": "initializing" },
    });
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    const agentClaims = await new TokenVerifier(apiKey, apiSecret).verify(agentToken);
    assert.equal(agentClaims.sub, "shape-agent");
    assert.equal(agentClaims.video.room, issued.json.room);
    assert.equal(agentClaims.attributes["lk.agent.state"], "initializing");
    const stopped = await call("/api/livekit/stop", { sessionId: created.json.sessionId });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.json.stopped, false);
    const turn = await call("/api/turn", { sessionId: created.json.sessionId, text: "Parents only notice the fight, not the pattern of screen time.", live: false });
    assert.equal(turn.status, 200, turn.text);
    assert.equal(turn.json.modelCall.live, false);
    const blocked = await call("/api/turn", { sessionId: created.json.sessionId, text: "This must not call Muse.", live: true });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.json.code, "no_key");
  } finally {
    child.kill("SIGTERM");
  }
}

const child = await startServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
try {
  unit();
  await pushbackTurn();
  await http();
  await livekitHttp();
  console.log("walkthrough ok");
} finally {
  child.kill("SIGTERM");
}
