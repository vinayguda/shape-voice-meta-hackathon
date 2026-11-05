import { sttEngine, sttModel } from "./env.js";
import { encodeWav, resampleInt16, createVad } from "./audio.js";
import { synthesizeSpeech, transcribePcm } from "./inference.js";
import { livekitUrl, mintJoinToken, roomNameFor } from "./livekit.js";
import { takeTurn } from "./interview.js";
import { transcribeWav } from "./muse.js";
import { pushLog, sessions } from "./prd.js";
import { voiceAgents } from "./voice-state.js";

const stopped = () => Object.assign(new Error("stopped"), { code: "stopped" });

function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(stopped());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(stopped());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sleep(ms, signal) {
  return raceAbort(new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
  }), signal);
}

async function publishData(room, message) {
  const local = room.localParticipant;
  if (!local) return;
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  await local.publishData(bytes, { reliable: true, topic: "shape" });
}

async function publishState(room, control, state) {
  control.phase = state;
  const local = room.localParticipant;
  if (!local) return;
  try {
    await local.setAttributes({ "lk.agent.state": state });
  } catch (error) {
    console.error("[shape] voice attribute", error.message);
  }
  try {
    await publishData(room, { type: "state", state });
  } catch (error) {
    console.error("[shape] voice state", error.message);
  }
}

async function playPcm(control, pcm, sampleRate) {
  const source = control.source;
  if (!source || !pcm.length) return;
  const frameSamples = Math.max(1, Math.floor(sampleRate * 0.02));
  for (let offset = 0; offset < pcm.length; offset += frameSamples) {
    if (control.signal.aborted) {
      source.clearQueue();
      return;
    }
    const slice = pcm.subarray(offset, Math.min(pcm.length, offset + frameSamples));
    const copy = new Int16Array(slice);
    const frame = new control.AudioFrame(copy, sampleRate, 1, copy.length);
    const started = Date.now();
    await source.captureFrame(frame);
    const wait = (copy.length / sampleRate) * 1000 - (Date.now() - started);
    if (wait > 8) await sleep(wait, control.signal).catch(() => {});
    if (control.signal.aborted) {
      source.clearQueue();
      return;
    }
  }
  try {
    await source.waitForPlayout();
  } catch {
    /* playout wait is best-effort */
  }
}

async function speakText(control, text) {
  const spoken = String(text || "").trim();
  if (!spoken || control.signal.aborted) return;
  await publishState(control.room, control, "speaking");
  const audio = await synthesizeSpeech(spoken);
  await playPcm(control, audio.pcm, audio.sampleRate);
}

async function hear(session, pcm, sampleRate, live) {
  const audio = resampleInt16(pcm, sampleRate, 16000);
  const useMuse = Boolean(live) && sttEngine() === "muse";
  if (useMuse) {
    try {
      const out = await transcribeWav(encodeWav(audio, 16000));
      pushLog(session, {
        name: "asr/transcribe",
        via: "model",
        transport: "none",
        source: out.model,
        args: { model: out.model, audioEncoding: "WAV", sampleRateHertz: 16000, via: "livekit" },
        summary: `${out.model} · ${out.latencyMs}ms · ${out.text}`,
        result: { live: true, latencyMs: out.latencyMs, audioDurationMs: out.audioDurationMs },
      });
      return out.text;
    } catch (error) {
      pushLog(session, {
        name: "asr/transcribe",
        via: "model",
        transport: "none",
        source: sttModel(),
        ok: false,
        args: { model: sttModel(), via: "livekit" },
        summary: `${error.message} Falling back to LiveKit Inference STT.`,
      });
      console.error("[shape] muse stt", error.message);
    }
  }
  const out = await transcribePcm(audio, 16000);
  pushLog(session, {
    name: "asr/transcribe",
    via: "model",
    transport: "none",
    source: out.model,
    args: { model: out.model, via: "livekit-inference" },
    summary: `${out.model} · ${out.text}`,
    result: { live: true },
  });
  return out.text;
}

async function handleUtterance(control, sessionId, samples, sampleRate) {
  if (control.busy || control.signal.aborted) return;
  const session = sessions.get(sessionId);
  if (!session) return;
  control.busy = true;
  try {
    await publishState(control.room, control, "thinking");
    const text = await hear(session, samples, sampleRate, control.live);
    if (!text || control.signal.aborted) return;
    try {
      await publishData(control.room, { type: "heard", text });
    } catch { /* the poll still shows the transcript */ }
    const result = await takeTurn(session, text, { live: control.live });
    try {
      await publishData(control.room, { type: "updated" });
    } catch { /* browser poll */ }
    const say = result.spoken || result.question || "";
    if (say && !control.signal.aborted) await speakText(control, say);
  } catch (error) {
    if (error?.code === "stopped" || control.signal.aborted) return;
    console.error("[shape] voice turn", error.message);
    try {
      await publishData(control.room, { type: "error", message: error.message || "The voice turn failed." });
    } catch { /* room may be gone */ }
    const apology = error.code === "no_key"
      ? "Live mode needs a Meta API key on the server. Switch to Demo, or keep talking after you do."
      : "I missed that. Say it once more.";
    try {
      await speakText(control, apology);
    } catch (speakError) {
      console.error("[shape] voice apology", speakError.message);
    }
  } finally {
    control.busy = false;
    if (!control.signal.aborted && control.room?.isConnected) {
      try {
        await publishState(control.room, control, "listening");
      } catch { /* disconnect raced the update */ }
    }
  }
}

