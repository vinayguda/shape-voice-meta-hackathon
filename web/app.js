"use strict";

const $ = (id) => document.getElementById(id);
const banner = $("banner");
const questionEl = $("question");
const kickerEl = $("question-kicker");
const card = $("question-card");
const recommendBtn = $("recommended");
const transcriptEl = $("transcript");
const composer = $("composer");
const interimEl = $("interim");
const micBtn = $("mic");
const sendBtn = $("send");
const statusEl = $("status");
const modelPill = $("model-pill");
const demoBtn = $("mode-demo");
const liveBtn = $("mode-live");
const voiceBox = $("voice");
const sttLabel = $("stt-label");
const sttBrowser = $("stt-browser");
const micEngine = $("mic-engine");
const voiceAgentBtn = $("voice-agent");
const voiceStateEl = $("voice-state");

let health = { model: "muse-spark-1.3", museConfigured: false, forceDemo: false, stt: {} };
let fillerAt = 0;
let state = null;
let live = false;
let busy = false;
let runToken = 0;
let voiceOn = true;
let recognition = null;
let listening = false;
let recToken = 0;
let recorder = null;
let recordStream = null;
let voiceAgentOn = false;
let voiceConnecting = false;
let voiceRoom = null;
let voicePoll = 0;
let voicePhase = "";

function showBanner(message) {
  banner.hidden = false;
  banner.textContent = message;
}

function clearBanner() {
  banner.hidden = true;
  banner.textContent = "";
}

function setBusy(next) {
  busy = next;
  document.body.classList.toggle("is-busy", next);
  card.classList.toggle("thinking", next && live);
  const thinking = $("thinking");
  if (thinking) {
    thinking.hidden = !(next && live);
    thinking.textContent = `Thinking… ${health.model || "muse-spark-1.3"}`;
  }
  sendBtn.disabled = next;
  micBtn.disabled = next && !listening;
  renderStatus();
}

function setMode(next) {
  live = Boolean(next);
  demoBtn.classList.toggle("on", !live);
  liveBtn.classList.toggle("on", live);
  demoBtn.setAttribute("aria-pressed", String(!live));
  liveBtn.setAttribute("aria-pressed", String(live));
  modelPill.textContent = live && health.museConfigured ? health.model : live ? `${health.model} · no key` : `${health.model} · demo`;
  publishVoiceMode();
  renderMicEngine();
  renderStatus();
}

function renderStatus() {
  if (!state) return;
  if (voiceAgentOn && voicePhase) {
    statusEl.textContent = voiceStateEl.textContent || `Voice agent · ${voicePhase}`;
    return;
  }
  if (busy) {
    statusEl.textContent = live ? `Thinking… ${health.model}` : "Updating the PRD…";
    return;
  }
  if (live && !health.museConfigured) {
    statusEl.textContent = "Live needs META_API_KEY on the server. Demo still runs the full interview.";
    return;
  }
  const model = state.lastModel;
  if (live && model?.live) {
    const bits = [model.model, `${model.latencyMs} ms`];
    if (model.reasoningTokens) bits.push(`${model.reasoningTokens} reasoning tokens`);
    if (model.note) bits.push(model.note);
    statusEl.textContent = bits.join(" · ");
    return;
  }
  statusEl.textContent = live
    ? `Live · the next answer calls ${health.model}`
    : "Demo · canned interview, no API call.";
}

function paint(data, changed = []) {
  state = data;
  kickerEl.textContent = data.kicker || "";
  questionEl.textContent = data.question || data.spoken || "";
  card.classList.toggle("pushback", Boolean(data.pushback));
  if (data.recommended) {
    recommendBtn.hidden = false;
    recommendBtn.textContent = `If you're unsure, say: ${data.recommended}`;
  } else {
    recommendBtn.hidden = true;
    recommendBtn.textContent = "";
  }
  renderStages();
  renderTranscript();
  renderPrd(changed);
  renderLog();
  renderStatus();
}

function renderStages() {
  const rail = $("stage-rail");
  rail.replaceChildren();
  (state.stages || []).forEach((stage, index) => {
    const item = document.createElement("li");
    const done = state.complete || index < state.stageIndex;
    const now = !state.complete && index === state.stageIndex;
    item.className = done ? "done" : now ? "now" : "";
    item.textContent = `${index + 1} ${stage.short}`;
    rail.append(item);
  });
}

