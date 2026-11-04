---- MODULE Interview ----
EXTENDS Naturals
CONSTANT N  \* number of stages (7)
VARIABLES phase, ctx, stage, filled, suggested, created, exported
vars == <<phase, ctx, stage, filled, suggested, created, exported>>

Init == phase = "start" /\ ctx = FALSE /\ stage = 1 /\ filled = 0
        /\ suggested = FALSE /\ created = 0 /\ exported = 0

LoadContext == phase = "start" /\ ~ctx /\ ctx' = TRUE
        /\ UNCHANGED <<phase, stage, filled, suggested, created, exported>>
Start == phase = "start" /\ phase' = "asking"
        /\ UNCHANGED <<ctx, stage, filled, suggested, created, exported>>
\* user gives a usable answer
Answer == phase = "asking" /\ phase' = "heard" /\ suggested' = FALSE
        /\ UNCHANGED <<ctx, stage, filled, created, exported>>
\* user says "not sure": agent's recommendation is used
NotSure == phase = "asking" /\ phase' = "heard" /\ suggested' = TRUE
        /\ UNCHANGED <<ctx, stage, filled, created, exported>>
\* answer too thin and model wrote nothing: same question again
TooThin == phase = "heard" /\ ~suggested /\ phase' = "asking"
        /\ UNCHANGED <<ctx, stage, filled, suggested, created, exported>>
\* section written; create_prd is skipped once a PRD exists
Write == phase = "heard" /\ phase' = "written" /\ filled' = filled + 1
        /\ created' = (IF created = 0 THEN 1 ELSE created)
        /\ UNCHANGED <<ctx, stage, suggested, exported>>
NextStage == phase = "written" /\ stage < N /\ stage' = stage + 1 /\ phase' = "asking"
        /\ UNCHANGED <<ctx, filled, suggested, created, exported>>
Complete == phase = "written" /\ stage = N /\ phase' = "complete"
        /\ UNCHANGED <<ctx, stage, filled, suggested, created, exported>>
Export == phase = "complete" /\ exported = 0 /\ exported' = 1 /\ phase' = "exported"
        /\ UNCHANGED <<ctx, stage, filled, suggested, created>>
Done == phase = "exported" /\ UNCHANGED vars

Next == LoadContext \/ Start \/ Answer \/ NotSure \/ TooThin \/ Write
        \/ NextStage \/ Complete \/ Export \/ Done

StageNeverSkipsSection == stage - 1 <= filled
ExportOnlyAfterAllSections == exported > 0 => filled = N
PrdCreatedAtMostOnce == created <= 1
PrdExistsBeforeLaterStages == stage > 1 => created = 1
====
