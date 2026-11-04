---- MODULE Turn ----
EXTENDS Naturals
VARIABLES phase, demo, hasKey, apiCalls, modelCalls, model, prdChanged
vars == <<phase, demo, hasKey, apiCalls, modelCalls, model, prdChanged>>
Fresh == apiCalls' = 0 /\ modelCalls' = 0 /\ model' = "none" /\ prdChanged' = FALSE

Init == phase = "idle" /\ demo \in BOOLEAN /\ hasKey \in BOOLEAN
        /\ apiCalls = 0 /\ modelCalls = 0 /\ model = "none" /\ prdChanged = FALSE

PressMic == phase = "idle" /\ phase' = "recording" /\ Fresh /\ UNCHANGED <<demo, hasKey>>
\* with a server key the mic records a clip for Muse Voice Transcribe (even in demo mode)
StopMicMuse == phase = "recording" /\ hasKey /\ phase' = "transcribing" /\ apiCalls' = apiCalls + 1
        /\ UNCHANGED <<demo, hasKey, modelCalls, model, prdChanged>>
\* with no key the browser's own speech recognition gives the text
StopMicBrowser == phase = "recording" /\ ~hasKey /\ phase' = "thinking"
        /\ UNCHANGED <<demo, hasKey, apiCalls, modelCalls, model, prdChanged>>
TranscribeOk == phase = "transcribing" /\ phase' = "thinking"
        /\ UNCHANGED <<demo, hasKey, apiCalls, modelCalls, model, prdChanged>>
TranscribeFails == phase = "transcribing" /\ phase' = "error"
        /\ UNCHANGED <<demo, hasKey, apiCalls, modelCalls, model, prdChanged>>
DemoReply == phase = "thinking" /\ demo /\ phase' = "applying"
        /\ UNCHANGED <<demo, hasKey, apiCalls, modelCalls, model, prdChanged>>
NoKey == phase = "thinking" /\ ~demo /\ ~hasKey /\ phase' = "error"
        /\ UNCHANGED <<demo, hasKey, apiCalls, modelCalls, model, prdChanged>>
ModelReplies == phase = "thinking" /\ ~demo /\ hasKey /\ modelCalls = 0 /\ phase' = "applying"
        /\ apiCalls' = apiCalls + 1 /\ modelCalls' = 1 /\ model' = "ok"
        /\ UNCHANGED <<demo, hasKey, prdChanged>>
ModelFails == phase = "thinking" /\ ~demo /\ hasKey /\ modelCalls = 0 /\ phase' = "error"
        /\ apiCalls' = apiCalls + 1 /\ modelCalls' = 1 /\ model' = "fail"
        /\ UNCHANGED <<demo, hasKey, prdChanged>>
\* code: a reply with pushback=true hits an undefined name after tools ran; the turn is rolled back
ModelPushesBack == phase = "thinking" /\ ~demo /\ hasKey /\ modelCalls = 0 /\ phase' = "error"
        /\ apiCalls' = apiCalls + 1 /\ modelCalls' = 1 /\ model' = "ok"
        /\ UNCHANGED <<demo, hasKey, prdChanged>>
Apply == phase = "applying" /\ phase' = "speaking" /\ prdChanged' = TRUE
        /\ UNCHANGED <<demo, hasKey, apiCalls, modelCalls, model>>
SpeakDone == phase = "speaking" /\ phase' = "idle" /\ UNCHANGED <<demo, hasKey, apiCalls, modelCalls, model, prdChanged>>
Dismiss == phase = "error" /\ phase' = "idle" /\ UNCHANGED <<demo, hasKey, apiCalls, modelCalls, model, prdChanged>>

Next == PressMic \/ StopMicMuse \/ StopMicBrowser \/ TranscribeOk \/ TranscribeFails \/ DemoReply
        \/ NoKey \/ ModelReplies \/ ModelFails \/ ModelPushesBack \/ Apply \/ SpeakDone \/ Dismiss

DemoMakesNoApiCall == demo => apiCalls = 0
OneModelCallPerTurn == modelCalls <= 1
ErrorLeavesPrdUnchanged == phase = "error" => ~prdChanged
ModelReplyIsSpoken == phase = "error" => model # "ok"
====
