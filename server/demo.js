import { STAGES } from "./stages.js";
import { changedKeys, executeTool, formatScope, pushLog, titleFrom, view } from "./prd.js";

export const SAMPLE_CONTEXT = `Notes from a parent interview:
Parents of kids 8 to 13 check iOS Screen Time once, feel guilty, and argue at dinner.
They want to see patterns, like YouTube after homework, and then talk with their kid.
They do not want app blocking or spyware-style monitoring.
A good week is a 10-minute check-in that actually happens.
Open worry: kids may not consent if a parent turns sharing on quietly.`;

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

export function cleanProse(text, maxSentences = 2) {
  let value = String(text || "").replace(/\s+/g, " ").trim();
  value = value.replace(/\b(\w+)(\s+\1\b)+/gi, "$1");
  if (!value) return "";
  const parts = value.split(/(?<=[.!?])\s+/).filter(Boolean);
  value = (parts.length ? parts : [value]).slice(0, maxSentences).join(" ");
  value = value.charAt(0).toUpperCase() + value.slice(1);
  if (!/[.!?]$/.test(value)) value += ".";
  return value;
}

export function rewriteProblem(text) {
  const chunks = String(text || "").split(/\n\n(?=Current workaround:)/i);
  let pain = chunks[0].replace(/\s+/g, " ").trim();
  pain = pain.replace(/^i want to build\s+/i, "");
  pain = pain.replace(/^i(?:'m| am) building\s+/i, "");
  pain = pain.replace(/^(?:an |a )?(?:app|tool|product)\s+(?:that |which )?(?:helps |help )/i, "");
  pain = pain.replace(/^i want\s+(?:an |a )?(?:app|tool|product)\s+(?:that |which )?(?:helps |help |for |to )/i, "");
  pain = pain.replace(/^i want to\s+/i, "");
  pain = pain.replace(/^parents to\s+/i, "Parents need to ");
  if (/^parents\b/i.test(pain) && !/^parents need\b/i.test(pain)) {
    pain = pain.replace(/^parents\b/i, "Parents");
  }
  pain = cleanProse(pain);
  if (chunks.length < 2) return pain;
  return `${pain}\n\n${chunks.slice(1).join("\n\n")}`;
}

export function personaPhrase(who) {
  let person = String(who || "the primary user").split(/[.!?]/)[0].replace(/\s+/g, " ").trim();
  if (!person) return "a primary user";
  if (/^(a|an|the)\b/i.test(person)) return person.charAt(0).toLowerCase() + person.slice(1);
  if (/s\b/i.test(person.split(" ")[0]) && /^parents\b/i.test(person)) return person.charAt(0).toLowerCase() + person.slice(1);
  return `a ${person.charAt(0).toLowerCase()}${person.slice(1)}`;
}

export function rewriteStories(text, who) {
  const person = personaPhrase(who);
  const lines = String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const stories = lines.map((line) => {
    if (/^suggested:/i.test(line)) return line;
    let want = line.replace(/^as .+?,?\s+i want(?: to)?\s+/i, "").replace(/\.$/, "").trim();
    want = want.replace(/^i want (?:an |a )?(?:app|tool|product) (?:that |to |for )?/i, "");
    want = want.replace(/^(?:to )?build (?:an |a )?(?:app|tool|product) (?:that |to |for )?(?:helps |help )?/i, "");
    want = want.replace(/^an app (?:that |to |for )?/i, "");
    want = want.replace(/^helps\s+/i, "");
    if (!want || isUnsure(want)) return "";
    if (/\bso that\b/i.test(want)) return `As ${person}, I want ${want.charAt(0).toLowerCase()}${want.slice(1)}.`;
    return `As ${person}, I want ${want.charAt(0).toLowerCase()}${want.slice(1)} so that the pain is smaller than it is today.`;
  }).filter(Boolean);
  return stories.join("\n\n");
}

function tidyStory(who, text) {
  const sentence = cleanProse(text, 1);
  if (!sentence || sentence.length > 180 || isUnsure(sentence)) return "";
  return rewriteStories(sentence, who);
}

export function synthesize(session) {
  const answers = session.answers;
  const problemParts = [];
  if (answers.problem) problemParts.push(rewriteProblem(answers.problem));
  if (answers.workaround) problemParts.push(`Current workaround: ${cleanProse(answers.workaround)}`);

  const who = answers.target_user || "the primary user";
  const stories = [
    tidyStory(who, answers.workflow || ""),
    tidyStory(who, answers.problem || ""),
    tidyStory(who, answers.workaround || ""),
  ].filter(Boolean);

  return {
    problem: problemParts.join("\n\n"),
    target_user: answers.target_user ? cleanProse(answers.target_user) : "",
    user_stories: [...new Set(stories)].join("\n\n"),
    mvp_scope: answers.mvp_scope ? formatScope(cleanProse(answers.mvp_scope, 4)) : "",
    success_metrics: answers.success_metrics ? cleanProse(answers.success_metrics, 3) : "",
    risks: answers.risks ? riskStatements(cleanProse(answers.risks, 3)) : "",
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
  const scopeBlob = `${session.answers.mvp_scope || ""}\n${session.prd?.sections?.mvp_scope || ""}`;
  const scopeDiscussed = Boolean((session.answers.mvp_scope || session.prd?.sections?.mvp_scope || "").trim());
  const scopeNamesOut = /\bout\s*:/i.test(scopeBlob) || /\bout of (the )?(scope|mvp|first|version|v1)\b/i.test(scopeBlob);
  if (scopeDiscussed && !scopeNamesOut) add("What is explicitly out of the first version?");
  if (session.complete && items.length === 0 && Object.keys(session.answers).length) {
    add("Shape flagged this because it never came up: what would make us change the MVP after the first ten users?");
  }
  return items.map((item) => `- ${item}`).join("\n");
}

export function isUnsure(text) {
  const value = String(text || "").trim().replace(/[.!?]+$/g, "").trim();
  if (!value || value.length > 60) return false;
  return /^(i'm not sure|i am not sure|im not sure|i don't know|i don’t know|i dont know|idk|not sure|unsure|no idea|you decide|whatever you think)(?:\b.*)?$/i.test(value);
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
    answer = `Suggested: ${recommendFor(stage.id, session)}`;
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
