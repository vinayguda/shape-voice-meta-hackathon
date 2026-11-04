import { forceDemo, maxTokens, metaKey, modelId } from "./env.js";
import { recommendFor, synthesize } from "./demo.js";
import { demoTurn } from "./demo.js";
import { changedKeys, executeTool, MCP_TOOLS, pushLog, titleFrom, view } from "./prd.js";
import { SECTION_IDS, STAGES } from "./stages.js";
import { echoToolCalls, museChat, parseToolCalls, textContent, usageOf } from "./muse.js";

const COMMIT_TURN = {
  name: "commit_turn",
  description:
    "Finish this interview turn after the PRD tools. Say one short spoken reply that ends in exactly one question, unless the interview is complete.",
  inputSchema: {
    type: "object",
    properties: {
      say: { type: "string", description: "Spoken reply. One to three sentences, no markdown. One question at the end unless interview_complete." },
      recommended_answer: { type: "string", description: "A concrete answer the user can say verbatim if they are unsure. Empty when interview_complete." },
      stage: {
        type: "string",
        enum: [...STAGES.map((stage) => stage.id), "done"],
        description: "The stage you are about to ask, not the one you just recorded. Use done when the interview is complete.",
      },
      pushback: { type: "boolean" },
      interview_complete: { type: "boolean" },
    },
    required: ["say", "stage", "interview_complete"],
  },
};

const SYSTEM_PROMPT = `You are Shape, a sharp PM interviewing a builder by voice. Follow grill-me discipline:
- Ask exactly one question, then wait.
- Walk this decision tree in order: problem, target_user, workaround, workflow, mvp_scope, success_metrics, risks. One follow-up if the answer is vague, then move on.
- Offer exactly one concrete recommended_answer the user could say out loud.
- Push back when they say everyone, list a platform of features, or give a metric with no number. Set pushback true and stay on that stage.
- Use their words in the PRD. Do not invent users, metrics, or features. Recommendations stay in recommended_answer until they accept them.
- Spoken lines are 1 to 3 short sentences. No markdown, no bullets. End with the one question unless the interview is complete.

On every turn, call tools in this order:
1. create_prd once, on the first useful answer.
2. update_prd_section for every section you can honestly fill or revise.
   problem includes the workaround once you know it, labeled "Current workaround:".
   user_stories are "As a …, I want …" lines grounded only in what they said.
   mvp_scope starts with "In:" and "Out:".
   open_questions are real unanswered questions.
3. commit_turn exactly once. stage is the stage you are ABOUT to ask. interview_complete is true only after risks is answered and you are done asking.

If they revise a section after the interview is complete, update that section and confirm in one sentence.`;

export function routeFor(live) {
  if (forceDemo() || !live) return "demo";
  if (!metaKey()) return "no_key";
  return "live";
}

export async function takeTurn(session, text, { live }) {
  const route = routeFor(Boolean(live));
  if (route === "no_key") {
    const error = new Error("No META_API_KEY on the server. Demo mode runs the full interview with no key.");
    error.status = 400;
    error.code = "no_key";
    throw error;
  }
  if (route === "demo") return demoTurn(session, text);
  return liveTurn(session, text);
}

