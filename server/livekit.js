import { AccessToken } from "livekit-server-sdk";
import { livekitConfig, livekitHttpUrl, livekitUrl, voiceAgentEnabled } from "./env.js";

export function roomNameFor(sessionId) {
  const id = String(sessionId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!id) {
    const error = new Error("Missing session.");
    error.status = 400;
    error.code = "bad_session";
    throw error;
  }
  return `shape-${id}`;
}

export async function mintJoinToken({ identity, name, room, attributes }) {
  const { apiKey, apiSecret, configured } = livekitConfig();
  if (!configured) {
    const error = new Error("LiveKit is not configured.");
    error.status = 503;
    error.code = "livekit_unconfigured";
    throw error;
  }
  const token = new AccessToken(apiKey, apiSecret, {
    identity,
    name,
    ttl: "2h",
    attributes,
  });
  token.addGrant({
    roomJoin: true,
    room,
    roomCreate: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
  });
  return token.toJwt();
}

export async function issueParticipantToken(session, { live }) {
  const room = roomNameFor(session.id);
  const identity = `user-${session.id}`;
  const token = await mintJoinToken({ identity, name: "You", room });
  let agent = "starting";
  if (!voiceAgentEnabled()) {
    agent = "disabled";
  } else {
    const { dispatchShape } = await import("./livekit-worker.js");
    await dispatchShape(room, { sessionId: session.id, live: Boolean(live) });
  }
  return { url: livekitUrl(), token, room, identity, agent };
}

export { livekitConfig, livekitHttpUrl, livekitUrl, voiceAgentEnabled };
