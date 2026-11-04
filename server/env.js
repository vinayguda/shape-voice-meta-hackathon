import fs from "node:fs";

export function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function metaKey() {
  return (process.env.META_API_KEY || process.env.MODEL_API_KEY || "").trim();
}

export function baseUrl() {
  return (process.env.META_BASE_URL || "https://api.meta.ai/v1").replace(/\/$/, "");
}

export function modelId() {
  return (process.env.META_MODEL || "muse-spark-1.3").trim();
}

export function maxTokens() {
  const n = Number(process.env.META_MAX_TOKENS || 1500);
  if (!Number.isFinite(n) || n < 256) return 1500;
  return Math.floor(n);
}

export function sttModel() {
  return (process.env.META_STT_MODEL || "muse-voice-transcribe-1.0").trim();
}

// Muse Voice Transcribe is the mic whenever a key is set.
// META_STT=browser forces the Web Speech API even if a key is present.
// With no key, the browser path is the only one that can run.
export function sttEngine() {
  if ((process.env.META_STT || "").trim().toLowerCase() === "browser") return "browser";
  if (!metaKey()) return "browser";
  return "muse";
}

export function forceDemo() {
  return process.env.DEMO === "1" || process.env.DEMO === "true";
}
