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
