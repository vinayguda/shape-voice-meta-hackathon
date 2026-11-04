import { forceDemo, maxTokens, metaKey, modelId } from "./env.js";
import { cleanProse, demoTurn, isUnsure, recommendFor, rewriteProblem, rewriteStories, synthesize } from "./demo.js";
import { canonSection, changedKeys, executeTool, formatScope, MCP_TOOLS, pushLog, titleFrom, view } from "./prd.js";
import { SECTION_IDS, STAGES } from "./stages.js";
import { museChat, parseToolCalls, textContent, usageOf } from "./muse.js";

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

const SYSTEM_PROMPT = `You are Shape, a voice PM running grill-me: one question at a time, walk each branch of the decision tree, offer one recommended answer, push back on scope, and stop when there is shared understanding. That pattern is Matt Pocock's grill-me, and the browser interview is in the spirit of grill-with-ui.
If the developer message includes context, use it. Reference it explicitly ("Your notes say X — does that mean…?"). Do not treat context as decided scope until they confirm it.
One short question, then wait. Use the user's words. Do not invent facts.
In this SINGLE response, call the tools together. Do not wait for tool results.
- create_prd only if no PRD exists yet. Do not call it again.
- update_prd_section for the stage you are recording. Problem is third person about the pain, not "I want to build an app". Workaround goes in problem as "Current workaround:". Scope uses "In:" and "Out:" and Out items do not start with "No". Stories are "As a {target user}, I want … so that …", never "As the primary user" and never "I want to build an app".
- If they say they are not sure, you decide, or no idea, write the recommended answer into that section prefixed with "Suggested:" and move on. Never write "I'm not sure."
- commit_turn in the same response. say is one or two sentences and ends with the NEXT stage's question from the developer message. stage is that next stage id. interview_complete is true only after risks is saved.
Never ask about a stage that is already filled. If they are revising after the interview is done, update that section and confirm. No second question.`;

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

export function brief(session) {
  const stage = STAGES[session.stageIndex];
  const next = STAGES[session.stageIndex + 1];
  const filled = SECTION_IDS.filter((id) => session.prd.sections[id]?.trim()).join(", ") || "none";
  const lines = [`Filled sections: ${filled}.`, `PRD: ${JSON.stringify(session.prd.sections)}`];
  if (session.context?.summary) {
    lines.push(
      `Context (${session.context.label}). Reference it when it changes the question. Example: "Your notes say … — does that mean …?"\n${session.context.summary}`,
    );
  }
  if (!stage || session.complete) {
    lines.unshift("Interview is complete. Do not ask another interview question. commit_turn.stage=done and interview_complete=true.");
    return lines.join("\n");
  }
  lines.unshift(
    `Record stage ${session.stageIndex + 1} of ${STAGES.length}: ${stage.id}.`,
    `Goal: ${stage.ask}`,
    next
      ? `After saving it, ask ONLY: ${next.ask} commit_turn.stage="${next.id}". Do not mention earlier stages.`
      : `This is the last stage. After saving it, commit_turn.stage="done" and interview_complete=true. Do not ask another question.`,
  );
  return lines.join("\n");
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
    context: session.context || null,
    last: session.last,
    lastModel: session.lastModel,
  });
}

function restore(session, snap) {
  for (const key of Object.keys(snap)) session[key] = snap[key];
}

const STAGE_HINTS = {
  problem: /pain|problem|idea|one sentence/i,
  target_user: /who|primary user|person|persona/i,
  workaround: /today|instead|workaround|currently do/i,
  workflow: /workflow|first try|end to end|walk/i,
  mvp_scope: /\bin\b|first version|out of|scope/i,
  success_metrics: /number|metric|30 days|measure|percent/i,
  risks: /risk|assumption|open question/i,
};

export function questionFitsStage(say, stageId) {
  const hint = STAGE_HINTS[stageId];
  return Boolean(say && hint && hint.test(say) && say.includes("?"));
}

export function stageSectionWritten(session, stageId, before = {}) {
  const now = session.prd.sections;
  const changed = (id) => (now[id] || "").trim() !== (before[id] || "").trim() && Boolean((now[id] || "").trim());
  if (stageId === "problem") return changed("problem");
  if (stageId === "target_user") return changed("target_user");
  if (stageId === "workaround") return changed("problem");
  if (stageId === "workflow") return changed("user_stories");
  if (stageId === "mvp_scope") return changed("mvp_scope");
  if (stageId === "success_metrics") return changed("success_metrics");
  if (stageId === "risks") return changed("risks") || changed("open_questions");
  return false;
}

export function decideAdvance({ stageIndex, written }) {
  if (stageIndex >= STAGES.length) return { stageIndex: STAGES.length, complete: true, stayed: false };
  if (!written) return { stageIndex, complete: false, stayed: true };
  const next = stageIndex + 1;
  if (next >= STAGES.length) return { stageIndex: STAGES.length, complete: true, stayed: false };
  return { stageIndex: next, complete: false, stayed: false };
}

function turnTokens(session) {
  const stage = STAGES[session.stageIndex];
  if (session.complete || !stage || stage.id === "risks") return Math.max(maxTokens(), 2500);
  return maxTokens();
}

function suggestedAnswer(session, stageId) {
  return `Suggested: ${recommendFor(stageId, session)}`;
}

function polishUpdate(session, args) {
  const section = canonSection(args.section);
  let content = String(args.content || "");
  if (isUnsure(content)) content = suggestedAnswer(session, STAGES[session.stageIndex]?.id || "problem");
  if (section === "problem") content = rewriteProblem(content);
  if (section === "user_stories") {
    content = rewriteStories(content, session.answers.target_user || session.prd.sections.target_user);
  }
  if (section === "mvp_scope") content = formatScope(content);
  return { ...args, content };
}