function openAiTools() {
  return [...MCP_TOOLS, COMMIT_TURN].map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

function brief(session) {
  const stage = STAGES[session.stageIndex];
  return [
    `Current stage to record: ${stage ? stage.id : "done"}.`,
    `Stage number: ${stage ? session.stageIndex + 1 : STAGES.length} of ${STAGES.length}.`,
    `Interview complete: ${session.complete}.`,
    `PRD title: ${session.prd.title}`,
    `PRD JSON: ${JSON.stringify(session.prd.sections)}`,
    `Accepted answers JSON: ${JSON.stringify(session.answers)}`,
  ].join("\n");
}

function stageIndexOf(id) {
  return STAGES.findIndex((stage) => stage.id === id);
}

function speakable(text) {
  const value = String(text || "").trim();
  if (!value || value.startsWith("{") || value.startsWith("```")) return "";
  return value;
}

function extractJson(text) {
  if (!text) return null;
  let value = text.trim();
  if (value.startsWith("```")) value = value.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  if (!value.startsWith("{")) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function snapshot(session) {
  return structuredClone({
    stageIndex: session.stageIndex,
    complete: session.complete,
    nudged: session.nudged,
    answers: session.answers,
    skipped: session.skipped,
    prd: session.prd,
    createdPrd: session.createdPrd,
    exported: session.exported,
    transcript: session.transcript,
    toolLog: session.toolLog,
    last: session.last,
    lastModel: session.lastModel,
  });
}

function restore(session, snap) {
  for (const key of Object.keys(snap)) session[key] = snap[key];
}

function modelFacing(name, result) {
  if (name === "export_prd") return { ok: true, filename: result.filename, bytes: result.bytes };
  if (!result.ok) return result;
  const { markdown, ...rest } = result;
  return rest;
}

function fillGaps(session) {
  const synthesized = synthesize(session);
  const meta = { source: "fallback", transport: "in-process" };
  if (!session.createdPrd) {
    const title =
      session.prd.title && session.prd.title !== "Untitled PRD"
        ? session.prd.title
        : titleFrom(session.answers.problem || session.prd.sections.problem || "");
    const args = { title };
    if (!session.prd.sections.problem && synthesized.problem) args.problem = synthesized.problem;
    executeTool(session, "create_prd", args, meta);
  }
  let filled = false;
  for (const id of SECTION_IDS) {
    if (synthesized[id] && !session.prd.sections[id]) {
      executeTool(session, "update_prd_section", { section: id, content: synthesized[id], mode: "replace" }, meta);
      filled = true;
    }
  }
  return filled;
}

function applyProgress(session, committed, oldIndex) {
  const done = committed?.interview_complete === true || committed?.stage === "done";
  if (done) {
    session.complete = true;
    session.stageIndex = STAGES.length;
    session.prd.status = "ready";
    return;
  }
  const idx = committed?.stage ? stageIndexOf(committed.stage) : -1;
  if (committed?.pushback && (idx < 0 || idx === oldIndex)) return;
  if (idx > oldIndex) session.stageIndex = idx;
  else if (committed?.pushback) return;
  else session.stageIndex = Math.min(oldIndex + 1, STAGES.length);
  if (session.stageIndex >= STAGES.length) {
    session.complete = true;
    session.prd.status = "ready";
  }
}

async function liveTurn(session, rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    const error = new Error("Say or type an answer first.");
    error.status = 400;
    error.code = "empty";
    throw error;
  }
  if (text.length > 4000) {
    const error = new Error("That answer is too long. Keep it under 4000 characters.");
    error.status = 400;
    error.code = "too_long";
    throw error;
  }
  const snap = snapshot(session);
  try {
    return await runLive(session, text);
  } catch (error) {
    restore(session, snap);
    throw error;
  }
}

async function runLive(session, text) {
  const before = { ...session.prd.sections };
  const oldIndex = session.stageIndex;
  const oldStage = STAGES[oldIndex] || null;
  const messages = [
    { role: "system", content: `${SYSTEM_PROMPT}\n\n${brief(session)}` },
    { role: "user", content: text },
  ];
  const tools = openAiTools();
  const configured = modelId();
  let committed = null;
  let spoken = "";
  let recommended = "";
  let sawLength = false;
  let reasoningTokens = 0;
  let usedModel = configured;
  const started = Date.now();

  for (let hop = 0; hop < 3; hop += 1) {
    const hopStarted = Date.now();
    const data = await museChat({ messages, tools, maxTokens: maxTokens() });
    const choice = data.choices?.[0];
    if (!choice) {
      const error = new Error("Muse returned no choices.");
      error.status = 502;
      error.code = "bad_response";
      throw error;
    }
    const message = choice.message || {};
    const finish = choice.finish_reason || "";
    if (finish === "length") sawLength = true;
    const content = textContent(message.content);
    const calls = parseToolCalls(message);
    const usage = usageOf(data);
    if (usage.reasoningTokens) reasoningTokens += usage.reasoningTokens;
    usedModel = data.model || configured;
    const latencyMs = Date.now() - hopStarted;
    pushLog(session, {
      name: "chat.completions",
      via: "model",
      transport: "none",
      source: usedModel,
      args: { model: usedModel, max_tokens: maxTokens(), hop },
      summary: [
        `${usedModel}`,
        `${latencyMs}ms`,
        finish ? `finish=${finish}` : "",
        `tools=${calls.length}`,
        usage.reasoningTokens ? `${usage.reasoningTokens} reasoning tokens` : "",
      ].filter(Boolean).join(" · "),
      result: { live: true, latencyMs, finish, ...usage },
    });

    if (finish === "length" && !content && calls.length === 0) {
      const error = new Error("Muse Spark spent the token budget on reasoning and returned an empty reply. Raise META_MAX_TOKENS (default 4000).");
      error.status = 502;
      error.code = "length";
      throw error;
    }

    if (!calls.length) {
      const parsed = extractJson(content);
      if (parsed) {
        applyParsed(session, parsed, usedModel);
        spoken = speakable(parsed.say) || spoken;
        recommended = parsed.recommended_answer || recommended;
        committed = {
          say: parsed.say,
          recommended_answer: parsed.recommended_answer,
          stage: parsed.stage,
          pushback: parsed.pushback,
          interview_complete: parsed.interview_complete,
        };
      } else {
        spoken = speakable(content) || spoken;
      }
      break;
    }

    messages.push({ role: "assistant", content: content || null, tool_calls: echoToolCalls(message) });
    const commits = [];
    for (const call of calls) {
      if (call.bad) {
        pushLog(session, {
          name: call.name,
          via: call.name === "commit_turn" ? "agent" : "mcp-tool",
          source: usedModel,
          ok: false,
          summary: "Arguments were truncated. Raise META_MAX_TOKENS.",
          args: {},
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, error: "arguments were not valid JSON" }),
        });
        continue;
      }
      if (call.name === "commit_turn") {
        commits.push(call);
        committed = call.args;
        spoken = speakable(call.args.say) || spoken;
        recommended = call.args.recommended_answer || recommended;
        pushLog(session, {
          name: "commit_turn",
          via: "agent",
          source: usedModel,
          args: {
            stage: call.args.stage,
            pushback: Boolean(call.args.pushback),
            interview_complete: Boolean(call.args.interview_complete),
          },
          summary: clipSay(call.args.say),
        });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: true }) });
        continue;
      }
      const { result } = executeTool(session, call.name, call.args, { source: usedModel, transport: "in-process" });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(modelFacing(call.name, result)) });
    }
    if (commits.length) break;
    if (hop === 0) {
      messages.push({
        role: "user",
        content: "Call commit_turn now. One spoken question, one recommended_answer, the next stage id, and interview_complete.",
      });
    }
  }

  applyProgress(session, committed, oldIndex);
  const advanced = session.complete || session.stageIndex !== oldIndex;
  if (advanced && oldStage && !session.answers[oldStage.id]) session.answers[oldStage.id] = text;

  const usedFallback = advanced ? fillGaps(session) : false;
  if (!spoken) {
    spoken = session.complete
      ? "That's a full pass. The PRD is on the canvas. Tell me a section to change, or download the Markdown."
      : STAGES[session.stageIndex]?.ask || "What should we change?";
  }
  if (!recommended && !session.complete && STAGES[session.stageIndex]) {
    recommended = recommendFor(STAGES[session.stageIndex].id, session);
  }

  session.transcript.push({ role: "user", text, at: Date.now() });
  session.transcript.push({ role: "shape", text: spoken, at: Date.now() });
  session.last = {
    say: spoken,
    question: spoken,
    recommended: recommended || "",
    pushback: Boolean(committed?.pushback) && !advanced,
  };
  if (session.complete) session.prd.status = "ready";
  if (session.complete && !session.exported) {
    executeTool(session, "export_prd", {}, { source: usedModel, transport: "in-process" });
    session.exported = true;
  }

  const notices = [];
  if (sawLength) notices.push("Muse hit META_MAX_TOKENS and the reply may be cut off.");
  if (usedFallback) notices.push("Shape filled any PRD section Muse left empty, using your words.");
  session.lastModel = {
    live: true,
    model: usedModel,
    latencyMs: Date.now() - started,
    reasoningTokens: reasoningTokens || null,
    note: notices.join(" "),
  };
  return {
    ...view(session),
    changedSections: changedKeys(before, session),
    modelCall: session.lastModel,
    notice: notices.join(" "),
  };
}

function clipSay(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > 140 ? `${value.slice(0, 139)}…` : value;
}

function applyParsed(session, parsed, source) {
  const updates = Array.isArray(parsed.updates) ? parsed.updates : [];
  for (const update of updates) {
    if (!update) continue;
    executeTool(
      session,
      "update_prd_section",
      { section: update.section || update.id, content: update.content || "", mode: update.mode || "replace" },
      { source, transport: "in-process" },
    );
  }
  if (parsed.title || parsed.problem) {
    executeTool(
      session,
      "create_prd",
      { title: parsed.title || titleFrom(parsed.problem || ""), problem: parsed.problem || "" },
      { source, transport: "in-process" },
    );
  }
}
