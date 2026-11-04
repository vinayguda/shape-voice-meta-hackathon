export const title = "Shape: one turn";
const L: Record<string,string> = { idle: "Idle", recording: "Recording", transcribing: "Transcribing (Muse Voice Transcribe)",
  thinking: "Thinking", applying: "Updating the PRD", speaking: "Speaking the reply", error: "Error message shown" };
export const state = (v: any) => L[v.phase];
export const group = (v: any) => v.phase === "error" ? "error" : v.phase === "idle" ? "rest" : "turn";
export const colors = { rest: "tan", turn: "blue", error: "pink" };
export const step = (a: string) => ({
  PressMic: "you click Mic and talk",
  StopMicMuse: "you click Stop [server has a key]",
  StopMicBrowser: "browser speech hears you [no key]",
  TranscribeOk: "your words come back",
  TranscribeFails: "transcription fails",
  DemoReply: "canned reply, no API call [Demo mode]",
  NoKey: "no key on the server [Live mode]",
  ModelReplies: "the model replies with tools [Live mode]",
  ModelFails: "the model fails or times out",
  ModelPushesBack: "the model pushes back",
  Apply: "sections saved, stage moves on",
  SpeakDone: "Shape finishes talking",
  Dismiss: "you try again",
} as Record<string,string>)[a] ?? a;