function renderTranscript() {
  transcriptEl.replaceChildren();
  for (const line of state.transcript || []) {
    const wrap = document.createElement("div");
    wrap.className = `bubble ${line.role === "user" ? "user" : "shape"}`;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = line.role === "user" ? "You" : "Shape";
    const text = document.createElement("p");
    text.textContent = line.text;
    wrap.append(who, text);
    transcriptEl.append(wrap);
  }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function renderPrd(changed) {
  const prd = state.prd;
  const title = $("prd-title");
  title.textContent = prd.title || "Untitled PRD";
  const status = $("prd-status");
  status.textContent = prd.status === "ready" ? "Ready" : "Draft";
  status.classList.toggle("ready", prd.status === "ready");
  const meta = state.sections || [];
  const filled = meta.filter((section) => (prd.sections[section.id] || "").trim()).length;
  $("prd-filled").textContent = `${filled} / ${meta.length} sections`;
  const root = $("prd-sections");
  root.replaceChildren();
  let freshNode = null;
  meta.forEach((section, index) => {
    const block = document.createElement("section");
    block.className = "sec";
    if (changed.includes(section.id)) {
      block.classList.add("fresh");
      freshNode = block;
    }
    const heading = document.createElement("h2");
    heading.textContent = `${String(index + 1).padStart(2, "0")}  ${section.label}`;
    const body = document.createElement("p");
    const value = (prd.sections[section.id] || "").trim();
    if (value) {
      body.className = "body";
      body.textContent = value;
    } else {
      body.className = "placeholder";
      body.textContent = "Fills in as you answer.";
    }
    block.append(heading, body);
    root.append(block);
  });
  const started = (state.transcript || []).some((line) => line.role === "user");
  const loaded = Boolean(state.context?.loaded);
  const panel = $("context-panel");
  const chip = $("context-chip");
  if (panel) panel.hidden = started || loaded;
  if (chip) {
    chip.hidden = !loaded;
    chip.textContent = loaded ? `Context loaded · ${state.context.label}` : "";
  }
  if (freshNode) {
    const sheet = freshNode.closest(".sheet");
    if (sheet && freshNode.offsetTop > sheet.clientHeight * 0.45) {
      freshNode.scrollIntoView({ block: "nearest" });
    }
  }
}

function renderLog() {
  const log = $("tool-log");
  const entries = state.toolLog || [];
  $("tool-count").textContent = String(entries.length);
  log.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty-log";
    empty.textContent = "PRD tools land here, and each mic clip logs muse-voice-transcribe-1.0. The same PRD tools are served at POST /mcp.";
    log.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = entry.ok === false ? "entry bad" : "entry";
    const time = document.createElement("time");
    time.textContent = new Date(entry.at).toLocaleTimeString([], { hour12: false });
    const tag = document.createElement("span");
    const kind = entry.via === "model" ? "model" : entry.via === "agent" ? "agent" : entry.via === "tool" ? "tool" : "";
    tag.className = `tag ${kind}`;
    tag.textContent = entry.via === "model" ? "model" : entry.via === "agent" ? "agent" : entry.via === "tool" ? "tool" : "mcp-tool";
    const rest = document.createElement("div");
    rest.className = "rest";
    const name = document.createElement("strong");
    name.textContent = entry.name;
    rest.append(name, document.createTextNode(`  ${entry.summary || ""}`));
    if (entry.transport && entry.transport !== "none") {
      rest.append(document.createTextNode(`  · ${entry.transport}`));
    }
    if (entry.source) rest.append(document.createTextNode(`  · ${entry.source}`));
    row.append(time, tag, rest);
    log.append(row);
  }
  log.scrollTop = log.scrollHeight;
}

async function startSession(token = runToken) {
  const response = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const data = await response.json();
  if (token !== runToken) return;
  if (!response.ok) {
    showBanner(data.error || "Could not start a session.");
    return;
  }
  clearBanner();
  composer.value = "";
  paint(data, []);
}

