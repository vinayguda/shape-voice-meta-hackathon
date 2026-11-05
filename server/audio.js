export function rmsInt16(samples) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export function downmix(samples, channels = 1) {
  const pcm = samples instanceof Int16Array ? samples : Int16Array.from(samples || []);
  const width = Math.max(1, channels | 0);
  if (width === 1) return pcm;
  const frames = Math.floor(pcm.length / width);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < width; c += 1) sum += pcm[i * width + c];
    out[i] = Math.round(sum / width);
  }
  return out;
}

export function concatInt16(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function resampleInt16(input, fromRate, toRate) {
  const pcm = input instanceof Int16Array ? input : Int16Array.from(input || []);
  if (!pcm.length || !fromRate || !toRate || fromRate === toRate) return pcm;
  const outLen = Math.max(1, Math.round((pcm.length * toRate) / fromRate));
  const out = new Int16Array(outLen);
  const scale = fromRate / toRate;
  const last = pcm.length - 1;
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * scale;
    const i0 = Math.min(last, Math.floor(pos));
    const i1 = Math.min(last, i0 + 1);
    const frac = pos - i0;
    out[i] = Math.round(pcm[i0] * (1 - frac) + pcm[i1] * frac);
  }
  return out;
}

export function encodeWav(samples, rate = 16000) {
  const pcm = samples instanceof Int16Array ? samples : Int16Array.from(samples || []);
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const buffer = Buffer.alloc(44 + data.length);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + data.length, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(data.length, 40);
  data.copy(buffer, 44);
  return buffer;
}

// Energy turn detector. Frames are copied by the caller. Silence does not
// emit. A short blip is dropped. Speech followed by silence returns one utterance.
export function createVad({
  threshold = 500,
  silenceMs = 700,
  minSpeechMs = 250,
  prefixMs = 200,
  maxSpeechMs = 20000,
} = {}) {
  let speaking = false;
  let silenceSamples = 0;
  let speechSamples = 0;
  let sampleRate = 16000;
  let prefix = [];
  let prefixSamples = 0;
  let utter = [];

  function finish(kind) {
    const chunks = utter;
    speaking = false;
    silenceSamples = 0;
    speechSamples = 0;
    utter = [];
    prefix = [];
    prefixSamples = 0;
    if (kind !== "utterance") return { type: "drop" };
    return { type: "utterance", samples: concatInt16(chunks), sampleRate };
  }

  return {
    reset() {
      speaking = false;
      silenceSamples = 0;
      speechSamples = 0;
      prefix = [];
      prefixSamples = 0;
      utter = [];
    },
    push({ samples, sampleRate: rate = 16000, channels = 1 }) {
      sampleRate = rate || 16000;
      const mono = downmix(samples, channels);
      if (!mono.length) return null;
      const rms = rmsInt16(mono);
      if (!speaking) {
        prefix.push(mono);
        prefixSamples += mono.length;
        const keep = Math.max(1, Math.floor((prefixMs / 1000) * sampleRate));
        while (prefixSamples > keep && prefix.length > 1) {
          prefixSamples -= prefix[0].length;
          prefix.shift();
        }
        if (rms >= threshold) {
          speaking = true;
          utter = prefix;
          prefix = [];
          prefixSamples = 0;
          speechSamples = mono.length;
          silenceSamples = 0;
        }
        return null;
      }
      utter.push(mono);
      if (rms >= threshold) {
        speechSamples += mono.length;
        silenceSamples = 0;
      } else {
        silenceSamples += mono.length;
      }
      const speechMs = (speechSamples / sampleRate) * 1000;
      const quietMs = (silenceSamples / sampleRate) * 1000;
      if (speechMs >= maxSpeechMs) return finish("utterance");
      if (quietMs >= silenceMs) return finish(speechMs >= minSpeechMs ? "utterance" : "drop");
      return null;
    },
  };
}
