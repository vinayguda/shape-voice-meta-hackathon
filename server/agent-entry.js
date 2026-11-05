import { AudioFrame, RoomEvent, combineAudioFrames } from "@livekit/rtc-node";
import {
  AutoSubscribe,
  defineAgent,
  inference,
  llm,
  stt,
  tts,
  voice,
} from "@livekit/agents";
import { DEFAULT_API_CONNECT_OPTIONS } from "@livekit/agents";
import { hasEspeak, speakEspeak } from "./espeak.js";
import { encodeWav, resampleInt16 } from "./audio.js";
import { inferenceSttModel, livekitCloud, ttsModel, ttsVoice, voiceTtsKind } from "./env.js";

const SHAPE_BASE = () => (process.env.SHAPE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");

function latestUserText(chatCtx) {
  const items = chatCtx?.items || [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.type === "message" && item.role === "user" && item.textContent) return String(item.textContent).trim();
  }
  return "";
}

async function postJson(pathname, body) {
  const response = await fetch(`${SHAPE_BASE()}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(70000),
  });
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
  if (!response.ok) {
    const error = new Error(json.error || `Shape ${pathname} failed (${response.status}).`);
    error.code = json.code;
    throw error;
  }
  return json;
}

async function transcribeFrame(frame, sessionId) {
  const pcm = frame.channels > 1
    ? resampleInt16(frame.data, frame.sampleRate, 16000)
    : resampleInt16(frame.data, frame.sampleRate, 16000);
  if (pcm.length < 1600) return "";
  const out = await postJson("/api/transcribe", {
    sessionId,
    wavBase64: encodeWav(pcm, 16000).toString("base64"),
  });
  return String(out.text || "").trim();
}

class MuseSTT extends stt.STT {
  label = "muse-voice-transcribe-1.0";
  constructor(sessionId) {
    super({ streaming: true, interimResults: false });
    this.sessionId = sessionId;
  }
  get model() { return "muse-voice-transcribe-1.0"; }
  get provider() { return "meta"; }
  _recognize(frame) {
    const frames = Array.isArray(frame) ? frame : [frame];
    const combined = frames.length === 1 ? frames[0] : combineAudioFrames(frames);
    return transcribeFrame(combined, this.sessionId).then((text) => ({
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ language: "en", text, startTime: 0, endTime: 0, confidence: 1 }],
    }));
  }
  stream() {
    return new MuseSpeechStream(this);
  }
}

class MuseSpeechStream extends stt.SpeechStream {
  label = "muse-voice-transcribe-1.0";
  constructor(parent) {
    super(parent, 16000, DEFAULT_API_CONNECT_OPTIONS);
    this.parent = parent;
  }
  async run() {
    const frames = [];
    for await (const item of this.input) {
      if (item === stt.SpeechStream.FLUSH_SENTINEL) {
        if (!frames.length) continue;
        const combined = frames.length === 1 ? frames[0] : combineAudioFrames(frames);
        frames.length = 0;
        const text = await transcribeFrame(combined, this.parent.sessionId);
        this.queue.put({
          type: stt.SpeechEventType.FINAL_TRANSCRIPT,
          alternatives: [{
            language: "en",
            text,
            startTime: 0,
            endTime: combined.samplesPerChannel / (combined.sampleRate || 16000),
            confidence: 1,
          }],
        });
      } else if (item) {
        frames.push(item);
      }
    }
  }
}

class ShapeLLM extends llm.LLM {
  constructor(control, room) {
    super();
    this.control = control;
    this.room = room;
  }
  label() { return "muse-spark-1.3"; }
  get model() { return "muse-spark-1.3"; }
  get provider() { return "meta"; }
  chat({ chatCtx, connOptions }) {
    return new ShapeLLMStream(this, chatCtx, connOptions || DEFAULT_API_CONNECT_OPTIONS);
  }
}

class ShapeLLMStream extends llm.LLMStream {
  constructor(parent, chatCtx, connOptions) {
    super(parent, { chatCtx, connOptions });
    this.parent = parent;
  }
  async run() {
    const text = latestUserText(this.chatCtx);
    let spoken = "I didn't catch that. Say it once more.";
    if (text) {
      const result = await postJson("/api/turn", {
        sessionId: this.parent.control.sessionId,
        text,
        live: Boolean(this.parent.control.live),
      });
      spoken = result.spoken || result.question || spoken;
      try {
        const bytes = new TextEncoder().encode(JSON.stringify({ type: "updated" }));
        await this.parent.room?.localParticipant?.publishData(bytes, { reliable: true, topic: "shape" });
      } catch { /* the browser also polls the session */ }
    }
    this.queue.put({
      id: "shape-turn",
      delta: { role: "assistant", content: spoken },
    });
  }
}

function pushFrames(queue, pcm, sampleRate, requestId) {
  const width = Math.max(1, Math.floor(sampleRate * 0.02));
  let final = false;
  for (let offset = 0; offset < pcm.length; offset += width) {
    const end = Math.min(pcm.length, offset + width);
    final = end === pcm.length;
    const copy = new Int16Array(pcm.subarray(offset, end));
    queue.put({
      requestId,
      segmentId: requestId,
      final,
      frame: new AudioFrame(copy, sampleRate, 1, copy.length),
    });
  }
  if (!final && pcm.length) {
    queue.put({
      requestId,
      segmentId: requestId,
      final: true,
      frame: new AudioFrame(new Int16Array(1), sampleRate, 1, 1),
    });
  }
}

class EspeakTTS extends tts.TTS {
  label = "espeak-ng";
  constructor() {
    super(24000, 1, { streaming: true });
  }
  get model() { return "espeak-ng"; }
  get provider() { return "local"; }
  synthesize(text) {
    return new EspeakChunk(text, this);
  }
  stream() {
    return new EspeakStream(this);
  }
}

class EspeakChunk extends tts.ChunkedStream {
  label = "espeak-ng";
  async run() {
    const audio = await speakEspeak(this.inputText);
    pushFrames(this.queue, audio.samples, audio.sampleRate, "espeak");
  }
}

class EspeakStream extends tts.SynthesizeStream {
  label = "espeak-ng";
  async run() {
    let pending = "";
    for await (const item of this.input) {
      if (item === tts.SynthesizeStream.FLUSH_SENTINEL) {
        const text = pending.trim();
        pending = "";
        if (!text) continue;
        this.markStarted();
        const audio = await speakEspeak(text);
        pushFrames(this.queue, audio.samples, audio.sampleRate, "espeak");
      } else {
        pending += item;
      }
    }
    if (pending.trim()) {
      this.markStarted();
      const audio = await speakEspeak(pending);
      pushFrames(this.queue, audio.samples, audio.sampleRate, "espeak");
    }
    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
  }
}

function buildTts() {
  if (voiceTtsKind() === "espeak") {
    if (!hasEspeak()) {
      throw new Error("Local LiveKit needs espeak-ng so the agent can speak into the room. Dev keys cannot call LiveKit Inference. Install espeak-ng, or point LIVEKIT_URL at LiveKit Cloud.");
    }
    return new EspeakTTS();
  }
  return new inference.TTS({
    model: ttsModel(),
    voice: ttsVoice(),
    language: "en",
  });
}

function buildStt(sessionId, live) {
  if (live || !livekitCloud()) return new MuseSTT(sessionId);
  return new inference.STT({ model: inferenceSttModel(), language: "en" });
}

function readJob(ctx) {
  let meta = {};
  try { meta = JSON.parse(ctx.job?.metadata || "{}"); } catch { meta = {}; }
  const roomName = ctx.room?.name || ctx.job?.room?.name || "";
  const sessionId = meta.sessionId || (roomName.startsWith("shape-") ? roomName.slice("shape-".length) : "");
  return { sessionId, live: Boolean(meta.live), roomName };
}

export default defineAgent({
  entry: async (ctx) => {
    const control = readJob(ctx);
    if (!control.sessionId) throw new Error("Shape voice job is missing a session id.");
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    ctx.room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (topic && topic !== "shape") return;
      let message;
      try { message = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
      if (message?.type === "mode") control.live = Boolean(message.live);
      if (message?.type === "stop") ctx.shutdown("stop");
    });
    ctx.room.on(RoomEvent.ParticipantDisconnected, () => {
      if (ctx.room.remoteParticipants.size === 0) ctx.shutdown("user left");
    });
    const session = new voice.AgentSession({
      vad: new inference.VAD({ model: "silero" }),
      stt: buildStt(control.sessionId, control.live),
      llm: new ShapeLLM(control, ctx.room),
      tts: buildTts(),
      turnHandling: {
        turnDetection: "vad",
        interruption: { enabled: true, mode: "vad" },
        preemptiveGeneration: { enabled: false },
      },
    });
    await session.start({
      agent: new voice.Agent({
        instructions: "You are Shape, a voice PM. Speak only the interview reply. Do not invent a different question.",
      }),
      room: ctx.room,
    });
    try {
      const response = await fetch(`${SHAPE_BASE()}/api/session/${control.sessionId}`);
      if (response.ok) {
        const view = await response.json();
        const greeting = view.spoken || view.question;
        if (greeting) session.say(greeting, { allowInterruptions: true, addToChatCtx: false });
      }
    } catch (error) {
      console.error("[shape] voice greeting", error.message);
    }
  },
});