async function sendText(raw, token = runToken) {
  const text = String(raw || "").trim();
  if (!text || busy || !state) return;
  if (token !== runToken) return;
  const previous = composer.value;
  composer.value = "";
  interimEl.textContent = "";
  setBusy(true);
  clearBanner();
  speakFiller();
  try {
    const response = await fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, text, live }),
      signal: AbortSignal.timeout(70000),
    });
    const data = await response.json();
    if (token !== runToken) return;
    if (!response.ok) {
      composer.value = previous || text;
      showBanner(data.error || "The turn failed.");
      return;
    }
    paint(data, data.changedSections || []);
    if (voiceOn) speak(data.spoken || data.question);
  } catch (error) {
    if (token !== runToken) return;
    composer.value = previous || text;
    showBanner(error.name === "TimeoutError" ? "The model took too long. Try Demo mode." : "Can't reach the Shape server.");
  } finally {
    if (token === runToken) setBusy(false);
  }
}

function speakFiller() {
  if (!voiceOn || !live) return;
  if (Date.now() - fillerAt < 4000) return;
  fillerAt = Date.now();
  speak("Got it.");
}

function speak(text) {
  if (voiceAgentOn || !voiceOn || !text || !window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.02;
    const voices = window.speechSynthesis.getVoices();
    const voice =
      voices.find((item) => /en-US/i.test(item.lang) && /natural|premium|google/i.test(item.name)) ||
      voices.find((item) => /^en/i.test(item.lang));
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  } catch {
    /* speech is optional */
  }
}

function cancelMic() {
  recToken += 1;
  listening = false;
  micBtn.classList.remove("listening");
  micBtn.setAttribute("aria-pressed", "false");
  micBtn.textContent = "Mic";
  if (recognition) {
    try { recognition.abort(); } catch { /* already stopped */ }
  }
  if (recorder && recorder.state === "recording") {
    try { recorder.stop(); } catch { /* already stopped */ }
  }
  if (recordStream) recordStream.getTracks().forEach((track) => track.stop());
}

function useMuseMic() {
  return live && health.stt?.engine === "muse" && !sttBrowser.checked;
}

function renderMicEngine() {
  const museMic = useMuseMic();
  sttLabel.hidden = !(live && health.stt?.engine === "muse");
  micEngine.textContent = museMic
    ? "Mic: push to talk, then muse-voice-transcribe-1.0."
    : "Mic: browser speech. Demo mode does not call Meta. Live uses Muse Voice Transcribe when a key is set.";
}

function toggleMic() {
  if (listening) {
    if (recorder && recorder.state === "recording") recorder.stop();
    else if (recognition) recognition.stop();
    return;
  }
  if (useMuseMic()) {
    startMuseRec().catch((error) => showBanner(error.message || "Could not record audio."));
    return;
  }
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) {
    showBanner("This browser has no Web Speech API. Type the answer, or use Chrome.");
    return;
  }
  window.speechSynthesis?.cancel();
  const token = ++recToken;
  let finalText = "";
  recognition = new Rec();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;
  listening = true;
  micBtn.classList.add("listening");
  micBtn.setAttribute("aria-pressed", "true");
  micBtn.textContent = "Listening";
  recognition.onresult = (event) => {
    let interim = "";
    finalText = "";
    for (let i = 0; i < event.results.length; i += 1) {
      const piece = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += piece;
      else interim += piece;
    }
    interimEl.textContent = interim || finalText;
  };
  recognition.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    showBanner(event.error === "not-allowed" ? "Microphone blocked. Type your answer instead." : `Speech recognition error: ${event.error}`);
  };
  recognition.onend = () => {
    listening = false;
    micBtn.classList.remove("listening");
    micBtn.setAttribute("aria-pressed", "false");
    micBtn.textContent = "Mic";
    if (token !== recToken) return;
    const said = (finalText || interimEl.textContent || "").trim();
    interimEl.textContent = "";
    if (said) sendText(said);
  };
  recognition.start();
}

async function startMuseRec() {
  window.speechSynthesis?.cancel();
  recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks = [];
  recorder = new MediaRecorder(recordStream);
  listening = true;
  micBtn.classList.add("listening");
  micBtn.setAttribute("aria-pressed", "true");
  micBtn.textContent = "Stop";
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  recorder.onstop = async () => {
    listening = false;
    micBtn.classList.remove("listening");
    micBtn.setAttribute("aria-pressed", "false");
    micBtn.textContent = "Mic";
    recordStream.getTracks().forEach((track) => track.stop());
    speakFiller();
    setBusy(true);
    statusEl.textContent = "Transcribing with muse-voice-transcribe-1.0…";
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      const wav = await blobToWav(blob);
      const wavBase64 = bufferToBase64(wav);
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wavBase64, sessionId: state?.sessionId }),
      });
      const data = await response.json();
      if (data.toolLog && state) {
        state.toolLog = data.toolLog;
        renderLog();
      }
      if (!response.ok) {
        showBanner(`${data.error || "Transcription failed."} Check Browser speech fallback, or set META_STT=browser.`);
        return;
      }
      interimEl.textContent = data.text;
      await sendText(data.text);
    } catch (error) {
      showBanner(error.message || "Could not transcribe that clip.");
    } finally {
      setBusy(false);
    }
  };
  recorder.start();
}

