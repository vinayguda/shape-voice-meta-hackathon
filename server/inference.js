import WebSocket from "ws";
import { AccessToken } from "livekit-server-sdk";
import { inferenceSttModel, livekitConfig, ttsModel, ttsVoice } from "./env.js";
import { concatInt16 } from "./audio.js";

const TTS_RATE = 24000;

export function inferenceHttpBase() {
  const override = (process.env.LIVEKIT_INFERENCE_URL || "").trim();
  if (override) return override.replace(/\/$/, "");
  const livekitUrl = (process.env.LIVEKIT_URL || "").toLowerCase();
  if (livekitUrl.includes(".staging.livekit.cloud")) return "https://agent-gateway.staging.livekit.cloud/v1";
  return "https://agent-gateway.livekit.cloud/v1";
}

export function inferenceWsBase() {
  return inferenceHttpBase().replace(/^http/i, "ws");
}

export function ttsSessionCreate({ model = ttsModel(), voice = ttsVoice(), sampleRate = TTS_RATE } = {}) {
  return {
    type: "session.create",
    sample_rate: String(sampleRate),
    encoding: "pcm_s16le",
    model,
    voice,
    language: "en",
    extra: {},
  };
}

export function sttSessionCreate({ model = inferenceSttModel(), sampleRate = 16000 } = {}) {
  return {
    type: "session.create",
    model,
    settings: {
      sample_rate: String(sampleRate),
      encoding: "pcm_s16le",
      language: "en",
      extra: {},
    },
  };
}

async function inferenceToken() {
  const { apiKey, apiSecret } = livekitConfig();
  const token = new AccessToken(apiKey, apiSecret, { identity: "shape-inference", ttl: "10m" });
  token.addInferenceGrant({ perform: true });
  return token.toJwt();
}

function connectSocket(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("LiveKit inference connection timed out."));
    }, timeoutMs);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error("LiveKit inference connection failed."));
    });
  });
}

function parseMessage(data) {
  const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  return JSON.parse(text);
}

export async function synthesizeSpeech(text, { model = ttsModel(), voice = ttsVoice() } = {}) {
  const spoken = String(text || "").replace(/\s+/g, " ").trim().slice(0, 1500);
  if (!spoken) return { pcm: new Int16Array(), sampleRate: TTS_RATE, model };
  const socket = await connectSocket(
    `${inferenceWsBase()}/tts`,
    { Authorization: `Bearer ${await inferenceToken()}` },
    10000,
  );
  const parts = [];
  try {
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("LiveKit TTS timed out."));
      }, 25000);
      socket.on("message", (data) => {
        let event;
        try {
          event = parseMessage(data);
        } catch {
          return;
        }
        if (event.type === "output_audio" && event.audio) {
          const bytes = Buffer.from(event.audio, "base64");
          const aligned = Buffer.from(bytes);
          parts.push(new Int16Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 2)));
        } else if (event.type === "done" || event.type === "session.closed") {
          clearTimeout(timer);
          resolve();
        } else if (event.type === "error") {
          clearTimeout(timer);
          reject(new Error(event.message || "LiveKit TTS failed."));
        }
      });
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("LiveKit TTS failed."));
      });
    });
    socket.send(JSON.stringify(ttsSessionCreate({ model, voice, sampleRate: TTS_RATE })));
    socket.send(JSON.stringify({
      type: "input_transcript",
      transcript: spoken,
      generation_config: { model, voice, language: "en" },
      extra: {},
    }));
    socket.send(JSON.stringify({ type: "session.flush" }));
    await done;
  } finally {
    try { socket.close(); } catch { /* already closed */ }
  }
  const pcm = concatInt16(parts.map((part) => new Int16Array(part)));
  if (!pcm.length) throw new Error("LiveKit TTS returned no audio.");
  return { pcm, sampleRate: TTS_RATE, model };
}

export async function transcribePcm(pcm, sampleRate = 16000) {
  const model = inferenceSttModel();
  const audio = pcm instanceof Int16Array ? pcm : Int16Array.from(pcm || []);
  if (audio.length < 1600) throw new Error("That clip was too short to transcribe.");
  const socket = await connectSocket(
    `${inferenceWsBase()}/stt?model=${encodeURIComponent(model)}`,
    { Authorization: `Bearer ${await inferenceToken()}` },
    10000,
  );
  const finals = [];
  let markCreated = () => {};
  const created = new Promise((resolve) => {
    markCreated = resolve;
  });
  try {
    let settled = false;
    let grace;
    const done = new Promise((resolve, reject) => {
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        if (error && !finals.length) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        socket.terminate();
        finish(new Error("LiveKit STT timed out."));
      }, 20000);
      socket.on("message", (data) => {
        let event;
        try {
          event = parseMessage(data);
        } catch {
          return;
        }
        if (event.type === "session.created") markCreated();
        if (event.type === "final_transcript" && event.transcript) {
          finals.push(String(event.transcript).trim());
          clearTimeout(grace);
          grace = setTimeout(() => finish(), 500);
        }
        if (event.type === "session.closed" || event.type === "session.finalized") finish();
        else if (event.type === "error") finish(new Error(event.message || "LiveKit STT failed."));
      });
      socket.once("close", () => finish());
      socket.once("error", (error) => {
        finish(error instanceof Error ? error : new Error("LiveKit STT failed."));
      });
    });
    done.catch(() => {});
    socket.send(JSON.stringify(sttSessionCreate({ model, sampleRate })));
    await Promise.race([created, new Promise((resolve) => setTimeout(resolve, 1500))]);
    const chunk = 3200;
    for (let offset = 0; offset < audio.length; offset += chunk) {
      const slice = audio.subarray(offset, Math.min(audio.length, offset + chunk));
      const bytes = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
      socket.send(JSON.stringify({ type: "input_audio", audio: bytes.toString("base64") }));
    }
    socket.send(JSON.stringify({ type: "session.finalize" }));
    await done;
  } finally {
    try { socket.close(); } catch { /* already closed */ }
  }
  const text = finals.join(" ").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("LiveKit STT returned no transcript.");
  return { text, model: `livekit:${model}` };
}
