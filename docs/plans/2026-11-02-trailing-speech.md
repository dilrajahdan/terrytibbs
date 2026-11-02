# Prevent invented endings after dictation

Executing worktree: `terrytibbs-worktrees/trailing-speech`, 2 November 2026.

Investigate unwanted “thank you” endings with the installed Whisper Turbo model.
Reuse the existing speech detector to bound trailing non-speech, retaining the
opening audio, internal pauses and a generous ending margin. Do not blacklist
legitimate words or add another recognition pass. Keep all processing local.

Acceptance: run known speech and genuine spoken thanks as controls; compare the
same audio with silent/noisy tails before and after; preserve quiet final words,
initial words and pauses; reject non-speech; exercise app hold/release and locked
recording delivery. Record reproduction and test limitations honestly. Build,
install and publish only the verified artifact, with changelog and checksums.

Verification: the unchanged public speech control passed. A 25-second tail
reproduced the invented ending. All 12 bounded real-model cases preserved the
reference words, including genuine thanks and quiet endings. All 115 unit and
11 app checks passed. Native insertion and clipboard preservation passed for
hold/release and locked capture with and without the added pause. A focus-change
failure in the first native run was repaired in the harness and rerun with
actual native frontmost/editable assertions. No physical microphone accuracy
claim is made. The mounted 0.6.9 DMG matches the tested compiled code.
