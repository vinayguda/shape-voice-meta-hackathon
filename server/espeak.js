import { spawn, execFileSync } from "node:child_process";
import { decodeWav, resampleInt16 } from "./audio.js";

export function hasEspeak() {
  try {
    execFileSync("espeak-ng", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function speakEspeak(text) {
  const spoken = String(text || "").replace(/\s+/g, " ").trim().slice(0, 800);
  if (!spoken) return Promise.resolve({ samples: new Int16Array(), sampleRate: 22050 });
  return new Promise((resolve, reject) => {
    const child = spawn("espeak-ng", ["-v", "en-us", "-s", "150", "--stdout", spoken], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let err = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    child.on("error", (error) => {
      reject(error.code === "ENOENT"
        ? new Error("espeak-ng is not installed. Local LiveKit speech needs it because dev keys cannot call LiveKit Inference.")
        : error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || `espeak-ng exited ${code}`));
        return;
      }
      try {
        const decoded = decodeWav(Buffer.concat(chunks));
        resolve({ samples: resampleInt16(decoded.samples, decoded.sampleRate, 24000), sampleRate: 24000 });
      } catch (error) {
        reject(error);
      }
    });
  });
}
