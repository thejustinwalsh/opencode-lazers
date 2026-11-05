# Native active-task trajectory scope observation

Root drove the current Architect Desktop window at approximately1793851100000–1170000.
The Tasks panel in Session scope displayed LZ136 running. Selecting it showed
LZ136 and its task details. Clicking Open trajectory selected that exact task ID
but retained Project scope, which displayed “Trajectory snapshot could not be
refreshed” followed by the misleading “No tasks are associated with this scope.”

Changing to Session scope recovered data but silently selected task8fb0fd83,
an old accepted task, although LZ136 was available in the same task picker.
Explicitly selecting LZ136 restored the correct original worker session
ses_48e456730db5448d89a03440b372dca5, gpt-6-luna/max, one running attempt,
127 tool calls, token counters and one available context. The panel correctly
left the unfinished attempt end unknown. Data exists; the Project read and
selection continuity are separate defects.

Keep this with existing trajectory capacity/navigation work: opening a task must
retain its identity across an available scope, error state must not claim an empty
scope, and Project history needs progressive bounded reads. This observation does
not establish a missing timestamp in the underlying DB or a repaired panel.
Desktop was left on the correct LZ136 Session trajectory.
