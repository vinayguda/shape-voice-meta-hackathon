import { fileURLToPath } from "node:url";
import { AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { AgentServer, ServerOptions } from "@livekit/agents";
import { livekitConfig, livekitHttpUrl, livekitUrl, roomNameFor } from "./livekit.js";

export const SHAPE_AGENT_NAME = "shape";

let server;
let registered = false;
let startError = "";
let starting;

export function workerState() {
  if (registered) return "ready";
  if (startError) return "error";
  if (starting) return "starting";
  return "off";
}

export function startShapeWorker() {
  if (starting) return starting;
  const { apiKey, apiSecret, configured } = livekitConfig();
  if (!configured) return Promise.resolve();
  const port = process.env.PORT || "3000";
  process.env.SHAPE_BASE_URL = `http://127.0.0.1:${port}`;
  server = new AgentServer(new ServerOptions({
    agent: fileURLToPath(new URL("./agent-entry.js", import.meta.url)),
    agentName: SHAPE_AGENT_NAME,
    wsURL: livekitUrl(),
    apiKey,
    apiSecret,
    logLevel: "info",
  }));
  server.event.on("worker_registered", () => {
    registered = true;
    startError = "";
    console.log("[shape] livekit agents worker registered");
  });
  starting = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), 12000);
    server.event.once("worker_registered", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  server.run().catch((error) => {
    startError = error?.message || String(error);
    console.error("[shape] livekit worker", startError);
  });
  return starting;
}

export async function dispatchShape(room, metadata) {
  if (starting) await starting;
  if (!registered) {
    const error = new Error(startError || "The LiveKit agent worker is not connected. Start livekit-server --dev, or check LIVEKIT_URL.");
    error.status = 503;
    error.code = "livekit_worker";
    throw error;
  }
  const { apiKey, apiSecret } = livekitConfig();
  const client = new AgentDispatchClient(livekitHttpUrl(), apiKey, apiSecret);
  await client.createDispatch(room, SHAPE_AGENT_NAME, { metadata: JSON.stringify(metadata) });
}

export async function deleteShapeRoom(sessionId) {
  const { apiKey, apiSecret } = livekitConfig();
  const rooms = new RoomServiceClient(livekitHttpUrl(), apiKey, apiSecret);
  try {
    await rooms.deleteRoom(roomNameFor(sessionId));
    return true;
  } catch {
    return false;
  }
}
