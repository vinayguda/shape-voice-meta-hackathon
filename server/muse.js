import { baseUrl, maxTokens, metaKey, modelId, sttModel } from "./env.js";

export class MuseError extends Error {
  constructor(message, { status = 502, code = "muse_error" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let dropReasoning = process.env.META_REASONING_EFFORT === "off" || process.env.META_REASONING_EFFORT === "0";

export function shouldDropReasoningEffort(status, bodyText) {
  return status === 400 && /reasoning[_ ]?effort/i.test(bodyText || "");
}

function clipErr(text) {
  return String(text || "").replace(/LLM_[A-Za-z0-9_]+/g, "LLM_…").replace(/\s+/g, " ").trim().slice(0, 180);
}

function mapStatus(status, text) {
  if (status === 401 || status === 403) {
    return new MuseError("Meta rejected META_API_KEY. Check the key, or switch to Demo mode.", { status, code: "auth" });
  }
  if (status === 429) {
    return new MuseError("Meta Model API rate limited this call. Wait a moment, or switch to Demo mode.", { status: 429, code: "rate_limit" });
  }
  return new MuseError(`Meta Model API returned ${status}. ${clipErr(text)}`.trim(), { status: status >= 400 && status < 600 ? status : 502, code: "muse_http" });
}

async function postChat(body) {
  const started = Date.now();
  const response = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${metaKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  console.log(`[shape] ${body.model} chat.completions ${response.status} ${Date.now() - started}ms`);
  return { status: response.status, text };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Muse Spark is a reasoning model. Reasoning tokens count against max_tokens,
// so a small cap (for example 20) comes back as content: null and
// finish_reason: "length". The default cap is 4000. Streaming is off because
// the spoken line usually arrives only after the tool calls, and a reasoning
// model emits those after it finishes thinking.
export async function museChat({ messages, tools, maxTokens: cap }) {
  const key = metaKey();
  if (!key) {
    throw new MuseError("No META_API_KEY on the server.", { status: 400, code: "no_key" });
  }
  const body = {
    model: modelId(),
    messages,
    max_tokens: cap || maxTokens(),
  };
  if (tools?.length) body.tools = tools;
  const effort = (process.env.META_REASONING_EFFORT || "low").trim();
  if (!dropReasoning && effort && effort !== "off") body.reasoning_effort = effort;

  let { status, text } = await postChat(body);
  if (shouldDropReasoningEffort(status, text) && body.reasoning_effort) {
    dropReasoning = true;
    delete body.reasoning_effort;
    console.warn("[shape] reasoning_effort was rejected; retrying without it");
    ({ status, text } = await postChat(body));
  }
  if (status === 429) {
    await delay(800);
    ({ status, text } = await postChat(body));
  }
  if (status < 200 || status >= 300) throw mapStatus(status, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new MuseError("Muse returned a non-JSON body.", { status: 502, code: "bad_response" });
  }
}

export function textContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || part?.content || "").join("");
  }
  return String(content);
}

export function parseToolCalls(message) {
  const list = message?.tool_calls;
  if (!Array.isArray(list)) return [];
  return list
    .map((call, index) => {
      const name = call.function?.name || call.name;
      const raw = call.function?.arguments ?? call.arguments ?? "{}";
      let args = {};
      let bad = false;
      if (typeof raw === "string") {
        try {
          args = raw.trim() ? JSON.parse(raw) : {};
        } catch {
          bad = true;
        }
      } else if (raw && typeof raw === "object") {
        args = raw;
      }
      return { id: call.id || `call_${index}`, name, args, bad };
    })
    .filter((call) => call.name);
}

export function echoToolCalls(message) {
  return (message.tool_calls || []).map((call, index) => ({
    id: call.id || `call_${index}`,
    type: "function",
    function: {
      name: call.function?.name || call.name,
      arguments:
        typeof call.function?.arguments === "string"
          ? call.function.arguments
          : JSON.stringify(call.function?.arguments ?? call.arguments ?? {}),
    },
  }));
}

export function usageOf(data) {
  const usage = data?.usage || {};
  const details = usage.completion_tokens_details || usage.output_tokens_details || {};
  return {
    completionTokens: usage.completion_tokens ?? null,
    reasoningTokens: details.reasoning_tokens ?? usage.reasoning_tokens ?? null,
  };
}

function pullTranscript(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload.trim();
  if (typeof payload.transcript === "string" && payload.transcript.trim()) return payload.transcript.trim();
  if (Array.isArray(payload.turns)) {
    const text = payload.turns.map((turn) => turn.transcript || turn.text || "").filter(Boolean).join(" ").trim();
    if (text) return text;
  }
  if (typeof payload.text === "string") return payload.text.trim();
  return "";
}

// Verified request. audioEncoding is case-sensitive: "WAV" works, "wav" does not.
// sampleRateHertz must be 16000. Do not send LINEAR16 or PCM_S16LE.
export function transcribeRequest(model = sttModel()) {
  return { model, audioEncoding: "WAV", sampleRateHertz: 16000 };
}

export function wavIs16kMono(buffer) {
  if (!buffer || buffer.length < 44) return false;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return false;
  if (buffer.toString("ascii", 8, 12) !== "WAVE") return false;
  const audioFormat = buffer.readUInt16LE(20);
  const channels = buffer.readUInt16LE(22);
  const rate = buffer.readUInt32LE(24);
  const bits = buffer.readUInt16LE(34);
  return audioFormat === 1 && channels === 1 && rate === 16000 && bits === 16;
}

export async function transcribeWav(wavBuffer) {
  if (!metaKey()) {
    throw new MuseError(
      "META_API_KEY is not set, so Muse Voice Transcribe cannot run. Set META_STT=browser to use the Web Speech API.",
      { status: 400, code: "no_key" },
    );
  }
  if (!wavIs16kMono(wavBuffer)) {
    throw new MuseError("Audio must be 16 kHz mono 16-bit WAV.", { status: 400, code: "bad_wav" });
  }
  const request = transcribeRequest();
  const model = request.model;
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
  form.append("audio", new Blob([wavBuffer], { type: "audio/wav" }), "turn.wav");
  const started = Date.now();
  const response = await fetch(`${baseUrl()}/asr/transcribe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${metaKey()}`, Accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  console.log(`[shape] ${model} asr/transcribe ${response.status} ${Date.now() - started}ms`);
  if (!response.ok) {
    throw new MuseError(`Muse Voice Transcribe failed (${response.status}). ${clipErr(text)}`.trim(), {
      status: 502,
      code: "stt_error",
    });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { transcript: text };
  }
  const transcript = pullTranscript(data);
  if (!transcript) {
    throw new MuseError("Muse Voice Transcribe returned no transcript.", { status: 502, code: "stt_empty" });
  }
  return {
    text: transcript,
    model,
    latencyMs: Date.now() - started,
    audioDurationMs: data.audioDurationMs ?? null,
  };
}