async function blobToWav(blob) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  await ctx.close();
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), rate);
}

function encodeWav(samples, rate) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const write = (offset, value) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function downloadPrd() {
  if (!state || busy) return;
  setBusy(true);
  try {
    const response = await fetch("/api/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, name: "export_prd", arguments: {} }),
    });
    const data = await response.json();
    if (!response.ok) {
      showBanner(data.error || "Export failed.");
      return;
    }
    paint(data, []);
    const blob = new Blob([data.result.markdown], { type: "text/markdown" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = data.result.filename || "prd.md";
    link.click();
    URL.revokeObjectURL(link.href);
  } finally {
    setBusy(false);
  }
}

async function loadContext(payload, token = runToken) {
  if (!state) return;
  const response = await fetch(`/api/session/${state.sessionId}/context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (token !== runToken) return;
  if (!response.ok) {
    showBanner(data.error || "Could not load that context.");
    return;
  }
  clearBanner();
  paint(data, []);
}

async function submitContext() {
  if (!state || busy) return;
  const notes = $("context-notes").value.trim();
  const url = $("context-url").value.trim();
  const file = $("context-file").files?.[0];
  if (!notes && !url && !file) {
    showBanner("Paste notes, choose a file, or add a URL.");
    return;
  }
  const payload = { text: notes, source: url ? "url" : file ? "file" : "paste", label: "notes" };
  if (file) {
    const name = file.name.toLowerCase();
    payload.label = file.name;
    if (name.endsWith(".pdf")) payload.pdfBase64 = bufferToBase64(await file.arrayBuffer());
    else if (name.endsWith(".md") || name.endsWith(".txt") || name.endsWith(".markdown")) payload.text = `${notes}\n\n${await file.text()}`.trim();
    else {
      showBanner("Upload a .md, .txt, or .pdf file.");
      return;
    }
  }
  if (url) payload.url = url;
  setBusy(true);
  try {
    await loadContext(payload);
  } finally {
    setBusy(false);
  }
}

async function playSample() {
  if (voiceAgentOn || voiceConnecting) await stopVoiceAgent();
  if (live && !health.museConfigured) {
    showBanner("The sample can run in Demo with no key. Live mode needs META_API_KEY.");
    return;
  }
  if (live && !window.confirm("Play the 7-turn sample through Muse Spark?")) return;
  const token = ++runToken;
  cancelMic();
  const payload = await fetch("/api/sample").then((response) => response.json());
  await startSession(token);
  if (token === runToken && payload.context) await loadContext({ text: payload.context, source: "sample", label: "sample notes" }, token);
  const previousVoice = voiceOn;
  voiceOn = false;
  try {
    for (let i = 0; i < payload.turns.length; i += 1) {
      if (token !== runToken) return;
      statusEl.textContent = `Sample ${i + 1} of ${payload.turns.length}`;
      await sendText(payload.turns[i], token);
      if (token !== runToken) return;
    }
  } finally {
    voiceOn = previousVoice;
  }
  if (token === runToken && voiceOn && state) speak(state.spoken || state.question);
}

const VOICE_LABELS = {
  initializing: "Connecting",
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

function setVoicePhase(next) {
  voicePhase = next || "";
  if (!voiceStateEl) return;
  if (!voiceAgentOn || !voicePhase) {
    voiceStateEl.hidden = true;
    voiceStateEl.textContent = "";
    voiceStateEl.dataset.state = "";
    if (!busy) card.classList.remove("thinking");
    const thinking = $("thinking");
    if (thinking && !busy) thinking.hidden = true;
    renderStatus();
    return;
  }
  const label = VOICE_LABELS[voicePhase] || voicePhase;
  voiceStateEl.hidden = false;
  voiceStateEl.dataset.state = voicePhase;
  voiceStateEl.textContent = `Voice agent · ${label}`;
  const thinkingNow = voicePhase === "thinking";
  card.classList.toggle("thinking", thinkingNow);
  const thinking = $("thinking");
  if (thinking) {
    thinking.hidden = !thinkingNow;
    thinking.textContent = `Thinking… ${health.model || "muse-spark-1.3"}`;
  }
  renderStatus();
}

function setVoiceControls(active) {
  voiceAgentOn = active;
  if (!voiceAgentBtn) return;
  voiceAgentBtn.classList.toggle("on", active);
  voiceAgentBtn.setAttribute("aria-pressed", String(active));
  voiceAgentBtn.textContent = active ? "Stop voice" : "Voice agent";
  micBtn.disabled = active;
  sendBtn.disabled = active || busy;
  composer.disabled = active;
  recommendBtn.disabled = active;
}

function loadLiveKit() {
  if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/livekit-client.umd.js";
    script.onload = () => (window.LivekitClient ? resolve(window.LivekitClient) : reject(new Error("LiveKit client did not load.")));
    script.onerror = () => reject(new Error("Could not load the LiveKit browser client."));
    document.head.append(script);
  });
}

function publishVoiceMode() {
  if (!voiceRoom || !voiceAgentOn) return;
  const payload = new TextEncoder().encode(JSON.stringify({ type: "mode", live }));
  voiceRoom.localParticipant?.publishData(payload, { reliable: true, topic: "shape" }).catch(() => {});
}

function detachVoiceAudio() {
  document.querySelectorAll("audio[data-shape-voice]").forEach((element) => element.remove());
}

async function refreshVoiceSession() {
  if (!voiceAgentOn || !state) return;
  const response = await fetch(`/api/session/${state.sessionId}`);
  const data = await response.json();
  if (!voiceAgentOn || !response.ok) return;
  const previous = state;
  const changed = (data.sections || []).map((section) => section.id).filter((id) => (
    (previous.prd?.sections?.[id] || "") !== (data.prd?.sections?.[id] || "")
  ));
  const moved = data.transcript?.length !== previous.transcript?.length
    || data.toolLog?.length !== previous.toolLog?.length
    || data.stageIndex !== previous.stageIndex
    || data.question !== previous.question
    || data.prd?.updatedAt !== previous.prd?.updatedAt
    || changed.length;
  if (moved) paint(data, changed);
}

function watchVoiceRoom(room, LK) {
  room.on(LK.RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== LK.Track.Kind.Audio) return;
    const element = track.attach();
    element.dataset.shapeVoice = "1";
    element.autoplay = true;
    document.body.append(element);
  });
  room.on(LK.RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
    if (topic && topic !== "shape") return;
    let message;
    try { message = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
    if (message.type === "state") setVoicePhase(message.state);
    if (message.type === "heard") interimEl.textContent = message.text || "";
    if (message.type === "updated") refreshVoiceSession().catch(() => {});
    if (message.type === "error" && message.message) showBanner(message.message);
  });
  room.on(LK.RoomEvent.ParticipantAttributesChanged, (_changed, participant) => {
    const next = participant?.attributes?.["lk.agent.state"];
    if (next) setVoicePhase(next);
  });
}

function waitForShape(room, LK) {
  const present = [...room.remoteParticipants.values()].some((participant) => participant.identity === "shape-agent");
  if (present) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      room.off(LK.RoomEvent.ParticipantConnected, onJoin);
      resolve(false);
    }, 20000);
    function onJoin(participant) {
      if (participant.identity !== "shape-agent") return;
      clearTimeout(timer);
      room.off(LK.RoomEvent.ParticipantConnected, onJoin);
      resolve(true);
    }
    room.on(LK.RoomEvent.ParticipantConnected, onJoin);
  });
}

async function beginVoice(room, LK) {
  cancelMic();
  window.speechSynthesis?.cancel();
  setVoicePhase("connecting");
  const response = await fetch("/api/livekit/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: state.sessionId, live }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not start the voice agent.");
  if (data.agent === "disabled") throw new Error("The server has LIVEKIT_AGENT=0, so it will not join the room.");
  await Promise.race([
    room.connect(data.url, data.token),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Timed out joining the LiveKit room. Check LIVEKIT_URL.")), 15000);
    }),
  ]);
  room.on(LK.RoomEvent.Disconnected, () => {
    if (voiceRoom === room) stopVoiceAgent({ remote: true });
  });
  await room.startAudio();
  await room.localParticipant.setMicrophoneEnabled(true, {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
  publishVoiceMode();
  const joined = await waitForShape(room, LK);
  if (!joined && voiceRoom === room) {
    throw new Error("Shape did not join the LiveKit room. Check LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET on the server.");
  }
  if (!voicePhase || voicePhase === "connecting") setVoicePhase("listening");
  voicePoll = window.setInterval(() => { refreshVoiceSession().catch(() => {}); }, 1000);
}

async function startVoiceAgent() {
  if (!health.livekit?.configured || !state) return;
  if (voiceAgentOn || voiceConnecting) {
    await stopVoiceAgent();
    return;
  }
  const LK = window.LivekitClient;
  if (!LK) {
    showBanner("LiveKit client is still loading. Try the button again.");
    return;
  }
  voiceConnecting = true;
  clearBanner();
  const room = new LK.Room();
  voiceRoom = room;
  setVoiceControls(true);
  watchVoiceRoom(room, LK);
  try {
    await room.startAudio();
    await beginVoice(room, LK);
  } catch (error) {
    if (voiceRoom === room) {
      showBanner(error.message || "Could not start the voice agent.");
      await stopVoiceAgent();
    }
  } finally {
    voiceConnecting = false;
  }
}

async function stopVoiceAgent({ remote = false } = {}) {
  const room = voiceRoom;
  const sessionId = state?.sessionId;
  voiceRoom = null;
  voiceConnecting = false;
  if (voicePoll) window.clearInterval(voicePoll);
  voicePoll = 0;
  setVoiceControls(false);
  setVoicePhase("");
  detachVoiceAudio();
  interimEl.textContent = "";
  if (room) {
    try {
      const payload = new TextEncoder().encode(JSON.stringify({ type: "stop" }));
      await room.localParticipant?.publishData(payload, { reliable: true, topic: "shape" });
    } catch { /* already disconnected */ }
    try { await room.disconnect(); } catch { /* already disconnected */ }
  }
  if (sessionId && health.livekit?.configured) {
    fetch("/api/livekit/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
  }
}

function bind() {
  demoBtn.addEventListener("click", () => setMode(false));
  liveBtn.addEventListener("click", () => {
    if (health.forceDemo) return;
    setMode(true);
  });
  $("reset").addEventListener("click", () => {
    runToken += 1;
    cancelMic();
    window.speechSynthesis?.cancel();
    stopVoiceAgent().finally(() => startSession(runToken));
  });
  $("sample").addEventListener("click", () => { playSample().catch((error) => showBanner(error.message)); });
  $("context-load").addEventListener("click", () => { submitContext().catch((error) => showBanner(error.message)); });
  $("speak").addEventListener("click", () => { voiceOn = true; voiceBox.checked = true; speak(state?.spoken || questionEl.textContent); });
  recommendBtn.addEventListener("click", () => {
    if (!state?.recommended) return;
    sendText(state.recommended);
  });
  $("composer-form").addEventListener("submit", (event) => {
    event.preventDefault();
    sendText(composer.value);
  });
  composer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendText(composer.value);
    }
  });
  micBtn.addEventListener("click", toggleMic);
  voiceAgentBtn?.addEventListener("click", () => { startVoiceAgent().catch((error) => showBanner(error.message)); });
  $("download").addEventListener("click", () => { downloadPrd().catch((error) => showBanner(error.message)); });
  voiceBox.addEventListener("change", () => {
    voiceOn = voiceBox.checked;
    if (!voiceOn) window.speechSynthesis?.cancel();
  });
}

async function boot() {
  bind();
  try {
    const response = await fetch("/api/health");
    health = await response.json();
  } catch {
    showBanner("Can't reach the Shape server.");
    return;
  }
  sttBrowser.checked = false;
  if (health.forceDemo) liveBtn.disabled = true;
  if (health.livekit?.configured && voiceAgentBtn) {
    voiceAgentBtn.hidden = false;
    loadLiveKit().catch(() => {});
  }
  setMode(!health.forceDemo && health.museConfigured);
  await startSession(runToken);
  window.speechSynthesis?.getVoices();
}

boot();
