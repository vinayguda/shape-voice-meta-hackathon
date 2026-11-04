import { STAGES } from "./stages.js";
import { changedKeys, executeTool, formatScope, pushLog, titleFrom, view } from "./prd.js";

export const SAMPLE = [
  "I want an app for parents to understand their kids' screen-time habits. Not just block apps, but see patterns, like YouTube spiking after homework, and talk about it with their kids.",
  "Parents of kids 8 to 13. Usually one parent is the one who actually sits down for the weekly check-in.",
  "They check iOS Screen Time once, feel guilty, and argue at dinner. There is nothing to look at together.",
  "Once a week the parent opens the app, sees three patterns, and starts a ten-minute conversation with their kid using those patterns as the agenda.",
  "In: weekly pattern summary and a shared check-in. Out: content blocking, spyware-style monitoring, and school admin dashboards.",
  "Fewer fights about screens, and weekly check-ins actually happen. Target: 60 percent of families complete a check-in four weeks in a row.",
  "The risky bet is that kids will consent to sharing patterns. Open question: how do we get that consent without the parent just turning it on?",
];

export function looksBloated(text) {
  const raw = String(text || "");
  if (/\bout\b|not in|won't|will not|explicitly|don't|do not/i.test(raw)) return false;
  const commas = (raw.match(/,/g) || []).length;
  return raw.trim().length > 120 && commas >= 3;
}

function clipWords(text, n) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= n) return words.join(" ");
  return `${words.slice(0, n).join(" ")}…`;
}

function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parentShaped(session) {
  return /parent|kid|child|screen-time|screen time/i.test(session.answers.problem || "");
}

export function recommendFor(id, session) {
  const parent = parentShaped(session);
  switch (id) {
    case "problem":
      return "A weekly screen-time check-in for parents. Today they only notice the fight, not the pattern.";
    case "target_user":
      return parent
        ? "The parent of a kid aged 8 to 13 who is supposed to do a weekly check-in and usually doesn't."
        : "The person who feels this every week and currently handles it by hand.";
    case "workaround":
      return parent
        ? "They open the phone's screen-time settings once, feel guilty, and argue at dinner."
        : "They improvise in a doc, a chat thread, or a meeting, and the same pain returns next week.";
    case "workflow":
      return parent
        ? "Once a week they open the app, see three patterns, and use them as the agenda for a ten-minute talk with their kid."
        : "They open the product, see the one thing that matters today, and finish the job in one sitting.";
    case "mvp_scope":
      return parent
        ? "In: a weekly pattern summary and a shared check-in. Out: blocking apps, spyware-style monitoring, and admin dashboards."
        : "In: the one workflow above, end to end. Out: extra personas, automations, and anything that can wait until version two.";
    case "success_metrics":
      return parent
        ? "60 percent of families complete a weekly check-in four weeks in a row."
        : "60 percent of target users finish the core workflow four weeks in a row.";
    case "risks":
      return parent
        ? "The risky bet is that kids will consent to sharing patterns. Open question: how do we get consent without the parent turning it on quietly?"
        : "The risky bet is that the primary user will change their habit in the first week. Open question: what would we need to see to kill this MVP?";
    default:
      return "";
  }
}

function asWho(who) {
  const first = String(who || "the primary user").split(/[.!?]/)[0].trim();
  const short = clipWords(first, 10);
  return short.charAt(0).toLowerCase() + short.slice(1);
}

export function synthesize(session) {
  const answers = session.answers;
  const problemParts = [];
  if (answers.problem) problemParts.push(answers.problem.trim());
  if (answers.workaround) problemParts.push(`Current workaround: ${answers.workaround.trim()}`);

  const who = asWho(answers.target_user || "the primary user");
  const stories = [];
  if (answers.problem) stories.push(`As ${who}, I want help with this problem: ${clipWords(answers.problem, 32)}`);
  if (answers.workflow) stories.push(`As ${who}, I want this workflow to work in one sitting: ${clipWords(answers.workflow, 32)}`);
  if (answers.workaround) stories.push(`As ${who}, I want to stop relying on this workaround: ${clipWords(answers.workaround, 28)}`);
  if (answers.mvp_scope) stories.push(`As ${who}, I want the first version to respect this boundary: ${clipWords(answers.mvp_scope, 28)}`);

  return {
    problem: problemParts.join("\n\n"),
    target_user: answers.target_user ? answers.target_user.trim() : "",
    user_stories: stories.join("\n\n"),
    mvp_scope: answers.mvp_scope ? formatScope(answers.mvp_scope) : "",
    success_metrics: answers.success_metrics ? answers.success_metrics.trim() : "",
    risks: answers.risks ? riskStatements(answers.risks) : "",
    open_questions: openQuestions(session),
  };
}

