// Interview graph. One question per stage, in order.
// Recommendations are verbatim answers the user can accept.

export const STAGES = [
  {
    id: "problem",
    label: "Problem",
    short: "Problem",
    ask: "What's the idea in one sentence, and what pain does it remove?",
  },
  {
    id: "target_user",
    label: "Target user",
    short: "User",
    ask: "Who is the primary user? Name a real person and a situation, not a market.",
  },
  {
    id: "workaround",
    label: "Workaround",
    short: "Today",
    ask: "What do they do today when this pain shows up?",
  },
  {
    id: "workflow",
    label: "Workflow",
    short: "Flow",
    ask: "Walk the one workflow that has to work on the first try.",
  },
  {
    id: "mvp_scope",
    label: "MVP scope",
    short: "Scope",
    ask: "What is in the first version, and what is explicitly out?",
  },
  {
    id: "success_metrics",
    label: "Success metrics",
    short: "Metric",
    ask: "How will you know it worked? Give me a number you could check in 30 days.",
  },
  {
    id: "risks",
    label: "Risks",
    short: "Risks",
    ask: "What is the riskiest assumption, and what is still an open question?",
  },
];

export const SECTION_META = [
  { id: "problem", label: "Problem" },
  { id: "target_user", label: "Target user / personas" },
  { id: "user_stories", label: "User stories" },
  { id: "mvp_scope", label: "MVP scope" },
  { id: "success_metrics", label: "Success metrics" },
  { id: "risks", label: "Risks" },
  { id: "open_questions", label: "Open questions" },
];

export const SECTION_IDS = SECTION_META.map((s) => s.id);
