const names = ["Problem","Target user","Today's workaround","Workflow","MVP scope","Success metrics","Risks / open questions"];
export const title = "Shape: the interview";
export const state = (v: any) => {
  if (v.phase === "start") return v.ctx ? "Your notes loaded" : "New session";
  if (v.phase === "asking") return "Shape asks the stage question";
  if (v.phase === "heard") return v.suggested ? "Shape picks its recommended answer" : "Your answer heard";
  if (v.phase === "written") return v.stage === 1 ? "PRD created, Problem written" : "Section written";
  if (v.phase === "complete") return "All 7 sections written";
  return "PRD exported";
};
export const group = (v: any) =>
  v.phase === "start" ? "setup" : v.phase === "complete" || v.phase === "exported" ? "finish" : "loop";
export const colors = { setup: "tan", loop: "blue", finish: "teal" };
export const step = (a: string, f: any, t: any) => {
  switch (a) {
    case "LoadContext": return "you paste notes or a link";
    case "Start": return "you start the interview";
    case "Answer": return "you answer";
    case "NotSure": return "you say 'not sure'";
    case "TooThin": return "nothing usable to write [answer too short]";
    case "Write": return t.suggested ? "Shape saves it as 'Suggested:'" : "Shape writes the section";
    case "NextStage": return f.stage === 1 ? "Shape asks about Target user" : "Shape asks the next stage [stages left]";
    case "Complete": return "after Risks is written";
    case "Export": return "Shape exports the PRD";
    case "Done": return null;
  }
  return a;
};
