import crypto from "node:crypto";
import { SECTION_IDS, SECTION_META, STAGES } from "./stages.js";

const ALIASES = new Map();
for (const { id } of SECTION_META) {
  ALIASES.set(id, id);
  ALIASES.set(id.replace(/_/g, " "), id);
}
ALIASES.set("persona", "target_user");
ALIASES.set("personas", "target_user");
ALIASES.set("target user / personas", "target_user");
ALIASES.set("stories", "user_stories");
ALIASES.set("user story", "user_stories");
ALIASES.set("mvp", "mvp_scope");
ALIASES.set("scope", "mvp_scope");
ALIASES.set("metrics", "success_metrics");
ALIASES.set("success", "success_metrics");
ALIASES.set("risk", "risks");
ALIASES.set("questions", "open_questions");
ALIASES.set("open question", "open_questions");

export const sessions = new Map();

export function canonSection(section) {
  const key = String(section || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (ALIASES.has(key)) return ALIASES.get(key);
  const underscored = key.replace(/ /g, "_");
  if (SECTION_IDS.includes(underscored)) return underscored;
  return null;
}

export function blankPrd() {
  const sections = {};
  for (const id of SECTION_IDS) sections[id] = "";
  return { title: "Untitled PRD", status: "draft", updatedAt: null, sections };
}

export function createSession(id = crypto.randomUUID()) {
  const first = STAGES[0];
  const say = `I'll ask one question at a time and write the PRD on the canvas as we go. ${first.ask}`;
  const session = {
    id,
    createdAt: new Date().toISOString(),
    stageIndex: 0,
    complete: false,
    nudged: {},
    answers: {},
    skipped: [],
    prd: blankPrd(),
    createdPrd: false,
    exported: false,
    transcript: [{ role: "shape", text: say, at: Date.now() }],
    toolLog: [],
    last: {
      say,
      question: first.ask,
      recommended:
        "A weekly screen-time check-in for parents. Today they only notice the fight, not the pattern.",
      pushback: false,
    },
    lastModel: null,
    context: null,
  };
  sessions.set(id, session);
  return session;
}

export function getOrCreate(id) {
  const key = (id || "mcp-default").trim() || "mcp-default";
  return sessions.get(key) || createSession(key);
}

export function pushLog(session, entry) {
  const full = {
    id: crypto.randomUUID(),
    at: Date.now(),
    ok: true,
    transport: "in-process",
    args: {},
    summary: "",
    ...entry,
  };
  session.toolLog.push(full);
  if (session.toolLog.length > 120) {
    session.toolLog.splice(0, session.toolLog.length - 120);
  }
  return full;
}

function touch(session) {
  session.prd.updatedAt = new Date().toISOString();
}

export function clip(text, n = 160) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1).trim()}…`;
}

export function titleFrom(problem) {
  const cleaned = String(problem || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "Untitled PRD";
  const match = cleaned.match(
    /\b(?:an |a )?(?:app|tool|product|service)\s+(?:for|that|to)\s+(.+)/i,
  );
  let title = (match ? match[1] : cleaned).split(/[.!?]/)[0];
  title = title.split(/\b(?:not just|but not)\b/i)[0].trim();
  title = title.replace(/^[,:\s]+|[,:\s]+$/g, "");
  if (title.length > 72) title = `${title.slice(0, 70).trim()}…`;
  if (!title) return "Untitled PRD";
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export function formatScope(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const labeled = raw.match(/\bin\s*:\s*([\s\S]*?)\s*\bout\s*:\s*([\s\S]*)/i);
  if (labeled) {
    return `In:\n${bulletize(labeled[1])}\n\nOut:\n${bulletize(labeled[2], true)}`;
  }
  const inside = [];
  const outside = [];
  for (const part of raw.split(/\n+|(?<=\.)\s+/)) {
    const piece = part.trim();
    if (!piece) continue;
    if (/^(no|not|without|out of|don't|do not|exclude)\b/i.test(piece) || /out of scope/i.test(piece)) {
      outside.push(piece.replace(/\.$/, ""));
    } else {
      inside.push(piece.replace(/\.$/, ""));
    }
  }
  if (!outside.length) {
    return `In:\n${bulletize(inside.join(", "))}\n\nOut:\n- Not specified yet. Shape will keep pushing for an explicit cut.`;
  }
  return `In:\n${bulletize(inside.join(", "))}\n\nOut:\n${bulletize(outside.join(", "), true)}`;
}

function bulletize(text, dropNo = false) {
  const parts = String(text || "")
    .split(/,|\n|·|•/)
    .map((part) => {
      let item = part.replace(/^[-*]\s*/, "").replace(/^(and|or)\s+/i, "").replace(/\.$/, "").trim();
      if (dropNo) item = item.replace(/^(no|not)\s+/i, "");
      return item.trim();
    })
    .filter(Boolean);
  if (!parts.length) return `- ${String(text || "").trim()}`;
  return parts.map((part) => `- ${part}`).join("\n");
}

export function slugify(title) {
  const slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${slug || "prd"}.md`;
}

export function toMarkdown(prd) {
  const lines = [
    `# ${prd.title || "Untitled PRD"}`,
    "",
    "> Draft PRD shaped in conversation with Shape.",
    `> Status: ${prd.status || "draft"}. Updated: ${prd.updatedAt || "not yet"}.`,
    "",
  ];
  for (const { id, label } of SECTION_META) {
    lines.push(`## ${label}`, "", prd.sections[id]?.trim() || "_Not discussed yet._", "");
  }
  lines.push(
    "---",
    "",
    "_Shaped with Meta Muse models via the Meta Model API. Interview inspired by Matt Pocock's grill-me and grill-with-ui._",
    "",
  );
  return lines.join("\n");
}

