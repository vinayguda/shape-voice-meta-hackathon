# Shape

Talk through a product idea. Shape interviews you like a sharp PM, one question at a time, and writes the PRD on screen while you talk.

![Mid-interview: the agent is on the workflow question and the PRD canvas is filling in](docs/screenshot-mid.png)

![Finished pass: the PRD is ready and the tool log shows the Muse or demo calls](docs/screenshot-ready.png)

**Track:** Indie Developer. **Theme:** Build for Your World.
**Built with Meta Muse models** via the [Meta Model API](https://dev.meta.ai) for the Meta Global AI Developer Hackathon (October 26–November 4, 2026).

Demo video: [TO FILL]

## Quickstart

Node 20 or newer. No install step.

```bash
git clone https://github.com/vinayguda/shape-voice-meta-hackathon.git
cd shape-voice-meta-hackathon
make dev
```

If `make` is not installed:

```bash
npm start
# or
node server/index.js
```

Open http://localhost:3000. Leave the toggle on **Demo** and click **Play sample idea**, or hold **Mic** (Chrome) and answer out loud. **Download .md** saves the PRD.

That one process serves the UI, the interview, and the MCP endpoint. Demo mode does not call the network.

Live Muse, when you have a key:

```bash
cp .env.example .env   # set META_API_KEY
npm start              # or: make dev
```

Toggle **Live Muse** in the header. `npm run check` or `make check` runs the scripted interview, the no-key guard, and the MCP tools.

## Hackathon

| | |
|---|---|
| Track | Indie Developer |
| Theme | Build for Your World |
| Window | October 26–November 4, 2026 |
| Entrant | Vinay Guda (solo) |
| Models | `muse-spark-1.3` on every live turn. `muse-voice-transcribe-1.0` on every mic clip when a key is set. |

Shape is for the builder who can explain an idea out loud and still walks into a blank doc. The interview asks the questions that usually get skipped, and the canvas is the spec at the end of the conversation.

## Built with Meta Muse models via Meta Model API

Base URL `https://api.meta.ai/v1`. Auth `Authorization: Bearer $META_API_KEY`. Chat Completions is OpenAI-compatible. No other LLM is called.

| Model id | Job | Where |
|---|---|---|
| `muse-spark-1.3` (override with `META_MODEL`) | Interview, follow-ups, pushback, slot extraction, PRD drafting, tool calls | `server/muse.js` `museChat` → `POST /v1/chat/completions`, called from `server/interview.js` on every **Live** user turn |
| `muse-voice-transcribe-1.0` | Speech-to-text for the mic | `server/muse.js` `transcribeWav` → `POST /v1/asr/transcribe`. 16 kHz mono WAV. `audioEncoding` is `WAV`. |

Muse Spark is a reasoning model. Reasoning tokens count against `max_tokens`. A cap of 20 comes back as `content: null` and `finish_reason=length`. The default cap is **1500** (`META_MAX_TOKENS`) and Shape sends `reasoning_effort=low` unless `META_REASONING_EFFORT=off`. If that field returns HTTP 400, the next attempt drops it.

A live interview turn is **one** chat completion. The spoken reply comes back in that same response as the PRD tool calls (`commit_turn`), and Shape applies the tools locally. On the owner's key, the previous two-call turns averaged about **16 seconds** (20.7, 13.2, 12.8, 27.4, 9.9, 13.9; each Muse call about 9 seconds, 245–1943 reasoning tokens). Dropping the second call puts a turn on the order of **one call, about 9–13 seconds**, plus about **1.6 seconds** for Muse Voice Transcribe. The screen says **Thinking…** while that call is in flight, and Shape says “Got it.” as soon as you release the mic. Raise `META_MAX_TOKENS` if a turn comes back cut off.

The mic is push-to-talk. The browser records a clip, resamples it to 16 kHz mono WAV, and Shape posts it to `POST /v1/asr/transcribe`. That call is verified: HTTP 200, transcript in `transcript`, about 1–2 seconds for a 4 second clip. The JSON part must be exactly `{"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV","sampleRateHertz":16000}`. `audioEncoding` is case-sensitive (`wav`, `LINEAR16`, and `PCM_S16LE` return 400). `POST /v1/audio/transcriptions` returns 404, and the realtime WebSocket is not used. Each clip is a row in the tool log (`asr/transcribe`).

`META_STT=browser` forces the Web Speech API in Live mode. **Demo mode always uses browser speech**, even when `META_API_KEY` is set, so a demo makes no Meta calls. With no key, Live mode uses that same browser fallback. Meta does not ship text-to-speech here, so replies use `speechSynthesis`.

The header pill and the tool log show the model id, latency, and reasoning-token count on live turns.

## How it works

```mermaid
flowchart LR
  person[Person] --> browser[Browser]
  browser -->|"Live mic: 16 kHz mono WAV"| stt["muse-voice-transcribe-1.0\nPOST /v1/asr/transcribe"]
  stt --> turn["Shape /api/turn"]
  browser -->|"Demo mic, typed text, or META_STT=browser"| turn
  turn -->|"Live mode"| spark["muse-spark-1.3\nPOST /v1/chat/completions"]
  spark -->|tool calls| tools["create_prd\nupdate_prd_section\nexport_prd"]
  tools --> canvas[PRD canvas]
  tools --> mcp["MCP Streamable HTTP\nPOST /mcp"]
  turn -->|spoken reply| voice[speechSynthesis]
  canvas --> file[Markdown download]
```

### Interview

```mermaid
stateDiagram-v2
  state "Legend" as legend {
    lg0: setup
    lg1: loop
    lg2: finish
  }
  class lg0 tan
  class lg1 blue
  class lg2 teal
  s0: New session
  s1: Shape asks the stage question
  s2: Your notes loaded
  s3: Your answer heard
  s4: Shape picks its recommended answer
  s5: PRD created, Problem written
  s6: Section written
  s7: All 7 sections written
  s8: PRD exported
  [*] --> s0
  s0 --> s1: you start the interview
  s0 --> s2: you paste notes or a link
  s1 --> s3: you answer
  s1 --> s4: you say 'not sure'
  s2 --> s1: you start the interview
  s3 --> s1: nothing usable to write [answer too short]
  s3 --> s5: Shape writes the section
  s4 --> s5: Shape saves it as 'Suggested:'
  s5 --> s1: Shape asks about Target user
  s3 --> s6: Shape writes the section
  s4 --> s6: Shape saves it as 'Suggested:'
  s6 --> s1: Shape asks the next stage [stages left]
  s6 --> s7: after Risks is written
  s7 --> s8: Shape exports the PRD
  class s0 tan
  class s1 blue
  class s2 tan
  class s3 blue
  class s4 blue
  class s5 blue
  class s6 blue
  class s7 teal
  class s8 teal
```

### One turn

```mermaid
stateDiagram-v2
  state "Legend" as legend {
    lg0: rest
    lg1: turn
    lg2: error
    lg3: Breaks DemoMakesNoApiCall or ModelReplyIsSpoken in some cases
    lg4: Path to the DemoMakesNoApiCall or ModelReplyIsSpoken bug
  }
  class lg0 tan
  class lg1 blue
  class lg2 pink
  class lg3 mayBreak
  class lg4 bugPath
  s0: Idle
  s1: Recording
  s2: Thinking
  s3: Transcribing (Muse Voice Transcribe)
  s4: Updating the PRD
  s5: Error message shown
  s6: Speaking the reply
  [*] --> s0
  s0 --> s1: you click Mic and talk
  s1 --> s2: browser speech hears you [no key]
  s1 --> s3: you click Stop [server has a key]
  s2 --> s5: no key on the server [Live mode] or the model fails or times out or the model pushes back
  s2 --> s4: canned reply, no API call [Demo mode] or the model replies with tools [Live mode]
  s3 --> s5: transcription fails
  s3 --> s2: your words come back
  s4 --> s6: sections saved, stage moves on
  s5 --> s0: you try again
  s6 --> s0: Shape finishes talking
  classDef mayBreak fill:#fff3e6,stroke:#e8730c,stroke-width:2.5px,color:#b85a06
  class s0 tan
  class s0 mayBreak
  class s0 bugPath
  class s1 blue
  class s1 bugPath
  class s2 blue
  class s2 mayBreak
  class s2 bugPath
  class s3 blue
  class s3 mayBreak
  class s3 bugPath
  class s4 blue
  class s4 mayBreak
  class s5 pink
  class s5 mayBreak
  class s5 bugPath
  class s6 blue
  class s6 mayBreak
```

Statecharts generated and model-checked (TLA+/TLC) with the statechart skill from Lauren Tan's pstack (MIT). Sources and views: `docs/statecharts/`. The checked turn machine still shows two edges this PR closes: Demo mic audio is not sent to Muse, and a `pushback: true` reply no longer rolls the turn back.

Demo mode walks the same graph and the same tool executor with canned replies, so the UI still runs if the key is missing or the API flakes. Switch the header to **Live Muse** and the next answer is a real `muse-spark-1.3` call. The opening question is the first branch of the graph and does not spend a request. Every answer after that does.

The graph, one question at a time: problem → target user → current workaround → workflow → MVP scope in and out → success metrics → risks and open questions. Shape offers a recommended answer you can tap, and it pushes back on "everyone," a platform-sized scope, a metric with no number, and one-word answers.

PRD sections on the canvas: Problem, Target user / personas, User stories, MVP scope, Success metrics, Risks, Open questions.

### MCP

The three PRD actions are real tools. The interview runs them in-process through the same function the MCP server exposes, so a turn does not hop over HTTP to itself. `POST /mcp` speaks Streamable HTTP (JSON-RPC, `MCP-Protocol-Version: 2025-03-26`).

```bash
curl -s http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`tools/call` accepts `create_prd`, `update_prd_section`, and `export_prd`. Pass `sessionId` to aim at an interview session, or omit it to use the default MCP session.

### Voice choice

LiveKit Agents would work, and the earlier Voice Agent Studio project was built that way. This repo does not copy that code. Shape stays one Node process: the browser records, Muse Voice Transcribe transcribes, Muse Spark interviews, and `speechSynthesis` speaks. Use headphones so the reply does not walk back into the mic. Typing and **Play sample idea** cover a machine with no microphone. Set `META_STT=browser` if you want the Web Speech API instead of Muse.

Before the first question you can paste notes, upload a `.md`, `.txt`, or text-based `.pdf`, or give a public URL. Shape stores that on the session, logs `load_context`, and puts a short summary in the Muse prompt on every turn so the question can cite it ("Your notes say X — does that mean…?"). **Play sample idea** loads an example set of parent-interview notes. The header shows **Context loaded** once it's in.

## Inspiration

Shape's interviewer follows **grill-me**: one question at a time, walk each branch of the decision tree, offer a recommended answer, push back on scope, and stop when there is shared understanding.

- **Matt Pocock's grill-me skill.** That is the pattern above. See [mattpocock/skills](https://github.com/mattpocock/skills).
- **[grill-with-ui](https://github.com/jasonku09/grill-with-ui)** by jasonku09. An agent-agnostic grilling interview on a local browser page instead of a terminal. Shape keeps the interview in the browser, does it by voice, and fills the PRD canvas live.

## What existed before

Voice-studio patterns (a session you can talk to, a visible log of model and tool activity) come from the author's earlier Voice Agent Studio project, a LiveKit admin console and playground. Everything in this repository was written during the hackathon window, October 26–November 4, 2026. There is no employer code here.

## What's next

Not in this build:

- Phone-call handoff, so a session can leave the browser for a phone call.
- WhatsApp in the middle of a call.
- A research tool the agent can call when a claim needs a source.

## Env

See `.env.example`. The names that matter:

| Variable | Purpose |
|---|---|
| `META_API_KEY` | Bearer token for the Meta Model API. `MODEL_API_KEY` is also accepted. |
| `META_BASE_URL` | `https://api.meta.ai/v1` |
| `META_MODEL` | `muse-spark-1.3` |
| `META_MAX_TOKENS` | Default 1500. Do not set this near 20. |
| `META_REASONING_EFFORT` | Default `low`. `off` disables it. |
| `META_STT` | Unset uses Muse Voice Transcribe when a key is set. `browser` forces the Web Speech API. |
| `META_STT_MODEL` | Default `muse-voice-transcribe-1.0`. |
| `DEMO` | `1` forces the canned interview even if a key is set. |

The browser never sees the key. `/api/health` reports only whether a key is present.

## License

MIT. Copyright 2026 Vinay Guda.
