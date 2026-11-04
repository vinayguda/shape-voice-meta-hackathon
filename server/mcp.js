import crypto from "node:crypto";
import { executeTool, getOrCreate, MCP_TOOLS } from "./prd.js";

const PROTOCOL = "2025-03-26";

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function fail(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function handleOne(message) {
  if (!message || typeof message !== "object") return { body: fail(null, -32600, "Invalid request") };
  const { id, method, params } = message;
  const note = id === undefined || id === null;
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return { status: 202 };
  }
  if (note && method?.startsWith("notifications/")) return { status: 202 };
  if (method === "initialize") {
    const requested = params?.protocolVersion || PROTOCOL;
    return {
      sessionId: crypto.randomUUID(),
      body: ok(id, {
        protocolVersion: requested === "2024-11-05" ? requested : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "shape-prd", version: "0.1.0" },
        instructions:
          "Shape PRD tools. Pass sessionId to read or write a session. Omit sessionId to use the default MCP session.",
      }),
    };
  }
  if (method === "ping") return { body: ok(id, {}) };
  if (method === "tools/list") {
    return {
      body: ok(id, {
        tools: MCP_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      }),
    };
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
    const known = MCP_TOOLS.some((tool) => tool.name === name);
    if (!known) return { body: fail(id, -32602, `Unknown tool ${name || ""}`.trim()) };
    const session = getOrCreate(args.sessionId);
    const { result } = executeTool(session, name, args, { source: "mcp", transport: "http" });
    const text = name === "export_prd" && result.ok ? result.markdown : JSON.stringify(result);
    return {
      body: ok(id, {
        content: [{ type: "text", text }],
        isError: !result.ok,
      }),
    };
  }
  if (note) return { status: 202 };
  return { body: fail(id, -32601, `Method not found: ${method || ""}`) };
}

export function handleMcp(message, headerSession) {
  if (Array.isArray(message)) {
    const bodies = [];
    let sessionId = headerSession;
    for (const item of message) {
      const out = handleOne(item);
      if (out.sessionId) sessionId = out.sessionId;
      if (out.body) bodies.push(out.body);
    }
    if (!bodies.length) return { status: 202, sessionId };
    return { status: 200, body: bodies, sessionId };
  }
  const out = handleOne(message);
  return { status: out.status || 200, body: out.body, sessionId: out.sessionId || headerSession };
}