function riskStatements(text) {
  const statements = splitSentences(text).filter((s) => !s.includes("?"));
  return statements.length ? statements.join(" ") : String(text || "").trim();
}

function openQuestions(session) {
  const items = [];
  const seen = new Set();
  const add = (question) => {
    const value = String(question || "").replace(/\s+/g, " ").trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push(value);
  };
  if (session.answers.risks) {
    for (const sentence of splitSentences(session.answers.risks)) {
      if (sentence.includes("?")) add(sentence);
    }
  }
  for (const id of session.skipped) {
    const stage = STAGES.find((item) => item.id === id);
    add(`Still open because it was skipped: ${stage?.label || id}.`);
  }
  if (/^(everyone|everybody|users|people|anyone)\b/i.test(session.answers.target_user || "")) {
    add("Primary user is still too broad. Who is the first real person?");
  }
  if (session.answers.mvp_scope && !/\bout\b/i.test(session.answers.mvp_scope)) {
    add("What is explicitly out of the first version?");
  }
  if (session.complete && items.length === 0 && Object.keys(session.answers).length) {
    add("Shape flagged this because it never came up: what would make us change the MVP after the first ten users?");
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function isUnsure(text) {
  return /^(i don't know|i don’t know|i dont know|idk|not sure|unsure|no idea|whatever you think)\b/i.test(text);
}

function isSkip(text) {
  return /^(skip|pass|come back later)\b/i.test(text);
}

function isEveryone(text) {
  return /^(everyone|everybody|users|people|anyone|consumers|the world|all users)\b/i.test(text);
}

function tooShort(text) {
  const words = text.split(/\s+/).filter(Boolean);
  return text.length < 18 || words.length < 4;
}

function once(session, key) {
  if (session.nudged[key]) return false;
  session.nudged[key] = true;
  return true;
}

function revisionSection(text) {
  const rules = [
    [/metric|success/, "success_metrics"],
    [/scope|out of scope|in scope|non-goal/, "mvp_scope"],
    [/risk/, "risks"],
    [/stor(y|ies)/, "user_stories"],
    [/open question/, "open_questions"],
    [/persona|target user|\buser\b/, "target_user"],
    [/problem|workaround|pain/, "problem"],
  ];
  for (const [pattern, id] of rules) {
    if (pattern.test(text)) return id;
  }
  return null;
}

function logDemo(session) {
  return pushLog(session, {
    name: "chat.completions",
    via: "model",
    transport: "none",
    source: "demo",
    args: { model: "demo", live: false },
    summary: "demo · no API call",
    result: { live: false, note: "Canned interview. No Meta API call." },
  });
}

function conclude(session, { say, question, recommended, pushback, before, modelEntry, started }) {
  session.last = {
    say,
    question: question || say,
    recommended: recommended || "",
    pushback: Boolean(pushback),
  };
  session.transcript.push({ role: "shape", text: say, at: Date.now() });
  if (session.complete) session.prd.status = "ready";
  if (session.complete && !session.exported) {
    executeTool(session, "export_prd", {}, { source: "demo", transport: "in-process" });
    session.exported = true;
  }
  const latencyMs = Date.now() - started;
  if (modelEntry) {
    modelEntry.result.latencyMs = latencyMs;
    modelEntry.summary = `demo · ${latencyMs}ms · no API call`;
  }
  session.lastModel = {
    live: false,
    model: "demo",
    latencyMs,
    note: "Canned interview. No Meta API call.",
  };
  return { ...view(session), changedSections: changedKeys(before, session), modelCall: session.lastModel };
}

function applySynthesis(session) {
  const synthesized = synthesize(session);
  const meta = { source: "demo", transport: "in-process" };
  if (!session.createdPrd) {
    executeTool(
      session,
      "create_prd",
      { title: titleFrom(session.answers.problem || ""), problem: synthesized.problem },
      meta,
    );
  }
  for (const id of Object.keys(synthesized)) {
    const content = synthesized[id];
    if (!content || session.prd.sections[id] === content) continue;
    executeTool(session, "update_prd_section", { section: id, content, mode: "replace" }, meta);
  }
}

function closing(session) {
  const title = session.prd.title && session.prd.title !== "Untitled PRD" ? session.prd.title : "this idea";
  return `That's a full pass. The PRD for ${title} is on the canvas. Tell me a section to change, or download the Markdown.`;
}

export function demoTurn(session, rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    const error = new Error("Say or type an answer first.");
    error.status = 400;
    error.code = "empty";
    throw error;
  }
  const started = Date.now();
  const before = { ...session.prd.sections };
  const modelEntry = logDemo(session);
  session.transcript.push({ role: "user", text, at: Date.now() });

  if (session.complete) return revise(session, text, before, modelEntry, started);

  const stage = STAGES[session.stageIndex];
  let answer = text;
  let skipping = false;

  if (isSkip(answer)) {
    skipping = true;
  } else if (isUnsure(answer)) {
    const key = `${stage.id}:unsure`;
    if (once(session, key)) {
      return conclude(session, {
        say: `I'd answer it this way, unless you would say it differently. ${recommendFor(stage.id, session)}`,
        recommended: recommendFor(stage.id, session),
        pushback: true,
        before,
        modelEntry,
        started,
      });
    }
    answer = recommendFor(stage.id, session);
  } else if (stage.id === "target_user" && isEveryone(answer) && once(session, "everyone")) {
    return conclude(session, {
      say: "Everyone is not a user. Who feels this on a bad day, and what are they trying to get done?",
      recommended: recommendFor(stage.id, session),
      pushback: true,
      before,
      modelEntry,
      started,
    });
  } else if (stage.id === "success_metrics" && !/\d/.test(answer) && once(session, "metric")) {
    return conclude(session, {
      say: "I need a number you could check in 30 days. What is it, and what would good look like?",
      recommended: recommendFor(stage.id, session),
      pushback: true,
      before,
      modelEntry,
      started,
    });
  } else if (stage.id === "mvp_scope" && looksBloated(answer) && once(session, "scope")) {
    return conclude(session, {
      say: "That's a platform, not a first version. If you had two weeks and one workflow, what stays, and what is explicitly out?",
      recommended: recommendFor(stage.id, session),
      pushback: true,
      before,
      modelEntry,
      started,
    });
  } else if (tooShort(answer) && once(session, `${stage.id}:short`)) {
    return conclude(session, {
      say: `That's too thin to write down. ${stage.ask}`,
      recommended: recommendFor(stage.id, session),
      pushback: true,
      before,
      modelEntry,
      started,
    });
  }

  if (skipping) session.skipped.push(stage.id);
  else session.answers[stage.id] = answer;

  // Open questions depend on session.complete, so mark completion before synthesis
  // only after we know this was the last stage. Synthesis reads answers first.
  const nextIndex = session.stageIndex + 1;
  const willComplete = nextIndex >= STAGES.length;
  session.complete = willComplete;
  applySynthesis(session);
  session.stageIndex = nextIndex;
  if (willComplete) session.prd.status = "ready";

  const next = STAGES[session.stageIndex];
  let say;
  let question = "";
  let recommended = "";
  if (!next) {
    say = closing(session);
    question = say;
  } else if (skipping) {
    say = `We'll leave ${stage.label.toLowerCase()} open. ${next.ask}`;
    question = next.ask;
    recommended = recommendFor(next.id, session);
  } else {
    say = `Got it. "${clipWords(answer, 8)}" ${next.ask}`;
    question = next.ask;
    recommended = recommendFor(next.id, session);
  }
  return conclude(session, { say, question, recommended, pushback: false, before, modelEntry, started });
}

function revise(session, text, before, modelEntry, started) {
  const section = revisionSection(text);
  const meta = { source: "demo", transport: "in-process" };
  let say;
  if (section && text.length > 40) {
    executeTool(session, "update_prd_section", { section, content: text, mode: "replace" }, meta);
    const label = section.replace(/_/g, " ");
    say = `Updated ${label}. The rest of the PRD stays. Download again to refresh the Markdown.`;
  } else {
    const prev = session.prd.sections.open_questions;
    const content = `${prev ? `${prev}\n` : ""}- Revision note: ${text}`;
    executeTool(session, "update_prd_section", { section: "open_questions", content, mode: "replace" }, meta);
    say = "I added that to open questions so it doesn't get lost. Name a section, like metrics or scope, if you want it rewritten.";
  }
  return conclude(session, { say, recommended: "", pushback: false, before, modelEntry, started });
}