function asContent(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).join("\n").trim();
  if (value == null) return "";
  return String(value).trim();
}

export function executeTool(session, name, rawArgs = {}, meta = {}) {
  const args = rawArgs && typeof rawArgs === "object" ? { ...rawArgs } : {};
  delete args.sessionId;
  const source = meta.source || "runtime";
  const transport = meta.transport || "in-process";
  let result;

  if (name === "create_prd" && session.createdPrd) {
    return { entry: null, result: { ok: true, created: false, skipped: true, title: session.prd.title } };
  }

  if (name === "create_prd") {
    const title = asContent(args.title);
    if (title) session.prd.title = title;
    else if (!session.prd.title) session.prd.title = "Untitled PRD";
    const problem = asContent(args.problem);
    if (problem && !session.prd.sections.problem) session.prd.sections.problem = problem;
    if (session.prd.status !== "ready") session.prd.status = "draft";
    session.createdPrd = true;
    touch(session);
    result = { ok: true, title: session.prd.title, created: true };
  } else if (name === "update_prd_section") {
    const section = canonSection(args.section);
    const content = asContent(args.content);
    const mode = args.mode === "append" ? "append" : "replace";
    if (!section) {
      result = { ok: false, error: `Unknown section "${args.section || ""}".` };
    } else if (!content) {
      result = { ok: false, error: "content is required." };
    } else {
      const prev = session.prd.sections[section] || "";
      session.prd.sections[section] = mode === "append" && prev ? `${prev}\n\n${content}` : content;
      touch(session);
      result = { ok: true, section, mode, chars: session.prd.sections[section].length, preview: clip(session.prd.sections[section], 180) };
    }
  } else if (name === "export_prd") {
    const markdown = toMarkdown(session.prd);
    const filename = slugify(session.prd.title);
    result = { ok: true, filename, bytes: Buffer.byteLength(markdown), markdown };
  } else {
    result = { ok: false, error: `Unknown tool "${name}".` };
  }

  const summary = summarize(name, args, result);
  const entry = pushLog(session, {
    name,
    via: "mcp-tool",
    transport,
    source,
    ok: Boolean(result.ok),
    args: compactArgs(name, args),
    summary,
  });
  return { entry, result };
}

function compactArgs(name, args) {
  if (name === "update_prd_section") {
    return { section: canonSection(args.section) || args.section, mode: args.mode || "replace", preview: clip(asContent(args.content), 120) };
  }
  if (name === "create_prd") return { title: clip(asContent(args.title), 80) };
  if (name === "export_prd") return {};
  return {};
}

function summarize(name, args, result) {
  if (!result.ok) return result.error || "failed";
  if (name === "create_prd") return `title “${result.title}”`;
  if (name === "update_prd_section") return `${result.section} · ${result.chars} chars · ${result.preview}`;
  if (name === "export_prd") return `${result.filename} · ${result.bytes} bytes`;
  return "ok";
}

export function changedKeys(before, session) {
  return SECTION_IDS.filter((id) => (before[id] || "") !== (session.prd.sections[id] || ""));
}

export function view(session) {
  const stage = STAGES[session.stageIndex];
  let kicker = "Interview complete";
  if (!session.complete && stage) {
    const head = session.last?.pushback ? "Pushback" : `Question ${session.stageIndex + 1} of ${STAGES.length}`;
    kicker = `${head} · ${stage.label}`;
  }
  return {
    sessionId: session.id,
    stageIndex: session.stageIndex,
    stage: stage?.id || "done",
    complete: session.complete,
    pushback: Boolean(session.last?.pushback),
    kicker,
    question: session.last?.question || session.last?.say || "",
    spoken: session.last?.say || "",
    recommended: session.last?.recommended || "",
    prd: session.prd,
    transcript: session.transcript,
    toolLog: session.toolLog,
    stages: STAGES.map(({ id, label, short }) => ({ id, label, short })),
    sections: SECTION_META,
    lastModel: session.lastModel,
    context: session.context?.loaded
      ? { loaded: true, label: session.context.label, chars: session.context.chars, source: session.context.source }
      : { loaded: false },
  };
}

export const MCP_TOOLS = [
  {
    name: "create_prd",
    description:
      "Create the PRD for this session. Call once, on the first useful answer. Sets the working title and, if the problem section is still empty, the problem statement.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short product title, under 80 characters." },
        problem: { type: "string", description: "Problem statement in the user's words." },
        sessionId: { type: "string", description: "Shape session id. Omit during the interview; pass it from an MCP client." },
      },
      required: ["title"],
    },
  },
  {
    name: "update_prd_section",
    description:
      "Replace or append one PRD section using the user's words. Do not invent users, metrics, or features they did not state.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: SECTION_IDS,
          description: "problem, target_user, user_stories, mvp_scope, success_metrics, risks, or open_questions.",
        },
        content: { type: "string" },
        mode: { type: "string", enum: ["replace", "append"] },
        sessionId: { type: "string" },
      },
      required: ["section", "content"],
    },
  },
  {
    name: "export_prd",
    description: "Render the current PRD as Markdown.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Shape session id. Omit to use the default MCP session." },
      },
    },
  },
];