function ensureStageWritten(session, stage, text, before) {
  if (!stage || stageSectionWritten(session, stage.id, before)) return;
  if (isUnsure(text)) {
    const content = suggestedAnswer(session, stage.id);
    const meta = { source: "fallback", transport: "in-process" };
    const section = stage.id === "workflow" ? "user_stories" : stage.id === "workaround" ? "problem" : stage.id;
    if (stage.id === "problem" && !session.createdPrd) {
      executeTool(session, "create_prd", { title: titleFrom(content), problem: content }, meta);
    }
    const written = stage.id === "mvp_scope" ? formatScope(content) : stage.id === "workaround"
      ? `${(session.prd.sections.problem || "").trim()}\n\nCurrent workaround: ${content}`.trim()
      : content;
    executeTool(session, "update_prd_section", { section, content: written, mode: "replace" }, meta);
    return;
  }
  const prose = stage.id === "problem" ? rewriteProblem(text) : cleanProse(text);
  if (prose.length < 12) return;
  const meta = { source: "fallback", transport: "in-process" };
  if (stage.id === "problem") {
    executeTool(session, "create_prd", { title: titleFrom(text), problem: prose }, meta);
    if (!(session.prd.sections.problem || "").includes(prose.slice(0, 24))) {
      executeTool(session, "update_prd_section", { section: "problem", content: prose, mode: "replace" }, meta);
    }
  } else if (stage.id === "target_user") {
    executeTool(session, "update_prd_section", { section: "target_user", content: prose, mode: "replace" }, meta);
  } else if (stage.id === "workaround") {
    const prev = (session.prd.sections.problem || "").trim();
    const content = /current workaround\s*:/i.test(prev) ? prev : `${prev ? `${prev}\n\n` : ""}Current workaround: ${prose}`;
    executeTool(session, "update_prd_section", { section: "problem", content, mode: "replace" }, meta);
  } else if (stage.id === "workflow") {
    const story = synthesize({ ...session, answers: { ...session.answers, workflow: prose } }).user_stories;
    const line = story.split("\n\n").find(Boolean);
    if (line) executeTool(session, "update_prd_section", { section: "user_stories", content: line, mode: "replace" }, meta);
  } else if (stage.id === "mvp_scope") {
    executeTool(session, "update_prd_section", { section: "mvp_scope", content: synthesize({ ...session, answers: { ...session.answers, mvp_scope: prose } }).mvp_scope || prose, mode: "replace" }, meta);
  } else if (stage.id === "success_metrics") {
    executeTool(session, "update_prd_section", { section: "success_metrics", content: prose, mode: "replace" }, meta);
  } else if (stage.id === "risks") {
    executeTool(session, "update_prd_section", { section: "risks", content: prose, mode: "replace" }, meta);
  }
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

function applyProgress(session, written, oldIndex) {
  const next = decideAdvance({ stageIndex: oldIndex, written });
  session.stageIndex = next.stageIndex;
  session.complete = next.complete;
  if (next.complete) session.prd.status = "ready";
  return next;
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

  const cap = turnTokens(session);
  const data = await museChat({ messages, tools, maxTokens: cap });
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
  const latencyMs = Date.now() - started;
  pushLog(session, {
    name: "chat.completions",
    via: "model",
    transport: "none",
    source: usedModel,
    args: { model: usedModel, max_tokens: cap },
    summary: [
      usedModel,
      `${latencyMs}ms`,
      finish ? `finish=${finish}` : "",
      `tools=${calls.length}`,
      usage.reasoningTokens ? `${usage.reasoningTokens} reasoning tokens` : "",
    ].filter(Boolean).join(" · "),
    result: { live: true, latencyMs, finish, ...usage },
  });

  if (!calls.length) {
    const parsed = extractJson(content);
    if (parsed) {
      applyParsed(session, parsed, usedModel);
      spoken = speakable(parsed.say) || spoken;
      recommended = parsed.recommended_answer || recommended;
      committed = parsed;
    } else {
      spoken = speakable(content) || spoken;
    }
  } else {
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
        continue;
      }
      if (call.name === "create_prd" && session.createdPrd) continue;
      if (call.name === "update_prd_section") call.args = polishUpdate(session, call.args);
      if (call.name === "commit_turn") {
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
        continue;
      }
      executeTool(session, call.name, call.args, { source: usedModel, transport: "in-process" });
    }
    if (!spoken) spoken = speakable(content);
  }

  const pushback = Boolean(committed?.pushback);
  if (!pushback && oldStage) ensureStageWritten(session, oldStage, text, before);
  const written = oldStage ? stageSectionWritten(session, oldStage.id, before) : false;
  const progress = applyProgress(session, written, oldIndex);
  if (progress.stayed === false && oldStage && !session.answers[oldStage.id]) {
    session.answers[oldStage.id] = isUnsure(text) ? suggestedAnswer(session, oldStage.id) : cleanProse(text);
  }
  const usedFallback = !progress.stayed ? fillGaps(session) : false;
  const modelSay = spoken;
  if (session.complete) {
    spoken = modelSay && /prd|download|canvas|markdown/i.test(modelSay)
      ? modelSay
      : "That's a full pass. The PRD is on the canvas. Tell me a section to change, or download the Markdown.";
  } else if (progress.stayed) {
    const stage = STAGES[session.stageIndex];
    spoken = stage && questionFitsStage(modelSay, stage.id) ? modelSay : stage?.ask || modelSay;
  } else {
    const stage = STAGES[session.stageIndex];
    spoken = stage && questionFitsStage(modelSay, stage.id) ? modelSay : stage?.ask || modelSay;
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
    pushback: Boolean(committed?.pushback) && progress.stayed,
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