async function consumeAudio(control, track) {
  const { AudioStream } = control.rtc;
  const stream = new AudioStream(track, { sampleRate: 16000, numChannels: 1, frameSizeMs: 20 });
  const reader = stream.getReader();
  const vad = createVad();
  try {
    while (!control.signal.aborted) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      if (control.phase !== "listening" || control.busy) {
        vad.reset();
        continue;
      }
      const copy = new Int16Array(value.data);
      const event = vad.push({ samples: copy, sampleRate: value.sampleRate || 16000, channels: value.channels || 1 });
      if (event?.type === "utterance") {
        void handleUtterance(control, control.sessionId, event.samples, event.sampleRate);
      }
    }
  } catch (error) {
    if (!control.signal.aborted) console.error("[shape] voice audio", error.message);
  } finally {
    try { await reader.cancel(); } catch { /* stream already closed */ }
  }
}

function armTrack(control, track, TrackKind) {
  if (!track || track.kind !== TrackKind.KIND_AUDIO) return;
  if (control.armedSid && control.armedSid === track.sid) return;
  control.armedSid = track.sid || `audio-${Date.now()}`;
  void consumeAudio(control, track);
}

async function waitForPerson(room, RoomEvent, signal) {
  if (room.remoteParticipants.size > 0 || signal.aborted) return;
  await new Promise((resolve) => {
    const timer = setTimeout(finish, 8000);
    function finish() {
      clearTimeout(timer);
      room.removeListener(RoomEvent.ParticipantConnected, onJoin);
      resolve();
    }
    function onJoin() {
      finish();
    }
    room.on(RoomEvent.ParticipantConnected, onJoin);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function runAgent(control) {
  const rtc = control.rtc;
  const { Room, RoomEvent, AudioSource, AudioFrame, LocalAudioTrack, TrackPublishOptions, TrackSource, TrackKind } = rtc;
  control.AudioFrame = AudioFrame;
  const room = new Room();
  control.room = room;
  const token = await mintJoinToken({
    identity: "shape-agent",
    name: "Shape",
    room: control.roomName,
    attributes: { "lk.agent.state": "initializing" },
  });
  room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
    if (topic && topic !== "shape") return;
    let message;
    try {
      message = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    if (message?.type === "stop") control.abort.abort();
    if (message?.type === "mode") control.live = Boolean(message.live);
  });
  room.on(RoomEvent.TrackSubscribed, (track) => armTrack(control, track, TrackKind));
  room.on(RoomEvent.ParticipantDisconnected, () => {
    if (room.remoteParticipants.size > 0) return;
    control.leaveTimer = setTimeout(() => {
      if (room.remoteParticipants.size === 0) control.abort.abort();
    }, 12000);
  });
  room.on(RoomEvent.ParticipantConnected, () => {
    if (control.leaveTimer) clearTimeout(control.leaveTimer);
  });
  try {
    await raceAbort(
      room.connect(control.url, token, { autoSubscribe: true, dynacast: false }),
      control.signal,
    );
    const source = new AudioSource(24000, 1);
    control.source = source;
    const localTrack = LocalAudioTrack.createAudioTrack("shape-voice", source);
    control.track = localTrack;
    await room.localParticipant.publishTrack(
      localTrack,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.track) armTrack(control, publication.track, TrackKind);
      }
    }
    await publishState(room, control, "initializing");
    await waitForPerson(room, RoomEvent, control.signal);
    if (control.signal.aborted) return;
    const session = sessions.get(control.sessionId);
    const greeting = session?.last?.say || session?.last?.question || "";
    if (greeting) {
      try {
        await speakText(control, greeting);
      } catch (error) {
        console.error("[shape] voice greeting", error.message);
        try {
          await publishData(room, { type: "error", message: `Shape could not speak yet. ${error.message}` });
        } catch { /* still listen */ }
      }
    }
    if (!control.signal.aborted) await publishState(room, control, "listening");
    await new Promise((resolve) => {
      if (control.signal.aborted) resolve();
      else control.signal.addEventListener("abort", resolve, { once: true });
    });
  } catch (error) {
    if (error?.code !== "stopped") console.error("[shape] voice agent", error.message || error);
  } finally {
    if (control.leaveTimer) clearTimeout(control.leaveTimer);
    try { control.source?.clearQueue(); } catch { /* source already closed */ }
    try { await control.track?.close(true); } catch { /* track already closed */ }
    try { await room.disconnect(); } catch { /* already disconnected */ }
    if (voiceAgents.get(control.sessionId) === control) voiceAgents.delete(control.sessionId);
  }
}

export async function ensureVoiceAgent(sessionId, { live }) {
  const existing = voiceAgents.get(sessionId);
  if (existing && !existing.signal.aborted) {
    existing.live = Boolean(live);
    return { reused: true, room: existing.roomName };
  }
  const rtc = await import("@livekit/rtc-node");
  const abort = new AbortController();
  const control = {
    sessionId,
    live: Boolean(live),
    roomName: roomNameFor(sessionId),
    url: livekitUrl(),
    abort,
    signal: abort.signal,
    phase: "initializing",
    busy: false,
    rtc,
    room: null,
    source: null,
    track: null,
  };
  voiceAgents.set(sessionId, control);
  void runAgent(control);
  return { reused: false, room: control.roomName };
}

export async function stopVoiceAgent(sessionId) {
  const control = voiceAgents.get(sessionId);
  if (!control) return false;
  control.abort.abort();
  voiceAgents.delete(sessionId);
  try { control.source?.clearQueue(); } catch { /* not publishing yet */ }
  try { await control.room?.disconnect(); } catch { /* not connected yet */ }
  return true;
}
